import type {
  ModelCompleteRequest,
  ModelUsage,
  PromptFillInput,
  PromptSubmitInput,
} from 'claude-code'
import { describe, expect, mock, test, type Plugin } from 'claude-code/testing'

const USAGE: ModelUsage = {
  input_tokens: 12,
  output_tokens: 6,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

const DRAFT = '개선된 요청'

/** The fixed JSON contract the optimizer's one completion returns. */
function answered(draft: string): { isAnswered: true; text: string; usage: ModelUsage } {
  return {
    isAnswered: true,
    text: JSON.stringify({ draft, message: '다듬었습니다', question: null }),
    usage: USAGE,
  }
}

const COMMAND_RUN = {
  command: 'optimize',
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: false, columns: 80 },
}

const SESSION_START = {
  cwd: '/tmp/prompt-optimizer-register',
  surface: 'terminal' as const,
  isInteractive: true,
}

/** The `command.run` envelope a foreign plugin's fill trigger carries. */
const FOREIGN_RUN = {
  command: 'foreign-fill',
  args: '',
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: false, columns: 80 },
}

/** A `config.set` input: the test `$` wants the pinned fields the real menu fills. */
function configChange(key: string, value: string) {
  return {
    key,
    value,
    previous: value,
    provider: { plugin: 'prompt-optimizer', tier: 'user' as const },
    origin: { kind: 'plugin' as const, name: 'register-test' },
  }
}

const FOREIGN_FILL_TEXT = '외부 플러그인 텍스트'

/**
 * A second plugin whose command makes a `prompt.fill` of its own, so the
 * optimizer's `prompt.fill` hook sees a foreign origin. Self-contained, as an
 * inline plugin must be.
 */
const FOREIGN_FILL: Plugin = {
  name: 'foreign-fill-plugin',
  register(on) {
    on('command.run', { command: 'foreign-fill' }, async ($, _e) => {
      // Inline, as an inline plugin's module closes over nothing of the test.
      const r = await $.prompt.fill({ text: '외부 플러그인 텍스트', mode: 'replace' })
      return { text: r.isFilled ? 'foreign landed' : 'foreign refused' }
    })
  },
}

/** The fragment a foreign `append` fill adds to the box. */
const FOREIGN_APPEND_FRAGMENT = '외부 조각'

/**
 * A foreign plugin that fills in `append` mode: its input's `text` is only the
 * fragment, while the box keeps what was already there.
 */
const FOREIGN_APPEND: Plugin = {
  name: 'foreign-append-plugin',
  register(on) {
    on('command.run', { command: 'foreign-append' }, async ($, _e) => {
      const r = await $.prompt.fill({ text: '외부 조각', mode: 'append' })
      return { text: r.isFilled ? 'foreign appended' : 'foreign append refused' }
    })
  },
}

/** The `command.run` envelope the append fill trigger carries. */
const FOREIGN_APPEND_RUN = {
  command: 'foreign-append',
  args: '',
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: false, columns: 80 },
}

describe('register — the wired module', () => {
  test(
    'intercepts, runs one completion, restores and bypasses, and leaves foreign input alone',
    { options: { uiMode: 'composer' } },
    async ($, on) => {
      const clock = mock.clock(on)

      // Stubs for the engine nouns the module reaches. Each sits beneath the
      // loaded plugin's own hooks, so a call proves the plugin dispatched it.
      const modelCalls: ModelCompleteRequest[] = []
      const fills: PromptFillInput[] = []
      const submits: PromptSubmitInput[] = []
      const configSets: Array<[string, unknown]> = []
      let forks = 0

      on('session.start', (_$, e) => ({ cwd: e.cwd }))
      on('config.set', (_$, e) => {
        configSets.push([e.key, e.value])
        return { value: e.value }
      })
      on('model.complete', (_$, e) => {
        modelCalls.push(e)
        return { value: answered(DRAFT) }
      })
      on('model.fork', () => {
        forks += 1
        return { deny: 'fork is never used' }
      })
      on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
      on('prompt.fill', (_$, e) => {
        fills.push(e)
        return { isFilled: true }
      })
      on('prompt.submit', (_$, e) => {
        submits.push(e)
        return { text: e.text }
      })

      await $.session.start(SESSION_START)

      // 1. An eligible composer submission is dropped before any lower hook.
      const dropped = await $.prompt.submit({
        text: '로그인 버그 고쳐줘',
        origin: { kind: 'composer' },
        wait: false,
      })
      expect(dropped).toEqual({ drop: '프롬프트를 다듬는 중입니다.' })
      expect(submits).toHaveLength(0)
      expect(modelCalls).toHaveLength(0)

      // 2. The scheduled round makes exactly one completion, on `haiku`.
      await clock.advance(1)
      expect(modelCalls).toHaveLength(1)
      expect(modelCalls[0]?.model).toBe('haiku')
      expect(submits).toHaveLength(0)

      // 3. `/optimize accept` fills the draft; resubmitting it bypasses once.
      const accepted = await $.command.run({ ...COMMAND_RUN, args: 'accept' })
      expect(accepted.text).toBe('개선안을 입력창으로 가져왔습니다. 내용을 확인하고 Enter를 누르세요.')
      expect(fills).toHaveLength(1)
      expect(fills[0]?.text).toBe(DRAFT)

      const bypassed = await $.prompt.submit({
        text: DRAFT,
        origin: { kind: 'composer' },
        wait: false,
      })
      expect(bypassed).toEqual({ text: DRAFT })
      expect(submits).toHaveLength(1)
      expect(submits[0]?.text).toBe(DRAFT)
      expect(modelCalls).toHaveLength(1)

      // 4. The raw marker strips itself and passes the rest through untouched.
      await $.prompt.submit({ text: '::raw hello', origin: { kind: 'composer' }, wait: false })
      expect(submits).toHaveLength(2)
      expect(submits[1]?.text).toBe('hello')
      expect(modelCalls).toHaveLength(1)

      // 5. A plugin's own submission is never intercepted.
      await $.prompt.submit({
        text: '다른 플러그인 제출',
        origin: { kind: 'plugin', name: 'other-plugin' },
        wait: false,
      })
      expect(submits).toHaveLength(3)
      expect(submits[2]?.text).toBe('다른 플러그인 제출')
      expect(modelCalls).toHaveLength(1)

      // 6. `/optimize off` turns interception off and mirrors the row into
      //    persistent settings.
      const off = await $.command.run({ ...COMMAND_RUN, args: 'off' })
      expect(off.text).toBe('자동 가로채기를 껐습니다.\n설정에 저장했습니다.')
      expect(configSets).toEqual([['prompt-optimizer.enabled', false]])
      await $.prompt.submit({ text: '그대로 보내기', origin: { kind: 'composer' }, wait: false })
      expect(submits).toHaveLength(4)
      expect(submits[3]?.text).toBe('그대로 보내기')
      expect(modelCalls).toHaveLength(1)

      // 7. The fork path is never used.
      expect(forks).toBe(0)
    },
  )

  test('config.set: the row takes the clamped value the chain resolved to', { options: {} }, async ($, on) => {
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
    // Beneath the plugin, a hook clamps the requested value.
    on('config.set', () => ({ value: 'clamped-model' }))

    await $.session.start(SESSION_START)
    const set = await $.config.set(configChange('prompt-optimizer.model', 'sonnet'))
    expect(set).toEqual({ value: 'clamped-model' })

    const status = await $.command.run({ ...COMMAND_RUN, args: 'status' })
    expect(status.text).toContain('모델: clamped-model')
  })

  test('config.set: a denied row change leaves the effective value alone', { options: {} }, async ($, on) => {
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
    on('config.set', () => ({ deny: 'locked by policy' }))

    await $.session.start(SESSION_START)
    const set = await $.config.set(configChange('prompt-optimizer.model', 'sonnet'))
    expect(set).toEqual({ deny: 'locked by policy' })

    const status = await $.command.run({ ...COMMAND_RUN, args: 'status' })
    expect(status.text).toContain('모델: haiku')
    expect(status.text).not.toContain('sonnet')
  })

  test('config.set: an invalid row value keeps the old value and toasts', { options: {} }, async ($, on) => {
    const toasts: string[] = []
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
    // Beneath the plugin, the row is written with an out-of-range value.
    on('config.set', (_$, e) => ({ value: e.value }))
    on('ui.toast', (_$, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })

    await $.session.start(SESSION_START)
    const set = await $.config.set(configChange('prompt-optimizer.maxTokens', '99999'))
    expect(set).toEqual({ value: '99999' })
    expect(toasts).toEqual([
      'prompt-optimizer: maxTokens 값이 올바르지 않아 이전 값을 유지합니다: "maxTokens" must be between 128 and 2048; using default 1024',
    ])

    // The stored value was refused, so the effective setting is unchanged.
    const status = await $.command.run({ ...COMMAND_RUN, args: 'status' })
    expect(status.text).toContain('최대 토큰: 1024')
  })

  test(
    'prompt.fill: a refused foreign fill leaves the restored draft bypassing',
    { options: { uiMode: 'composer' }, plugins: [FOREIGN_FILL] },
    async ($, on) => {
      const clock = mock.clock(on)
      const submits: PromptSubmitInput[] = []
      let refuseForeign = false

      on('session.start', (_$, e) => ({ cwd: e.cwd }))
      on('model.complete', () => ({ value: answered(DRAFT) }))
      on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
      on('prompt.fill', (_$, e) => {
        if (
          refuseForeign &&
          e.origin.kind === 'plugin' &&
          e.origin.name === FOREIGN_FILL.name
        ) {
          return { isFilled: false }
        }
        return { isFilled: true }
      })
      on('prompt.submit', (_$, e) => {
        submits.push(e)
        return { text: e.text }
      })

      await $.session.start(SESSION_START)
      await $.prompt.submit({ text: '원문 요청', origin: { kind: 'composer' }, wait: false })
      await clock.advance(1)
      const accepted = await $.command.run({ ...COMMAND_RUN, args: 'accept' })
      expect(accepted.text).toContain('입력창으로 가져왔습니다')

      refuseForeign = true
      const foreign = await $.command.run(FOREIGN_RUN)
      expect(foreign.text).toBe('foreign refused')

      // The box never took the foreign text, so the restored draft still
      // bypasses interception exactly once.
      const passed = await $.prompt.submit({ text: DRAFT, origin: { kind: 'composer' }, wait: false })
      expect(passed).toEqual({ text: DRAFT })
      expect(submits.map(s => s.text)).toEqual([DRAFT])
    },
  )

  test(
    'prompt.fill: a landed foreign fill moves the bypass onto its text',
    { options: { uiMode: 'composer' }, plugins: [FOREIGN_FILL] },
    async ($, on) => {
      const clock = mock.clock(on)
      const submits: PromptSubmitInput[] = []
      let boxText = ''

      on('session.start', (_$, e) => ({ cwd: e.cwd }))
      on('model.complete', () => ({ value: answered(DRAFT) }))
      on('prompt.read', () => ({ value: { text: boxText, cursor: boxText.length } }))
      on('prompt.fill', (_$, e) => {
        boxText = e.text
        return { isFilled: true, text: boxText }
      })
      on('prompt.submit', (_$, e) => {
        submits.push(e)
        return { text: e.text }
      })

      await $.session.start(SESSION_START)
      await $.prompt.submit({ text: '원문 요청', origin: { kind: 'composer' }, wait: false })
      await clock.advance(1)
      await $.command.run({ ...COMMAND_RUN, args: 'accept' })

      const foreign = await $.command.run(FOREIGN_RUN)
      expect(foreign.text).toBe('foreign landed')
      expect(boxText).toBe(FOREIGN_FILL_TEXT)

      const passed = await $.prompt.submit({
        text: FOREIGN_FILL_TEXT,
        origin: { kind: 'composer' },
        wait: false,
      })
      expect(passed).toEqual({ text: FOREIGN_FILL_TEXT })
      expect(submits.map(s => s.text)).toEqual([FOREIGN_FILL_TEXT])
    },
  )

  test(
    'prompt.fill: an append foreign fill moves the bypass onto the whole box',
    { options: { uiMode: 'composer' }, plugins: [FOREIGN_APPEND] },
    async ($, on) => {
      const clock = mock.clock(on)
      const submits: PromptSubmitInput[] = []
      let boxText = ''

      on('session.start', (_$, e) => ({ cwd: e.cwd }))
      on('model.complete', () => ({ value: answered(DRAFT) }))
      on('prompt.read', () => ({ value: { text: boxText, cursor: boxText.length } }))
      on('prompt.fill', (_$, e) => {
        // Emulate the box: `replace` sets it, `append` keeps it and adds the
        // fragment, so the fill's own `text` is not the whole box.
        boxText = e.mode === 'append' ? boxText + e.text : e.text
        return { isFilled: true, text: boxText }
      })
      on('prompt.submit', (_$, e) => {
        submits.push(e)
        return { text: e.text }
      })

      await $.session.start(SESSION_START)
      await $.prompt.submit({ text: '원문 요청', origin: { kind: 'composer' }, wait: false })
      await clock.advance(1)
      await $.command.run({ ...COMMAND_RUN, args: 'accept' })
      expect(boxText).toBe(DRAFT)

      const foreign = await $.command.run(FOREIGN_APPEND_RUN)
      expect(foreign.text).toBe('foreign appended')
      expect(boxText).toBe(DRAFT + FOREIGN_APPEND_FRAGMENT)

      // The bypass follows the whole box, so submitting it passes once; the
      // bare fragment (the fill's own `text`) would have matched nothing.
      const passed = await $.prompt.submit({ text: boxText, origin: { kind: 'composer' }, wait: false })
      expect(passed).toEqual({ text: boxText })
      expect(submits.map(s => s.text)).toEqual([boxText])
    },
  )

  // The register-level wiring: the submit hook's scheduled round reads the main
  // session's model through `portsOf`'s `$.session.model()` closure and selects
  // the block. A later round re-reads it; an unlisted (haiku) model drops the
  // block. The optimizer's own model and effort never move.
  test(
    'model guidance: the wired submit path selects the main model block each round',
    { options: { uiMode: 'composer' } },
    async ($, on) => {
      const clock = mock.clock(on)
      const modelCalls: ModelCompleteRequest[] = []
      let modelValue = 'claude-opus-5-5[1m]'
      let modelReads = 0

      on('session.start', (_$, e) => ({ cwd: e.cwd }))
      on('session.model', () => {
        modelReads += 1
        return { value: modelValue }
      })
      on('model.complete', (_$, e) => {
        modelCalls.push(e)
        return { value: answered(DRAFT) }
      })
      on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))

      await $.session.start(SESSION_START)

      await $.prompt.submit({ text: '로그인 버그 고쳐줘', origin: { kind: 'composer' }, wait: false })
      await clock.advance(1)
      expect(modelCalls).toHaveLength(1)
      expect(modelCalls[0]?.system ?? '').toContain('[대상 모델 편집 지침: opus-5-5]')
      expect(modelCalls[0]?.model).toBe('haiku')
      expect(modelCalls[0]?.effort).toBe('low')

      // The next round re-reads the getter; haiku stays on common guidance.
      modelValue = 'claude-haiku-4-5-20251001'
      await $.prompt.submit({ text: '더 짧게', origin: { kind: 'composer' }, wait: false })
      await clock.advance(1)
      expect(modelCalls).toHaveLength(2)
      expect(modelCalls[1]?.system ?? '').not.toContain('[대상 모델 편집 지침:')
      expect(modelCalls[1]?.model).toBe('haiku')
      expect(modelCalls[1]?.effort).toBe('low')
      expect(modelReads).toBe(2)
    },
  )
})
