import type {
  ModelCompleteRequest,
  ModelUsage,
  PromptFillInput,
  PromptSubmitInput,
} from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

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
      let forks = 0

      on('session.start', (_$, e) => ({ cwd: e.cwd }))
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

      // 6. `/optimize off` turns interception off for later submissions.
      const off = await $.command.run({ ...COMMAND_RUN, args: 'off' })
      expect(off.text).toBe('자동 가로채기를 껐습니다.')
      await $.prompt.submit({ text: '그대로 보내기', origin: { kind: 'composer' }, wait: false })
      expect(submits).toHaveLength(4)
      expect(submits[3]?.text).toBe('그대로 보내기')
      expect(modelCalls).toHaveLength(1)

      // 7. The fork path is never used.
      expect(forks).toBe(0)
    },
  )
})
