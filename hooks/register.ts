/**
 * Mod entry point (task L): the assembly.
 *
 * This module owns `register(on, options)`. It resolves the settings once,
 * builds the controller (task I), the presenter (K) and the ports the helper
 * modules take, then binds every module to the engine's real events: the six
 * lifecycle/submission events below, plus the UI (K) and the `/optimize`
 * command (J) through `registerUi`/`registerCommands`.
 *
 * Two loader facts shape the code:
 *
 * - `$` may only be passed to a function declared at the top of this file, and
 *   used only as `$.noun.method(...)` at its call site. `portsOf` and
 *   `uiPortsOf` are those top-level functions; the controller and helpers
 *   receive the plain objects they return, never `$`.
 * - A hook may not register hooks, so every `on(...)` runs in `register()`'s
 *   own body. A `$`-grounded closure keeps working after its hook returns (a
 *   scheduled round runs long after its submit hook dropped), so each hook
 *   refreshes `currentSchedule` for the controller.
 *
 * Events registered here, once each and without a matcher: `session.start`,
 * `session.end`, `prompt.submit`, `prompt.edit`, `prompt.fill`, `config.set`,
 * `classic.SessionStart` and `classic.UserPromptSubmit`. The two classic hooks
 * only observe `next(e)`'s `additionalContext` for the memory snapshot and
 * return the result unchanged; both key what they capture by the classic
 * `e.session_id`, and the snapshot reads the last session recorded through it,
 * so `/clear` (which changes that id without a `session.start`) still follows
 * the classic hook. A hook raised inside a subagent (`e.agent_id` set) is
 * ignored entirely, so a worker's own settings hooks cannot disturb the main
 * session's memory. `SessionStart` also clears the previous-prompt entries,
 * since a new session, `/clear` or a compact may leave none of the memory they
 * retrieved present in the main context, and it is the only hook that changes
 * the stored session; `session.end` drops only the ending session's memory,
 * leaving an already captured next session's intact.
 * `registerUi`/`registerCommands` own `ui.render`/`ui.press`/`ui.input`/
 * `ui.close` and `command.run`, each under its matcher.
 */

import type { EngineInterface, On, PluginOptions } from 'claude-code'

import { OPTIMIZE_COMMAND, registerCommands, type SettingsPort } from './commands'
import { resolveConfig, validateConfigChange } from './config'
import {
  CONTEXT_MEMORY_CHARS,
  type ConfigKey,
  type EnginePorts,
  type OptimizerConfig,
} from './contracts'
import { createController } from './controller'
import { classifySubmission } from './eligibility'
import { createMemoryStore, renderMemory } from './memory'
import { createPresenter } from './ui/present'
import { registerUi } from './ui/register'
import { paneOpenArgs, type UiPorts } from './ui/ui-ports'

/** The name plugin.json declares; `prompt.fill` reports foreign fills by it. */
const PLUGIN_NAME = 'prompt-optimizer'

/** The prefix `/config` rows carry: `<plugin>.<field>`. */
const CONFIG_PREFIX = `${PLUGIN_NAME}.`

/** A readable message from a thrown value. */
function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Writes one validated value onto the live config object. */
function assignConfig(config: OptimizerConfig, key: ConfigKey, value: OptimizerConfig[ConfigKey]): void {
  ;(config as unknown as Record<string, unknown>)[key] = value
}

/**
 * Keeps `$` at the hook site: builds the {@link EnginePorts} closures the
 * controller and helpers take, so no `$` crosses an import.
 */
function portsOf($: EngineInterface): EnginePorts {
  return {
    session: {
      // The helpers only call `messages()` with no argument; the widening cast
      // keeps the overloaded call type without reading the method as a value.
      messages: (() => $.session.messages()) as unknown as EnginePorts['session']['messages'],
      cwd: () => $.session.cwd(),
      root: () => $.session.root(),
      repo: () => $.session.repo(),
    },
    fs: {
      stat: path => $.fs.stat(path),
      read: ((path: string) => $.fs.read(path)) as unknown as EnginePorts['fs']['read'],
    },
    // The loader wants a literal env name; `HOME` is the only one read.
    env: { get: () => $.env.get('HOME') },
    model: { complete: (request, options) => $.model.complete(request, options) },
    prompt: {
      read: () => $.prompt.read(),
      fill: args => $.prompt.fill(args),
      submit: args => $.prompt.submit(args),
    },
    ui: { close: args => $.ui.close(args) },
  }
}

/** Keeps `$` at the hook site: the presenter/UI boundary the controller uses. */
function uiPortsOf($: EngineInterface): UiPorts {
  return {
    open: args => $.ui.open(args),
    close: id => $.ui.close({ id }),
    invalidate: () => $.ui.invalidate('ui.render'),
    status: text => $.ui.status(text),
    log: text => $.ui.log(text),
    toast: text => $.ui.toast(text),
  }
}

/**
 * Registers the whole optimizer against the engine.
 *
 * Settings are resolved once from `options`; `/optimize on|off|model` edits an
 * in-memory override layer, while the `/config` menu writes through
 * `config.set` and lands on the base config.
 */
export function register(on: On, options: PluginOptions): void {
  const resolved = resolveConfig(options)
  const warnings = resolved.warnings
  let config = resolved.config
  let overrides: Partial<OptimizerConfig> = {}
  const getConfig = (): OptimizerConfig => ({ ...config, ...overrides })

  let currentUi: UiPorts | null = null
  let currentSchedule: ((fn: () => void) => void) | null = null
  let idCounter = 0
  // Memory diagnostics, split so each kind is reported once independently (a
  // shared classic id reports at most once; see the classic hooks below):
  // `emptyIdReported` covers an id that cannot key the store, `lastMismatchId`
  // covers the last id that differed from `session.start`'s (e.g. after
  // `/clear`), and
  // `missingStartIdReported` covers a `session.start` that yielded no id at all.
  let emptyIdReported = false
  let lastMismatchId: string | null = null
  let missingStartIdReported = false

  const presenter = createPresenter()
  const memory = createMemoryStore()

  const settings: SettingsPort = {
    get: getConfig,
    set: async (key, value) => {
      const result = validateConfigChange(key, value)
      if (!result.ok) return { ok: false, error: result.error }
      overrides = { ...overrides, [result.key]: result.value }
      return { ok: true }
    },
  }

  const controller = createController({
    now: () => Date.now(),
    newId: () => {
      idCounter += 1
      return `po-${idCounter}`
    },
    schedule: fn => {
      if (currentSchedule !== null) currentSchedule(fn)
      else void Promise.resolve().then(fn)
    },
    getConfig,
    readMemory: () => renderMemory(memory.latest(), CONTEXT_MEMORY_CHARS),
    onChange: (state, notice) => {
      if (currentUi !== null) presenter.present(currentUi, state, notice)
    },
  })

  /**
   * A one-time debug note for a classic hook's `session_id`, or `null` when it
   * needs none. An id that is missing, empty or not a string cannot key the
   * memory store, so it is reported once and the caller skips recording for it;
   * an id that differs from the id `session.start` recorded (as after a
   * `/clear`) is reported once while it stays the latest mismatch (only the
   * last such id is remembered, so a different one reports again); and a
   * `session.start` that yielded no id at all is reported once, since then
   * every classic id "differs" and the follow-the-classic-hook fallback is the
   * only path. Each kind keeps its own state, so toggling between them cannot
   * make either repeat.
   */
  function classicIdDiagnostic(id: unknown): string | null {
    if (typeof id !== 'string' || id === '') {
      if (emptyIdReported) return null
      emptyIdReported = true
      return 'prompt-optimizer: a classic hook carried no session_id; long-term memory capture is skipped for it'
    }
    const sessionId = controller.getState().sessionId
    if (sessionId === '') {
      if (missingStartIdReported) return null
      missingStartIdReported = true
      return 'prompt-optimizer: session.start yielded no session id; long-term memory follows the classic hook id'
    }
    if (sessionId === id || lastMismatchId === id) return null
    lastMismatchId = id
    return 'prompt-optimizer: classic hook session_id differs from the session.start id (e.g. after /clear); long-term memory follows the classic hook id'
  }

  /** Picks the interface for a run about to start; a pane that will not place falls back. */
  async function chooseUi(ui: UiPorts): Promise<'pane' | 'composer'> {
    if (getConfig().uiMode === 'composer') return 'composer'
    try {
      const opened = await ui.open(paneOpenArgs())
      return opened.isPlaced ? 'pane' : 'composer'
    } catch {
      return 'composer'
    }
  }

  // Refreshes the per-dispatch bindings from this hook's `$`. Inlined in every
  // hook (a helper could not take `$`): the presenter and any scheduled round
  // then use the current dispatch's `$`.
  on('session.start', async ($, e, next) => {
    currentUi = uiPortsOf($)
    currentSchedule = fn => {
      $.clock.after(1, fn)
    }
    const r = await next(e)

    let id = ''
    try {
      id = await $.session.id()
    } catch {
      id = ''
    }
    controller.onSessionStart(id)

    try {
      await $.command.register(OPTIMIZE_COMMAND)
    } catch (cause) {
      $.ui.log(`prompt-optimizer: could not register the /optimize command (${describeError(cause)})`, {
        to: 'debug',
      })
    }
    for (const warning of warnings) {
      $.ui.log(`prompt-optimizer: ${warning}`, { to: 'debug' })
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    currentUi = null
    currentSchedule = null
    // The engine names the ending session; fall back to the controller's id
    // when the event carried none. `onSessionEnd` keeps the state's sessionId
    // (state.ts), so the fallback names the same session either side of it.
    const endingSessionId =
      typeof e.sessionId === 'string' && e.sessionId !== ''
        ? e.sessionId
        : controller.getState().sessionId
    controller.onSessionEnd()
    // Drop only the ending session's memory. A new session's classic
    // SessionStart can arrive before this end (e.g. `/clear`), and its fresh
    // memory must survive; a mismatched id leaves the store untouched.
    memory.resetSession(endingSessionId)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    currentUi = uiPortsOf($)
    currentSchedule = fn => {
      $.clock.after(1, fn)
    }
    const ports = portsOf($)
    try {
      // The classifier decides the shape first; only an optimization needs a UI
      // chosen (and a pane opened) here. The controller re-reads the same state.
      let ui: 'pane' | 'composer' = 'composer'
      const decision = classifySubmission(e, getConfig(), controller.getState(), Date.now())
      if (decision.kind === 'optimize' && currentUi !== null) {
        ui = await chooseUi(currentUi)
      }
      // `onSubmit` never awaits a model call: it stores state and schedules the
      // first round, so this hook returns far inside its ten-second budget.
      const out = await controller.onSubmit(ports, e, ui)
      return out.action === 'next' ? next({ ...e, text: out.text }) : { drop: out.reason }
    } catch {
      return next(e)
    }
  })

  on('prompt.edit', async ($, e, next) => {
    currentUi = uiPortsOf($)
    currentSchedule = fn => {
      $.clock.after(1, fn)
    }
    const r = await next(e)
    if (controller.getState().bypass !== null) controller.onPromptEdit(r.text)
    return r
  })

  on('prompt.fill', async ($, e, next) => {
    currentUi = uiPortsOf($)
    currentSchedule = fn => {
      $.clock.after(1, fn)
    }
    const r = await next(e)
    if (
      r.isFilled &&
      e.origin.kind === 'plugin' &&
      e.origin.name !== PLUGIN_NAME &&
      controller.getState().bypass !== null
    ) {
      // Another plugin altered the box: the restored draft is gone, so its
      // bypass follows what the box actually holds now. The fill's own `text`
      // is only its fragment for `append`/`insert`, so read the box; a box
      // that cannot be read falls back to the fragment. A fill that was
      // refused left the box as it was, so the permit still stands.
      let text = e.text
      try {
        text = (await $.prompt.read()).text
      } catch {
        text = e.text
      }
      controller.onPromptEdit(text)
    }
    return r
  })

  on('config.set', async ($, e, next) => {
    currentUi = uiPortsOf($)
    const r = await next(e)
    if (e.key.startsWith(CONFIG_PREFIX) && 'value' in r) {
      const field = e.key.slice(CONFIG_PREFIX.length)
      // A hook beneath may clamp or replace the value; the row's actual new
      // value is what `next` resolved to, never the requested `e.value`.
      const result = validateConfigChange(field, r.value)
      if (result.ok) {
        assignConfig(config, result.key, result.value)
        const nextOverrides = { ...overrides }
        delete nextOverrides[result.key]
        overrides = nextOverrides
      } else {
        // The row was written, but the value fails this plugin's own rules (out
        // of range, blank model, ...). Say so, instead of silently letting the
        // stored value and the effective one diverge.
        $.ui.toast(
          `prompt-optimizer: ${field} 값이 올바르지 않아 이전 값을 유지합니다: ${result.error}`,
        )
      }
    }
    return r
  })

  // The memory-capture hooks: they only observe, never change the chain. The
  // result `r` is awaited first (a throwing `next` propagates untouched), then
  // a hook raised inside a subagent (`agent_id` set) is left alone — a worker's
  // settings hooks must not disturb the main session's memory. Otherwise the
  // captured `additionalContext` is copied into the store under the classic
  // hook's own `e.session_id`, and the SAME `r` is returned. Recording runs
  // first, wrapped so a capture fault cannot break another plugin's settings
  // hooks; the diagnostic follows in its own `try`, so a logging fault cannot
  // skip the capture. The classic `session_id` is the read key (the transcript
  // file's name): the snapshot reads the last adopted session
  // (`memory.latest()`), so a `/clear` that changes the id without a
  // `session.start` still follows the classic hook. An id that is missing,
  // empty or not a string cannot key the store, so it is not recorded at all;
  // a diagnostic explains either case once per kind.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    const agentId = (e as { agent_id?: unknown }).agent_id
    if (typeof agentId === 'string' && agentId !== '') return r
    try {
      if (typeof e.session_id === 'string' && e.session_id !== '') {
        memory.recordSessionStart(e.session_id, r.additionalContext)
        // A new session (/clear, compact, resume) may leave none of the memory
        // retrieved for the previous prompt in the main context, so drop it.
        memory.recordPromptSubmit(e.session_id, undefined)
      }
    } catch {
      // A capture fault must not break the chain.
    }
    try {
      const note = classicIdDiagnostic(e.session_id)
      if (note !== null) $.ui.log(note, { to: 'debug' })
    } catch {
      // A logging fault must not undo the capture above.
    }
    return r
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const r = await next(e)
    const agentId = (e as { agent_id?: unknown }).agent_id
    if (typeof agentId === 'string' && agentId !== '') return r
    try {
      if (typeof e.session_id === 'string' && e.session_id !== '') {
        memory.recordPromptSubmit(e.session_id, r.additionalContext)
      }
    } catch {
      // A capture fault must not break the chain.
    }
    try {
      const note = classicIdDiagnostic(e.session_id)
      if (note !== null) $.ui.log(note, { to: 'debug' })
    } catch {
      // A logging fault must not undo the capture above.
    }
    return r
  })

  registerUi(on, controller, () => getConfig().maxRounds, PLUGIN_NAME)
  registerCommands(on, { controller, settings, chooseUi })
}
