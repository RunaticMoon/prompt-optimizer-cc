/**
 * One-column textual comparison between two draft revisions (#31).
 *
 * Pure and synchronous: it reads two exact strings and returns the lines that
 * stayed, appeared and disappeared, with their original line numbers. It never
 * reads workflow state, the engine or the composer, so the comparison can be
 * cached and tested in isolation.
 *
 * The comparison is textual only. A changed line is a removal plus an
 * addition; nothing claims that a generated sentence is covered by a source or
 * that an unchanged sentence was agreed to. Blank lines and trailing newlines
 * are significant, and no whitespace is normalized.
 *
 * Line LCS is bounded: when either input grows past the limits below, the
 * shared line prefix and suffix are kept and everything between them becomes
 * one removal block and one addition block, marked `coarse`. Source strings are
 * never truncated.
 */

/** The kind of one line, or one coarse block, in a draft comparison. */
export type DraftDiffKind = 'equal' | 'add' | 'remove'

/** One unchanged line, one added line, or one removed line/block. */
export interface DraftDiffChange {
  kind: DraftDiffKind
  /** Exact text, without the `-`/`+` display marker. Coarse blocks may span lines. */
  text: string
  /** 1-based first line in `before`; null for an addition. */
  beforeLine: number | null
  /** 1-based first line in `after`; null for a removal. */
  afterLine: number | null
}

/** The result of comparing two draft texts. */
export interface DraftDiff {
  /** Ordered comparison: unchanged, removed and added lines or blocks. */
  changes: readonly DraftDiffChange[]
  /** Number of lines that appear only in `after`. */
  added: number
  /** Number of lines that appear only in `before`. */
  removed: number
  /** True when the inputs were too large for line LCS and a block comparison was used. */
  coarse: boolean
}

/** Largest `before`-lines x `after`-lines product that still uses line LCS. */
export const DIFF_MAX_LINE_PRODUCT = 40000

/** Largest combined UTF-16 length that still uses line LCS. */
export const DIFF_MAX_INPUT_CHARS = 60000

/**
 * Splits text into lines while keeping a final newline significant.
 *
 * An empty string is zero lines, while `"a\n"` is the line `"a"` plus an empty
 * final line, so `join('\n')` reproduces the input exactly.
 */
function toLines(text: string): string[] {
  return text === '' ? [] : text.split('\n')
}

/** Compares line by line with a bounded LCS table. */
function diffLines(before: readonly string[], after: readonly string[]): DraftDiff {
  const n = before.length
  const m = after.length
  // table[i][j] is the LCS length of before[i...] and after[j...].
  const table: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = table[i]
    const below = table[i + 1]
    if (!row || !below) continue
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] =
        before[i] === after[j]
          ? (below[j + 1] ?? 0) + 1
          : Math.max(below[j] ?? 0, row[j + 1] ?? 0)
    }
  }

  const changes: DraftDiffChange[] = []
  let added = 0
  let removed = 0
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const row = table[i]
    const below = table[i + 1]
    if (!row || !below) break
    const beforeLine = before[i] ?? ''
    if (beforeLine === after[j]) {
      changes.push({ kind: 'equal', text: beforeLine, beforeLine: i + 1, afterLine: j + 1 })
      i += 1
      j += 1
    } else if ((below[j] ?? 0) >= (row[j + 1] ?? 0)) {
      // On a tie, remove first so a replacement renders as '-' then '+'.
      changes.push({ kind: 'remove', text: beforeLine, beforeLine: i + 1, afterLine: null })
      removed += 1
      i += 1
    } else {
      changes.push({ kind: 'add', text: after[j] ?? '', beforeLine: null, afterLine: j + 1 })
      added += 1
      j += 1
    }
  }
  while (i < n) {
    changes.push({ kind: 'remove', text: before[i] ?? '', beforeLine: i + 1, afterLine: null })
    removed += 1
    i += 1
  }
  while (j < m) {
    changes.push({ kind: 'add', text: after[j] ?? '', beforeLine: null, afterLine: j + 1 })
    added += 1
    j += 1
  }
  return { changes, added, removed, coarse: false }
}

/** Keeps the shared line prefix/suffix and reports the middle as blocks. */
function diffBlocks(before: readonly string[], after: readonly string[]): DraftDiff {
  const shortest = Math.min(before.length, after.length)
  let prefix = 0
  while (prefix < shortest && before[prefix] === after[prefix]) prefix += 1

  let suffix = 0
  while (
    suffix < shortest - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const changes: DraftDiffChange[] = []
  let added = 0
  let removed = 0
  for (let i = 0; i < prefix; i += 1) {
    changes.push({ kind: 'equal', text: before[i] ?? '', beforeLine: i + 1, afterLine: i + 1 })
  }

  const beforeMiddle = before.slice(prefix, before.length - suffix)
  const afterMiddle = after.slice(prefix, after.length - suffix)
  if (beforeMiddle.length > 0) {
    changes.push({
      kind: 'remove',
      text: beforeMiddle.join('\n'),
      beforeLine: prefix + 1,
      afterLine: null,
    })
    removed = beforeMiddle.length
  }
  if (afterMiddle.length > 0) {
    changes.push({
      kind: 'add',
      text: afterMiddle.join('\n'),
      beforeLine: null,
      afterLine: prefix + 1,
    })
    added = afterMiddle.length
  }

  for (let k = 0; k < suffix; k += 1) {
    const beforeIndex = before.length - suffix + k
    const afterIndex = after.length - suffix + k
    changes.push({
      kind: 'equal',
      text: before[beforeIndex] ?? '',
      beforeLine: beforeIndex + 1,
      afterLine: afterIndex + 1,
    })
  }
  return { changes, added, removed, coarse: true }
}

/**
 * Compares two exact draft texts for one-column review.
 *
 * Identical texts produce no changes. Otherwise small enough inputs use line
 * LCS; larger inputs keep the shared prefix/suffix and report the middle as
 * coarse blocks. `before` and `after` are not truncated or modified.
 *
 * @param before the baseline draft (original or previous successful revision)
 * @param after the draft being reviewed
 * @returns ordered changes, added/removed line counts and whether it was coarse
 */
export function diffDraft(before: string, after: string): DraftDiff {
  if (before === after) return { changes: [], added: 0, removed: 0, coarse: false }

  const beforeLines = toLines(before)
  const afterLines = toLines(after)
  const bounded =
    beforeLines.length * afterLines.length <= DIFF_MAX_LINE_PRODUCT &&
    before.length + after.length <= DIFF_MAX_INPUT_CHARS
  return bounded ? diffLines(beforeLines, afterLines) : diffBlocks(beforeLines, afterLines)
}

/** Marker shown before each rendered change line; a space keeps equal lines aligned. */
const KIND_MARK: Readonly<Record<DraftDiffKind, string>> = {
  equal: ' ',
  add: '+',
  remove: '-',
}

/**
 * Renders a comparison as plain, one-column text with a count heading.
 *
 * Counts and `-`/`+` markers carry the meaning without color. Equal lines are
 * prefixed with a space, and every line of a coarse block is marked.
 *
 * @param diff the result of {@link diffDraft}
 * @returns a heading plus one display line per change line
 */
export function renderDraftDiff(diff: DraftDiff): string {
  const heading = `변경: +${diff.added} -${diff.removed}${diff.coarse ? ' (블록 비교)' : ''}`
  if (diff.changes.length === 0) return `${heading}\n변경된 줄이 없습니다.`
  const body = diff.changes
    .map((change) =>
      change.text
        .split('\n')
        .map((line) => `${KIND_MARK[change.kind]}${line}`)
        .join('\n'),
    )
    .join('\n')
  return `${heading}\n${body}`
}
