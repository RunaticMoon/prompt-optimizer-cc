import { describe, expect, test } from 'claude-code/testing'

import type { PromptSubmitInput } from 'claude-code'

import type {
  BypassTicket,
  ModelUsage,
  OptimizerConfig,
  RuntimeState,
  Workflow,
} from '../hooks/contracts'
import { DEFAULT_CONFIG } from '../hooks/contracts'
import { classifySubmission } from '../hooks/eligibility'

const USAGE: ModelUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

const SESSION = 'sess-1'

function config(over: Partial<OptimizerConfig> = {}): OptimizerConfig {
  return { ...DEFAULT_CONFIG, ...over }
}

function state(over: Partial<RuntimeState> = {}): RuntimeState {
  return {
    sessionId: SESSION,
    workflow: null,
    bypass: null,
    rawMode: null,
    usage: {
      calls: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      updatedAt: 0,
    },
    ...over,
  }
}

function workflow(over: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    sessionId: SESSION,
    generation: 1,
    phase: 'reviewing',
    original: '원본',
    originalContext: [],
    draft: '초안',
    context: null,
    dialogue: [],
    rounds: 0,
    ui: 'composer',
    usage: USAGE,
    ...over,
  }
}

function submit(over: Partial<PromptSubmitInput> = {}): PromptSubmitInput {
  return { text: '로그인 오류를 고쳐줘', wait: false, origin: { kind: 'composer' }, ...over }
}

function bypass(over: Partial<BypassTicket> = {}): BypassTicket {
  return {
    sessionId: SESSION,
    workflowId: 'wf-1',
    text: '초안',
    expiresAt: 10_000,
    ...over,
  }
}

describe('classifySubmission — rule 1: origin', () => {
  const nonComposer: PromptSubmitInput['origin'][] = [
    { kind: 'bridge' },
    { kind: 'sdk' },
    { kind: 'task-notification' },
    { kind: 'scheduled-trigger' },
    { kind: 'peer' },
    { kind: 'peer-send-message' },
    { kind: 'projects-relay' },
    { kind: 'channel', server: 'slack' },
    { kind: 'coordinator' },
    { kind: 'observer' },
    { kind: 'observer-activity' },
    { kind: 'auto-continuation' },
    { kind: 'unclassified' },
    { kind: 'slack-ping' },
    { kind: 'plugin', name: 'other-plugin' },
  ]

  test('every non-composer origin passes without optimizing', () => {
    for (const origin of nonComposer) {
      expect(classifySubmission(submit({ origin }), config(), state(), 0)).toEqual({
        kind: 'pass',
        reason: 'not-composer',
      })
    }
  })

  test('a composer submission reaches optimization', () => {
    expect(classifySubmission(submit(), config(), state(), 0)).toEqual({
      kind: 'optimize',
      text: '로그인 오류를 고쳐줘',
      trigger: 'auto',
    })
  })

  test('origin is checked before a turn is', () => {
    expect(
      classifySubmission(submit({ origin: { kind: 'sdk' }, turnId: 't1' }), config(), state(), 0),
    ).toEqual({ kind: 'pass', reason: 'not-composer' })
  })
})

describe('classifySubmission — rule 2: turn and queue', () => {
  test('a prompt typed mid-turn passes', () => {
    expect(classifySubmission(submit({ turnId: 'turn-7' }), config(), state(), 0)).toEqual({
      kind: 'pass',
      reason: 'mid-turn',
    })
  })

  test('mid-turn wins over a wait request', () => {
    expect(
      classifySubmission(submit({ turnId: 'turn-7', wait: true }), config(), state(), 0),
    ).toEqual({ kind: 'pass', reason: 'mid-turn' })
  })

  test('a wait request with no turn passes as queued', () => {
    expect(classifySubmission(submit({ wait: true }), config(), state(), 0)).toEqual({
      kind: 'pass',
      reason: 'queued',
    })
  })
})

describe('classifySubmission — rule 3: attachments', () => {
  test('a non-text attachment passes untouched', () => {
    expect(
      classifySubmission(submit({ attachments: [{ type: 'image' }] }), config(), state(), 0),
    ).toEqual({ kind: 'pass', reason: 'attachments' })
  })

  test('an empty attachment list is not a block', () => {
    expect(classifySubmission(submit({ attachments: [] }), config(), state(), 0)).toEqual({
      kind: 'optimize',
      text: '로그인 오류를 고쳐줘',
      trigger: 'auto',
    })
  })
})

describe('classifySubmission — rule 4: empty', () => {
  test('empty and whitespace-only text pass as empty', () => {
    for (const text of ['', '   ', '\n\t ']) {
      expect(classifySubmission(submit({ text }), config(), state(), 0)).toEqual({
        kind: 'pass',
        reason: 'empty',
      })
    }
  })
})

describe('classifySubmission — rule 6: bypass', () => {
  test('a live matching ticket releases its draft', () => {
    const ticket = bypass()
    expect(classifySubmission(submit({ text: ticket.text }), config(), state({ bypass: ticket }), 9_999)).toEqual({
      kind: 'bypass',
      text: '초안',
      ticket,
    })
  })

  test('the ticket is checked just before it expires', () => {
    const ticket = bypass({ expiresAt: 10_000 })
    expect(classifySubmission(submit({ text: '초안' }), config(), state({ bypass: ticket }), 9_999)).toMatchObject({
      kind: 'bypass',
    })
  })

  test('an expired ticket is ignored at the exact expiry instant', () => {
    const ticket = bypass({ expiresAt: 10_000 })
    expect(classifySubmission(submit({ text: '초안' }), config(), state({ bypass: ticket }), 10_000)).toEqual({
      kind: 'optimize',
      text: '초안',
      trigger: 'auto',
    })
  })

  test('a ticket from another session is ignored', () => {
    const ticket = bypass({ sessionId: 'sess-2' })
    expect(classifySubmission(submit({ text: '초안' }), config(), state({ bypass: ticket }), 0)).toEqual({
      kind: 'optimize',
      text: '초안',
      trigger: 'auto',
    })
  })

  test('a ticket does not release different text', () => {
    const ticket = bypass()
    expect(classifySubmission(submit({ text: '다른 초안' }), config(), state({ bypass: ticket }), 0)).toEqual({
      kind: 'optimize',
      text: '다른 초안',
      trigger: 'auto',
    })
  })

  test('absent ticket optimizes', () => {
    expect(classifySubmission(submit(), config(), state(), 0)).toEqual({
      kind: 'optimize',
      text: '로그인 오류를 고쳐줘',
      trigger: 'auto',
    })
  })

  test('the ticket is not consumed by the classifier', () => {
    const ticket = bypass()
    const current = state({ bypass: ticket })
    classifySubmission(submit({ text: ticket.text }), config(), current, 0)
    expect(current.bypass).toBe(ticket)
  })
})

describe('classifySubmission — rule 5: raw mode', () => {
  const MODE = { sessionId: SESSION, draft: '초안' }

  test('an armed mode sends the text as typed, marker and all', () => {
    expect(
      classifySubmission(submit({ text: '>> 로그인 오류를 고쳐줘' }), config(), state({ rawMode: MODE }), 0),
    ).toEqual({ kind: 'raw', text: '>> 로그인 오류를 고쳐줘' })
  })

  test('the mode never compares the submission to its remembered draft', () => {
    // A paste placeholder may already have expanded, so the submitted text need
    // not equal the mode's draft; the mode still passes it as-is.
    expect(
      classifySubmission(submit({ text: '상자와 다른 텍스트' }), config(), state({ rawMode: MODE }), 0),
    ).toEqual({ kind: 'raw', text: '상자와 다른 텍스트' })
  })

  test('a mode armed for another session is ignored', () => {
    expect(
      classifySubmission(
        submit({ text: '로그인 오류를 고쳐줘' }),
        config(),
        state({ rawMode: { sessionId: 'sess-2', draft: '초안' } }),
        0,
      ),
    ).toEqual({ kind: 'optimize', text: '로그인 오류를 고쳐줘', trigger: 'auto' })
  })

  test('an unarmed submission that starts with the prefix is ordinary optimize', () => {
    expect(classifySubmission(submit({ text: '>> 그대로' }), config(), state(), 0)).toEqual({
      kind: 'optimize',
      text: '>> 그대로',
      trigger: 'auto',
    })
  })

  test('the mode still escapes while the optimizer is disabled', () => {
    expect(
      classifySubmission(submit({ text: '>> 통과' }), config({ enabled: false }), state({ rawMode: MODE }), 0),
    ).toEqual({ kind: 'raw', text: '>> 통과' })
  })

  test('the mode wins over an active composer dialogue', () => {
    expect(
      classifySubmission(
        submit({ text: '>> 통과' }),
        config(),
        state({ rawMode: MODE, workflow: workflow({ ui: 'composer', phase: 'reviewing' }) }),
        0,
      ),
    ).toEqual({ kind: 'raw', text: '>> 통과' })
  })

  test('mid-turn and queued submissions still pass before the mode', () => {
    expect(
      classifySubmission(submit({ text: '그대로', turnId: 'turn-7' }), config(), state({ rawMode: MODE }), 0),
    ).toEqual({ kind: 'pass', reason: 'mid-turn' })
    expect(
      classifySubmission(submit({ text: '그대로', wait: true }), config(), state({ rawMode: MODE }), 0),
    ).toEqual({ kind: 'pass', reason: 'queued' })
  })

  test('empty text is empty even with the mode armed', () => {
    expect(
      classifySubmission(submit({ text: '   ' }), config(), state({ rawMode: MODE }), 0),
    ).toEqual({ kind: 'pass', reason: 'empty' })
  })
})

describe('classifySubmission — rule 8: active workflow', () => {
  test('a composer dialogue in review takes the submission as a reply', () => {
    expect(
      classifySubmission(
        submit({ text: '더 짧게' }),
        config(),
        state({ workflow: workflow({ ui: 'composer', phase: 'reviewing' }) }),
        0,
      ),
    ).toEqual({ kind: 'reply', workflowId: 'wf-1', text: '더 짧게' })
  })

  test('a failed composer dialogue also takes a reply', () => {
    expect(
      classifySubmission(
        submit(),
        config(),
        state({ workflow: workflow({ ui: 'composer', phase: 'failed' }) }),
        0,
      ),
    ).toEqual({ kind: 'reply', workflowId: 'wf-1', text: '로그인 오류를 고쳐줘' })
  })

  test('a reply works while the optimizer is disabled', () => {
    expect(
      classifySubmission(
        submit({ text: '계속' }),
        config({ enabled: false }),
        state({ workflow: workflow({ ui: 'composer', phase: 'reviewing' }) }),
        0,
      ),
    ).toEqual({ kind: 'reply', workflowId: 'wf-1', text: '계속' })
  })

  test('a workflow mid-flight is busy, not a reply', () => {
    for (const phase of ['collecting', 'generating', 'transferring', 'sending', 'idle'] as const) {
      expect(
        classifySubmission(
          submit(),
          config(),
          state({ workflow: workflow({ ui: 'composer', phase }) }),
          0,
        ),
      ).toEqual({ kind: 'busy', workflowId: 'wf-1' })
    }
  })

  test('a pane-held workflow is busy even in review', () => {
    expect(
      classifySubmission(
        submit(),
        config(),
        state({ workflow: workflow({ ui: 'pane', phase: 'reviewing' }) }),
        0,
      ),
    ).toEqual({ kind: 'busy', workflowId: 'wf-1' })
  })

  test('empty text is empty even with an active dialogue', () => {
    expect(
      classifySubmission(
        submit({ text: '   ' }),
        config(),
        state({ workflow: workflow({ ui: 'composer', phase: 'reviewing' }) }),
        0,
      ),
    ).toEqual({ kind: 'pass', reason: 'empty' })
  })

  test('a bypass ticket outranks the active dialogue', () => {
    const ticket = bypass()
    expect(
      classifySubmission(
        submit({ text: ticket.text }),
        config(),
        state({ bypass: ticket, workflow: workflow({ ui: 'composer', phase: 'reviewing' }) }),
        0,
      ),
    ).toEqual({ kind: 'bypass', text: '초안', ticket })
  })
})

describe('classifySubmission — rule 7: slash and shell', () => {
  test('slash commands pass to the engine', () => {
    expect(classifySubmission(submit({ text: '/optimize off' }), config(), state(), 0)).toEqual({
      kind: 'pass',
      reason: 'slash-command',
    })
  })

  test('shell input passes to the engine', () => {
    expect(classifySubmission(submit({ text: '!ls -la' }), config(), state(), 0)).toEqual({
      kind: 'pass',
      reason: 'shell',
    })
  })

  test('a slash command passes even while the optimizer is disabled', () => {
    expect(
      classifySubmission(submit({ text: '/clear' }), config({ enabled: false }), state(), 0),
    ).toEqual({ kind: 'pass', reason: 'slash-command' })
  })

  test('a command during a composer dialogue is not a reply', () => {
    expect(
      classifySubmission(
        submit({ text: '/optimize accept' }),
        config(),
        state({ workflow: workflow({ ui: 'composer', phase: 'reviewing' }) }),
        0,
      ),
    ).toEqual({ kind: 'pass', reason: 'slash-command' })
  })

  test('shell input during a composer dialogue is not a reply', () => {
    expect(
      classifySubmission(
        submit({ text: '!git status' }),
        config(),
        state({ workflow: workflow({ ui: 'composer', phase: 'reviewing' }) }),
        0,
      ),
    ).toEqual({ kind: 'pass', reason: 'shell' })
  })
})

describe('classifySubmission — rule 9: disabled', () => {
  test('a disabled optimizer passes ordinary text', () => {
    expect(classifySubmission(submit(), config({ enabled: false }), state(), 0)).toEqual({
      kind: 'pass',
      reason: 'disabled',
    })
  })

  test('a disabled optimizer passes even an over-long prompt as disabled', () => {
    expect(
      classifySubmission(submit({ text: 'a'.repeat(6001) }), config({ enabled: false }), state(), 0),
    ).toEqual({ kind: 'pass', reason: 'disabled' })
  })
})

describe('classifySubmission — rule 10: over-limit', () => {
  test('exactly the cap still optimizes', () => {
    const text = 'a'.repeat(6000)
    expect(classifySubmission(submit({ text }), config(), state(), 0)).toEqual({
      kind: 'optimize',
      text,
      trigger: 'auto',
    })
  })

  test('one character over the cap passes', () => {
    expect(classifySubmission(submit({ text: 'a'.repeat(6001) }), config(), state(), 0)).toEqual({
      kind: 'pass',
      reason: 'over-limit',
    })
  })

  test('the cap is measured before the trigger prefix is stripped', () => {
    expect(
      classifySubmission(
        submit({ text: `?? ${'a'.repeat(5998)}` }),
        config({ triggerMode: 'prefix' }),
        state(),
        0,
      ),
    ).toEqual({ kind: 'pass', reason: 'over-limit' })
  })
})

describe('classifySubmission — rule 11: prefix mode', () => {
  test('the trigger prefix is required and stripped', () => {
    expect(
      classifySubmission(submit({ text: '?? 로그인 오류를 고쳐줘' }), config({ triggerMode: 'prefix' }), state(), 0),
    ).toEqual({ kind: 'optimize', text: '로그인 오류를 고쳐줘', trigger: 'prefix' })
  })

  test('the stripped remainder is trimmed', () => {
    expect(
      classifySubmission(submit({ text: '??    hello   ' }), config({ triggerMode: 'prefix' }), state(), 0),
    ).toEqual({ kind: 'optimize', text: 'hello', trigger: 'prefix' })
  })

  test('a bare prefix is a blank escape, not empty input', () => {
    // Only the trigger was typed; there is nothing to improve. It becomes a
    // blank raw escape so the controller drops it with 보낼 내용이 없습니다.
    expect(
      classifySubmission(submit({ text: '??    ' }), config({ triggerMode: 'prefix' }), state(), 0),
    ).toEqual({ kind: 'raw', text: '' })
  })

  test('a bare prefix trimmed by the CLI is still a blank escape', () => {
    expect(
      classifySubmission(submit({ text: '??' }), config({ triggerMode: 'prefix' }), state(), 0),
    ).toEqual({ kind: 'raw', text: '' })
  })

  test('text without the trigger passes', () => {
    expect(
      classifySubmission(submit({ text: '로그인 오류를 고쳐줘' }), config({ triggerMode: 'prefix' }), state(), 0),
    ).toEqual({ kind: 'pass', reason: 'no-trigger' })
  })

  test('an approval reply without the trigger still passes as no-trigger', () => {
    expect(classifySubmission(submit({ text: '응' }), config({ triggerMode: 'prefix' }), state(), 0)).toEqual({
      kind: 'pass',
      reason: 'no-trigger',
    })
  })

  test('a configured trigger prefix is honored literally', () => {
    expect(
      classifySubmission(
        submit({ text: '## 다듬어줘' }),
        config({ triggerMode: 'prefix', triggerPrefix: '## ' }),
        state(),
        0,
      ),
    ).toEqual({ kind: 'optimize', text: '다듬어줘', trigger: 'prefix' })
  })

  test('an empty trigger prefix never triggers', () => {
    expect(
      classifySubmission(
        submit({ text: '그대로' }),
        config({ triggerMode: 'prefix', triggerPrefix: '' }),
        state(),
        0,
      ),
    ).toEqual({ kind: 'pass', reason: 'no-trigger' })
  })

  test('a disabled optimizer outranks prefix mode', () => {
    expect(
      classifySubmission(
        submit({ text: '?? 무시' }),
        config({ enabled: false, triggerMode: 'prefix' }),
        state(),
        0,
      ),
    ).toEqual({ kind: 'pass', reason: 'disabled' })
  })
})

describe('classifySubmission — rule 12: smart mode', () => {
  const smart = config({ triggerMode: 'smart' })

  test('the exact whole-input approvals pass with smart-continuation', () => {
    for (const text of ['응', '계속', '진행해']) {
      expect(classifySubmission(submit({ text }), smart, state(), 0)).toEqual({
        kind: 'pass',
        reason: 'smart-continuation',
      })
    }
  })

  test('surrounding whitespace still matches, and the decision carries no text change', () => {
    for (const text of [' 응', '응 ', '  계속  ', '\t진행해\n']) {
      expect(classifySubmission(submit({ text }), smart, state(), 0)).toEqual({
        kind: 'pass',
        reason: 'smart-continuation',
      })
    }
  })

  test('characters trim() removes at the edges still match the approval', () => {
    // U+FEFF (BOM/zero-width no-break space) and U+00A0 (no-break space) count
    // as leading/trailing whitespace to trim(), so the plan's trim() contract
    // passes them; only characters trim() keeps, such as U+200B, block a pass.
    for (const text of ['응\uFEFF', '응\u00A0', '\uFEFF계속\u00A0']) {
      expect(classifySubmission(submit({ text }), smart, state(), 0)).toEqual({
        kind: 'pass',
        reason: 'smart-continuation',
      })
    }
  })

  test('punctuation, variants and longer sentences conservatively optimize', () => {
    for (const text of ['응.', '응?', '계속해', '네', 'yes', '응요']) {
      expect(classifySubmission(submit({ text }), smart, state(), 0)).toEqual({
        kind: 'optimize',
        text,
        trigger: 'auto',
      })
    }
  })

  test('short new requests, negations and mixed approvals are never bypassed', () => {
    for (const text of ['운영 DB 삭제해', '응, 대신 DB 구조도 바꿔줘', '응 하지마', '아니', '계속\nDB도 변경']) {
      expect(classifySubmission(submit({ text }), smart, state(), 0)).toEqual({
        kind: 'optimize',
        text,
        trigger: 'auto',
      })
    }
  })

  test('emoji, code, quotes and characters trim() does not remove are not approvals', () => {
    for (const text of ['응🚀', '`응`', '"응"', '응\u200b']) {
      expect(classifySubmission(submit({ text }), smart, state(), 0)).toEqual({
        kind: 'optimize',
        text,
        trigger: 'auto',
      })
    }
  })

  test('the explicit trigger prefix still optimizes the stripped remainder', () => {
    expect(classifySubmission(submit({ text: '?? 응' }), smart, state(), 0)).toEqual({
      kind: 'optimize',
      text: '응',
      trigger: 'prefix',
    })
  })

  test('the trigger prefix wins over a pasted draft', () => {
    expect(classifySubmission(submit({ text: '?? 응' }), smart, state(), 0, { pasted: true })).toEqual({
      kind: 'optimize',
      text: '응',
      trigger: 'prefix',
    })
  })

  test('a bare trigger stays a blank raw escape', () => {
    expect(classifySubmission(submit({ text: '??' }), smart, state(), 0)).toEqual({ kind: 'raw', text: '' })
    expect(classifySubmission(submit({ text: '??   ' }), smart, state(), 0)).toEqual({ kind: 'raw', text: '' })
  })

  test('a custom prefix is honored literally', () => {
    expect(
      classifySubmission(
        submit({ text: '## 다듬어줘' }),
        config({ triggerMode: 'smart', triggerPrefix: '## ' }),
        state(),
        0,
      ),
    ).toEqual({ kind: 'optimize', text: '다듬어줘', trigger: 'prefix' })
  })

  test('an empty configured prefix matches nothing instead of everything', () => {
    const emptyPrefix = config({ triggerMode: 'smart', triggerPrefix: '' })
    expect(classifySubmission(submit({ text: '응' }), emptyPrefix, state(), 0)).toEqual({
      kind: 'pass',
      reason: 'smart-continuation',
    })
    expect(classifySubmission(submit({ text: '그대로' }), emptyPrefix, state(), 0)).toEqual({
      kind: 'optimize',
      text: '그대로',
      trigger: 'auto',
    })
  })

  test('a pasted unprefixed approval keeps the paste reason while bypass is on', () => {
    expect(classifySubmission(submit({ text: '응' }), smart, state(), 0, { pasted: true })).toEqual({
      kind: 'pass',
      reason: 'pasted',
    })
  })

  test('with pasteBypass off, a pasted approval falls through to smart-continuation', () => {
    expect(
      classifySubmission(submit({ text: '응' }), config({ triggerMode: 'smart', pasteBypass: false }), state(), 0, {
        pasted: true,
      }),
    ).toEqual({ kind: 'pass', reason: 'smart-continuation' })
  })

  test('the higher rules still win under smart mode', () => {
    const ticket = bypass()
    const mode = { sessionId: SESSION, draft: '초안' }
    // origin, turn, queue, attachments, empty
    expect(classifySubmission(submit({ text: '응', origin: { kind: 'sdk' } }), smart, state(), 0)).toEqual({
      kind: 'pass',
      reason: 'not-composer',
    })
    expect(classifySubmission(submit({ text: '응', turnId: 't1' }), smart, state(), 0)).toEqual({
      kind: 'pass',
      reason: 'mid-turn',
    })
    expect(classifySubmission(submit({ text: '응', wait: true }), smart, state(), 0)).toEqual({
      kind: 'pass',
      reason: 'queued',
    })
    expect(classifySubmission(submit({ text: '응', attachments: [{ type: 'image' }] }), smart, state(), 0)).toEqual({
      kind: 'pass',
      reason: 'attachments',
    })
    expect(classifySubmission(submit({ text: '   ' }), smart, state(), 0)).toEqual({
      kind: 'pass',
      reason: 'empty',
    })
    // raw mode and bypass ticket
    expect(classifySubmission(submit({ text: '응' }), smart, state({ rawMode: mode }), 0)).toEqual({
      kind: 'raw',
      text: '응',
    })
    expect(classifySubmission(submit({ text: ticket.text }), smart, state({ bypass: ticket }), 0)).toEqual({
      kind: 'bypass',
      text: ticket.text,
      ticket,
    })
    // slash and shell
    expect(classifySubmission(submit({ text: '/clear' }), smart, state(), 0)).toEqual({
      kind: 'pass',
      reason: 'slash-command',
    })
    expect(classifySubmission(submit({ text: '!ls' }), smart, state(), 0)).toEqual({
      kind: 'pass',
      reason: 'shell',
    })
    // disabled and over-limit
    expect(classifySubmission(submit({ text: '응' }), config({ triggerMode: 'smart', enabled: false }), state(), 0)).toEqual({
      kind: 'pass',
      reason: 'disabled',
    })
    expect(classifySubmission(submit({ text: '응'.repeat(6001) }), smart, state(), 0)).toEqual({
      kind: 'pass',
      reason: 'over-limit',
    })
  })

  test('an active composer dialogue takes the approval as a reply, not a bypass', () => {
    expect(
      classifySubmission(
        submit({ text: '응' }),
        smart,
        state({ workflow: workflow({ ui: 'composer', phase: 'reviewing' }) }),
        0,
      ),
    ).toEqual({ kind: 'reply', workflowId: 'wf-1', text: '응' })
    expect(
      classifySubmission(
        submit({ text: '계속' }),
        smart,
        state({ workflow: workflow({ ui: 'composer', phase: 'failed' }) }),
        0,
      ),
    ).toEqual({ kind: 'reply', workflowId: 'wf-1', text: '계속' })
  })

  test('a workflow mid-flight or held by the pane is busy', () => {
    expect(
      classifySubmission(
        submit({ text: '응' }),
        smart,
        state({ workflow: workflow({ ui: 'composer', phase: 'generating' }) }),
        0,
      ),
    ).toEqual({ kind: 'busy', workflowId: 'wf-1' })
    expect(
      classifySubmission(
        submit({ text: '응' }),
        smart,
        state({ workflow: workflow({ ui: 'pane', phase: 'reviewing' }) }),
        0,
      ),
    ).toEqual({ kind: 'busy', workflowId: 'wf-1' })
  })
})

describe('classifySubmission — rule 13: pasted draft', () => {
  test('a pasted-only draft in always mode passes as pasted', () => {
    expect(classifySubmission(submit(), config(), state(), 0, { pasted: true })).toEqual({
      kind: 'pass',
      reason: 'pasted',
    })
  })

  test('facts.pasted false keeps the ordinary optimize', () => {
    expect(classifySubmission(submit(), config(), state(), 0, { pasted: false })).toEqual({
      kind: 'optimize',
      text: '로그인 오류를 고쳐줘',
      trigger: 'auto',
    })
  })

  test('an absent facts argument keeps the older behavior', () => {
    expect(classifySubmission(submit(), config(), state(), 0)).toEqual({
      kind: 'optimize',
      text: '로그인 오류를 고쳐줘',
      trigger: 'auto',
    })
    expect(classifySubmission(submit({ text: 'a'.repeat(6001) }), config(), state(), 0)).toEqual({
      kind: 'pass',
      reason: 'over-limit',
    })
  })

  test('turning pasteBypass off optimizes the pasted draft', () => {
    expect(
      classifySubmission(submit(), config({ pasteBypass: false }), state(), 0, { pasted: true }),
    ).toEqual({ kind: 'optimize', text: '로그인 오류를 고쳐줘', trigger: 'auto' })
  })

  test('the prefix trigger outranks a pasted draft', () => {
    expect(
      classifySubmission(
        submit({ text: '?? 붙여넣은 텍스트' }),
        config({ triggerMode: 'prefix' }),
        state(),
        0,
        { pasted: true },
      ),
    ).toEqual({ kind: 'optimize', text: '붙여넣은 텍스트', trigger: 'prefix' })
  })

  test('an untriggered pasted draft in prefix mode still passes as no-trigger', () => {
    expect(
      classifySubmission(submit(), config({ triggerMode: 'prefix' }), state(), 0, { pasted: true }),
    ).toEqual({ kind: 'pass', reason: 'no-trigger' })
  })

  test('an active composer dialogue takes a pasted draft as a reply', () => {
    expect(
      classifySubmission(
        submit({ text: '반복 지시' }),
        config(),
        state({ workflow: workflow({ ui: 'composer', phase: 'reviewing' }) }),
        0,
        { pasted: true },
      ),
    ).toEqual({ kind: 'reply', workflowId: 'wf-1', text: '반복 지시' })
  })

  test('a matching bypass ticket outranks a pasted draft', () => {
    const ticket = bypass()
    expect(
      classifySubmission(submit({ text: ticket.text }), config(), state({ bypass: ticket }), 0, {
        pasted: true,
      }),
    ).toEqual({ kind: 'bypass', text: '초안', ticket })
  })

  test('an armed raw mode outranks a pasted draft', () => {
    expect(
      classifySubmission(submit({ text: '>> 그대로' }), config(), state({ rawMode: { sessionId: SESSION, draft: '>> 그대로' } }), 0, {
        pasted: true,
      }),
    ).toEqual({ kind: 'raw', text: '>> 그대로' })
  })

  test('a disabled optimizer outranks a pasted draft', () => {
    expect(
      classifySubmission(submit(), config({ enabled: false }), state(), 0, { pasted: true }),
    ).toEqual({ kind: 'pass', reason: 'disabled' })
  })
})

describe('classifySubmission — rule 14: always mode', () => {
  test('ordinary text optimizes on the text as typed', () => {
    expect(classifySubmission(submit({ text: '  로그인 오류를 고쳐줘  ' }), config(), state(), 0)).toEqual({
      kind: 'optimize',
      text: '  로그인 오류를 고쳐줘  ',
      trigger: 'auto',
    })
  })

  test('Korean and emoji text optimizes unchanged', () => {
    const text = '🚀 배포 스크립트를 한국어 주석과 함께 작성해줘'
    expect(classifySubmission(submit({ text }), config(), state(), 0)).toEqual({
      kind: 'optimize',
      text,
      trigger: 'auto',
    })
  })

  test('always mode still optimizes a typed approval reply', () => {
    expect(classifySubmission(submit({ text: '응' }), config(), state(), 0)).toEqual({
      kind: 'optimize',
      text: '응',
      trigger: 'auto',
    })
  })

  test('always mode keeps its own treatment of prefix text (no stripping)', () => {
    expect(classifySubmission(submit({ text: '?? 응' }), config(), state(), 0)).toEqual({
      kind: 'optimize',
      text: '?? 응',
      trigger: 'auto',
    })
  })
})
