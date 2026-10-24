/**
 * Read-only review formatting for the composer commands (#31).
 *
 * Everything here shapes text the reducer already holds: `show` renders one
 * stored text whole, `diff` renders a bounded one-column comparison via the
 * pure draft differ, and `sources` combines the decision ledger with the
 * collector's repository records. No model, filesystem, prompt or UI call
 * happens here, and nothing stored is rewritten: a draft, a change note and a
 * repository excerpt are displayed exactly as kept.
 */
import type { Workflow } from './contracts'
import { display, formatDecisions } from './decision-view'
import { diffDraft, renderDraftDiff } from './draft-diff'

/** The one-line predecessor error shared by `show previous` and `diff previous`. */
export const NO_PREVIOUS_NOTICE = '비교할 이전 성공 라운드가 없습니다.'

/** Rendered comparison lines kept before the remainder is summarized. */
export const DIFF_MAX_LINES = 80

/**
 * One stored text shown whole under its label, through the command's own
 * answer (never a fill and never the main transcript).
 */
export function formatShow(label: string, text: string): string {
  return `${label}\n${text}`
}

/**
 * Renders one comparison as one-column text under a baseline title.
 *
 * A comparison that outgrows the {@link DIFF_MAX_LINES}-line window fills the
 * window with the `-`/`+` change lines first and keeps equal lines only in
 * the space left, so a long unchanged stretch can never push an actual change
 * out of view. Anything not kept is summarized with the omitted count and a
 * pointer to `show` for the complete before/after texts. The heading's
 * added/removed counts always describe the whole comparison, not the kept
 * window.
 */
export function formatDraftDiff(
  before: string,
  after: string,
  baseline: 'original' | 'previous',
): string {
  const title = baseline === 'original' ? '원문 대비 변경' : '직전 성공 라운드 대비 변경'
  const rendered = renderDraftDiff(diffDraft(before, after))
  const [heading = '', ...body] = rendered.split('\n')
  if (body.length <= DIFF_MAX_LINES) return `${title}\n${rendered}`
  const kept = keepChangedFirst(body)
  const omitted = body.length - kept.length
  const showHint = baseline === 'original'
    ? '/optimize show original 과 /optimize show'
    : '/optimize show previous 와 /optimize show'
  return `${title}\n${heading}\n${kept.join('\n')}\n… 외 ${omitted}줄 요약 생략 · 전체 텍스트는 ${showHint} 로 확인`
}

/**
 * Picks the kept window so changed lines are never hidden: every `-`/`+` line
 * goes in first (in comparison order) and equal lines fill only the space
 * left. The marks come from {@link renderDraftDiff} itself, so a leading
 * `-`/`+` is reliably a change and any other leading character is context.
 */
function keepChangedFirst(body: readonly string[]): string[] {
  const changed: string[] = []
  const context: string[] = []
  for (const line of body) {
    if (line.startsWith('-') || line.startsWith('+')) changed.push(line)
    else context.push(line)
  }
  if (changed.length >= DIFF_MAX_LINES) return changed.slice(0, DIFF_MAX_LINES)
  return [...changed, ...context.slice(0, DIFF_MAX_LINES - changed.length)]
}

/** The standing label for every generated sentence, agreed or not. */
const UNCONFIRMED_NOTICE =
  '미확정 제안: 개선안 전체와 변경 메모는 모델이 만든 제안입니다. 근거 문장과 일치해도 사용자 합의가 아닙니다.'

/** Drops the excerpt's own leading path label; the record header names it. */
function excerptBody(excerpt: string, path: string): string {
  const headed = `${path}\n`
  if (excerpt.startsWith(headed)) return excerpt.slice(headed.length)
  const labelled = `${path} `
  if (excerpt.startsWith(labelled)) return excerpt.slice(labelled.length)
  return excerpt
}

/**
 * The `/optimize sources` body: the captured user decisions with their
 * sources (26's formatter), then the repository files the collector actually
 * read and selected, then the standing unconfirmed-proposal label for the
 * whole generated draft and change note.
 *
 * Excerpts are raw file content, so every line goes through 26's control
 * escape: the line structure stays, but a control character in the file can
 * neither break the list nor hide in the printed text.
 */
export function formatSources(workflow: Readonly<Workflow>): string {
  const sources = workflow.context?.repositorySources ?? []
  const lines: string[] = [formatDecisions(workflow), '', '수집한 저장소 근거 · 현재 요청 포함 여부는 별도:']
  if (sources.length === 0) {
    lines.push('읽고 선택한 저장소 파일이 없습니다.')
  } else {
    for (const source of sources) {
      lines.push(`- [${source.kind}] ${source.path}`)
      for (const line of excerptBody(source.excerpt, source.path).split('\n')) {
        lines.push(`  ${display(line)}`)
      }
    }
  }
  lines.push(UNCONFIRMED_NOTICE)
  return lines.join('\n')
}
