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

describe('classifySubmission — rule 5: bypass', () => {
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

describe('classifySubmission — rule 6: raw prefix', () => {
  test('the marker strips itself and keeps the rest as typed', () => {
    expect(classifySubmission(submit({ text: '::raw 로그인 오류를 고쳐줘' }), config(), state(), 0)).toEqual({
      kind: 'raw',
      text: '로그인 오류를 고쳐줘',
    })
  })

  test('extra spacing after the marker is preserved', () => {
    expect(classifySubmission(submit({ text: '::raw  two spaces' }), config(), state(), 0)).toEqual({
      kind: 'raw',
      text: ' two spaces',
    })
  })

  test('a marker followed by only spaces is raw, untrimmed', () => {
    expect(classifySubmission(submit({ text: '::raw    ' }), config(), state(), 0)).toEqual({
      kind: 'raw',
      text: '   ',
    })
  })

  test('a bare marker with an empty remainder is raw too', () => {
    // The controller drops the blank raw submission; the classifier still
    // strips the marker so it never reaches the main session as its own text.
    expect(classifySubmission(submit({ text: '::raw ' }), config(), state(), 0)).toEqual({
      kind: 'raw',
      text: '',
    })
  })

  test('the marker is matched case-sensitively', () => {
    expect(classifySubmission(submit({ text: '::RAW 그대로' }), config(), state(), 0)).toEqual({
      kind: 'optimize',
      text: '::RAW 그대로',
      trigger: 'auto',
    })
  })

  test('an empty raw prefix disables the escape', () => {
    expect(
      classifySubmission(submit({ text: '::raw 그대로' }), config({ rawPrefix: '' }), state(), 0),
    ).toEqual({ kind: 'optimize', text: '::raw 그대로', trigger: 'auto' })
  })

  test('raw still escapes while the optimizer is disabled', () => {
    expect(
      classifySubmission(submit({ text: '::raw 통과' }), config({ enabled: false }), state(), 0),
    ).toEqual({ kind: 'raw', text: '통과' })
  })

  test('raw wins over an active composer dialogue', () => {
    expect(
      classifySubmission(
        submit({ text: '::raw 통과' }),
        config(),
        state({ workflow: workflow({ ui: 'composer', phase: 'reviewing' }) }),
        0,
      ),
    ).toEqual({ kind: 'raw', text: '통과' })
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

  test('a bare prefix passes as empty', () => {
    expect(
      classifySubmission(submit({ text: '??    ' }), config({ triggerMode: 'prefix' }), state(), 0),
    ).toEqual({ kind: 'pass', reason: 'empty' })
  })

  test('text without the trigger passes', () => {
    expect(
      classifySubmission(submit({ text: '로그인 오류를 고쳐줘' }), config({ triggerMode: 'prefix' }), state(), 0),
    ).toEqual({ kind: 'pass', reason: 'no-trigger' })
  })

  test('a configured trigger prefix is honored literally', () => {
    expect(
      classifySubmission(
        submit({ text: '>> 다듬어줘' }),
        config({ triggerMode: 'prefix', triggerPrefix: '>> ' }),
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

describe('classifySubmission — rule 12: always mode', () => {
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
})
