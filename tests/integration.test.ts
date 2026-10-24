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
  PluginOptions,
  PromptAutocompleteInput,
  PromptAutocompleteResult,
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
import { MAX_REQUEST_CHARS } from '../hooks/contracts'
import { register } from '../hooks/register'

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
const PASTE_PLACEHOLDER = '다음 내용을 고쳐줘\n[Pasted text #1 +3 lines]'
const PASTE_EXPANDED = '다음 내용을 고쳐줘\n<pasted_content>\n첫째 줄: 로그인 오류\n둘째 줄: 재현 절차\n셋째 줄: 기대 동작\n</pasted_content>'

/** The fixed JSON contract the optimizer's one completion returns. */
function answered(
  draft: string,
  message = '다듬었습니다',
  question: string | null = null,
  options: readonly string[] = [],
): ModelCompleteResult {
  return { isAnswered: true, text: JSON.stringify({ draft, message, question, options }), usage: USAGE }
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
  /**
   * When false, `submit` does not first model the person's typing as a
   * `prompt.edit`, so a draft the test filled by a key-less paste stays
   * paste-only (PSTB-2735 §7). Defaults to true.
   */
  typed?: boolean
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
  /** Overrides `prompt.fill`; null restores the normal composer fill. */
  setFill(fn: ((input: PromptFillInput) => { isFilled: boolean; refusal?: 'no_composer' | 'dialog' }) | null): void
  /** The simulated composer's current text. */
  box(): string
  setBox(text: string): void
  /** Starts the session (the plugin wires itself on this). */
  start(): Promise<void>
  /** A composer submission, with the emulated engine starting a turn on a pass. */
  submit(text: string, over?: SubmitOver): Promise<PromptSubmitResult>
  /** Runs `/optimize <args>` and returns the command's line. */
  run(args: string): Promise<string>
  /** A user edit of the composer; returns the box after it. `{ key: false }` models a key-less paste. */
  edit(inputText: string, options?: { key?: false }): Promise<PromptBox>
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
function setup($: Engine, on: On, input: {
  messages?: readonly SessionMessage[]
  projectEvidence?: boolean
  /**
   * When given, every argument the plugin hands `$.session.messages()` is
   * pushed here, so a test can tell the row form from `{ as: 'api' }`.
   */
  messageCalls?: unknown[]
} = {}): World {
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
  /** Whether the test drove the draft's own edit chain for the next submit. */
  let droveDraft = false
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
  on('session.messages', (_$, e) => {
    input.messageCalls?.push(e)
    return { value: [...(input.messages ?? [])] }
  })
  on('session.cwd', () => ({ value: '/repo/sub' }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, name: 'owner/repo' } }))
  on('session.model', () => {
    modelReads += 1
    return modelRefusal === null ? { value: modelRaw } : { deny: modelRefusal }
  })
  on('fs.stat', (_$, e) => ({ value: {
    kind: input.projectEvidence && (e.path === '/repo' || e.path === '/repo/sub') ? 'dir' : 'file',
    size: 90, mtimeMs: 0, isLink: false,
    ...(input.projectEvidence && e.resolve ? { realPath: e.path } : {}),
  } }))
  on('fs.list', (_$, e) => ({ value: input.projectEvidence && e.path === '/repo'
    ? [{ name: 'node-images.ts', kind: 'file', size: 90, mtimeMs: 0, isLink: false }]
    : [] }))
  on('fs.read', (_$, e) => ({ value: input.projectEvidence && e.path === '/repo/node-images.ts'
    ? 'export const imageProperty = "image"; // node image property resolver'
    : '규칙 텍스트' }))
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
    async start() {
      await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })
    },
    async submit(text, over = {}) {
      // The engine reports the person's typing as `prompt.edit` before Enter.
      // Model that here so an ordinary `submit` is a typed prompt (PSTB-2735
      // §7); a test that drove its own edit chain, or passes `typed: false` for
      // a paste, keeps its own facts. The engine clears the box before the
      // submit hook, so the harness's own box is restored afterwards.
      if (
        (over.origin ?? { kind: 'composer' }).kind === 'composer' &&
        over.typed !== false &&
        !droveDraft
      ) {
        const before = boxText
        await ($.prompt as unknown as {
          edit: (e: PromptEditInput) => Promise<PromptBox>
        }).edit({
          origin: { kind: 'composer' },
          key: { key: 'a' },
          text: '',
          cursor: 0,
          start: 0,
          end: 0,
          inputText: text,
        })
        boxText = before
      }
      droveDraft = false
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
    async edit(inputText, options = {}) {
      // A key makes this a person's own edit; `key: false` models a paste (no
      // key) for the paste-only path (PSTB-2735 §7).
      droveDraft = true
      const input: PromptEditInput = {
        origin: { kind: 'composer' },
        ...(options.key === false ? {} : { key: { key: 'a' } }),
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
  test('five rounds require explicit approval before a sixth call and keep an unsent answer', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    const dialogs: Array<{ question: string }[]> = []
    let answerDialog: (result: { result: { questions: unknown[]; answers: Record<string, string> } }) => void = () => undefined
    on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
      dialogs.push(e.questions)
      return new Promise(resolve => { answerDialog = resolve })
    })
    w.setModel((_request, call) => answered(`개선안 ${call}`, '', call === 5 ? '아직 남은 비교 기준은 무엇인가요?' : null))
    await w.start()
    for (let round = 1; round <= 5; round += 1) {
      await w.submit(round === 1 ? ORIGINAL : `보완 ${round}`)
      await w.advance(1)
    }
    await w.waitFor(() => dialogs.length === 1)
    expect(w.completes).toHaveLength(5)
    expect(JSON.stringify(dialogs[0])).toContain('5회를 더 허용')
    expect(await w.run('status')).toContain('5/5회')

    const answer = '직전 변경 이력과 비교'
    w.setBox(answer)
    expect(await w.submit(answer)).toMatchObject({ drop: '개선 횟수 한도에 도달했습니다. 미해결 질문이 남아 있습니다. 5회를 더 허용하려면 패널에서 선택하거나 /optimize more 를 입력하세요.' })
    await w.advance(1)
    expect(w.box()).toBe(answer)
    expect(w.completes).toHaveLength(5)
    expect(await w.run('more')).toContain('열린 선택 창')

    answerDialog({ result: { questions: [], answers: { [dialogs[0]![0]!.question]: '추가 5회 허용' } } })
    await w.waitFor(() => w.logs.some(line => line.includes('한도를 10회로')))
    expect(await w.run('status')).toContain('5/10회')
    expect(w.completes).toHaveLength(5)
    await w.submit(answer)
    await w.advance(1)
    expect(w.box()).toBe('')
    expect(w.completes).toHaveLength(6)
    expect(w.completes[5]?.prompt).toContain('max: 10\nremaining: 4')
    expect(w.completes[5]?.prompt).toContain(answer)
    expect(w.submits).toHaveLength(0)

    expect(await w.run('accept')).toContain('입력창으로 가져왔습니다')
    expect(await w.submit('개선안 6')).toEqual({ text: '개선안 6' })
    await w.submit('다음 요청')
    await w.advance(1)
    expect(await w.run('status')).toContain('1/5회')
  })

  for (const uiMode of ['pane', 'composer'] as const) {
    test(`intercepted composer text is cleared before ${uiMode} accept and the next workflow`, { options: { uiMode } }, async ($, on) => {
      const w = setup($, on)
      await w.start()
      w.setModel((_request, call) => answered(`개선안 ${call}`))

      for (let cycle = 1; cycle <= 2; cycle += 1) {
        const original = `${ORIGINAL} ${cycle}`
        // A dropped submission leaves the submitted text in the real composer.
        // The harness deliberately does not clear it on submit's behalf.
        w.setBox(original)
        expect(await w.submit(original)).toEqual({ drop: DROP_OPTIMIZING })
        expect(w.box()).toBe(original)
        await w.advance(1)

        expect(w.box()).toBe('')
        expect(w.fills.at(-1)?.text).toBe('')
        expect(w.fills.at(-1)?.mode).toBe('replace')
        expect(await w.run('accept')).toContain('입력창으로 가져왔습니다')
        const draft = `개선안 ${cycle}`
        expect(w.box()).toBe(draft)
        expect(await w.submit(draft)).toEqual({ text: draft })
        expect(w.submits).toHaveLength(cycle)
        expect(w.completes).toHaveLength(cycle)
      }

      // The restored text's permit was consumed; repeating it starts a run.
      expect(await w.submit('개선안 2')).toEqual({ drop: DROP_OPTIMIZING })
      expect(w.submits).toHaveLength(2)
    })
  }

  test('composer supplements are consumed before importing the revised draft', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    w.setModel((_request, call) => answered(`개선안 ${call}`))
    w.setBox(ORIGINAL)
    await w.submit(ORIGINAL)
    await w.advance(1)
    expect(w.box()).toBe('')

    const supplement = '더 짧게'
    w.setBox(supplement)
    expect(await w.submit(supplement)).toEqual({ drop: '보완 요청을 옵티마이저에 전달했습니다.' })
    expect(w.box()).toBe(supplement)
    await w.advance(1)
    expect(w.box()).toBe('')
    expect(w.completes).toHaveLength(2)
    expect(w.completes[1]?.prompt).toContain(supplement)

    expect(await w.run('accept')).toContain('입력창으로 가져왔습니다')
    expect(w.box()).toBe('개선안 2')
    expect(w.fills.map(fill => fill.text)).toEqual(['', '', '개선안 2'])
    expect(await w.submit('개선안 2')).toEqual({ text: '개선안 2' })
    expect(w.submits).toHaveLength(1)
  })

  test('prefix submissions clear the submitted text including its prefix and surrounding whitespace', { options: { uiMode: 'composer', triggerMode: 'prefix' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    const submitted = `?? ${ORIGINAL}`
    w.setBox(` \n${submitted}\n `)
    expect(await w.submit(submitted)).toEqual({ drop: DROP_OPTIMIZING })
    await w.advance(1)

    expect(w.box()).toBe('')
    expect(w.completes[0]?.prompt).toContain(ORIGINAL)
    expect(w.completes[0]?.prompt).not.toContain('?? ')
    expect(await w.run('accept')).toContain('입력창으로 가져왔습니다')
    expect(w.box()).toBe(DRAFT)
  })

  for (const handback of ['original', 'prefix', 'reply'] as const) {
    test(`accept replaces a ${handback} handed back after the scheduled clear`, {
      options: { uiMode: 'composer', triggerMode: handback === 'prefix' ? 'prefix' : 'always' },
    }, async ($, on) => {
      const w = setup($, on)
      await w.start()
      let submitted = handback === 'prefix' ? `?? ${ORIGINAL}` : ORIGINAL
      expect(w.box()).toBe('')
      await w.submit(submitted)
      await w.advance(1)
      if (handback === 'reply') {
        submitted = '더 짧게'
        await w.submit(submitted)
        await w.advance(1)
      }
      expect(w.box()).toBe('')
      expect(w.fills).toHaveLength(0)

      // Another submit hook can delay the host's dropped-text handback until
      // after the optimizer's timer has already observed an empty composer.
      w.setBox(submitted)
      expect(await w.run('accept')).toContain('입력창으로 가져왔습니다')
      expect(w.box()).toBe(DRAFT)
      expect(w.fills.map(fill => fill.text)).toEqual([DRAFT])
      expect(await w.submit(DRAFT)).toEqual({ text: DRAFT })
      expect(w.submits).toHaveLength(1)
      expect(w.completes).toHaveLength(handback === 'reply' ? 2 : 1)
    })
  }

  for (const representation of ['placeholder', 'expanded'] as const) {
    for (const timing of ['before', 'after'] as const) {
      test(`a pasted ${representation} handed back ${timing} the clear timer still allows accept`, { options: { uiMode: 'composer' } }, async ($, on) => {
        const w = setup($, on)
        await w.start()
        // The edit event sees the displayed placeholder, while submission
        // expands its pasted content and the host temporarily empties the box.
        await w.edit(PASTE_PLACEHOLDER)
        w.setBox('')
        expect(await w.submit(PASTE_EXPANDED)).toEqual({ drop: DROP_OPTIMIZING })

        const handedBack = representation === 'placeholder' ? PASTE_PLACEHOLDER : PASTE_EXPANDED
        if (timing === 'before') w.setBox(handedBack)
        await w.advance(1)
        expect(w.box()).toBe('')
        expect(w.fills.map(fill => fill.text)).toEqual(timing === 'before' ? [''] : [])
        if (timing === 'after') w.setBox(handedBack)

        expect(w.completes[0]?.prompt).toContain('첫째 줄: 로그인 오류')
        expect(w.completes[0]?.prompt).not.toContain('[Pasted text #1')
        expect(await w.run('accept')).toContain('입력창으로 가져왔습니다')
        expect(w.box()).toBe(DRAFT)
        expect(await w.submit(DRAFT)).toEqual({ text: DRAFT })
        expect(w.submits).toHaveLength(1)
        expect(w.completes).toHaveLength(1)
      })
    }
  }

  for (const timing of ['before', 'after'] as const) {
    test(`autocomplete observes a paste without an edit event for handback ${timing} the clear timer`, { options: { uiMode: 'composer' } }, async ($, on) => {
      const w = setup($, on)
      const suggestions = [{ text: 'lines]', label: '기존 자동완성', description: '다른 훅의 제안' }]
      on('prompt.autocomplete', () => ({ suggestions }))
      await w.start()

      // Large pastes can set the box directly, without a prompt.edit event.
      // Autocomplete observes the displayed placeholder and must preserve
      // the suggestions already supplied by another hook.
      w.setBox(PASTE_PLACEHOLDER)
      const start = PASTE_PLACEHOLDER.lastIndexOf(' ') + 1
      const prompt = $.prompt as unknown as {
        autocomplete(input: PromptAutocompleteInput): Promise<PromptAutocompleteResult>
      }
      expect(await prompt.autocomplete({
        text: PASTE_PLACEHOLDER,
        cursor: PASTE_PLACEHOLDER.length,
        start,
        token: PASTE_PLACEHOLDER.slice(start),
      })).toEqual({ suggestions })

      // A single typed key after the paste keeps the draft optimizable without
      // changing the placeholder snapshot (PSTB-2735: a paste-only draft would
      // otherwise pass straight through).
      await w.edit('')
      w.setBox('')
      expect(await w.submit(PASTE_EXPANDED)).toEqual({ drop: DROP_OPTIMIZING })
      if (timing === 'before') w.setBox(PASTE_PLACEHOLDER)
      await w.advance(1)
      expect(w.box()).toBe('')
      expect(w.fills.map(fill => fill.text)).toEqual(timing === 'before' ? [''] : [])
      if (timing === 'after') w.setBox(PASTE_PLACEHOLDER)

      expect(await w.run('accept')).toContain('입력창으로 가져왔습니다')
      expect(w.box()).toBe(DRAFT)
      expect(await w.submit(DRAFT)).toEqual({ text: DRAFT })
      expect(w.submits).toHaveLength(1)
      expect(w.completes).toHaveLength(1)
    })
  }

  for (const timing of ['before', 'after'] as const) {
    test(`a user edit ${timing} the clear timer revokes ownership of a consumed paste placeholder`, { options: { uiMode: 'composer' } }, async ($, on) => {
      const w = setup($, on)
      await w.start()
      await w.edit(PASTE_PLACEHOLDER)
      w.setBox('')
      await w.submit(PASTE_EXPANDED)

      // Even identical placeholder text belongs to a new draft once a real
      // edit event produced it, rather than the host restoring the submission.
      if (timing === 'before') await w.edit(PASTE_PLACEHOLDER)
      await w.advance(1)
      if (timing === 'after') await w.edit(PASTE_PLACEHOLDER)

      expect(w.box()).toBe(PASTE_PLACEHOLDER)
      expect(w.fills).toHaveLength(0)
      expect(await w.run('accept')).toContain('새로 작성한 내용')
      expect(w.box()).toBe(PASTE_PLACEHOLDER)
      expect(w.fills).toHaveLength(0)
      expect(w.completes).toHaveLength(1)
      expect(w.submits).toHaveLength(0)
    })
  }

  test('a subsequent submission cannot reuse the previous paste edit snapshot', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    await w.edit(PASTE_PLACEHOLDER)
    w.setBox('')
    await w.submit(PASTE_EXPANDED)
    await w.advance(1)
    // No fill or edit occurs between submissions: the first submission itself
    // must consume the snapshot, leaving none for the following supplement.
    expect(w.fills).toHaveLength(0)
    expect(await w.submit('더 짧게')).toEqual({ drop: '보완 요청을 옵티마이저에 전달했습니다.' })
    w.setBox(PASTE_PLACEHOLDER)
    await w.advance(1)

    expect(w.box()).toBe(PASTE_PLACEHOLDER)
    expect(w.fills).toHaveLength(0)
    expect(await w.run('accept')).toContain('새로 작성한 내용')
    expect(w.box()).toBe(PASTE_PLACEHOLDER)
    expect(w.fills).toHaveLength(0)
    expect(w.completes).toHaveLength(2)
    expect(w.submits).toHaveLength(0)
  })

  for (const args of ['', ORIGINAL]) {
    test(`explicit optimize clears only its source from the composer (${args === '' ? 'current draft' : 'argument'})`, { options: { uiMode: 'composer' } }, async ($, on) => {
      const w = setup($, on)
      await w.start()
      w.setBox(ORIGINAL)
      await w.run(args)
      expect(w.box()).toBe(ORIGINAL)
      await w.advance(1)

      expect(w.box()).toBe('')
      expect(w.completes).toHaveLength(1)
      expect(await w.run('accept')).toContain('입력창으로 가져왔습니다')
      expect(w.box()).toBe(DRAFT)
    })
  }

  for (const trigger of ['composer', 'command'] as const) {
    test(`a new composer draft written before the scheduled ${trigger} run is preserved`, { options: { uiMode: 'composer' } }, async ($, on) => {
      const w = setup($, on)
      await w.start()
      w.setBox(ORIGINAL)
      if (trigger === 'composer') await w.submit(ORIGINAL)
      else await w.run('')

      const replacement = '새로 작성 중인 요청'
      w.setBox(replacement)
      await w.advance(1)
      expect(w.box()).toBe(replacement)
      expect(w.fills).toHaveLength(0)
      expect(w.completes).toHaveLength(1)
      expect(await w.run('accept')).toContain('새로 작성한 내용')
      expect(w.box()).toBe(replacement)
      expect(w.fills).toHaveLength(0)
      expect(w.submits).toHaveLength(0)
    })
  }

  test('a busy pane submission stays in the composer', { options: { uiMode: 'pane' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    w.setBox(ORIGINAL)
    await w.submit(ORIGINAL)
    await w.advance(1)
    expect(w.box()).toBe('')

    const unsent = '다른 요청을 작성 중'
    w.setBox(unsent)
    expect(await w.submit(unsent)).toEqual({ drop: '프롬프트 옵티마이저가 작업 중입니다. /optimize cancel 로 취소할 수 있습니다.' })
    await w.advance(1)
    expect(w.box()).toBe(unsent)
    expect(w.fills.map(fill => fill.text)).toEqual([''])
    expect(w.completes).toHaveLength(1)
    expect(w.submits).toHaveLength(0)
  })

  for (const interruption of ['cancel', 'session'] as const) {
    test(`a ${interruption} before the scheduled run prevents clearing the old source`, { options: { uiMode: 'composer' } }, async ($, on) => {
      const w = setup($, on)
      await w.start()
      w.setBox(ORIGINAL)
      await w.submit(ORIGINAL)
      if (interruption === 'cancel') await w.run('cancel')
      else {
        await w.endSession()
        await w.restartSession('sess-2')
      }
      const fillsBeforeAdvance = w.fills.length
      await w.advance(1)

      expect(w.box()).toBe(ORIGINAL)
      expect(w.fills).toHaveLength(fillsBeforeAdvance)
      expect(w.completes).toHaveLength(0)
    })
  }

  for (const failure of ['refused', 'throw'] as const) {
    test(`a ${failure} composer clear leaves the source intact and still allows accept once filling recovers`, { options: { uiMode: 'composer' } }, async ($, on) => {
      const w = setup($, on)
      await w.start()
      w.setBox(ORIGINAL)
      w.setFill(() => {
        if (failure === 'throw') throw new Error('composer fill unavailable')
        return { isFilled: false, refusal: 'dialog' }
      })
      await w.submit(ORIGINAL)
      await w.advance(1)

      expect(w.box()).toBe(ORIGINAL)
      expect(w.fills.map(fill => fill.text)).toEqual([''])
      expect(w.completes).toHaveLength(1)
      expect(w.submits).toHaveLength(0)

      w.setFill(null)
      expect(await w.run('accept')).toContain('입력창으로 가져왔습니다')
      expect(w.box()).toBe(DRAFT)
      expect(w.fills.map(fill => fill.text)).toEqual(['', DRAFT])
      expect(await w.submit(DRAFT)).toEqual({ text: DRAFT })
      expect(w.submits).toHaveLength(1)
      expect(w.completes).toHaveLength(1)
      expect(await w.submit(DRAFT)).toEqual({ drop: DROP_OPTIMIZING })
      expect(w.submits).toHaveLength(1)
    })
  }

  for (const trigger of ['composer', 'command'] as const) {
    test(`repository evidence reaches the optimizer through ${trigger}`, { options: { uiMode: 'composer' } }, async ($, on) => {
      const w = setup($, on, { projectEvidence: true })
      await w.start()
      const original = '노드별 image와 property diff API를 추가해줘'
      if (trigger === 'command') await w.run(original)
      else await w.submit(original)
      await w.advance(1)
      await w.waitFor(() => w.completes.length === 1)

      expect(w.completes[0]?.prompt).toContain('node-images.ts')
      expect(w.completes[0]?.prompt).toContain('imageProperty')
      expect(w.completes[0]?.prompt).toContain('Partial excerpts only')
      expect(w.submits).toHaveLength(0)
      expect(w.forks).toBe(0)
    })
  }

  // PSTB-2735: a draft the person only pasted (or had injected by another app)
  // goes to the main session as-is; one typed character brings it back under
  // the optimizer.
  test('PTB · 붙여넣기만 한 초안은 원문 그대로 메인으로 간다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()

    await w.edit(ORIGINAL, { key: false })
    const passed = await w.submit(ORIGINAL, { typed: false })

    expect(passed).toEqual({ text: ORIGINAL })
    expect(w.submits.map(s => s.text)).toEqual([ORIGINAL])
    expect(w.completes).toHaveLength(0)
  })

  test('PTB · 붙여넣기 뒤 한 글자라도 타이핑하면 다시 다듬는다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()

    await w.edit(ORIGINAL, { key: false })
    await w.edit('!')
    const dropped = await w.submit(w.box(), { typed: false })

    expect(dropped).toEqual({ drop: DROP_OPTIMIZING })
    expect(w.submits).toHaveLength(0)
    await w.advance(1)
    expect(w.completes).toHaveLength(1)
    expect(w.completes[0]?.prompt).toContain(ORIGINAL)
  })

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

  test('pane의 보완 후 1 버튼은 개선안을 입력창에 넣고 Enter 전에는 전송하지 않는다', { options: { uiMode: 'pane' } }, async ($, on) => {
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

    await mounted.press({ key: 'optimizer:accept' })
    await w.settle()

    expect(w.box()).toBe('초안2')
    expect(w.submits).toHaveLength(0)
    expect(await w.submit('초안2')).toEqual({ text: '초안2' })
    expect(w.submits).toHaveLength(1)
    expect(w.submits[0]?.text).toBe('초안2')
  })

  for (const source of [ORIGINAL, PASTE_EXPANDED]) {
    test(`pane cancel restores the saved ${source === ORIGINAL ? 'original' : 'pasted original'} after clearing and refinement`, { options: { uiMode: 'pane' } }, async ($, on) => {
      const w = setup($, on)
      await w.start()
      await w.edit(source === ORIGINAL ? source : PASTE_PLACEHOLDER)
      await w.submit(source)
      await w.advance(1)
      expect(w.box()).toBe('')

      const mounted = await mountPane($)
      await mounted.input({ key: 'optimizer:instruction', text: '더 짧게' })
      expect(w.completes).toHaveLength(2)
      // The kit exposes no host ui.close event; Esc's controller mapping is
      // covered in ui.test.tsx and the actual terminal smoke.
      await w.run('cancel')
      await w.settle()

      expect(w.box()).toBe(source)
      expect(w.fills.map(fill => fill.text)).toEqual(['', source])
      expect(w.submits).toHaveLength(0)
      expect(await w.run('status')).toContain('진행 중인 개선 작업: 없음')
      expect(await w.submit(source)).toEqual({ text: source })
      expect(w.submits).toHaveLength(1)
      expect(w.completes).toHaveLength(2)
    })
  }

  test('pane cancel restores a cleared original while generation is pending and ignores its late reply', { options: { uiMode: 'pane' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    let release: (result: ModelCompleteResult) => void = () => undefined
    w.setModel(() => new Promise(resolve => { release = resolve }))
    w.setBox(ORIGINAL)
    await w.submit(ORIGINAL)
    const advancing = w.advance(1)
    await w.settle()
    await w.waitFor(() => w.completes.length === 1)
    expect(w.box()).toBe('')

    await w.run('cancel')
    expect(w.box()).toBe(ORIGINAL)
    release(answered('취소 후 늦은 개선안'))
    await advancing
    await w.settle()

    expect(w.box()).toBe(ORIGINAL)
    expect(w.fills.map(fill => fill.text)).toEqual(['', ORIGINAL])
    expect(w.submits).toHaveLength(0)
    expect(await w.run('status')).toContain('진행 중인 개선 작업: 없음')
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
      if (index > 0) {
        // A failed round restores the original with a bypass permit. A fresh
        // session clears it, so each failure is measured on its own rather than
        // the permit following the next typed prompt.
        await w.endSession()
        await w.start()
      }
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

  // Invariant 9: explicit send commands still submit once when called twice.
  test('INV9 · send 명령 연타는 submit 1회다', { options: { uiMode: 'pane' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    await w.submit(ORIGINAL)
    await w.advance(1)

    await Promise.all([w.run('send'), w.run('send')])
    await w.advance(1)
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

  // Invariant 10c: with the mode off, a `>>` submission is ordinary text and
  // is optimized like any other prompt (the submit-time prefix strip is gone).
  test('INV10 · 모드가 꺼진 ">>" 제출은 일반 텍스트로 개선된다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()

    // A prefix typed as ordinary text would arm the optimizer-off marker mid-
    // typing; this test is about a submission that arrives with the mode off,
    // so mark the draft typed without typing the marker itself.
    await w.edit('x')
    w.setBox('')
    const dropped = await w.submit('>> hello world')
    expect(dropped).toEqual({ drop: DROP_OPTIMIZING })
    expect(w.submits).toHaveLength(0)

    await w.advance(1)
    expect(w.completes).toHaveLength(1)
    expect(w.completes[0]?.prompt).toContain('>> hello world')
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
  // system prompt holds the JSON contract, and the whole stays within its budget.
  test('INV16 · 첫 요청에 원문·context가 실리고 system이 JSON 계약과 요청 상한을 지킨다', { options: { uiMode: 'composer' } }, async ($, on) => {
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
    expect((request?.prompt.length ?? 0) + (request?.system?.length ?? 0)).toBeLessThanOrEqual(MAX_REQUEST_CHARS)
    expect(request?.model).toBe('sonnet')
  })

  // The optimizer never asks for the API-form transcript, so the hook context
  // the engine injects (which only lives in that form) cannot reach it: the
  // request carries no long-term memory section.
  test('MEM · 옵티마이저는 api 형태 대화(주입 훅 문맥)를 읽지 않는다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const messageCalls: unknown[] = []
    const w = setup($, on, {
      messageCalls,
      messages: [
        {
          role: 'user',
          text: '<system-reminder>\nSessionStart hook additional context: MEM-SS-1\n</system-reminder>',
          toolUses: [],
        },
      ],
    })
    await w.start()
    await w.submit(ORIGINAL)
    await w.advance(1)

    const apiCalls = messageCalls.filter(call => (call as { as?: string } | undefined)?.as === 'api')
    expect(messageCalls.length).toBeGreaterThan(0)
    expect(apiCalls).toHaveLength(0)
    const first = w.completes[0]?.prompt ?? ''
    expect(first).not.toContain('## Long-term memory')
  })

  // The plugin must not register any classic event: a managed environment
  // skips its classic hooks and shows the load-time note this change removes.
  test('REG · 플러그인은 classic.* 이벤트를 등록하지 않는다', () => {
    const patterns: string[] = []
    const recordingOn = ((pattern: string) => {
      patterns.push(pattern)
      return { pattern }
    }) as unknown as On

    register(recordingOn, {} as PluginOptions)

    expect(patterns).toContain('prompt.submit')
    expect(patterns.some(pattern => pattern.startsWith('classic.'))).toBe(false)
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
const COMMON_TAG = '[요구사항 구체화 지침]'

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
    expect(request?.model).toBe('sonnet')
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
    expect(request?.model).toBe('sonnet')
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
    expect(w.completes[0]?.model).toBe('sonnet')
    expect(w.completes[0]?.effort).toBe('low')

    w.setModelValue(SONNET_55)
    const retried = await w.run('retry')
    expect(retried).toContain('다시 다듬')
    expect(w.completes).toHaveLength(2)
    expect(w.completes[1]?.system ?? '').toContain(`${BLOCK_TAG} sonnet-5-5]`)
    expect(w.completes[1]?.system ?? '').not.toContain(`${BLOCK_TAG} opus-5-5]`)
    expect(w.completes[1]?.model).toBe('sonnet')
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
      expect(request.model).toBe('sonnet')
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
    expect(request?.model).toBe('sonnet')
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
    expect(w.completes[0]?.model).toBe('sonnet')
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
    expect(w.completes[0]?.model).toBe('sonnet')
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
    expect(w.completes[1]?.model).toBe('sonnet')
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
    expect(w.completes[1]?.model).toBe('sonnet')
    expect(w.completes[1]?.effort).toBe('low')
  })
})

/**
 * Task 31-7 — the combined review lifecycle (#31) through the loaded plugin.
 *
 * One mocked run walks the whole review story `docs/DESIGN.md` documents for
 * #31: an original prompt, a numbered composer answer to the model's
 * clarifying question (captured as a user decision with its exact
 * question/options source), a success, an explicit targeted correction, a
 * failed generation, a successful retry that applies the correction, an undo
 * to the preceding success, another refinement on the restored state, accept,
 * and the person's own Enter as the only delivery. The variants cover a
 * session reset with a late reply and the delivery-conflict protection around
 * an undone draft. Everything is asserted through the real event paths: where
 * each request's evidence came from, the call/round/usage counters, and that
 * nothing reaches the main session before the person's Enter.
 */

describe('integration — combined review lifecycle (#31)', () => {
  const QUESTION = '어디에서 로그인 오류가 발생하나요?'
  const OPTIONS = ['웹 브라우저', '모바일 앱']
  const CORRECTED = '로컬 스크립트로만 재현을 검증한다'
  const SUPPLEMENT = '더 짧게 줄여줘'

  test('RV1 · 원문→1번 답변→정정→실패→재시도→undo→보완→accept→Enter 전주기', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)

    // The model's one clarifying question opens the host selection dialog; the
    // person answers "1번" in the composer instead, so the dialog is held open
    // until it has gone stale and is released below.
    const dialogs: Array<{ question: string }[]> = []
    let answerDialog: (result: { result: { questions: unknown[]; answers: Record<string, string> } }) => void = () => undefined
    on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
      dialogs.push(e.questions)
      return new Promise(resolve => { answerDialog = resolve })
    })

    w.setModel((_request, call) => {
      if (call === 1) return answered(`개선안${call}`, '첫 개선', QUESTION, OPTIONS)
      if (call === 3) return apiError()
      return answered(`개선안${call}`, `${call}번째 변경`)
    })
    await w.start()

    // Original → question. The first success records revision r1 (개선안1).
    w.setBox(ORIGINAL)
    expect(await w.submit(ORIGINAL)).toEqual({ drop: DROP_OPTIMIZING })
    await w.advance(1)
    await w.waitFor(() => dialogs.length === 1)
    expect(w.completes).toHaveLength(1)
    expect(dialogs[0]?.[0]?.question).toBe(QUESTION)

    // Numbered answer → success. The composer answer is captured as decision
    // d1 with its exact provenance, the request carries that source, and the
    // second success records r2 (개선안2).
    w.setBox('1번')
    expect(await w.submit('1번')).toEqual({ drop: '보완 요청을 옵티마이저에 전달했습니다.' })
    await w.advance(1)
    expect(w.completes).toHaveLength(2)
    expect(w.completes[0]?.prompt).not.toContain('<user_decisions>')
    expect(w.completes[1]?.prompt).toContain('<user_decisions>')
    expect(w.completes[1]?.prompt).toContain('"id":"d1"')
    expect(w.completes[1]?.prompt).toContain('"selectedOption":{"index":1,"text":"웹 브라우저"}')
    expect(w.completes[1]?.prompt).toContain(QUESTION)
    const sources = await w.run('sources')
    expect(sources).toContain('답변: 1번')
    expect(sources).toContain('미확정 제안')

    // The held dialog is stale now (the round moved on): releasing it must not
    // refine again or block the state-only commands below.
    answerDialog({ result: { questions: [], answers: { [QUESTION]: OPTIONS[0] ?? '' } } })
    await w.settle()

    // Targeted correction: state only, no call, no revision.
    expect(await w.run(`correct d1 ${CORRECTED}`)).toContain('결정을 정정했습니다')
    expect(w.completes).toHaveLength(2)

    // Failed generation: it spends a round and usage, keeps the correction
    // pending, and records no revision (show still serves 개선안2).
    expect(await w.run('retry')).toContain('다시 다듬')
    expect(w.completes).toHaveLength(3)
    let status = await w.run('status')
    expect(status).toContain('단계 failed · 3/5회')
    expect(status).toContain('마지막 오류')
    expect(await w.run('show')).toContain('현재 개선안:\n개선안2')

    // Successful retry: the correction reaches the request as the active
    // decision d2 (superseding d1), the numbered answer leaves it, and the
    // success clears the failure and records r3 (개선안4).
    expect(await w.run('retry')).toContain('다시 다듬')
    expect(w.completes).toHaveLength(4)
    expect(w.completes[3]?.prompt).toContain(CORRECTED)
    expect(w.completes[3]?.prompt).toContain('"id":"d2"')
    expect(w.completes[3]?.prompt).toContain('"supersedes":"d1"')
    expect(w.completes[3]?.prompt).not.toContain('1번')
    status = await w.run('status')
    expect(status).toContain('단계 reviewing · 4/5회')
    expect(status).not.toContain('마지막 오류')

    // Undo: state-only restore of r2. Counters stay, the composer is untouched,
    // and the corrected decision is gone from the ledger with the draft back.
    expect(await w.run('undo')).toBe('이전 성공 라운드로 되돌렸습니다. 사용량과 라운드 한도는 유지됩니다.')
    expect(await w.run('show')).toContain('현재 개선안:\n개선안2')
    const decisions = await w.run('decisions')
    expect(decisions).toContain('답변: 1번')
    expect(decisions).toContain('선택: 1) 웹 브라우저')
    expect(decisions).not.toContain(CORRECTED)
    status = await w.run('status')
    expect(status).toContain('단계 reviewing · 4/5회')
    expect(status).toContain('이 세션 사용량: 4회 · 입력 40 · 출력 20 · 캐시 읽기 4 · 캐시 쓰기 8')
    expect(w.fills).toHaveLength(2)
    expect(await w.run('diff previous')).toContain('+개선안2')
    expect(await w.run('diff original')).toContain('-로그인 오류를 고쳐줘')
    expect(await w.run('show previous')).toContain('직전 성공 라운드 개선안:\n개선안1')

    // Another refinement runs on the restored revision: the next request
    // carries the restored ledger (d1 plus the new answer minted as d3 — the
    // burned d2 id is never recycled) and none of the undone correction.
    w.setBox(SUPPLEMENT)
    expect(await w.submit(SUPPLEMENT)).toEqual({ drop: '보완 요청을 옵티마이저에 전달했습니다.' })
    await w.advance(1)
    expect(w.completes).toHaveLength(5)
    expect(w.completes[4]?.prompt).toContain('1번')
    expect(w.completes[4]?.prompt).toContain(SUPPLEMENT)
    expect(w.completes[4]?.prompt).toContain('"id":"d3"')
    expect(w.completes[4]?.prompt).not.toContain('"supersedes"')
    expect(w.completes[4]?.prompt).not.toContain(CORRECTED)

    // Every request repeated the same snapshot baseline — the context and
    // original collected once — and counted its own round.
    for (const [index, request] of w.completes.entries()) {
      expect(request?.prompt).toContain('<original_prompt>')
      expect(request?.prompt).toContain(ORIGINAL)
      expect(request?.prompt).toContain('규칙 텍스트')
      expect(request?.prompt).toContain(`current: ${index + 1}\nmax: 5\nremaining: ${4 - index}`)
    }

    // Counters: five calls, five rounds, usage summed; nothing has reached the
    // main session yet.
    status = await w.run('status')
    expect(status).toContain('단계 reviewing · 5/5회')
    expect(status).toContain('이 세션 사용량: 5회 · 입력 50 · 출력 25 · 캐시 읽기 5 · 캐시 쓰기 10')
    expect(w.submits).toHaveLength(0)
    expect(w.turns).toBe(0)

    // Accept fills the exact current draft; the person's Enter is the only
    // delivery, exactly once, with no re-interception.
    expect(await w.run('accept')).toContain('입력창으로 가져왔습니다')
    expect(w.box()).toBe('개선안5')
    expect(w.fills.map(fill => fill.text)).toEqual(['', '', '', '개선안5'])
    expect(await w.submit('개선안5')).toEqual({ text: '개선안5' })
    expect(w.submits.map(submission => submission.text)).toEqual(['개선안5'])
    expect(w.completes).toHaveLength(5)
    expect(w.turns).toBe(1)
    expect(await w.run('status')).toContain('진행 중인 개선 작업: 없음')
    expect(await w.run('status')).toContain('이 세션 사용량: 5회')
  })

  test('RV2 · 세션 초기화 뒤 늦은 성공 응답은 새 세션을 바꾸지 않는다', { options: { uiMode: 'composer' } }, async ($, on) => {
    const w = setup($, on)
    await w.start()
    let release: (result: ModelCompleteResult) => void = () => undefined
    w.setModel((_request, call) => call === 1
      ? answered(`개선안${call}`)
      : new Promise<ModelCompleteResult>(resolve => { release = resolve }))

    w.setBox(ORIGINAL)
    await w.submit(ORIGINAL)
    await w.advance(1)
    expect(w.completes).toHaveLength(1)

    w.setBox('더 짧게')
    expect(await w.submit('더 짧게')).toEqual({ drop: '보완 요청을 옵티마이저에 전달했습니다.' })
    // A detached advance: the round reaches the model, whose promise stays
    // pending until `release` below.
    const advancing = w.advance(1)
    await w.settle()
    await w.waitFor(() => w.completes.length === 2)

    // The session ends while the completion is still in flight.
    await w.endSession()
    await w.restartSession('sess-2')
    expect(await w.run('status')).toContain('진행 중인 개선 작업: 없음')
    expect(await w.run('status')).toContain('이 세션 사용량: 0회')

    // The late reply belongs to the ended session: no workflow, no usage, no
    // composer write. NOTE: the AbortSignal the plugin handed to the
    // completion never reaches a test hook, so the abort itself is not
    // observable here; the ignored effect below is.
    release(answered('늦은 개선안'))
    await advancing
    await w.settle()
    expect(await w.run('status')).toContain('진행 중인 개선 작업: 없음')
    expect(await w.run('status')).toContain('이 세션 사용량: 0회')
    expect(w.fills).toHaveLength(2)
    expect(w.submits).toHaveLength(0)

    // The new session starts a fresh run with fresh counters and none of the
    // old dialogue.
    w.setModel((_request, call) => answered(`새 세션 초안${call}`))
    w.setBox(ORIGINAL)
    await w.submit(ORIGINAL)
    await w.advance(1)
    expect(w.completes).toHaveLength(3)
    expect(w.completes[2]?.prompt).toContain('current: 1\nmax: 5')
    expect(w.completes[2]?.prompt).not.toContain('더 짧게')
    expect(await w.run('status')).toContain('단계 reviewing · 1/5회')
    expect(await w.run('status')).toContain('이 세션 사용량: 1회 · 입력 10 · 출력 5 · 캐시 읽기 1 · 캐시 쓰기 2')
  })

  test('RV3 · undo 뒤 accept는 입력창에 새로 쓴 내용을 덮어쓰지 않는다', { options: { uiMode: 'composer' } }, async ($, on) => {
    // #28's typed-during-delivery guard lives on a separate, not-yet-merged
    // branch. This variant asserts only the guarantees present here — accept's
    // existing draft-conflict protection and undo's state-only (never touches
    // the composer) rule — and imports nothing from #28.
    const w = setup($, on)
    await w.start()
    w.setModel((_request, call) => answered(`개선안${call}`))

    w.setBox(ORIGINAL)
    await w.submit(ORIGINAL)
    await w.advance(1)
    w.setBox('더 짧게')
    await w.submit('더 짧게')
    await w.advance(1)
    expect(w.completes).toHaveLength(2)
    const fillsBeforeUndo = w.fills.length

    expect(await w.run('undo')).toBe('이전 성공 라운드로 되돌렸습니다. 사용량과 라운드 한도는 유지됩니다.')
    expect(await w.run('show')).toContain('현재 개선안:\n개선안1')
    expect(w.fills).toHaveLength(fillsBeforeUndo)

    // A draft typed after the undo owns the box: accept refuses and keeps it.
    await w.edit('내가 방금 쓴 요청')
    expect(w.box()).toBe('내가 방금 쓴 요청')
    expect(await w.run('accept')).toContain('새로 작성한 내용이 있어 덮어쓰지 않았습니다')
    expect(w.box()).toBe('내가 방금 쓴 요청')
    expect(w.fills).toHaveLength(fillsBeforeUndo)
    expect(w.submits).toHaveLength(0)

    // Once the box is free, accept restores the undone draft and the person's
    // Enter delivers it once.
    w.setBox('')
    expect(await w.run('accept')).toContain('입력창으로 가져왔습니다')
    expect(w.box()).toBe('개선안1')
    expect(await w.submit('개선안1')).toEqual({ text: '개선안1' })
    expect(w.submits.map(submission => submission.text)).toEqual(['개선안1'])
    expect(w.completes).toHaveLength(2)
    expect(w.turns).toBe(1)
  })
})
