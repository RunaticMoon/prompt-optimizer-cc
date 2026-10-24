import { describe, expect, test } from 'claude-code/testing'

import {
  DIFF_MAX_INPUT_CHARS,
  DIFF_MAX_LINE_PRODUCT,
  diffDraft,
  renderDraftDiff,
} from '../hooks/draft-diff'
import type { DraftDiff } from '../hooks/draft-diff'

/** Compact "kind:text" view of a comparison. */
function kinds(diff: DraftDiff): string[] {
  return diff.changes.map((change) => `${change.kind}:${change.text}`)
}

/** Replays one side of a comparison, proving that no text was truncated or normalized. */
function rebuild(diff: DraftDiff, side: 'before' | 'after'): string {
  const kept = side === 'before' ? new Set(['equal', 'remove']) : new Set(['equal', 'add'])
  return diff.changes
    .filter((change) => kept.has(change.kind))
    .map((change) => change.text)
    .join('\n')
}

describe('draft-diff — bounds', () => {
  test('the line table and input limits match the shared contract', () => {
    expect(DIFF_MAX_LINE_PRODUCT).toBe(40000)
    expect(DIFF_MAX_INPUT_CHARS).toBe(60000)
  })
})

describe('diffDraft — no change', () => {
  test('identical text has no changes and no counts', () => {
    const text = '# 목표\n- 첫 줄\n- 둘째 줄'
    const diff = diffDraft(text, text)
    expect(diff).toEqual({ changes: [], added: 0, removed: 0, coarse: false })
  })

  test('identical empty text has no changes', () => {
    expect(diffDraft('', '')).toEqual({ changes: [], added: 0, removed: 0, coarse: false })
  })
})

describe('diffDraft — additions, removals and replacements', () => {
  test('an empty side becomes only additions or only removals', () => {
    const added = diffDraft('', 'a\nb')
    expect(added.changes).toEqual([
      { kind: 'add', text: 'a', beforeLine: null, afterLine: 1 },
      { kind: 'add', text: 'b', beforeLine: null, afterLine: 2 },
    ])
    expect(added.added).toBe(2)
    expect(added.removed).toBe(0)
    expect(rebuild(added, 'before')).toBe('')

    const removed = diffDraft('a\nb', '')
    expect(removed.changes).toEqual([
      { kind: 'remove', text: 'a', beforeLine: 1, afterLine: null },
      { kind: 'remove', text: 'b', beforeLine: 2, afterLine: null },
    ])
    expect(removed.added).toBe(0)
    expect(removed.removed).toBe(2)
    expect(rebuild(removed, 'after')).toBe('')
  })

  test('an insertion keeps the surrounding lines and original line numbers', () => {
    const diff = diffDraft('a\nc', 'a\nb\nc')
    expect(kinds(diff)).toEqual(['equal:a', 'add:b', 'equal:c'])
    expect(diff.changes[1]).toEqual({ kind: 'add', text: 'b', beforeLine: null, afterLine: 2 })
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(0)
    expect(rebuild(diff, 'before')).toBe('a\nc')
    expect(rebuild(diff, 'after')).toBe('a\nb\nc')
  })

  test('a deletion removes only the missing line', () => {
    const diff = diffDraft('a\nb\nc', 'a\nc')
    expect(kinds(diff)).toEqual(['equal:a', 'remove:b', 'equal:c'])
    expect(diff.changes[1]).toEqual({ kind: 'remove', text: 'b', beforeLine: 2, afterLine: null })
    expect(diff.added).toBe(0)
    expect(diff.removed).toBe(1)
  })

  test('a replacement is a removal followed by an addition', () => {
    const diff = diffDraft('keep\nold\nkeep', 'keep\nnew\nkeep')
    expect(kinds(diff)).toEqual(['equal:keep', 'remove:old', 'add:new', 'equal:keep'])
    expect(diff.changes[1]).toEqual({ kind: 'remove', text: 'old', beforeLine: 2, afterLine: null })
    expect(diff.changes[2]).toEqual({ kind: 'add', text: 'new', beforeLine: null, afterLine: 2 })
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
  })
})

describe('diffDraft — exact text', () => {
  test('multiline Korean and emoji stay on their original lines', () => {
    const before = '목표: 😀 유지\n삭제할 줄\n공통 ✅'
    const after = '목표: 😀 유지\n추가한 줄 🚀\n공통 ✅'
    const diff = diffDraft(before, after)
    expect(kinds(diff)).toEqual([
      'equal:목표: 😀 유지',
      'remove:삭제할 줄',
      'add:추가한 줄 🚀',
      'equal:공통 ✅',
    ])
    expect(rebuild(diff, 'before')).toBe(before)
    expect(rebuild(diff, 'after')).toBe(after)
  })

  test('whitespace and tabs are compared literally', () => {
    const diff = diffDraft('  a\t \n b', '  a\t \nB')
    expect(kinds(diff)).toEqual(['equal:  a\t ', 'remove: b', 'add:B'])
  })

  test('a trailing newline is an empty final line, not ignored', () => {
    const added = diffDraft('a\nb', 'a\nb\n')
    expect(kinds(added)).toEqual(['equal:a', 'equal:b', 'add:'])
    expect(added.changes[2]).toEqual({ kind: 'add', text: '', beforeLine: null, afterLine: 3 })
    expect(added.added).toBe(1)
    expect(added.removed).toBe(0)
    expect(rebuild(added, 'after')).toBe('a\nb\n')

    const removed = diffDraft('a\nb\n', 'a\nb')
    expect(kinds(removed)).toEqual(['equal:a', 'equal:b', 'remove:'])
    expect(removed.changes[2]).toEqual({ kind: 'remove', text: '', beforeLine: 3, afterLine: null })
    expect(removed.added).toBe(0)
    expect(removed.removed).toBe(1)
    expect(rebuild(removed, 'before')).toBe('a\nb\n')
  })

  test('a blank line inside the text is a real line', () => {
    const diff = diffDraft('a\n\nb', 'a\nb')
    expect(kinds(diff)).toEqual(['equal:a', 'remove:', 'equal:b'])
    expect(diff.changes[1].beforeLine).toBe(2)
  })
})

describe('diffDraft — deterministic repeated lines', () => {
  test('repeated equal lines produce the same result on every call', () => {
    const first = diffDraft('x\nx\nx', 'x\nx')
    const second = diffDraft('x\nx\nx', 'x\nx')
    expect(first).toEqual(second)
    expect(kinds(first)).toEqual(['equal:x', 'equal:x', 'remove:x'])
    expect(first.changes[2].beforeLine).toBe(3)
  })

  test('a tie removes before it adds', () => {
    const diff = diffDraft('a\nb\na', 'a\na')
    expect(kinds(diff)).toEqual(['equal:a', 'remove:b', 'equal:a'])
    expect(diff.changes[1].beforeLine).toBe(2)
    expect(diff.changes[2].beforeLine).toBe(3)
    expect(diff.changes[2].afterLine).toBe(2)
  })
})

describe('diffDraft — bounded fallback', () => {
  test('a single line beyond the input limit becomes an exact coarse block', () => {
    const before = 'x'.repeat(DIFF_MAX_INPUT_CHARS)
    const after = 'y'.repeat(DIFF_MAX_INPUT_CHARS)
    const diff = diffDraft(before, after)
    expect(diff.coarse).toBe(true)
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    expect(diff.changes).toEqual([
      { kind: 'remove', text: before, beforeLine: 1, afterLine: null },
      { kind: 'add', text: after, beforeLine: null, afterLine: 1 },
    ])
  })

  test('a line-count product beyond the limit keeps prefix/suffix and one block pair', () => {
    const base = Array.from({ length: 201 }, (_, index) => `line ${index + 1}`)
    const afterLines = [...base.slice(0, 100), 'new A', 'new B', ...base.slice(101)]
    const before = base.join('\n')
    const after = afterLines.join('\n')
    expect(base.length * afterLines.length).toBeGreaterThan(DIFF_MAX_LINE_PRODUCT)
    expect(before.length + after.length).toBeLessThan(DIFF_MAX_INPUT_CHARS)

    const diff = diffDraft(before, after)
    expect(diff.coarse).toBe(true)
    expect(diff.added).toBe(2)
    expect(diff.removed).toBe(1)
    expect(diff.changes.filter((change) => change.kind !== 'equal')).toEqual([
      { kind: 'remove', text: 'line 101', beforeLine: 101, afterLine: null },
      { kind: 'add', text: 'new A\nnew B', beforeLine: null, afterLine: 101 },
    ])
    expect(rebuild(diff, 'before')).toBe(before)
    expect(rebuild(diff, 'after')).toBe(after)
  })

  test('the exact line-count boundary still uses line LCS', () => {
    const base = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`)
    const afterLines = [...base.slice(0, 99), 'changed', ...base.slice(100)]
    const before = base.join('\n')
    const after = afterLines.join('\n')
    expect(base.length * afterLines.length).toBe(DIFF_MAX_LINE_PRODUCT)
    expect(before.length + after.length).toBeLessThan(DIFF_MAX_INPUT_CHARS)

    const diff = diffDraft(before, after)
    expect(diff.coarse).toBe(false)
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    expect(kinds(diff).filter((entry) => !entry.startsWith('equal:'))).toEqual([
      'remove:line 100',
      'add:changed',
    ])
    expect(rebuild(diff, 'before')).toBe(before)
    expect(rebuild(diff, 'after')).toBe(after)
  })
})

describe('renderDraftDiff', () => {
  test('renders a count heading and -/+ prefixes without color', () => {
    const text = renderDraftDiff(diffDraft('keep\nold', 'keep\nnew'))
    expect(text).toBe('변경: +1 -1\n keep\n-old\n+new')
    expect(text).not.toContain('\u001b')
  })

  test('marks every line of a coarse block and labels the comparison', () => {
    const base = Array.from({ length: 201 }, (_, index) => `line ${index + 1}`)
    const after = [...base.slice(0, 100), 'new A', 'new B', ...base.slice(101)].join('\n')
    const text = renderDraftDiff(diffDraft(base.join('\n'), after))
    expect(text).toContain('변경: +2 -1 (블록 비교)')
    expect(text).toContain('-line 101')
    expect(text).toContain('+new A\n+new B')
  })

  test('states plainly when nothing changed', () => {
    expect(renderDraftDiff(diffDraft('same', 'same'))).toBe(
      '변경: +0 -0\n변경된 줄이 없습니다.',
    )
  })
})
