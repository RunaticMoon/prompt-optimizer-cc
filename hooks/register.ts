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
 * `session.end`, `prompt.submit`, `prompt.edit`, `prompt.fill`, `config.set`.
 * `registerUi`/`registerCommands` own `ui.render`/`ui.press`/`ui.input`/
 * `ui.close` and `command.run`, each under its matcher.
 */

import type { EngineInterface, On, PluginOptions } from 'claude-code'

import { OPTIMIZE_COMMAND, registerCommands, type SettingsPort } from './commands'
import { resolveConfig, validateConfigChange } from './config'
import type { ConfigKey, EnginePorts, OptimizerConfig } from './contracts'
import { createController } from './controller'
import { classifySubmission } from './eligibility'
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

  const presenter = createPresenter()

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
    onChange: (state, notice) => {
      if (currentUi !== null) presenter.present(currentUi, state, notice)
    },
  })

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
    controller.onSessionEnd()
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

  registerUi(on, controller, () => getConfig().maxRounds, PLUGIN_NAME)
  registerCommands(on, { controller, settings, chooseUi })
}
