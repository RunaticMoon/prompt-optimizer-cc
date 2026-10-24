import type {
  EngineInterface,
  PromptFillArgs,
  PromptFilled,
  PromptSubmitArgs,
  PromptSubmitResult,
} from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import type { RestoreCheck, RestoreGuard, SubmitTarget, TransferTarget } from '../hooks/contracts'
import { BYPASS_TTL_MS, sendApproved, transferDraft } from '../hooks/delivery'

/**
 * A stand-in engine exposing only the `$.ui` / `$.prompt` members delivery
 * uses, while recording every call in order so a test can assert both what
 * happened and how often.
 */
interface EngineHooks {
  /**
   * The box before the fill. A string is the live box a fill then rewrites; an
   * array is handed to successive `$.prompt.read()` calls, '' once exhausted.
   */
  box?: string | readonly string[]
  /** Overrides `$.prompt.read`, so a test can hold one read open. */
  read?: () => { text: string; cursor: number } | Promise<{ text: string; cursor: number }>
  /** Overrides `$.ui.close`, so a test can hold the pane close open. */
  close?: () => Promise<void>
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
  /** The live box, so a test can prove a dispatched fill cannot be retracted. */
  boxText(): string
}

function fakeEngine(hooks: EngineHooks = {}): FakeEngine {
  const calls: string[] = []
  const fills: PromptFillArgs[] = []
  const submits: PromptSubmitArgs[] = []
  const closes: string[] = []
  const queue: string[] | null = Array.isArray(hooks.box) ? [...hooks.box] : null
  // The live box: a fill rewrites it the way the engine does, so a later read
  // and the fill's own `text` agree on the box's final contents.
  let live = typeof hooks.box === 'string' ? hooks.box : ''

  const engine = {
    ui: {
      close: async ({ id }: { id: string }): Promise<void> => {
        calls.push(`ui.close(${id})`)
        closes.push(id)
        if (hooks.close !== undefined) return hooks.close()
        if (hooks.closeError !== undefined) throw hooks.closeError
      },
    },
    prompt: {
      read: async (): Promise<{ text: string; cursor: number }> => {
        calls.push('prompt.read')
        if (hooks.readError !== undefined) throw hooks.readError
        if (hooks.read !== undefined) return hooks.read()
        const text = queue !== null ? (queue.shift() ?? '') : live
        return { text, cursor: text.length }
      },
      fill: async (input: PromptFillArgs): Promise<PromptFilled> => {
        calls.push(`prompt.fill(${input.mode ?? 'replace'})`)
        fills.push(input)
        if (hooks.fillError !== undefined) throw hooks.fillError
        if (hooks.fill !== undefined) return hooks.fill(input)
        const mode = input.mode ?? 'replace'
        live = mode === 'replace' ? input.text : live + input.text
        return { isFilled: true, text: live, cursor: live.length }
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
  return { engine: engine as unknown as EngineInterface, calls, fills, submits, closes, boxText: () => live }
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

/** A promise a test settles by hand, for holding a read, close or fill open. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

/** Spins microtasks until `predicate` holds, so a detached transfer is observable. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('waitFor: condition never held')
}

/** A mutable stand-in restore guard, moved by the test at each boundary. */
function fakeGuard(initial: RestoreCheck = 'current', recovery?: string): {
  guard: RestoreGuard
  set(check: RestoreCheck, text?: string): void
} {
  let check = initial
  let text = recovery
  return {
    guard: { check: () => check, recoveryText: () => text },
    set(next, nextText) {
      check = next
      text = nextText
    },
  }
}

/** One prompt-box snapshot as `$.prompt.read` returns it. */
type BoxSnapshot = { text: string; cursor: number }

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

  test('accepts either the submitted text or its pasted composer form', async () => {
    const candidates = ['붙여넣은 원문 전체', '[Pasted text #1 +8 lines]'] as const
    for (const candidate of candidates) {
      const { engine, fills } = fakeEngine({ box: `  ${candidate}\n` })
      const result = await transferDraft(engine, transfer(), {
        now: 0,
        expectedDraft: candidates,
      })

      expect(result.kind).toBe('filled')
      expect(fills).toHaveLength(1)
      expect(fills[0]?.text).toBe('개선된 초안')
    }
  })

  test('multiple expected draft forms still protect unrelated new input', async () => {
    const { engine, fills } = fakeEngine({ box: '사용자가 새로 쓴 내용' })
    const result = await transferDraft(engine, transfer(), {
      now: 0,
      expectedDraft: ['붙여넣은 원문 전체', '[Pasted text #1 +8 lines]'],
    })

    expect(result).toEqual({ kind: 'refused', reason: 'draft-conflict' })
    expect(fills).toHaveLength(0)
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
    const { engine, calls, fills } = fakeEngine({ box: '기존 초안' })
    const result = await transferDraft(engine, transfer({ text: ' + 추가', mode: 'append' }), { now: 0 })

    expect(result).toMatchObject({ kind: 'filled', text: '기존 초안 + 추가' })
    expect(fills[0]).toEqual({ text: ' + 추가', mode: 'append' })
    // The fill's own view of the box is enough; no read is needed.
    expect(calls).toEqual(['prompt.fill(append)'])
  })

  test('insert mode skips the conflict check', async () => {
    const { engine, calls } = fakeEngine({ box: '앞뒤' })
    const result = await transferDraft(engine, transfer({ text: '가운데', mode: 'insert' }), { now: 0 })

    expect(result.kind).toBe('filled')
    expect(calls).toEqual(['prompt.fill(insert)'])
  })
})

describe('transferDraft — restore guard', () => {
  test('a read that resolves after an observed edit cannot fill', async () => {
    const read = deferred<BoxSnapshot>()
    const { engine, fills } = fakeEngine({ read: () => read.promise })
    const g = fakeGuard()

    const pending = transferDraft(engine, transfer(), { now: 0, guard: g.guard })
    g.set('edited', '새로 작성한 요청')
    read.resolve({ text: '', cursor: 0 })

    expect(await pending).toEqual({
      kind: 'refused',
      reason: 'draft-conflict',
      recoveryText: '새로 작성한 요청',
    })
    expect(fills).toHaveLength(0)
  })

  test('a revision change refuses even when the read text is unchanged (ABA)', async () => {
    const read = deferred<BoxSnapshot>()
    const { engine, fills } = fakeEngine({ read: () => read.promise })
    const g = fakeGuard()

    const pending = transferDraft(engine, transfer(), { now: 0, guard: g.guard })
    // The box read comes back as the target text, which `canReplace` alone
    // would accept; the changed revision is the evidence of the edit.
    g.set('edited')
    read.resolve({ text: '개선된 초안', cursor: 6 })

    expect(await pending).toEqual({ kind: 'refused', reason: 'draft-conflict' })
    expect(fills).toHaveLength(0)
  })

  test('an edit already pending before the call refuses without touching the box', async () => {
    const g = fakeGuard('edited', '작성 중이던 내용')
    const { engine, calls, fills } = fakeEngine({ box: '' })

    expect(await transferDraft(engine, transfer(), { now: 0, guard: g.guard })).toEqual({
      kind: 'refused',
      reason: 'draft-conflict',
      recoveryText: '작성 중이던 내용',
    })
    expect(calls).toEqual([])
    expect(fills).toHaveLength(0)
  })

  test('an owner change during the pane close stops the restore', async () => {
    const close = deferred<void>()
    const { engine, fills } = fakeEngine({ box: '', close: () => close.promise })
    const g = fakeGuard()

    const pending = transferDraft(engine, transfer(), { now: 0, paneId: 'pane-1', guard: g.guard })
    await waitFor(() => fills.length === 0)
    g.set('stale')
    close.resolve()

    expect(await pending).toEqual({ kind: 'refused', reason: 'stale-owner' })
    expect(fills).toHaveLength(0)
  })

  test('an owner change while the read is pending stops the restore', async () => {
    const read = deferred<BoxSnapshot>()
    const { engine, fills } = fakeEngine({ read: () => read.promise })
    const g = fakeGuard()

    const pending = transferDraft(engine, transfer(), { now: 0, guard: g.guard })
    g.set('stale')
    read.resolve({ text: '', cursor: 0 })

    expect(await pending).toEqual({ kind: 'refused', reason: 'stale-owner' })
    expect(fills).toHaveLength(0)
  })

  test('an edit observed during the fill refuses with its recovery text and no ticket', async () => {
    const fill = deferred<PromptFilled>()
    const { engine, fills } = fakeEngine({ box: '', fill: () => fill.promise })
    const g = fakeGuard()

    const pending = transferDraft(engine, transfer(), { now: 0, guard: g.guard })
    await waitFor(() => fills.length === 1)
    g.set('edited', '새로 작성한 요청')
    fill.resolve({ isFilled: true, text: '개선된 초안', cursor: 6 })

    const result = await pending
    expect(result).toEqual({
      kind: 'refused',
      reason: 'draft-conflict',
      recoveryText: '새로 작성한 요청',
    })
    expect('ticket' in result).toBe(false)
    expect(fills).toHaveLength(1)
  })

  test('an owner change after the dispatch returns stale-owner and cannot undo the fill', async () => {
    const fill = deferred<PromptFilled>()
    let box = ''
    const { engine, fills } = fakeEngine({
      box: '',
      fill: input =>
        fill.promise.then(() => {
          box = input.text
          return { isFilled: true, text: box, cursor: box.length }
        }),
    })
    const g = fakeGuard()

    const pending = transferDraft(engine, transfer(), { now: 0, guard: g.guard })
    await waitFor(() => fills.length === 1)
    g.set('stale')
    fill.resolve({ isFilled: true, text: '', cursor: 0 })

    const result = await pending
    expect(result).toEqual({ kind: 'refused', reason: 'stale-owner' })
    expect('ticket' in result).toBe(false)
    expect(fills).toHaveLength(1)
    // The host mutation already happened; the plugin can only report it.
    expect(box).toBe('개선된 초안')
  })

  test('an edit observed during the fallback read withholds the ticket', async () => {
    let reads = 0
    const second = deferred<BoxSnapshot>()
    const { engine, fills } = fakeEngine({
      read: () => {
        reads += 1
        return reads === 1 ? { text: '', cursor: 0 } : second.promise
      },
      fill: () => ({ isFilled: true, text: '', cursor: 0 }),
    })
    const g = fakeGuard()

    const pending = transferDraft(engine, transfer(), { now: 0, guard: g.guard })
    await waitFor(() => fills.length === 1 && reads === 2)
    g.set('edited', '새로 작성한 요청')
    second.resolve({ text: '새로 작성한 요청', cursor: 8 })

    const result = await pending
    expect(result).toEqual({
      kind: 'refused',
      reason: 'draft-conflict',
      recoveryText: '새로 작성한 요청',
    })
    expect('ticket' in result).toBe(false)
  })

  test('an unchanged guard still fills a box holding the normalized target', async () => {
    const g = fakeGuard()
    const { engine, fills } = fakeEngine({ box: '  개선된 초안  ' })

    const result = await transferDraft(engine, transfer(), { now: 0, guard: g.guard })

    expect(result.kind).toBe('filled')
    expect(fills).toHaveLength(1)
  })

  test('append keeps its behavior with a current guard', async () => {
    const g = fakeGuard()
    const { engine, fills } = fakeEngine({ box: '기존 초안' })

    const result = await transferDraft(engine, transfer({ text: ' + 추가', mode: 'append' }), {
      now: 0,
      guard: g.guard,
    })

    expect(result).toMatchObject({ kind: 'filled', text: '기존 초안 + 추가' })
    expect(fills).toHaveLength(1)
  })

  test('append refuses before the dispatch when the guard is stale', async () => {
    const g = fakeGuard('stale')
    const { engine, fills } = fakeEngine({ box: '기존 초안' })

    expect(
      await transferDraft(engine, transfer({ text: ' + 추가', mode: 'append' }), { now: 0, guard: g.guard }),
    ).toEqual({ kind: 'refused', reason: 'stale-owner' })
    expect(fills).toHaveLength(0)
  })

  test('a fill refusal keeps the engine cause when the guard only saw an edit', async () => {
    const g = fakeGuard()
    const { engine } = fakeEngine({
      box: '',
      fill: () => {
        g.set('edited', '작성 중')
        return { isFilled: false, refusal: 'no_composer', text: '', cursor: 0 }
      },
    })

    expect(await transferDraft(engine, transfer(), { now: 0, guard: g.guard })).toEqual({
      kind: 'refused',
      reason: 'no_composer',
    })
  })

  test('a thrown fill reports stale ownership when the call is obsolete', async () => {
    const g = fakeGuard()
    const { engine } = fakeEngine({
      box: '',
      fill: () => {
        g.set('stale')
        throw new Error('boom')
      },
    })

    expect(await transferDraft(engine, transfer(), { now: 0, guard: g.guard })).toEqual({
      kind: 'refused',
      reason: 'stale-owner',
    })
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
  test('replace issues a permit over the box text with the TTL expiry', async () => {
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

  test('replace permits the box text after the engine strips undrawable code points', async () => {
    // The engine drops zero-width code points at both the fill and the send, so
    // a permit over `target.text` would never match the composer's submission.
    const { engine } = fakeEngine({
      box: '',
      fill: input => ({ isFilled: true, text: input.text.replaceAll('\u200B', ''), cursor: 0 }),
    })
    const result = await transferDraft(engine, transfer({ text: '초안\u200B' }), { now: 0 })

    expect(result).toMatchObject({ kind: 'filled', text: '초안' })
    expect(result.kind === 'filled' ? result.ticket.text : null).toBe('초안')
  })

  test('falls back to a fresh read when the fill reports no text', async () => {
    // The first read clears the conflict check; the fill reports no text, so
    // the second read supplies the box.
    const { engine, calls } = fakeEngine({
      box: ['', '읽어낸 상자'],
      fill: () => ({ isFilled: true, text: '', cursor: 0 }),
    })
    const result = await transferDraft(engine, transfer({ text: '초안' }), { now: 0 })

    expect(result).toMatchObject({ kind: 'filled', text: '읽어낸 상자' })
    expect(calls).toEqual(['prompt.read', 'prompt.fill(replace)', 'prompt.read'])
  })

  test('falls back to the requested text when the fill and the box are both blank', async () => {
    const { engine } = fakeEngine({
      box: '',
      fill: () => ({ isFilled: true, text: '', cursor: 0 }),
    })
    const result = await transferDraft(engine, transfer({ text: '초안' }), { now: 0 })

    expect(result).toMatchObject({ kind: 'filled', text: '초안' })
  })

  test('append issues a permit over the box after the fill', async () => {
    const { engine } = fakeEngine({ box: '기존 초안' })
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

  test('append uses the fill’s own report even when the box cannot be read', async () => {
    const { engine, calls } = fakeEngine({
      box: '',
      readError: new Error('gone'),
      fill: () => ({ isFilled: true, text: '합쳐진 텍스트', cursor: 6 }),
    })
    const result = await transferDraft(engine, transfer({ text: ' + 추가', mode: 'append' }), { now: 0 })

    expect(result).toMatchObject({ kind: 'filled', text: '합쳐진 텍스트' })
    // The fill's text is authoritative, so no re-read is attempted.
    expect(calls).toEqual(['prompt.fill(append)'])
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
  test('submits the approved text exactly once, as the person’s own words', async () => {
    const { engine, calls, submits } = fakeEngine()
    const result = await sendApproved(engine, submitTarget({ text: '보낼 텍스트' }))

    expect(result).toEqual({ kind: 'sent', text: '보낼 텍스트' })
    expect(calls).toEqual(['prompt.submit'])
    expect(submits).toEqual([{ text: '보낼 텍스트', asUser: true }])
  })

  test('does not pass context: the submit arg carries only text and asUser', async () => {
    const { engine, submits } = fakeEngine()
    const result = await sendApproved(
      engine,
      submitTarget({ text: '본문', context: ['block-a', 'block-b'] }),
    )

    expect(submits).toEqual([{ text: '본문', asUser: true }])
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
