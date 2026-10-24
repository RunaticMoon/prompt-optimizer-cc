/**
 * Read-only rendering of a workflow's captured user decisions (#26).
 *
 * The formatter never changes the ledger: every answer and question is shown
 * through {@link display}, which escapes control characters so one entry
 * cannot break the command's line structure while the stored text stays
 * byte-exact. There is no model, filesystem or UI call here.
 */
import type { UserDecision, Workflow } from './contracts'
import { supersededBy } from './decisions'

/** Escapes line-breaking control characters without altering stored text. */
export function display(text: string): string {
  return text
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, character => {
      const code = (character.codePointAt(0) as number).toString(16).padStart(4, '0')
      return `\\u${code}`
    })
}

/**
 * The `/optimize decisions` body: the invariant original, every decision id
 * with its source, question, numbered choices, raw answer, resolved choice and
 * replaced-by state, then the source/proposal warning and correction hint.
 */
export function formatDecisions(workflow: Readonly<Workflow>): string {
  const ledger = workflow.decisions
  const lines: string[] = [
    '확정된 사용자 결정:',
    '원문: 사용자 원문 · 항상 적용되며 정정 id 대상이 아닙니다.',
  ]
  if (ledger === undefined || ledger.entries.length === 0) {
    lines.push('아직 기록된 사용자 답변이 없습니다.')
  } else {
    const replaced = supersededBy(ledger)
    for (const entry of ledger.entries) lines.push(...formatEntry(entry, replaced))
  }
  lines.push('초안·변경 메모·모델 추천은 확정된 사용자 결정이 아닙니다.')
  lines.push('정정: /optimize correct <id> <내용> 후 /optimize retry')
  return lines.join('\n')
}

/** One ledger entry as indented lines, including replaced history. */
function formatEntry(entry: UserDecision, replaced: ReadonlyMap<string, string>): string[] {
  const lines: string[] = []
  const replacement = replaced.get(entry.id)
  lines.push(`- ${entry.id} · ${replacement === undefined ? '활성' : `대체됨 → ${replacement}`}`)
  const source = entry.source
  const origin = source.questionId === null ? '사용자 답변' : `사용자 답변 · 질문 ${source.questionId}`
  lines.push(`  출처: ${origin} · 답변 시점 ${source.answeredAfterRound}라운드`)
  if (source.question !== null && source.question !== '') {
    lines.push(`  질문: ${display(source.question)}`)
  }
  if (source.options.length > 0) {
    const options = source.options.map((option, index) => `${index + 1}) ${display(option)}`)
    lines.push(`  선택지: ${options.join(' / ')}`)
  }
  lines.push(`  답변: ${display(entry.text)}`)
  if (entry.selectedOption !== undefined) {
    lines.push(`  선택: ${entry.selectedOption.index}) ${display(entry.selectedOption.text)}`)
  }
  if (entry.supersedes !== undefined) lines.push(`  이전 결정 대체: ${entry.supersedes}`)
  return lines
}
