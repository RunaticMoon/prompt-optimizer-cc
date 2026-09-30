import type {
  EngineInterface,
  PromptFillArgs,
  PromptFilled,
  PromptSubmitArgs,
  PromptSubmitResult,
} from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import type { SubmitTarget, TransferTarget } from '../hooks/contracts'
import { BYPASS_TTL_MS, sendApproved, transferDraft } from '../hooks/delivery'

/**
 * A stand-in engine exposing only the `$.ui` / `$.prompt` members delivery
 * uses, while recording every call in order so a test can assert both what
 * happened and how often.
 */
interface EngineHooks {
  /** Box texts returned by successive `$.prompt.read()` calls; '' when absent. */
  box?: string | readonly string[]
  /** Overrides the default successful fill result. */
  fill?: (input: PromptFillArgs) => PromptFilled | Promise<PromptFilled>
  fillError?: unknown
  readError?: unknown
  closeError?: unknown
  /** Overrides the default successful submit result. */
  submit?: (input: PromptSubmitArgs) => PromptSubmitResult | Promise<PromptSubmitResult>
  submitError?: unknown
}

interface FakeEngine {
  engine: EngineInterface
  /** Every engine call, in order: `ui.close(id)`, `prompt.read`, `prompt.fill(mode)`, `prompt.submit`. */
  calls: string[]
  fills: PromptFillArgs[]
  submits: PromptSubmitArgs[]
  closes: string[]
}

function fakeEngine(hooks: EngineHooks = {}): FakeEngine {
  const calls: string[] = []
  const fills: PromptFillArgs[] = []
  const submits: PromptSubmitArgs[] = []
  const closes: string[] = []
  const boxes: string[] =
    hooks.box === undefined
      ? []
      : typeof hooks.box === 'string'
        ? [hooks.box]
        : [...hooks.box]

  const engine = {
    ui: {
      close: async ({ id }: { id: string }): Promise<void> => {
        calls.push(`ui.close(${id})`)
        closes.push(id)
        if (hooks.closeError !== undefined) throw hooks.closeError
      },
    },
    prompt: {
      read: async (): Promise<{ text: string; cursor: number }> => {
        calls.push('prompt.read')
        if (hooks.readError !== undefined) throw hooks.readError
        const text = boxes.shift() ?? ''
        return { text, cursor: text.length }
      },
      fill: async (input: PromptFillArgs): Promise<PromptFilled> => {
        calls.push(`prompt.fill(${input.mode ?? 'replace'})`)
        fills.push(input)
        if (hooks.fillError !== undefined) throw hooks.fillError
        if (hooks.fill !== undefined) return hooks.fill(input)
        return { isFilled: true, text: input.text, cursor: input.text.length }
      },
      submit: async (input: PromptSubmitArgs): Promise<PromptSubmitResult> => {
        calls.push('prompt.submit')
        submits.push(input)
        if (hooks.submitError !== undefined) throw hooks.submitError
        if (hooks.submit !== undefined) return hooks.submit(input)
        return { text: input.text }
      },
    },
  }
  return { engine: engine as unknown as EngineInterface, calls, fills, submits, closes }
}

function transfer(over: Partial<TransferTarget> = {}): TransferTarget {
  return { sessionId: 'sess-1', workflowId: 'wf-1', text: '개선된 초안', mode: 'replace', ...over }
}

function submitTarget(over: Partial<SubmitTarget> = {}): SubmitTarget {
  return {
    sessionId: 'sess-1',
    workflowId: 'wf-1',
    text: '보낼 텍스트',
    context: [],
    source: 'draft',
    ...over,
  }
}

describe('transferDraft — pane close and call order', () => {
  test('closes the pane before reading and filling', async () => {
    const { engine, calls } = fakeEngine({ box: '' })
    const result = await transferDraft(engine, transfer(), { now: 1_000, paneId: 'pane-1' })

    expect(calls).toEqual(['ui.close(pane-1)', 'prompt.read', 'prompt.fill(replace)'])
    expect(result.kind).toBe('filled')
  })

  test('touches no pane when none is given', async () => {
    const { engine, calls, closes } = fakeEngine({ box: '' })
    await transferDraft(engine, transfer(), { now: 0 })

    expect(closes).toEqual([])
    expect(calls).toEqual(['prompt.read', 'prompt.fill(replace)'])
  })

  test('continues after a pane close failure', async () => {
    const { engine, calls, fills } = fakeEngine({ box: '', closeError: new Error('already closed') })
    const result = await transferDraft(engine, transfer(), { now: 0, paneId: 'pane-1' })

    expect(calls).toEqual(['ui.close(pane-1)', 'prompt.read', 'prompt.fill(replace)'])
    expect(fills).toHaveLength(1)
    expect(result.kind).toBe('filled')
  })
})

describe('transferDraft — draft conflict', () => {
  test('fills an empty box', async () => {
    const { engine, fills } = fakeEngine({ box: '' })
    const result = await transferDraft(engine, transfer(), { now: 0 })

    expect(fills).toHaveLength(1)
    expect(result).toMatchObject({ kind: 'filled', text: '개선된 초안' })
  })

  test('a whitespace-only box is replaced', async () => {
    const { engine, fills } = fakeEngine({ box: '   \n\t ' })
    const result = await transferDraft(engine, transfer(), { now: 0 })

    expect(fills).toHaveLength(1)
    expect(result.kind).toBe('filled')
  })

  test('refuses to overwrite text the person typed, without filling', async () => {
    const { engine, calls, fills } = fakeEngine({ box: '내가 새로 쓴 내용' })
    const result = await transferDraft(engine, transfer(), { now: 0 })

    expect(result).toEqual({ kind: 'refused', reason: 'draft-conflict' })
    expect(fills).toHaveLength(0)
    expect(calls).toEqual(['prompt.read'])
  })

  test('overwrites when the box holds the caller’s expected draft', async () => {
    const { engine, fills } = fakeEngine({ box: '이전 초안' })
    const result = await transferDraft(engine, transfer({ text: '새 초안' }), {
      now: 0,
      expectedDraft: '이전 초안',
    })

    expect(fills).toHaveLength(1)
    expect(result.kind).toBe('filled')
  })

  test('expectedDraft is compared after trimming', async () => {
    const { engine } = fakeEngine({ box: '  이전 초안  ' })
    const result = await transferDraft(engine, transfer({ text: '새 초안' }), {
      now: 0,
      expectedDraft: '이전 초안',
    })

    expect(result.kind).toBe('filled')
  })

  test('overwrites when the box already holds the target text', async () => {
    const { engine, fills } = fakeEngine({ box: '  개선된 초안 ' })
    const result = await transferDraft(engine, transfer(), { now: 0 })

    expect(fills).toHaveLength(1)
    expect(result.kind).toBe('filled')
  })

  test('refuses when the box differs from both the expected draft and the target', async () => {
    const { engine, fills } = fakeEngine({ box: '사용자가 쓴 다른 내용' })
    const result = await transferDraft(engine, transfer({ text: '새 초안' }), {
      now: 0,
      expectedDraft: '이전 초안',
    })

    expect(result).toEqual({ kind: 'refused', reason: 'draft-conflict' })
    expect(fills).toHaveLength(0)
  })

  test('refuses rather than overwrite when the box cannot be read', async () => {
    const { engine, fills } = fakeEngine({ box: '무엇이든', readError: new Error('no box') })
    const result = await transferDraft(engine, transfer(), { now: 0 })

    expect(result).toEqual({ kind: 'refused', reason: 'unknown' })
    expect(fills).toHaveLength(0)
  })

  test('append mode skips the conflict check and adds after the draft', async () => {
    const { engine, calls, fills } = fakeEngine({ box: '기존 초안 + 추가' })
    const result = await transferDraft(engine, transfer({ text: ' + 추가', mode: 'append' }), { now: 0 })

    expect(result.kind).toBe('filled')
    expect(fills[0]).toEqual({ text: ' + 추가', mode: 'append' })
    expect(calls).toEqual(['prompt.fill(append)', 'prompt.read'])
  })

  test('insert mode skips the conflict check', async () => {
    const { engine, calls } = fakeEngine({ box: '앞뒤' })
    const result = await transferDraft(engine, transfer({ text: '가운데', mode: 'insert' }), { now: 0 })

    expect(result.kind).toBe('filled')
    expect(calls).toEqual(['prompt.fill(insert)', 'prompt.read'])
  })
})

describe('transferDraft — fill refusal mapping', () => {
  const refused = (refusal?: PromptFilled['refusal']): PromptFilled => ({
    isFilled: false,
    refusal,
    text: '',
    cursor: 0,
  })

  test('maps no_composer', async () => {
    const { engine } = fakeEngine({ box: '', fill: () => refused('no_composer') })
    expect(await transferDraft(engine, transfer(), { now: 0 })).toEqual({
      kind: 'refused',
      reason: 'no_composer',
    })
  })

  test('maps dialog', async () => {
    const { engine } = fakeEngine({ box: '', fill: () => refused('dialog') })
    expect(await transferDraft(engine, transfer(), { now: 0 })).toEqual({
      kind: 'refused',
      reason: 'dialog',
    })
  })

  test('maps an absent cause to a hook refusal', async () => {
    const { engine } = fakeEngine({ box: '', fill: () => refused() })
    expect(await transferDraft(engine, transfer(), { now: 0 })).toEqual({
      kind: 'refused',
      reason: 'hook-refused',
    })
  })

  test('maps an unrecognised cause to unknown', async () => {
    const unexpected = { isFilled: false, refusal: 'other', text: '', cursor: 0 } as unknown as PromptFilled
    const { engine } = fakeEngine({ box: '', fill: () => unexpected })
    expect(await transferDraft(engine, transfer(), { now: 0 })).toEqual({
      kind: 'refused',
      reason: 'unknown',
    })
  })

  test('maps a thrown fill to unknown', async () => {
    const { engine } = fakeEngine({ box: '', fillError: new Error('boom') })
    expect(await transferDraft(engine, transfer(), { now: 0 })).toEqual({
      kind: 'refused',
      reason: 'unknown',
    })
  })
})

describe('transferDraft — bypass permit', () => {
  test('replace issues a permit over the target text with the TTL expiry', async () => {
    const { engine } = fakeEngine({ box: '' })
    const result = await transferDraft(
      engine,
      transfer({ sessionId: 'sess-2', workflowId: 'wf-9', text: '초안' }),
      { now: 1_000 },
    )

    expect(result).toEqual({
      kind: 'filled',
      text: '초안',
      ticket: {
        sessionId: 'sess-2',
        workflowId: 'wf-9',
        text: '초안',
        expiresAt: 1_000 + BYPASS_TTL_MS,
      },
    })
  })

  test('append issues a permit over the box after the fill', async () => {
    const { engine } = fakeEngine({ box: '기존 초안 + 추가' })
    const result = await transferDraft(engine, transfer({ text: ' + 추가', mode: 'append' }), { now: 5 })

    expect(result).toEqual({
      kind: 'filled',
      text: '기존 초안 + 추가',
      ticket: {
        sessionId: 'sess-1',
        workflowId: 'wf-1',
        text: '기존 초안 + 추가',
        expiresAt: 5 + BYPASS_TTL_MS,
      },
    })
  })

  test('append falls back to the fill’s text when the box cannot be re-read', async () => {
    const { engine } = fakeEngine({
      box: '',
      readError: new Error('gone'),
      fill: () => ({ isFilled: true, text: '합쳐진 텍스트', cursor: 6 }),
    })
    const result = await transferDraft(engine, transfer({ text: ' + 추가', mode: 'append' }), { now: 0 })

    expect(result).toMatchObject({ kind: 'filled', text: '합쳐진 텍스트' })
  })

  test('a refusal carries no permit', async () => {
    const { engine } = fakeEngine({
      box: '',
      fill: () => ({ isFilled: false, refusal: 'no_composer', text: '', cursor: 0 }),
    })
    const result = await transferDraft(engine, transfer(), { now: 0 })

    expect(Object.keys(result)).toEqual(['kind', 'reason'])
  })
})

describe('sendApproved', () => {
  test('submits the approved text exactly once, with only the text', async () => {
    const { engine, calls, submits } = fakeEngine()
    const result = await sendApproved(engine, submitTarget({ text: '보낼 텍스트' }))

    expect(result).toEqual({ kind: 'sent', text: '보낼 텍스트' })
    expect(calls).toEqual(['prompt.submit'])
    expect(submits).toEqual([{ text: '보낼 텍스트' }])
  })

  test('does not pass context: the submit arg carries text alone', async () => {
    const { engine, submits } = fakeEngine()
    const result = await sendApproved(
      engine,
      submitTarget({ text: '본문', context: ['block-a', 'block-b'] }),
    )

    expect(submits).toEqual([{ text: '본문' }])
    expect(result).toEqual({ kind: 'sent', text: '본문' })
  })

  test('reports a drop with the engine reason and does not retry', async () => {
    const { engine, calls } = fakeEngine({ submit: () => ({ drop: 'blocked by a hook' }) })
    const result = await sendApproved(engine, submitTarget())

    expect(result).toEqual({ kind: 'dropped', reason: 'blocked by a hook' })
    expect(calls).toEqual(['prompt.submit'])
  })

  test('reports a thrown Error as a failure and does not retry', async () => {
    const { engine, calls } = fakeEngine({ submitError: new Error('network down') })
    const result = await sendApproved(engine, submitTarget())

    expect(result).toEqual({ kind: 'failed', message: 'network down' })
    expect(calls).toEqual(['prompt.submit'])
  })

  test('reports a non-Error throw as its string form', async () => {
    const { engine } = fakeEngine({ submitError: 'nope' })
    expect(await sendApproved(engine, submitTarget())).toEqual({ kind: 'failed', message: 'nope' })
  })

  test('returns the text the engine reports as entered', async () => {
    const { engine } = fakeEngine({ submit: () => ({ text: 'engine text' }) })
    const result = await sendApproved(engine, submitTarget({ text: 'requested' }))

    expect(result).toEqual({ kind: 'sent', text: 'engine text' })
  })
})
