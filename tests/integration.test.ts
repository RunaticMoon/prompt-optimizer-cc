/**
 * Task M — independent integration regression tests.
 *
 * These tests drive the LOADED plugin (`hooks/register.ts`) through the kit's
 * real event paths, the way `register.test.ts` does: the test's own `on(...)`
 * hooks sit BENEATH the loaded plugin's hooks, so the bottom stub an assertion
 * reads is the main session's ingress. Reaching it proves a prompt entered the
 * session (and a turn began); a `{ drop }` answer never reaches it.
 *
 * The invariants come from `docs/DESIGN.md` 5 (통합 후 검증 기준). Each test
 * names the invariant it covers. Where the kit cannot observe something (the
 * `AbortSignal` handed to `$.model.complete` never reaches a hook), the test
 * says so instead of pretending otherwise.
 */

import type {
  ModelCompleteRequest,
  ModelCompleteResult,
  ModelUsage,
  On,
  PromptBox,
  PromptEditInput,
  PromptFillInput,
  PromptSubmitInput,
  PromptSubmitResult,
  RenderInput,
  SessionMessage,
} from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

/** The plugin's own name, as `plugin.json` declares it. */
const PLUGIN = 'prompt-optimizer'

/** The pane id the UI opens the dialogue under (`PANE_ID` in the controller). */
const PANE_ID = PLUGIN

const USAGE: ModelUsage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 1,
  cache_creation_input_tokens: 2,
}

const ZERO: ModelUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

const ORIGINAL = '로그인 오류를 고쳐줘'
const DRAFT = '개선된 요청'

/** The fixed JSON contract the optimizer's one completion returns. */
function answered(draft: string, message = '다듬었습니다', question: string | null = null): ModelCompleteResult {
  return { isAnswered: true, text: JSON.stringify({ draft, message, question }), usage: USAGE }
}

/** The `api-error` arm, carrying a status and an error kind. */
function apiError(): ModelCompleteResult {
  return { isAnswered: false, reason: 'api-error', status: 500, error: 'server_error', usage: USAGE }
}

/** The `aborted` arm (a timeout or a cancel at the engine). */
function aborted(): ModelCompleteResult {
  return { isAnswered: false, reason: 'aborted', usage: ZERO }
}

/** The `command.run` envelope the `/optimize` runs carry. */
const RUN = {
  command: 'optimize',
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: false, columns: 80 },
}

/** The Pane instance the pane-mode test mounts and presses. */
const PANE: RenderInput<'Pane', 'terminal'> = {
  component: 'Pane',
  surface: 'terminal',
  requestId: PANE_ID,
  viewport: { columns: 110, rows: 40 },
  props: {
    title: '프롬프트 옵티마이저',
    isFocused: true,
    bodyColumns: 72,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
}

/** One optimizer completion's outcome, or a pending promise the test releases. */
type ModelBehavior = (
  request: ModelCompleteRequest,
  call: number,
) => ModelCompleteResult | Promise<ModelCompleteResult>

/** Fields a caller may override on a `prompt.submit`. */
interface SubmitOver {
  origin?: PromptSubmitInput['origin']
  turnId?: string
  wait?: boolean
  attachments?: PromptSubmitInput['attachments']
}

/** The harness a single test builds: observers, controls and actions. */
interface World {
  clock: MockClock
  /** Bottom `prompt.submit` calls: the main session's ingress, one per prompt that entered. */
  submits: PromptSubmitInput[]
  /** Every `prompt.fill` the plugin made (landed or refused). */
  fills: PromptFillInput[]
  /** Every `model.complete` request, in order. */
  completes: ModelCompleteRequest[]
  /** Main turns the emulated engine started (only after a prompt entered). */
  turns: number
  /** `model.fork` attempts; must stay 0. */
  forks: number
  /** Bottom `prompt.context`/`prompt.section` involvement; must stay 0. */
  contextHooks: number
  sectionHooks: number
  /** Panes the plugin opened/closed, by id. */
  opens: string[]
  closes: string[]
  /** Transcript lines the plugin logged. */
  logs: string[]
  /** How many times the plugin called `$.session.model()`. */
  readonly modelReads: number
  /** Sets the value the bottom `session.model` hook answers with. */
  setModelValue(value: string): void
  /** Makes `$.session.model()` refuse, so detection falls back to common. */
  setModelDeny(reason?: string): void
  /** Replaces the completion behavior. */
  setModel(behavior: ModelBehavior): void
  /** Makes the next `prompt.fill` refuse. */
  setFill(fn: (input: PromptFillInput) => { isFilled: boolean; refusal?: 'no_composer' | 'dialog' }): void
  /** The simulated composer's current text. */
  box(): string
  setBox(text: string): void
  /** The additionalContext the bottom `classic.SessionStart` hook returns. */
  setSessionStartContext(entries: readonly string[] | undefined): void
  /** The additionalContext the bottom `classic.UserPromptSubmit` hook returns. */
  setPromptSubmitContext(entries: readonly string[] | undefined): void
  /** Starts the session (the plugin wires itself on this). */
  start(): Promise<void>
  /** A composer submission, with the emulated engine starting a turn on a pass. */
  submit(text: string, over?: SubmitOver): Promise<PromptSubmitResult>
  /** Runs `/optimize <args>` and returns the command's line. */
  run(args: string): Promise<string>
  /** A user edit of the composer; returns the box after it. */
  edit(inputText: string): Promise<PromptBox>
  /** Advances the mock clock (running any scheduled round). */
  advance(ms?: number): Promise<void>
  /** Lets in-flight work progress without moving the clock. */
  settle(): Promise<void>
  /** Spins microtasks until `predicate` holds; for a detached round. */
  waitFor(predicate: () => boolean, spins?: number): Promise<void>
  endSession(): Promise<void>
  restartSession(id: string): Promise<void>
  /** The harness session's id, i.e. what `$.session.id()` answers. */
  sessionId(): string
}

/**
 * Builds the world above the loaded plugin. Every bottom hook is registered
 * before the first `$` call, as the kit requires; the plugin's own hooks then
 * sit above them.
 */
function setup($: Engine, on: On, input: { messages?: readonly SessionMessage[] } = {}): World {
  const clock = mock.clock(on)

  const submits: PromptSubmitInput[] = []
  const fills: PromptFillInput[] = []
  const completes: ModelCompleteRequest[] = []
  const opens: string[] = []
  const closes: string[] = []
  const logs: string[] = []
  let turns = 0
  let forks = 0
  let contextHooks = 0
  let sectionHooks = 0
  let sessionId = 'sess-1'
  let boxText = ''
  let ssContext: readonly string[] | undefined
  let upsContext: readonly string[] | undefined
  let behavior: ModelBehavior = () => answered(DRAFT)
  let fillFn: ((input: PromptFillInput) => { isFilled: boolean; refusal?: 'no_composer' | 'dialog' }) | null = null
  // The main session's model as the bottom `session.model` hook answers it. The
  // default `''` normalizes to the `common` profile, so the fixtures that never
  // set a model read exactly as the built-in plugin did before model guidance.
  let modelRaw = ''
  let modelReads = 0
  let modelRefusal: string | null = null

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: sessionId }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.messages', () => ({ value: [...(input.messages ?? [])] }))
  on('session.cwd', () => ({ value: '/repo/sub' }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, name: 'owner/repo' } }))
  on('session.model', () => {
    modelReads += 1
    return modelRefusal === null ? { value: modelRaw } : { deny: modelRefusal }
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: 9, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: '규칙 텍스트' }))
  on('env.get', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('config.set', (_$, e) => ({ value: e.value }))

  on('ui.open', (_$, e) => {
    opens.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    closes.push(e.id)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))

  on('model.complete', async (_$, e) => {
    completes.push(e)
    return { value: await behavior(e, completes.length) }
  })
  on('model.fork', () => {
    forks += 1
    return { deny: 'fork is never used' }
  })
  on('turn.start', (_$, e) => {
    turns += 1
    return { turnId: e.turnId }
  })
  on('prompt.context', () => {
    contextHooks += 1
    return { blocks: [] }
  })
  on('prompt.section', () => {
    sectionHooks += 1
    return { text: null }
  })

  on('prompt.read', () => ({ value: { text: boxText, cursor: boxText.length } }))
  on('prompt.fill', (_$, e) => {
    fills.push(e)
    if (fillFn !== null) return fillFn(e)
    boxText = e.text
    return { isFilled: true }
  })
  on('prompt.edit', (_$, e) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    boxText = text
    return { text, cursor: e.start + e.inputText.length }
  })
  on('prompt.submit', (_$, e) => {
    submits.push(e)
    return { text: e.text }
  })

  // The bottom classic hooks: the loaded plugin's `classic.*` hooks sit above
  // them and observe their `additionalContext` through `next(e)`.
  on('classic.SessionStart', () => ({
    additionalContext: ssContext === undefined ? undefined : [...ssContext],
  }))
  on('classic.UserPromptSubmit', () => ({
    additionalContext: upsContext === undefined ? undefined : [...upsContext],
  }))

  const turnStart = async (): Promise<void> => {
    await $.turn.start({ text: '', turnId: `turn-${turns + 1}` })
  }

  return {
    clock,
    submits,
    fills,
    completes,
    get turns() {
      return turns
    },
    get forks() {
      return forks
    },
    get contextHooks() {
      return contextHooks
    },
    get sectionHooks() {
      return sectionHooks
    },
    opens,
    closes,
    logs,
    get modelReads() {
      return modelReads
    },
    setModelValue(value) {
      modelRaw = value
      modelRefusal = null
    },
    setModelDeny(reason = 'model getter unavailable') {
      modelRefusal = reason
    },
    setModel(next) {
      behavior = next
    },
    setFill(fn) {
      fillFn = fn
    },
    box: () => boxText,
    setBox: text => {
      boxText = text
    },
    setSessionStartContext(entries) {
      ssContext = entries === undefined ? undefined : [...entries]
    },
    setPromptSubmitContext(entries) {
      upsContext = entries === undefined ? undefined : [...entries]
    },
    async start() {
      await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })
    },
    async submit(text, over = {}) {
      const result = await $.prompt.submit({
        text,
        origin: over.origin ?? { kind: 'composer' },
        wait: over.wait ?? false,
        ...(over.turnId !== undefined ? { turnId: over.turnId } : {}),
        ...(over.attachments !== undefined ? { attachments: over.attachments } : {}),
      })
      // A pass reaches the bottom hook and, in the engine, starts a main turn.
      if (!('drop' in result)) await turnStart()
      return result
    },
    async run(args) {
      const result = await $.command.run({ ...RUN, args })
      return result.text ?? ''
    },
    async edit(inputText) {
      const input: PromptEditInput = {
        origin: { kind: 'composer' },
        text: boxText,
        cursor: boxText.length,
        start: boxText.length,
        end: boxText.length,
        inputText,
      }
      return ($.prompt as unknown as { edit: (e: PromptEditInput) => Promise<PromptBox> }).edit(input)
    },
    advance: (ms = 1) => clock.advance(ms),
    settle: () => clock.settle(),
    async waitFor(predicate, spins = 2000) {
      for (let i = 0; i < spins; i += 1) {
        if (predicate()) return
        await Promise.resolve()
      }
      throw new Error('waitFor: condition never held')
    },
    async endSession() {
      await $.session.end({ reason: 'clear', sessionId, resume: { id: sessionId } })
    },
    async restartSession(id) {
      sessionId = id
      await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })
    },
    sessionId: () => sessionId,
  }
}

const DROP_OPTIMIZING = '프롬프트를 다듬는 중입니다.'

/** Mounts the plugin's real Pane, so a test can press its buttons. */
function mountPane($: Engine) {
  return $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    props: PANE.props,
    requestId: PANE_ID,
    viewport: PANE.viewport,
  })
}

/**
 * Invariant 5 through the command path: `/optimize send` and `/optimize raw`
 * deliver, once each.
 *
 * The plugin defers the controller call through a `$.clock.after(0)` callback,
 * so the submission happens after `command.run` returns (the host refuses a
 * submit made from inside the hook); the test advances the mock clock to run it.
 */
async function assertInv5CommandDelivery($: Engine, on: On): Promise<void> {
  const w = setup($, on)
  await w.start()
  w.setModel((_request, call) => answered(`초안${call}`))

  await w.submit('원문A')
  await w.advance(1)
  await w.submit('더 짧게')
  await w.advance(1)

  expect(await w.run('send')).toBe('개선안 전송을 예약했습니다.')
  // Nothing delivered yet: the command has only queued the deferred send.
  expect(w.submits).toHaveLength(0)
  await w.advance(0)
  expect(w.submits).toHaveLength(1)
  expect(w.submits[0]?.text).toBe('초안2')
  expect(w.submits[0]?.origin).toEqual({ kind: 'plugin', name: PLUGIN, asUser: true })

  w.setBox('')
  await w.submit('원문B')
  await w.advance(1)
  expect(await w.run('raw')).toBe('원문 전송을 예약했습니다.')
  expect(w.submits).toHaveLength(1)
  await w.advance(0)
  expect(w.submits).toHaveLength(2)
  expect(w.submits[1]?.text).toBe('원문B')
  expect(w.submits[1]?.origin).toEqual({ kind: 'plugin', name: PLUGIN, asUser: true })
}

describe('integration — session isolation and delivery accuracy', () => {
  // Invariant 1: a plain composer submission is dropped; nothing reaches main.
  test('INV1 · 일반 composer 제출은 drop되고 하위 submit·turn·completion이 없다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()

    const dropped = await w.submit(ORIGINAL)

    expect(dropped).toEqual({ drop: DROP_OPTIMIZING })
    expect(w.submits).toHaveLength(0)
    expect(w.turns).toBe(0)
    expect(w.completes).toHaveLength(0)
    expect(w.forks).toBe(0)
  })

  // Invariant 2: two supplements in composer mode stay in the optimizer.
  test('INV2 · 보완 대화 2회가 model.complete 3회를 쓰고 하위 submit은 0회다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()

    await w.submit(ORIGINAL)
    await w.advance(1)

    const first = await w.submit('더 짧게')
    expect(first).toEqual({ drop: '보완 요청을 옵티마이저에 전달했습니다.' })
    await w.advance(1)

    const second = await w.submit('한국어를 유지해')
    expect(second).toEqual({ drop: '보완 요청을 옵티마이저에 전달했습니다.' })
    await w.advance(1)

    expect(w.completes).toHaveLength(3)
    expect(w.submits).toHaveLength(0)
    expect(w.turns).toBe(0)
    expect(w.forks).toBe(0)
  })

  // Invariant 3: accept fills the exact draft; the same text Enter passes once.
  test('INV3 · accept가 정확한 개선안을 1회 채우고 같은 텍스트 Enter가 1회 통과한다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    await w.submit(ORIGINAL)
    await w.advance(1)

    const accepted = await w.run('accept')
    expect(accepted).toContain('입력창으로 가져왔습니다')
    expect(w.fills).toHaveLength(1)
    expect(w.fills[0]?.text).toBe(DRAFT)
    expect(w.box()).toBe(DRAFT)

    const passed = await w.submit(DRAFT)
    expect(passed).toEqual({ text: DRAFT })
    expect(w.submits).toHaveLength(1)
    expect(w.submits[0]?.text).toBe(DRAFT)
    // No re-interception and no second completion.
    expect(w.completes).toHaveLength(1)
  })

  // Invariant 4: after restore, a user edit sends the edited text once.
  test('INV4 · 복원 후 prompt.edit 편집본이 재가로채기 없이 1회 전송된다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    await w.submit(ORIGINAL)
    await w.advance(1)
    await w.run('accept')

    const edited = `${DRAFT} 다시 확인`
    const after = await w.edit(' 다시 확인')
    expect(after.text).toBe(edited)
    expect(w.box()).toBe(edited)

    const passed = await w.submit(edited)
    expect(passed).toEqual({ text: edited })
    expect(w.submits).toHaveLength(1)
    expect(w.submits[0]?.text).toBe(edited)
    expect(w.completes).toHaveLength(1)
  })

  // Invariant 5, command path: `/optimize send` and `/optimize raw` deliver
  // once, from the deferred callback (after the command hook released its turn).
  test('INV5(command) · /optimize send·raw가 command 반환 뒤 1회 전달한다', { options: { uiMode: 'composer' } }, async ($, on) => {
    await assertInv5CommandDelivery($, on)
  })

  // Invariant 5, working path: the pane's send button submits once (the host
  // check applies only to command hooks, not to ui.press).
  test('INV5(UI) · pane의 send 버튼은 개선안을 1회 전송한다', { options: { uiMode: 'pane' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    w.setModel((_request, call) => answered(`초안${call}`))
    await w.submit(ORIGINAL)
    await w.advance(1)

    const mounted = await mountPane($)
    // The pane's own Input refines (a composer submission in pane mode is busy).
    await mounted.input({ key: 'optimizer:instruction', text: '더 짧게' })
    await w.settle()
    expect(w.completes).toHaveLength(2)

    await mounted.press({ key: 'optimizer:send' })
    await w.settle()

    expect(w.submits).toHaveLength(1)
    expect(w.submits[0]?.text).toBe('초안2')
  })

  // Invariant 5, working path: the pane's raw button sends the stored original.
  test('INV5(UI) · pane의 raw 버튼은 원문을 1회 전송하고 개선안을 섞지 않는다', { options: { uiMode: 'pane' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    await w.submit(ORIGINAL)
    await w.advance(1)

    const mounted = await mountPane($)
    await mounted.press({ key: 'optimizer:raw' })
    await w.settle()

    expect(w.submits).toHaveLength(1)
    expect(w.submits[0]?.text).toBe(ORIGINAL)
    expect(w.submits[0]?.text).not.toBe(DRAFT)
  })

  // Invariants 6 + 8: cancel restores the original, never auto-sends, and a
  // late completion changes nothing.
  test('INV6/INV8 · cancel은 자동 전송 없이 원문을 복원하고 늦은 응답을 무시한다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()

    let release: ((result: ModelCompleteResult) => void) | undefined
    w.setModel(() => new Promise<ModelCompleteResult>(resolve => {
      release = resolve
    }))

    await w.submit(ORIGINAL)
    // A detached advance: `settle` lets the scheduled round reach the model,
    // whose promise stays pending until `release` below.
    const advancing = w.advance(1)
    await w.settle()
    await w.waitFor(() => w.completes.length === 1)

    const cancelled = await w.run('cancel')
    expect(cancelled).toContain('취소')
    expect(w.fills).toHaveLength(1)
    expect(w.fills[0]?.text).toBe(ORIGINAL)
    expect(w.submits).toHaveLength(0)

    release?.(answered('늦은 응답'))
    await advancing
    await w.settle()

    // The late answer neither repaints nor sends.
    expect(w.submits).toHaveLength(0)
    expect(w.fills).toHaveLength(1)
    expect(w.box()).toBe(ORIGINAL)
    // NOTE: the AbortSignal the plugin passes to $.model.complete never reaches
    // a test hook, so "the completion was aborted" is not directly observable
    // here; the effect above is. See the task report.
  })

  // Invariant 7: every failure arm restores the original, with no retry.
  test('INV7 · api-error·aborted·throw가 재시도 없이 원문을 복원한다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()

    const behaviors: ModelBehavior[] = [
      () => apiError(),
      () => aborted(),
      () => {
        throw new Error('optimizer call rejected')
      },
    ]

    for (const [index, behavior] of behaviors.entries()) {
      w.setBox('')
      w.setModel(behavior)
      await w.submit(`요청${index}`)
      await w.advance(1)
    }

    expect(w.fills.map(fill => fill.text)).toEqual(['요청0', '요청1', '요청2'])
    expect(w.completes).toHaveLength(3)
    expect(w.submits).toHaveLength(0)
    expect(w.forks).toBe(0)
  })

  // Invariant 9: a double accept fills once.
  test('INV9 · accept 연타는 fill 1회다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    await w.submit(ORIGINAL)
    await w.advance(1)

    await Promise.all([w.run('accept'), w.run('accept')])
    expect(w.fills).toHaveLength(1)
  })

  // Invariant 9: a double send submits once (through the pane button, since the
  // command path is the product bug above).
  test('INV9 · pane send 연타는 submit 1회다', { options: { uiMode: 'pane' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    await w.submit(ORIGINAL)
    await w.advance(1)

    const mounted = await mountPane($)
    await Promise.all([
      mounted.press({ key: 'optimizer:send' }),
      mounted.press({ key: 'optimizer:send' }),
    ])
    await w.settle()

    expect(w.submits).toHaveLength(1)
  })

  // Invariant 10a: prefix mode only improves the prefixed submission.
  test('INV10 · prefix 모드는 접두어가 붙은 제출만 개선한다', { options: { uiMode: 'composer', triggerMode: 'prefix' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()

    const plain = await w.submit('접두어 없는 요청')
    expect(plain).toEqual({ text: '접두어 없는 요청' })
    expect(w.submits).toHaveLength(1)
    expect(w.completes).toHaveLength(0)

    const triggered = await w.submit('?? 로그인 오류')
    expect(triggered).toEqual({ drop: DROP_OPTIMIZING })
    await w.advance(1)
    expect(w.completes).toHaveLength(1)
    expect(w.completes[0]?.prompt).toContain('로그인 오류')
    expect(w.completes[0]?.prompt).not.toContain('?? ')
  })

  // Invariant 10b: `off` passes everything through.
  test('INV10 · off는 자동 가로채기를 멈춘다', { options: { uiMode: 'composer', enabled: false } }, async ($, on) => {
    const w = setup($, on)
    await w.start()

    const passed = await w.submit('그대로 보내기')
    expect(passed).toEqual({ text: '그대로 보내기' })
    expect(w.submits).toHaveLength(1)
    expect(w.completes).toHaveLength(0)
  })

  // Invariant 10c: `>>` strips itself and passes the rest untouched.
  test('INV10 · >>는 접두어를 떼고 나머지를 그대로 보낸다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()

    const passed = await w.submit('>> hello world')
    expect(passed).toEqual({ text: 'hello world' })
    expect(w.submits).toHaveLength(1)
    expect(w.submits[0]?.text).toBe('hello world')
    expect(w.completes).toHaveLength(0)
  })

  // Invariant 11: other origins, mid-turn, queued and attachments all pass.
  test('INV11 · SDK·plugin·peer·mid-turn·queue·첨부는 그대로 통과한다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()

    const cases: Array<[string, SubmitOver]> = [
      ['sdk prompt', { origin: { kind: 'sdk' } }],
      ['plugin prompt', { origin: { kind: 'plugin', name: 'other-plugin' } }],
      ['peer prompt', { origin: { kind: 'peer' } }],
      ['mid-turn prompt', { turnId: 'turn-running' }],
      ['queued prompt', { wait: true }],
      ['attached prompt', { attachments: [{ type: 'image', mediaType: 'image/png' }] }],
    ]

    for (const [text, over] of cases) {
      const passed = await w.submit(text, over)
      expect(passed).toEqual({ text })
    }

    expect(w.submits).toHaveLength(cases.length)
    expect(w.completes).toHaveLength(0)
    expect(w.fills).toHaveLength(0)
  })

  // Invariant 12: a fresh draft in the box is never overwritten.
  test('INV12 · 입력창에 새 초안이 있으면 accept가 덮어쓰지 않는다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    await w.run('명시적 요청')
    await w.advance(1)

    w.setBox('내가 새로 쓴 내용')
    await w.run('accept')

    expect(w.fills).toHaveLength(0)
    expect(w.box()).toBe('내가 새로 쓴 내용')
    expect(w.submits).toHaveLength(0)

    // No bypass was issued, so submitting the optimizer's draft is an answer.
    const outcome = await w.submit(DRAFT)
    expect('drop' in outcome).toBe(true)
    expect(w.submits).toHaveLength(0)
  })

  // Invariant 13: a refused fill issues no bypass.
  test('INV13 · fill이 dialog로 거부되면 bypass를 발급하지 않는다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    await w.submit(ORIGINAL)
    await w.advance(1)

    w.setFill(() => ({ isFilled: false, refusal: 'dialog' }))
    await w.run('accept')
    expect(w.fills).toHaveLength(1)
    expect(w.box()).toBe('')

    const outcome = await w.submit(DRAFT)
    expect('drop' in outcome).toBe(true)
    expect(w.submits).toHaveLength(0)
  })

  // Invariant 14: a new session does not honour the previous session's bypass.
  test('INV14 · session.end 후 새 세션에서 이전 bypass가 통과하지 않는다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    await w.submit(ORIGINAL)
    await w.advance(1)
    await w.run('accept')
    expect(w.fills).toHaveLength(1)

    await w.endSession()
    await w.restartSession('sess-2')

    const outcome = await w.submit(DRAFT)
    expect(outcome).toEqual({ drop: DROP_OPTIMIZING })
    await w.advance(1)
    expect(w.completes).toHaveLength(2)
    expect(w.submits).toHaveLength(0)
  })

  // Invariant 15: no fork, no context/section hooks, the configured model.
  test('INV15 · fork 0회·prompt.context/section 미개입·요청 모델은 설정값', { options: { uiMode: 'composer', model: 'sonnet' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()

    await w.submit(ORIGINAL)
    await w.advance(1)
    await w.submit('더 짧게')
    await w.advance(1)
    await w.run('accept')

    expect(w.forks).toBe(0)
    expect(w.contextHooks).toBe(0)
    expect(w.sectionHooks).toBe(0)
    expect(w.completes.length).toBeGreaterThan(0)
    expect(w.completes.every(request => request.model === 'sonnet')).toBe(true)
  })

  // Invariant 16: the first request carries the original and context, the
  // system prompt holds the JSON contract, and the whole stays within 16000.
  test('INV16 · 첫 요청에 원문·context가 실리고 system이 JSON 계약을 지키며 16000 이하다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on, {
      messages: [
        { role: 'user', text: '이전에 물어본 내용', toolUses: [] },
        { role: 'assistant', text: '이전 답변입니다', toolUses: [] },
      ],
    })
    await w.start()
    await w.submit(ORIGINAL)
    await w.advance(1)

    const request = w.completes[0]
    expect(request).toBeDefined()
    expect(request?.prompt).toContain('<context>')
    expect(request?.prompt).toContain('<original_prompt>')
    expect(request?.prompt).toContain(ORIGINAL)
    expect(request?.system ?? '').toContain('"draft"')
    expect(request?.system ?? '').toContain('JSON')
    expect((request?.prompt.length ?? 0) + (request?.system?.length ?? 0)).toBeLessThanOrEqual(16000)
    expect(request?.model).toBe('haiku')
  })

  // Long-term memory capture: the plugin's `classic.SessionStart` and
  // `classic.UserPromptSubmit` hooks copy other plugins' `additionalContext`
  // into the snapshot, and a fresh SessionStart clears the previous-prompt ones.
  //
  // The classic envelope's `session_id` is given explicitly and made to match
  // `$.session.id()` (`w.sessionId()`, the value the harness's `session.id` hook
  // answers). The kit stamps a classic call with the test session's own UUID
  // otherwise, which no `session.id` hook can name; in the real engine both
  // name the same session (the transcript file's name), which is the memory
  // store's key.
  test('MEM · classic 메모리 포착이 옵티마이저 스냅샷에 실린다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()

    // 1. A SessionStart context lands in the first request's snapshot.
    w.setSessionStartContext(['MEM-SS-1'])
    await $.classic.SessionStart({ source: 'startup', session_id: w.sessionId() })
    await w.submit(ORIGINAL)
    await w.advance(1)
    const first = w.completes[0]?.prompt ?? ''
    expect(first).toContain('## Long-term memory')
    expect(first).toContain('### Injected at session start')
    expect(first).toContain('MEM-SS-1')

    // 2. A later UserPromptSubmit context joins the next run's snapshot, beside
    //    the session-start one.
    await w.run('cancel')
    w.setPromptSubmitContext(['MEM-UPS-1'])
    await $.classic.UserPromptSubmit({ prompt: '이전 프롬프트', session_id: w.sessionId() })
    await w.run('두번째 원문')
    await w.advance(1)
    const second = w.completes[1]?.prompt ?? ''
    expect(second).toContain('MEM-SS-1')
    expect(second).toContain('### Injected for the previous prompt')
    expect(second).toContain('MEM-UPS-1')

    // 3. A fresh SessionStart clears the previous-prompt entries.
    await w.run('cancel')
    w.setSessionStartContext(['MEM-SS-2'])
    await $.classic.SessionStart({ source: 'clear', session_id: w.sessionId() })
    await w.run('세번째 원문')
    await w.advance(1)
    const third = w.completes[2]?.prompt ?? ''
    expect(third).toContain('MEM-SS-2')
    expect(third).not.toContain('MEM-UPS-1')
    expect(third).not.toContain('### Injected for the previous prompt')
  })

  // L-2 regression: the memory store is session-scoped. Memory captured for
  // session A must not leak into a new session (different id) that never sees
  // its own classic SessionStart.
  test('MEM · 새 세션은 classic SessionStart 없이 이전 세션 기억을 물려받지 않는다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()

    w.setSessionStartContext(['MEM-SS-A'])
    await $.classic.SessionStart({ source: 'startup', session_id: w.sessionId() })
    await w.submit(ORIGINAL)
    await w.advance(1)
    expect(w.completes[0]?.prompt ?? '').toContain('MEM-SS-A')

    // End session A and start session B without any classic SessionStart.
    await w.run('cancel')
    await w.endSession()
    await w.restartSession('sess-2')

    await w.submit('새 세션 원문')
    await w.advance(1)
    const next = w.completes[1]?.prompt ?? ''
    expect(next).not.toContain('MEM-SS-A')
    expect(next).not.toContain('## Long-term memory')
  })

  // L-2 follow-up: an ending session must not wipe a next session's memory that
  // a classic SessionStart already captured before the end arrived (e.g. a
  // `/clear` whose new session's SessionStart lands first). `resetSession`
  // clears only the ending session's id.
  test('MEM · 새 세션 SessionStart가 이전 세션 end보다 먼저 와도 새 세션 기억을 지우지 않는다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()

    // Session A captures memory and shows it.
    w.setSessionStartContext(['MEM-A'])
    await $.classic.SessionStart({ source: 'startup', session_id: w.sessionId() })
    await w.submit(ORIGINAL)
    await w.advance(1)
    expect(w.completes[0]?.prompt ?? '').toContain('MEM-A')

    // Session B's SessionStart arrives before A's end (the reverse of the
    // usual order), keyed by B's id.
    w.setSessionStartContext(['MEM-B'])
    await $.classic.SessionStart({ source: 'clear', session_id: 'sess-2' })

    // Now A's session.end fires; the harness still names A.
    await w.endSession()

    // B continues under its own classic id without a `session.start`; the
    // snapshot reads the last captured classic session, so its memory is there.
    await w.submit('B 세션 원문')
    await w.advance(1)
    const br = w.completes[1]?.prompt ?? ''
    expect(br).toContain('MEM-B')
    expect(br).not.toContain('MEM-A')
  })

  // High-1: `/clear` ends A and the process goes on under B's classic id with
  // no `session.start` for it. The snapshot must follow the classic hook's id,
  // so B's SessionStart memory is used and A's is gone.
  test('MEM · /clear(session.start 없음) 후 새 classic SessionStart 기억이 다음 개선 요청에 포함된다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()

    // A captures its session-start memory and shows it.
    w.setSessionStartContext(['MEM-A'])
    await $.classic.SessionStart({ source: 'startup', session_id: w.sessionId() })
    await w.submit(ORIGINAL)
    await w.advance(1)
    expect(w.completes[0]?.prompt ?? '').toContain('MEM-A')

    // `/clear`: the engine ends A (reason `clear`, naming A), then B's classic
    // SessionStart arrives with a new id. No `session.start` fires for B.
    await w.endSession()
    w.setSessionStartContext(['MEM-B'])
    await $.classic.SessionStart({ source: 'clear', session_id: 'sess-2' })

    // Without restartSession, the next request still sees B's memory only.
    await w.submit('B 세션 원문')
    await w.advance(1)
    const br = w.completes[1]?.prompt ?? ''
    expect(br).toContain('MEM-B')
    expect(br).not.toContain('MEM-A')

    // The differing classic id is diagnosed exactly once, not per hook.
    const diagnoses = w.logs.filter(text => text.includes('classic hook session_id differs'))
    expect(diagnoses).toHaveLength(1)
  })

  // Medium-2: the classic hook's id and the `session.start` id need not agree
  // (e.g. a resume/clear the plugin saw no `session.start` for). Memory still
  // follows the classic hook, and the mismatch is diagnosed once per id.
  test('MEM · classic id가 session.start id와 달라도 기억이 보인다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()

    w.setSessionStartContext(['MEM-DIFF'])
    await $.classic.SessionStart({ source: 'resume', session_id: 'sess-other' })
    // A second classic hook for the same id must not repeat the diagnostic.
    await $.classic.SessionStart({ source: 'resume', session_id: 'sess-other' })

    await w.submit(ORIGINAL)
    await w.advance(1)
    expect(w.completes[0]?.prompt ?? '').toContain('MEM-DIFF')

    const diagnoses = w.logs.filter(text => text.includes('classic hook session_id differs'))
    expect(diagnoses).toHaveLength(1)
  })

  // Follow-up: an invalid classic `session_id` cannot key the store, so the
  // capture is skipped (the stored session's memory stays) and the diagnostic
  // lands exactly once. An empty id is passed verbatim; if the harness replaced
  // it with the test session id, this test would fail at the first assertion.
  test('MEM · classic id가 비면 기억을 기록하지 않고 진단만 1회 남긴다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()

    // A valid capture first, so "skipped" is observable as "unchanged".
    w.setSessionStartContext(['MEM-KEEP'])
    await $.classic.SessionStart({ source: 'startup', session_id: w.sessionId() })
    await w.submit(ORIGINAL)
    await w.advance(1)
    expect(w.completes[0]?.prompt ?? '').toContain('MEM-KEEP')

    // Empty id twice: no adopt, no replacement, one diagnostic.
    w.setSessionStartContext(['MEM-EMPTY'])
    await $.classic.SessionStart({ source: 'startup', session_id: '' })
    await $.classic.SessionStart({ source: 'startup', session_id: '' })

    const noId = w.logs.filter(text => text.includes('carried no session_id'))
    expect(noId).toHaveLength(1)

    await w.run('cancel')
    await w.run('다음 원문')
    await w.advance(1)
    const next = w.completes[1]?.prompt ?? ''
    expect(next).toContain('MEM-KEEP')
    expect(next).not.toContain('MEM-EMPTY')
  })

  // Subagent guard: a classic hook raised inside a subagent carries `agent_id`,
  // and its settings hooks must not touch the main session's memory.
  test('MEM · 서브에이전트(agent_id) classic 훅은 기억을 바꾸지 않는다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()

    // The main thread captures its own memory first.
    w.setSessionStartContext(['MEM-MAIN'])
    await $.classic.SessionStart({ source: 'startup', session_id: w.sessionId() })
    w.setPromptSubmitContext(['MEM-MAIN-UPS'])
    await $.classic.UserPromptSubmit({ prompt: '메인', session_id: w.sessionId() })

    // The same id from a subagent carries new context: both hooks are ignored.
    w.setSessionStartContext(['MEM-SUB'])
    await $.classic.SessionStart({ source: 'startup', session_id: w.sessionId(), agent_id: 'sub-1' })
    w.setPromptSubmitContext(['MEM-SUB-UPS'])
    await $.classic.UserPromptSubmit({ prompt: '서브', session_id: w.sessionId(), agent_id: 'sub-1' })

    await w.submit(ORIGINAL)
    await w.advance(1)
    const prompt = w.completes[0]?.prompt ?? ''
    expect(prompt).toContain('MEM-MAIN')
    expect(prompt).toContain('MEM-MAIN-UPS')
    expect(prompt).not.toContain('MEM-SUB')
    expect(prompt).not.toContain('MEM-SUB-UPS')
  })

  // A UserPromptSubmit for a different session id must not adopt or replace the
  // stored session's memory; session changes come from SessionStart alone.
  test('MEM · 다른 session_id의 UserPromptSubmit이 현재 세션 기억을 덮지 않는다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()

    w.setSessionStartContext(['MEM-CUR'])
    await $.classic.SessionStart({ source: 'startup', session_id: w.sessionId() })

    w.setPromptSubmitContext(['MEM-OTHER'])
    await $.classic.UserPromptSubmit({ prompt: '다른 세션', session_id: 'sess-other' })

    await w.submit(ORIGINAL)
    await w.advance(1)
    const prompt = w.completes[0]?.prompt ?? ''
    expect(prompt).toContain('MEM-CUR')
    expect(prompt).not.toContain('MEM-OTHER')

    const diagnoses = w.logs.filter(text => text.includes('classic hook session_id differs'))
    expect(diagnoses).toHaveLength(1)
  })

  // Diagnostic split: the empty-id report has its own state, so toggling between
  // an empty id and a mismatched (non-empty) id cannot make it repeat.
  test('MEM · 빈 id와 불일치 id를 번갈아 보내도 각 진단은 1회만 남는다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()

    await $.classic.SessionStart({ source: 'startup', session_id: '' })
    await $.classic.SessionStart({ source: 'startup', session_id: 'sess-other' })
    await $.classic.SessionStart({ source: 'startup', session_id: '' })
    await $.classic.SessionStart({ source: 'startup', session_id: 'sess-other' })

    const noId = w.logs.filter(text => text.includes('carried no session_id'))
    const differs = w.logs.filter(text => text.includes('classic hook session_id differs'))
    expect(noId).toHaveLength(1)
    expect(differs).toHaveLength(1)
  })

  // A `session.start` that yielded no id cannot compare, so the follow-the-
  // classic-hook fallback is reported once for observability.
  test('MEM · session.start id가 없으면 classic id 대체 사실을 1회 진단한다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    await w.restartSession('')

    await $.classic.SessionStart({ source: 'startup', session_id: 'sess-other' })
    await $.classic.SessionStart({ source: 'startup', session_id: 'sess-other' })

    const missing = w.logs.filter(text => text.includes('session.start yielded no session id'))
    expect(missing).toHaveLength(1)
  })

  // The pane UI path: mount the real Pane and press its accept button.
  test('UI · pane 모드에서 ui.mount/press accept가 1회 채우고 우회한다', { options: { uiMode: 'pane' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    await w.submit(ORIGINAL)
    await w.advance(1)
    expect(w.opens).toContain(PANE_ID)

    const mounted = await mountPane($)
    await mounted.press({ key: 'optimizer:accept' })

    expect(w.fills).toHaveLength(1)
    expect(w.fills[0]?.text).toBe(DRAFT)

    const passed = await w.submit(DRAFT)
    expect(passed).toEqual({ text: DRAFT })
    expect(w.submits).toHaveLength(1)
  })
})

/**
 * Task M — model-aware guidance through the three real entry paths.
 *
 * Every fixture below drives the LOADED plugin, so the `session.model` value
 * set with `w.setModelValue(...)` is read through the very closure `portsOf`
 * builds at the submission hook, the command hook and the pane UI hook. Each
 * assertion checks what the one `model.complete` request carried: the
 * `[대상 모델 편집 지침: <profile>]` block for the main session's model, while
 * the optimizer's own `model` and `effort` stay untouched.
 */

/** The opening of the model-specific system-prompt block `composeSystemPrompt` writes. */
const BLOCK_TAG = '[대상 모델 편집 지침:'

/** The shared editing guidance that is present even when no model block is added. */
const COMMON_TAG = '[요청 편집 지침]'

/** The fixed role/JSON contract, always the last section. */
const CONTRACT_TAG = '[고정 계약]'

/** The canonical main-session ids C measured (probe-model REPORT, 2.1.286). */
const OPUS_1M = 'claude-opus-5-5[1m]'
const SONNET_55 = 'claude-sonnet-5-5'
const FABLE_51 = 'claude-fable-5-1'
const HAIKU = 'claude-haiku-4-5-20251001'

/** A `config.set` input for one `/config` row, as the test `$` stamps it. */
function configChange(key: string, value: string | boolean) {
  return {
    key,
    value,
    previous: value,
    provider: { plugin: PLUGIN, tier: 'user' as const },
    origin: { kind: 'plugin' as const, name: 'integration-test' },
  }
}

describe('integration — model-aware guidance at the three entry points', () => {
  // Entry 1: prompt.submit reserves a round; the scheduled round reads the main
  // session's model (C's `claude-opus-5-5[1m]`) and applies its block, while the
  // optimizer's own model and effort are unchanged.
  test('MG1 · prompt.submit 예약 라운드가 opus-5-5[1m]을 읽어 블록을 넣는다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    w.setModelValue(OPUS_1M)

    const dropped = await w.submit(ORIGINAL)
    expect(dropped).toEqual({ drop: DROP_OPTIMIZING })
    await w.advance(1)

    expect(w.completes).toHaveLength(1)
    const request = w.completes[0]
    expect(request?.system ?? '').toContain(`${BLOCK_TAG} opus-5-5]`)
    expect(request?.system ?? '').not.toContain('sonnet-5-5')
    expect(request?.system ?? '').toContain(COMMON_TAG)
    expect(request?.system ?? '').toContain(CONTRACT_TAG)
    expect(request?.model).toBe('haiku')
    expect(request?.effort).toBe('low')
    expect(w.modelReads).toBe(1)
  })

  // Entry 1, second round: the model is read afresh on every round, so a
  // changed main model lands on the supplement/reply round too.
  test('MG2 · 보완 라운드가 모델을 다시 읽어 새 프로필로 바뀐다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    w.setModelValue(OPUS_1M)
    await w.submit(ORIGINAL)
    await w.advance(1)
    expect(w.completes[0]?.system ?? '').toContain(`${BLOCK_TAG} opus-5-5]`)

    w.setModelValue(SONNET_55)
    const supplement = await w.submit('더 짧게')
    expect(supplement).toEqual({ drop: '보완 요청을 옵티마이저에 전달했습니다.' })
    await w.advance(1)

    expect(w.completes).toHaveLength(2)
    const request = w.completes[1]
    expect(request?.system ?? '').toContain(`${BLOCK_TAG} sonnet-5-5]`)
    expect(request?.system ?? '').not.toContain(`${BLOCK_TAG} opus-5-5]`)
    expect(request?.model).toBe('haiku')
    expect(request?.effort).toBe('low')
    expect(w.modelReads).toBe(2)
  })

  // Entry 2: `/optimize <text>` starts a run, `/optimize retry` re-reads the
  // model and uses the new profile.
  test('MG3 · /optimize 시작·retry 경로가 모델 전환을 반영한다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    w.setModelValue(OPUS_1M)

    await w.run('명시적 요청')
    await w.advance(1)
    expect(w.completes).toHaveLength(1)
    expect(w.completes[0]?.system ?? '').toContain(`${BLOCK_TAG} opus-5-5]`)
    expect(w.completes[0]?.model).toBe('haiku')
    expect(w.completes[0]?.effort).toBe('low')

    w.setModelValue(SONNET_55)
    const retried = await w.run('retry')
    expect(retried).toContain('다시 다듬')
    expect(w.completes).toHaveLength(2)
    expect(w.completes[1]?.system ?? '').toContain(`${BLOCK_TAG} sonnet-5-5]`)
    expect(w.completes[1]?.system ?? '').not.toContain(`${BLOCK_TAG} opus-5-5]`)
    expect(w.completes[1]?.model).toBe('haiku')
    expect(w.completes[1]?.effort).toBe('low')
    expect(w.modelReads).toBe(2)
  })

  // Entry 3: repeated pane Input refinements go through `ui/register.tsx`'s
  // own `portsOf`, and each round re-reads the model.
  test('MG4 · pane 보완 입력이 매 라운드 모델 전환을 반영한다', { options: { uiMode: 'pane' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    w.setModelValue(OPUS_1M)
    await w.submit(ORIGINAL)
    await w.advance(1)
    expect(w.completes).toHaveLength(1)
    expect(w.completes[0]?.system ?? '').toContain(`${BLOCK_TAG} opus-5-5]`)

    const mounted = await mountPane($)
    w.setModelValue(SONNET_55)
    await mounted.input({ key: 'optimizer:instruction', text: '더 짧게' })
    expect(w.completes).toHaveLength(2)
    expect(w.completes[1]?.system ?? '').toContain(`${BLOCK_TAG} sonnet-5-5]`)
    expect(w.completes[1]?.system ?? '').not.toContain(`${BLOCK_TAG} opus-5-5]`)

    w.setModelValue(FABLE_51)
    await mounted.input({ key: 'optimizer:instruction', text: '더 명확하게' })
    expect(w.completes).toHaveLength(3)
    expect(w.completes[2]?.system ?? '').toContain(`${BLOCK_TAG} fable-5-1]`)
    expect(w.completes[2]?.system ?? '').not.toContain(`${BLOCK_TAG} sonnet-5-5]`)

    for (const request of w.completes) {
      expect(request.model).toBe('haiku')
      expect(request.effort).toBe('low')
    }
    expect(w.modelReads).toBe(3)
  })

  // A listed-but-common model: Haiku 4.5 gets no model block, only the common
  // guidance and the fixed contract.
  test('MG5 · haiku는 common이라 모델 블록 없이 공통·고정 계약만 남는다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    w.setModelValue(HAIKU)

    await w.submit(ORIGINAL)
    await w.advance(1)

    expect(w.completes).toHaveLength(1)
    const request = w.completes[0]
    expect(request?.system ?? '').not.toContain(BLOCK_TAG)
    expect(request?.system ?? '').toContain(COMMON_TAG)
    expect(request?.system ?? '').toContain(CONTRACT_TAG)
    expect(request?.model).toBe('haiku')
    expect(request?.effort).toBe('low')
    expect(w.modelReads).toBe(1)
  })

  // A refused getter degrades to common without failing the round: the
  // completion still happens exactly once.
  test('MG6 · getter 거부는 common으로 폴백하고 completion은 1회 수행한다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    w.setModelDeny()

    await w.submit(ORIGINAL)
    await w.advance(1)

    expect(w.completes).toHaveLength(1)
    expect(w.completes[0]?.system ?? '').not.toContain(BLOCK_TAG)
    expect(w.completes[0]?.model).toBe('haiku')
    expect(w.completes[0]?.effort).toBe('low')
    expect(w.modelReads).toBe(1)
  })

  // `modelGuidance: false` from the start: the getter is never called and no
  // model block appears.
  test('MG7 · modelGuidance=false는 getter를 부르지 않고 블록도 없다', { options: { uiMode: 'composer', modelGuidance: false } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    w.setModelValue(OPUS_1M)

    await w.submit(ORIGINAL)
    await w.advance(1)

    expect(w.completes).toHaveLength(1)
    expect(w.completes[0]?.system ?? '').not.toContain(BLOCK_TAG)
    expect(w.completes[0]?.model).toBe('haiku')
    expect(w.completes[0]?.effort).toBe('low')
    expect(w.modelReads).toBe(0)
  })

  // Toggling off at runtime through `config.set`: the first round reads the
  // model, the next round after the toggle does not.
  test('MG8 · config.set로 modelGuidance를 끄면 다음 라운드부터 getter를 부르지 않는다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    w.setModelValue(OPUS_1M)
    await w.submit(ORIGINAL)
    await w.advance(1)
    expect(w.completes[0]?.system ?? '').toContain(`${BLOCK_TAG} opus-5-5]`)
    expect(w.modelReads).toBe(1)

    const set = await $.config.set(configChange(`${PLUGIN}.modelGuidance`, false))
    expect(set).toEqual({ value: false })

    const supplement = await w.submit('더 짧게')
    expect(supplement).toEqual({ drop: '보완 요청을 옵티마이저에 전달했습니다.' })
    await w.advance(1)

    expect(w.completes).toHaveLength(2)
    expect(w.completes[1]?.system ?? '').not.toContain(BLOCK_TAG)
    expect(w.completes[1]?.model).toBe('haiku')
    expect(w.completes[1]?.effort).toBe('low')
    expect(w.modelReads).toBe(1)
  })

  // The optimizer's own model is independent of the main session's model: a
  // configured `sonnet` stays on the request while the guidance follows opus.
  test('MG9 · 메인 모델과 별개로 요청 model·effort는 옵티마이저 설정값이다', { options: { uiMode: 'composer', model: 'sonnet' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    w.setModelValue(OPUS_1M)

    await w.submit(ORIGINAL)
    await w.advance(1)

    expect(w.completes).toHaveLength(1)
    expect(w.completes[0]?.model).toBe('sonnet')
    expect(w.completes[0]?.effort).toBe('low')
    expect(w.completes[0]?.system ?? '').toContain(`${BLOCK_TAG} opus-5-5]`)
  })

  // A session reset clears the last applied snapshot; the next session reads
  // its own model and applies the matching block.
  test('MG10 · session reset 후 새 세션이 자기 모델을 다시 읽는다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    w.setModelValue(OPUS_1M)
    await w.submit(ORIGINAL)
    await w.advance(1)
    expect(w.completes).toHaveLength(1)
    expect(w.completes[0]?.system ?? '').toContain(`${BLOCK_TAG} opus-5-5]`)

    await w.endSession()
    await w.restartSession('sess-2')
    w.setModelValue(SONNET_55)
    await w.submit(ORIGINAL)
    await w.advance(1)

    expect(w.completes).toHaveLength(2)
    expect(w.completes[1]?.system ?? '').toContain(`${BLOCK_TAG} sonnet-5-5]`)
    expect(w.completes[1]?.system ?? '').not.toContain(`${BLOCK_TAG} opus-5-5]`)
    expect(w.completes[1]?.model).toBe('haiku')
    expect(w.completes[1]?.effort).toBe('low')
  })
})
