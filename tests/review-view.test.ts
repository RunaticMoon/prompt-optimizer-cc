import { describe, expect, test } from 'claude-code/testing'

import type { ContextSnapshot, RepositorySource, UserDecision, Workflow } from '../hooks/contracts'
import { DIFF_MAX_LINES, NO_PREVIOUS_NOTICE, formatDraftDiff, formatShow, formatSources } from '../hooks/review-view'

const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
} as const

function decision(over: Partial<UserDecision> = {}): UserDecision {
  return {
    id: 'd1',
    text: '로컬에서만 처리',
    source: {
      kind: 'user-answer',
      questionId: 'q:wf-1:1:1',
      question: '처리 위치는?',
      options: ['로컬', '외부'],
      answeredAfterRound: 1,
    },
    ...over,
  }
}

function context(over: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    conversation: '',
    rules: '',
    location: '',
    tools: '',
    text: '',
    chars: 0,
    ...over,
  }
}

function workflow(over: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    sessionId: 'sess-1',
    generation: 0,
    phase: 'reviewing',
    original: '원본 요청',
    originalContext: [],
    draft: '개선된 요청',
    context: null,
    dialogue: [],
    rounds: 1,
    ui: 'composer',
    usage: ZERO_USAGE,
    ...over,
  }
}

describe('formatShow', () => {
  test('renders the whole stored text verbatim under its label', () => {
    const text = '첫 줄\n  들여쓴 둘째 줄\t탭 유지\n'
    expect(formatShow('현재 개선안:', text)).toBe(`현재 개선안:\n${text}`)
  })
})

describe('formatDraftDiff', () => {
  test('titles each baseline and reports identical texts without changes', () => {
    for (const baseline of ['original', 'previous'] as const) {
      const title = baseline === 'original' ? '원문 대비 변경' : '직전 성공 라운드 대비 변경'
      const text = formatDraftDiff('같은 텍스트', '같은 텍스트', baseline)
      expect(text).toContain(title)
      expect(text).toContain('변경: +0 -0')
      expect(text).toContain('변경된 줄이 없습니다.')
    }
  })

  test('renders removals before additions with exact lines and counts', () => {
    const text = formatDraftDiff('첫 줄\n옛 줄\n끝', '첫 줄\n새 줄\n끝', 'previous')
    expect(text).toContain('직전 성공 라운드 대비 변경')
    expect(text).toContain('변경: +1 -1')
    expect(text).toContain('-옛 줄')
    expect(text).toContain('+새 줄')
  })

  test('summarizes beyond the kept window with the omitted count and a show pointer', () => {
    // No shared line: one removal plus 101 additions, 102 rendered body lines.
    const after = ['새 줄', ...Array.from({ length: 100 }, (_, i) => `새 줄 ${i + 1}`)].join('\n')
    const text = formatDraftDiff('옛 줄', after, 'original')
    const lines = text.split('\n')
    expect(text).toContain('변경: +101 -1')
    // Title, heading, the kept window of 80, then the omitted-count line.
    expect(lines).toHaveLength(83)
    expect(lines.filter(line => line.startsWith('+새 줄'))).toHaveLength(79)
    expect(lines.filter(line => line.startsWith('-'))).toHaveLength(1)
    expect(text).toContain(`… 외 ${102 - DIFF_MAX_LINES}줄 요약 생략`)
    expect(text).toContain('전체 텍스트는 /optimize show original 과 /optimize show 로 확인')
  })

  test('a long unchanged stretch never pushes the actual change out of the window', () => {
    // 100 equal lines, then one replacement at the end: 102 rendered body lines.
    const head = Array.from({ length: 100 }, (_, i) => `줄 ${i + 1}`)
    const text = formatDraftDiff([...head, '옛 마지막'].join('\n'), [...head, '새 마지막'].join('\n'), 'original')
    const lines = text.split('\n')
    expect(text).toContain('변경: +1 -1')
    // The changed lines lead the kept window; equal lines only fill the space left.
    expect(lines[2]).toBe('-옛 마지막')
    expect(lines[3]).toBe('+새 마지막')
    expect(lines).toHaveLength(83)
    expect(lines.filter(line => line.startsWith(' 줄 '))).toHaveLength(78)
    expect(text).toContain(`… 외 ${102 - DIFF_MAX_LINES}줄 요약 생략`)
  })

  test('the previous baseline points at show previous for the full text', () => {
    const after = Array.from({ length: DIFF_MAX_LINES + 5 }, (_, i) => `줄 ${i}`).join('\n')
    const text = formatDraftDiff('옛 줄', after, 'previous')
    expect(text).toContain('전체 텍스트는 /optimize show previous 와 /optimize show 로 확인')
  })

  test('a comparison within the window is shown whole', () => {
    const after = ['새 줄', ...Array.from({ length: DIFF_MAX_LINES - 2 }, (_, i) => `줄 ${i}`)].join('\n')
    const text = formatDraftDiff('옛 줄', after, 'original')
    expect(text).not.toContain('요약 생략')
    expect(text).toContain(`변경: +${DIFF_MAX_LINES - 1} -1`)
  })
})

describe('formatSources', () => {
  test('lists decisions, collector records and the unconfirmed-proposal label', () => {
    const sources: RepositorySource[] = [
      { path: 'docs/GLOSSARY.md', excerpt: 'docs/GLOSSARY.md\n12: Node: resolved graph object', kind: 'domain' },
      { path: 'package.json', excerpt: 'package.json (declared scripts; not executed)\ntest: vitest run', kind: 'scripts' },
    ]
    const text = formatSources(workflow({
      decisions: { entries: [decision()], nextId: 2 },
      context: context({ repositorySources: sources }),
    }))

    expect(text).toContain('확정된 사용자 결정:')
    expect(text).toContain('- d1 · 활성')
    expect(text).toContain('출처: 사용자 답변 · 질문 q:wf-1:1:1')
    expect(text).toContain('수집한 저장소 근거 · 현재 요청 포함 여부는 별도:')
    // The excerpt's own path label is not repeated under the record header.
    expect(text).toContain('- [domain] docs/GLOSSARY.md')
    expect(text).toContain('  12: Node: resolved graph object')
    expect(text).not.toContain('- [domain] docs/GLOSSARY.md\n  docs/GLOSSARY.md')
    expect(text).toContain('- [scripts] package.json')
    expect(text).toContain('  test: vitest run')
    // The whole generated draft and change note stay unconfirmed.
    expect(text).toContain('미확정 제안: 개선안 전체와 변경 메모는 모델이 만든 제안입니다')
    expect(text).toContain('정정: /optimize correct <id> <내용> 후 /optimize retry')
  })

  test('says there are no records when the run collected none', () => {
    const text = formatSources(workflow({ decisions: { entries: [], nextId: 1 }, context: context() }))
    expect(text).toContain('읽고 선택한 저장소 파일이 없습니다.')
    expect(text).toContain('아직 기록된 사용자 답변이 없습니다.')
    expect(text).toContain('미확정 제안')
  })

  test('renders an excerpt body verbatim when it does not carry the path label', () => {
    const sources: RepositorySource[] = [{ path: 'src/a.ts', excerpt: '3: export const a = 1', kind: 'source' }]
    const text = formatSources(workflow({ context: context({ repositorySources: sources }) }))
    expect(text).toContain('- [source] src/a.ts')
    expect(text).toContain('  3: export const a = 1')
  })

  test('escapes control characters in a raw excerpt so it cannot break the list', () => {
    const sources: RepositorySource[] = [{
      path: 'src/evil.ts',
      excerpt: 'src/evil.ts\n1: 안전\r줄\t탭\u0007벨',
      kind: 'source',
    }]
    const text = formatSources(workflow({ context: context({ repositorySources: sources }) }))
    expect(text).toContain('- [source] src/evil.ts')
    // The hostile line keeps its place with every control character escaped.
    expect(text).toContain('  1: 안전\\r줄\\t탭\\u0007벨')
    expect(text.split('\n').filter(line => line.includes('안전'))).toHaveLength(1)
  })
})

describe('NO_PREVIOUS_NOTICE', () => {
  test('is the shared predecessor error', () => {
    expect(NO_PREVIOUS_NOTICE).toBe('비교할 이전 성공 라운드가 없습니다.')
  })
})
