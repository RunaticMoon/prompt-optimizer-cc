/**
 * The `/optimize` slash command (DESIGN ⑥ 설정과 명령, 작업 J).
 *
 * `parseOptimizeArgs` turns the typed argument string into one intent, without
 * touching the engine; `registerCommands` binds that intent to the controller
 * and the settings port through a single `command.run` hook, narrowed to
 * `{ command: 'optimize' }` so every other command passes through untouched.
 *
 * The hook answers with `{ text }` alone: its lines are what the person sees,
 * and no `context` is ever returned, so nothing of the optimizer's dialogue
 * reaches the main transcript or the main model.
 *
 * Two loader facts shape the module:
 *
 * - `$` may only be used at its call site (`$.noun.method(...)`). `portsOf`
 *   builds an {@link EnginePorts} of closures here and the controller receives
 *   that plain object, never `$` itself.
 * - A `command.run` registration is matched, never bare: another file (task L)
 *   owns `command.register` and the session wiring.
 */

import type { CommandSpec, EngineInterface, On } from 'claude-code'

import type { ConfigKey, EnginePorts, OptimizerConfig, RuntimeState } from './contracts'
import type { UiPorts } from './ui/ui-ports'

/** The `/optimize` command spec; task L passes it to `$.command.register`. */
export const OPTIMIZE_COMMAND: CommandSpec = {
  name: 'optimize',
  description: '프롬프트 옵티마이저: 개선 시작·승인·전송·설정',
  argumentHint: '[text|on|off|accept|send|raw|cancel|retry|status|model <id>]',
  immediate: true,
}

/**
 * The slice of the settings the command needs: the current config for `status`,
 * and one validated write for `on`/`off`/`model`. The host owns persistence and
 * validation; the command only reports what came back.
 */
export interface SettingsPort {
  /** The config in force now. */
  get(): OptimizerConfig
  /** Writes one key; a rejected value returns `{ ok: false, error }`. */
  set(key: ConfigKey, value: unknown): Promise<{ ok: true } | { ok: false; error: string }>
}

/**
 * The controller surface the command drives (task I's `OptimizerController`).
 *
 * Declared locally with only the members used here; TypeScript's structural
 * typing lets task I's implementation pass as-is. Each method takes the engine
 * ports the command built, never `$`.
 */
export interface CommandController {
  /** The current serializable state, for `status`. */
  getState(): Readonly<RuntimeState>
  /** Starts an explicit optimization; `text` absent means the composer draft. */
  startExplicit(ports: EnginePorts, text: string | undefined, ui: 'pane' | 'composer'): Promise<void>
  /** Continues the dialogue with one supplement. */
  refine(ports: EnginePorts, instruction: string): Promise<void>
  /** Re-runs the last completion, optionally with a supplement. */
  retry(ports: EnginePorts, instruction?: string): Promise<void>
  /** Restores the draft into the composer. */
  accept(ports: EnginePorts): Promise<void>
  /** Sends the improved draft now. */
  sendDraft(ports: EnginePorts): Promise<void>
  /** Sends the stored original. */
  sendOriginal(ports: EnginePorts): Promise<void>
  /** Cancels the active run. */
  cancel(ports: EnginePorts): Promise<void>
}

/** What `registerCommands` needs: the controller, the settings, and the UI choice. */
export interface CommandDeps {
  /** The improvement dialogue's controller. */
  controller: CommandController
  /** Read/validate settings for the `on`, `off`, `model` and `status` intents. */
  settings: SettingsPort
  /**
   * Asks the host to try a pane; its answer picks the explicit run's UI.
   *
   * The ports are the ones built inside this hook from the live `$`: opening
   * the pane inside the command's own dispatch is what lets a narrow terminal
   * still place it (2.1.285's user-gesture rule).
   */
  chooseUi(ui: UiPorts): Promise<'pane' | 'composer'>
}

/** One parsed `/optimize` invocation. */
export type ParsedCommand =
  | { kind: 'start'; text?: string }
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'accept' }
  | { kind: 'send' }
  | { kind: 'raw' }
  | { kind: 'cancel' }
  | { kind: 'retry'; instruction?: string }
  | { kind: 'status' }
  | { kind: 'model'; model: string }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

/** The `/optimize help` body. */
const HELP_TEXT = [
  '프롬프트 옵티마이저 명령:',
  '/optimize [text] — 입력한 텍스트(없으면 현재 입력창 초안)로 개선 시작',
  '/optimize on | off — 자동 가로채기 켜기 | 끄기',
  '/optimize accept — 개선안을 입력창으로 가져오기',
  '/optimize send — 개선안을 지금 보내기',
  '/optimize raw — 원문을 그대로 보내기',
  '/optimize retry [instruction] — 보완 내용으로 다시 다듬기',
  '/optimize cancel — 개선 작업 취소',
  '/optimize status — 설정과 진행 상황 보기',
  '/optimize model <id> — 옵티마이저 모델 변경',
  '/optimize -- <text> — 예약어로 시작하는 문장도 개선 시작',
].join('\n')

/**
 * Parses the argument string after `/optimize`.
 *
 * The first whitespace-delimited token, compared case-insensitively, selects a
 * reserved command; the rest is its argument. `model` without an argument, or
 * an unknown shape, becomes an `error`. Any non-reserved first token (or a
 * `--` escape) makes the whole trimmed argument the optimization text, and an
 * empty argument starts from the current composer draft.
 */
export function parseOptimizeArgs(args: string): ParsedCommand {
  const trimmed = args.trim()
  if (trimmed === '') return { kind: 'start' }
  // `--` releases the rest as literal text, so a prompt that begins with a
  // reserved word can still be optimized.
  if (trimmed === '--') return { kind: 'start' }
  if (trimmed.startsWith('-- ')) {
    const text = trimmed.slice(3).trim()
    return text === '' ? { kind: 'start' } : { kind: 'start', text }
  }

  const gap = trimmed.search(/\s/)
  const head = (gap === -1 ? trimmed : trimmed.slice(0, gap)).toLowerCase()
  const rest = gap === -1 ? '' : trimmed.slice(gap + 1).trim()

  switch (head) {
    case 'on':
      return { kind: 'on' }
    case 'off':
      return { kind: 'off' }
    case 'accept':
      return { kind: 'accept' }
    case 'send':
      return { kind: 'send' }
    case 'raw':
      return { kind: 'raw' }
    case 'cancel':
      return { kind: 'cancel' }
    case 'status':
      return { kind: 'status' }
    case 'help':
      return { kind: 'help' }
    case 'retry':
      return rest === '' ? { kind: 'retry' } : { kind: 'retry', instruction: rest }
    case 'model':
      return rest === '' ? { kind: 'error', message: '모델 이름이 필요합니다. 예: /optimize model haiku' } : { kind: 'model', model: rest }
    default:
      return { kind: 'start', text: trimmed }
  }
}

/**
 * The `/optimize status` body: the effective settings, the active run's stage
 * and rounds, and this session's summed usage. Pure, so it is easy to test.
 */
export function formatStatus(config: OptimizerConfig, state: Readonly<RuntimeState>): string {
  const lines: string[] = [
    `프롬프트 옵티마이저: ${config.enabled ? '켜짐' : '꺼짐'}`,
    `트리거: ${config.triggerMode === 'always' ? '항상' : `접두어 "${config.triggerPrefix}"`} · UI: ${config.uiMode}`,
    `모델: ${config.model} · 최대 토큰: ${config.maxTokens} · 타임아웃: ${config.timeoutMs}ms · 최대 라운드: ${config.maxRounds}`,
    `문맥: 최근 ${config.contextTurns}턴 · 최대 ${config.contextMaxChars}자 · raw 접두어 "${config.rawPrefix}"`,
  ]
  if (config.systemPromptFile !== '') lines.push(`시스템 프롬프트 파일: ${config.systemPromptFile}`)

  const workflow = state.workflow
  if (workflow === null) {
    lines.push('진행 중인 개선 작업: 없음')
  } else {
    lines.push(`진행 중인 개선 작업: ${workflow.id} · 단계 ${workflow.phase} · ${workflow.rounds}/${config.maxRounds}회`)
    if (workflow.lastError !== undefined) lines.push(`마지막 오류: ${workflow.lastError}`)
  }

  const usage = state.usage
  lines.push(
    `이 세션 사용량: ${usage.calls}회 · 입력 ${usage.input} · 출력 ${usage.output} · 캐시 읽기 ${usage.cacheRead} · 캐시 쓰기 ${usage.cacheWrite}`,
  )
  return lines.join('\n')
}

/**
 * Registers the single `command.run` hook for `/optimize`.
 *
 * Only this event is registered, and only under the `{ command: 'optimize' }`
 * matcher: `command.register` and the other events belong to task L, and a
 * bare second registration of the same event would fail the loader.
 */
export function registerCommands(on: On, deps: CommandDeps): void {
  on('command.run', { command: OPTIMIZE_COMMAND.name }, ($, e) =>
    runCommand(deps, portsOf($), uiPortsOf($), e.args).then(text => ({ text })),
  )
}

/**
 * Keeps `$` at the hook site: builds the {@link EnginePorts} closures the
 * controller and helpers take, so no `$` crosses an import.
 */
function portsOf($: EngineInterface): EnginePorts {
  return {
    session: {
      // The controller only calls `messages()` with no argument; the cast keeps
      // the overloaded call type without reading the method as a value.
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

/**
 * Keeps `$` at the hook site: the UI boundary `chooseUi` receives, so the pane
 * is opened inside the command's own user-gesture dispatch.
 */
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

/** Runs one parsed intent and returns the line(s) the person sees. */
async function runCommand(
  deps: CommandDeps,
  ports: EnginePorts,
  ui: UiPorts,
  args: string,
): Promise<string> {
  const parsed = parseOptimizeArgs(args)
  try {
    return await dispatch(deps, ports, ui, parsed)
  } catch (error) {
    // A failing controller method (or a refused UI choice) becomes one line,
    // never an exception escaping the command hook.
    return `오류: ${describeError(error)}`
  }
}

/** Executes one parsed intent. */
async function dispatch(
  deps: CommandDeps,
  ports: EnginePorts,
  ui: UiPorts,
  command: ParsedCommand,
): Promise<string> {
  switch (command.kind) {
    case 'on':
      return applySetting(deps.settings, 'enabled', true, '자동 가로채기를 켰습니다.', '자동 가로채기를 켜지 못했습니다')
    case 'off':
      return applySetting(deps.settings, 'enabled', false, '자동 가로채기를 껐습니다.', '자동 가로채기를 끄지 못했습니다')
    case 'model':
      return applySetting(
        deps.settings,
        'model',
        command.model,
        `옵티마이저 모델을 "${command.model}"로 설정했습니다.`,
        '모델을 바꾸지 못했습니다',
      )
    case 'status':
      return formatStatus(deps.settings.get(), deps.controller.getState())
    case 'help':
      return HELP_TEXT
    case 'error':
      return `사용법 오류: ${command.message}`

    case 'start': {
      const choice = await deps.chooseUi(ui)
      await deps.controller.startExplicit(ports, command.text, choice)
      return command.text === undefined
        ? '현재 입력창 초안으로 개선을 시작합니다.'
        : '입력한 텍스트로 개선을 시작합니다.'
    }

    case 'accept':
      if (!hasWorkflow(deps)) return NO_WORKFLOW
      await deps.controller.accept(ports)
      return '개선안을 입력창으로 가져왔습니다. 내용을 확인하고 Enter를 누르세요.'
    case 'send':
      if (!hasWorkflow(deps)) return NO_WORKFLOW
      await deps.controller.sendDraft(ports)
      return '개선안을 보냈습니다.'
    case 'raw':
      if (!hasWorkflow(deps)) return NO_WORKFLOW
      await deps.controller.sendOriginal(ports)
      return '원문을 그대로 보냈습니다.'
    case 'cancel':
      if (!hasWorkflow(deps)) return NO_WORKFLOW
      await deps.controller.cancel(ports)
      return '개선 작업을 취소했습니다.'
    case 'retry':
      if (!hasWorkflow(deps)) return NO_WORKFLOW
      await deps.controller.retry(ports, command.instruction)
      return command.instruction === undefined ? '같은 요청으로 다시 다듬습니다.' : '보완 내용으로 다시 다듬습니다.'
  }
}

/** A friendly line when a command needs a run and none is active. */
const NO_WORKFLOW = '진행 중인 개선 작업이 없습니다. `/optimize <텍스트>`로 새로 시작하세요.'

/** Whether an active workflow exists to act on. */
function hasWorkflow(deps: CommandDeps): boolean {
  return deps.controller.getState().workflow !== null
}

/** Applies one settings write and reports success or the returned error. */
async function applySetting(
  settings: SettingsPort,
  key: ConfigKey,
  value: unknown,
  success: string,
  failure: string,
): Promise<string> {
  const result = await settings.set(key, value)
  return result.ok ? success : `${failure}: ${result.error}`
}

/** A thrown value's message, for a one-line error. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
