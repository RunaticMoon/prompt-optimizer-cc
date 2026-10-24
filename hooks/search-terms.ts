/**
 * Deterministic bilingual search vocabulary for the bounded repository scan.
 *
 * This module owns extraction and aliasing only: no filesystem access, no
 * clock, no model call. Search representations are NFC-normalized and
 * lowercased; the caller's original text is never mutated. Korean particles
 * are peeled once at most, and a request ending is dropped only when a known
 * alias stem precedes it, so a one-syllable stem is never manufactured.
 *
 * Aliases are retrieval hints, not claims of semantic equivalence. Direct
 * input always outranks an alias, and a project mapping can only change which
 * file is read, never how its text is treated.
 */

/** One search keyword with its ranking weight and canonical concept key. */
export interface SearchTerm {
  /** Lowercased NFC surface form used for substring matching. */
  text: string
  /** Ranking weight: explicit path 128, identifier 32, Hangul 16, alias 8. */
  weight: number
  /** Canonical concept key shared by alias surfaces. */
  key: string
}

/** An ordered set of surfaces that share one canonical concept key. */
export type AliasGroup = readonly string[]

/** Ranking weights, kept together so path/line scoring stays consistent. */
export const SEARCH_WEIGHT = {
  path: 128,
  identifier: 32,
  hangul: 16,
  alias: 8,
} as const

/** Most unique terms one extraction returns. */
export const SEARCH_TERM_LIMIT = 28

/** Most direct Latin identifier surfaces kept from one request. */
export const SEARCH_LATIN_LIMIT = 20

/** Most project alias groups parsed from one glossary file. */
export const PROJECT_ALIAS_GROUP_LIMIT = 16

/** Largest glossary prefix inspected for explicit mappings. */
export const PROJECT_ALIAS_CHARS = 4096

/**
 * Built-in reversible concept groups. Every historical Korean alias keeps its
 * English expansion; the extra concepts are general retrieval hints only.
 */
export const BUILTIN_ALIASES: readonly AliasGroup[] = [
  ['로그인', 'login', 'auth', 'signin', 'sign-in'],
  ['장바구니', 'cart', 'basket'],
  ['회원가입', 'signup', 'sign-up', 'register'],
  ['로그아웃', 'logout', 'signout', 'sign-out'],
  ['주문', 'order', 'orders'],
  ['결제', 'payment', 'checkout'],
  ['검색', 'search'],
  ['업로드', 'upload'],
  ['다운로드', 'download'],
  ['노드', 'node'],
  ['이미지', 'image'],
  ['속성', 'property', 'properties'],
  ['이력', 'history', 'change'],
  ['차이', 'diff'],
  ['스웨거', 'swagger', 'openapi'],
]

/** Canonical concept key for each built-in group, in {@link BUILTIN_ALIASES} order. */
const BUILTIN_KEYS = [
  'login', 'cart', 'signup', 'logout', 'order', 'payment', 'search', 'upload',
  'download', 'node', 'image', 'property', 'history', 'diff', 'swagger',
]

/** Generic request words that must not steer ranking or target selection. */
const NOISE = new Set([
  '오류', '기능', '추가', '수정', '고쳐줘', '해줘', '해주세요', '해', '더',
  '짧게', '길게', '그대로', '유지해', '한국어', '영어', '번', '아까', '고른',
  '것', '부분', '확인', '부탁', '원해', '필요', '응답',
])

/** Particle suffixes, longest first so one pass strips the longest match. */
const PARTICLES = [
  '에서는', '에서', '으로', '에게', '에는', '은', '는', '이', '가', '을', '를',
  '의', '에', '도', '만', '와', '과', '로',
] as const

/** Request endings dropped only after a known alias stem. */
const REQUEST_ENDINGS = ['해주세요', '해줘', '합니다', '하다'] as const

/** Markers that turn a preceding Hangul noun into a refresh target. */
const TARGET_MARKERS = ['기능', '화면', '모듈', '대상', '처리'] as const

/** Group key returned for an ordinary identifier or path. */
export function lexicalKey(text: string): string {
  return normalize(text)
}

/** Stable key for a project alias group: sorted members, never recursive. */
export function aliasGroupKey(members: readonly string[]): string {
  return [...new Set(members.map(normalize).filter(Boolean))].sort(compareCodePoint).join('\u001f')
}

/** Canonical key for one merged group: built-ins keep their table concept key. */
export function canonicalGroupKey(members: readonly string[]): string {
  const normalized = [...new Set(members.map(normalize).filter(Boolean))]
  for (let i = 0; i < BUILTIN_ALIASES.length; i += 1) {
    const builtin = [...new Set((BUILTIN_ALIASES[i] ?? []).map(normalize))]
    if (builtin.length !== normalized.length) continue
    if (builtin.every(member => normalized.includes(member))) return BUILTIN_KEYS[i] ?? aliasGroupKey(normalized)
  }
  return aliasGroupKey(normalized)
}

/**
 * Builds the merged built-in + project group list, dropping empty groups.
 * Identical groups are kept once so callers may pass an already merged list
 * without duplicating round-robin expansion slots.
 */
export function mergeAliasGroups(projectAliases: readonly AliasGroup[] = []): readonly AliasGroup[] {
  const groups: AliasGroup[] = []
  const seen = new Set<string>()
  for (const raw of [...BUILTIN_ALIASES, ...projectAliases]) {
    const members = [...new Set(raw.map(normalize).filter(isSearchToken))]
    if (members.length === 0) continue
    const key = aliasGroupKey(members)
    if (seen.has(key)) continue
    seen.add(key)
    groups.push(members)
  }
  return groups
}

/**
 * Extracts weighted search terms for the initial repository scan.
 *
 * Paths and identifiers come first, then Hangul raw/stem forms, then alias
 * expansions. The result is capped at {@link SEARCH_TERM_LIMIT}; alias groups
 * expand round-robin so one long group cannot crowd out another target.
 */
export function extractSearchTerms(
  text: string,
  projectAliases: readonly AliasGroup[] = [],
): readonly SearchTerm[] {
  const groups = mergeAliasGroups(projectAliases)
  const index = groupIndex(groups)
  const source = text.normalize('NFC')
  const direct: SearchTerm[] = []
  const seen = new Map<string, SearchTerm>()

  const add = (value: string, weight: number, key?: string): void => {
    const term = normalize(value)
    if (!isSearchToken(term) || NOISE.has(term)) return
    const identity = key ?? index.keyFor.get(term) ?? lexicalKey(term)
    const existing = seen.get(term)
    if (existing !== undefined) {
      if (weight > existing.weight) seen.set(term, { text: term, weight, key: identity })
      return
    }
    const next = { text: term, weight, key: identity }
    seen.set(term, next)
    direct.push(next)
  }

  for (const path of extractPaths(source)) add(path, SEARCH_WEIGHT.path)
  for (const quoted of extractQuotedIdentifiers(source)) add(quoted, SEARCH_WEIGHT.identifier)
  for (const identifier of latinTokens(source).slice(0, SEARCH_LATIN_LIMIT)) {
    add(identifier, SEARCH_WEIGHT.identifier)
  }
  for (const raw of hangulTokens(source)) {
    add(raw, SEARCH_WEIGHT.hangul)
    for (const stem of stemsFor(raw, index)) add(stem, SEARCH_WEIGHT.hangul)
  }

  const matched = new Set<number>()
  for (const term of direct) {
    for (const group of index.byMember.get(term.text) ?? []) matched.add(group)
  }
  for (const raw of hangulTokens(source)) {
    for (const ending of REQUEST_ENDINGS) {
      if (!raw.endsWith(ending)) continue
      const stem = raw.slice(0, -ending.length)
      if (stem.length < 2) continue
      const owners = index.byMember.get(stem)
      if (owners === undefined) continue
      for (const group of owners) matched.add(group)
      add(stem, SEARCH_WEIGHT.hangul)
    }
  }

  const output = dedupeTerms(direct).slice(0, SEARCH_TERM_LIMIT)
  const orderedGroups = [...matched].sort((a, b) => compareCodePoint(groups[a]?.join('\u001f') ?? '', groups[b]?.join('\u001f') ?? ''))
  let added = true
  while (output.length < SEARCH_TERM_LIMIT && added) {
    added = false
    for (const group of orderedGroups) {
      const members = groups[group] ?? []
      for (const member of members) {
        if (output.length >= SEARCH_TERM_LIMIT) break
        if (seen.has(member) || NOISE.has(member) || !isSearchToken(member)) continue
        const term = { text: member, weight: SEARCH_WEIGHT.alias, key: index.keyFor.get(member) ?? lexicalKey(member) }
        seen.set(member, term)
        output.push(term)
        added = true
        break
      }
    }
    if (output.length >= SEARCH_TERM_LIMIT) break
  }

  return output
}

/**
 * Extracts only targets a fresh answer genuinely added: safe relative paths,
 * code-shaped or quoted identifiers, known alias concepts, and Hangul nouns
 * explicitly attached to 기능/화면/모듈/대상/처리. A marker-attached noun may
 * carry one trailing particle: it is stripped and keyed like any other surface,
 * so `로그인을 화면` names the already-seen login concept while an unknown noun
 * keeps its stripped form as a new target. Known-concept stems without a marker
 * also count; other prose nouns stay search-only. Adverbial or generic style
 * captures yield none, and an option number is never resolved into a target.
 */
export function extractTargets(
  text: string,
  projectAliases: readonly AliasGroup[] = [],
): readonly string[] {
  const groups = mergeAliasGroups(projectAliases)
  const index = groupIndex(groups)
  const source = text.normalize('NFC')
  const keys: string[] = []
  const add = (value: string): void => {
    const term = normalize(value)
    if (!isSearchToken(term) || NOISE.has(term)) return
    const key = index.keyFor.get(term) ?? lexicalKey(term)
    if (!keys.includes(key)) keys.push(key)
  }

  const paths = extractPaths(source)
  for (const path of paths) add(path)
  // Path internals are one target, not extra login/cart concepts.
  let prose = source
  for (const path of paths) prose = prose.split(path).join(' ')
  for (const quoted of extractQuotedIdentifiers(prose)) add(quoted)
  for (const identifier of codeIdentifiers(prose)) add(identifier)
  for (const identifier of prose.toLowerCase().match(/[A-Za-z][A-Za-z0-9_-]{1,39}/g) ?? []) {
    if (index.byMember.has(identifier)) add(identifier)
  }
  for (const raw of hangulTokens(prose)) {
    if (index.byMember.has(raw)) add(raw)
    for (const stem of stemsFor(raw, index)) {
      // A stripped stem authorizes a scan only when it names a known concept;
      // an unknown noun stays search-only unless a marker names it below.
      if (index.byMember.has(stem)) add(stem)
    }
  }
  const marker = new RegExp(`([가-힣]{2,40})\\s*(?:${TARGET_MARKERS.join('|')})`, 'g')
  for (const match of prose.matchAll(marker)) {
    const captured = normalize(match[1] ?? '')
    // One trailing particle keeps the concept identity (`로그인을` → `로그인`);
    // an unknown noun keeps the stripped form so `대시보드를 화면` still works.
    let noun = captured
    for (const particle of PARTICLES) {
      if (!captured.endsWith(particle)) continue
      const stem = captured.slice(0, -particle.length)
      if (stem.length >= 2) noun = stem
      break
    }
    // Adverbs and generic style nouns are presentation, not targets, even when
    // a marker follows them (`자연스럽게 처리`, `부분을 대상`).
    if (/(?:게|히)$/.test(noun)) continue
    add(noun)
  }

  return keys
}

/**
 * Parses explicit `GLOSSARY.md` / `GLOSSARY-MAP.md` rows.
 *
 * Accepted forms are `장바구니: basketStore, cartItems`, the same row as a
 * two-column pipe table, and either with a leading bullet and backticks.
 * Prose, headings, table separators, URLs, paths, shell syntax, control
 * characters, and duplicate groups are ignored; at most
 * {@link PROJECT_ALIAS_GROUP_LIMIT} groups are kept from the first
 * {@link PROJECT_ALIAS_CHARS} characters.
 */
export function parseProjectAliases(text: string): readonly AliasGroup[] {
  const groups: AliasGroup[] = []
  const seen = new Set<string>()
  for (const raw of text.slice(0, PROJECT_ALIAS_CHARS).split('\n')) {
    if (groups.length >= PROJECT_ALIAS_GROUP_LIMIT) break
    // A collected excerpt prefixes each source line with `N: `.
    const line = raw.replace(/^\s*\d+:\s?/, '').trim()
    if (line === '' || line.startsWith('#') || /^\|?\s*:?-{2,}/.test(line)) continue
    if (hasUnsafeGlossarySyntax(line)) continue
    const pair = parseGlossaryRow(line)
    if (pair === null) continue
    const members = [...new Set(pair.map(normalize))]
    const key = members.slice().sort(compareCodePoint).join('\u001f')
    if (seen.has(key)) continue
    seen.add(key)
    groups.push(pair)
  }
  return groups
}

/**
 * Extracts explicit relative file path hints, keeping their original case for
 * candidate seeding. Unsafe absolute, parent, hidden, backslash, colon, or
 * NUL-bearing paths are dropped; callers still apply every filesystem guard.
 */
export function extractPaths(text: string): readonly string[] {
  const paths: string[] = []
  const matches = text.normalize('NFC').match(/(?<![A-Za-z0-9_.\/-])[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g) ?? []
  for (const match of matches) {
    const path = match.replace(/[.,;:!?]+$/, '')
    if (safeRelativePath(path) && !paths.includes(path)) paths.push(path)
  }
  return paths
}

/** True when a path hint is relative and contains only safe path parts. */
export function safeRelativePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes(':') || path.includes('\0')) return false
  const parts = path.split('/')
  if (parts.length < 2) return false
  if (!parts.every(part => part !== '' && !part.startsWith('.') && part !== '..')) return false
  return /\.[A-Za-z0-9]{1,12}$/.test(parts[parts.length - 1] ?? '')
}

/** Normalizes a search representation without touching the caller's text. */
function normalize(text: string): string {
  return text.normalize('NFC').toLowerCase()
}

/** Code-point ordering, independent of the host locale. */
export function compareCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Latin identifier surfaces; quoted two-letter identifiers are handled apart. */
function latinTokens(text: string): string[] {
  return text.match(/[A-Za-z][A-Za-z0-9_-]{2,39}/g) ?? []
}

/** Identifier-shaped content inside backticks, including two-letter names. */
function extractQuotedIdentifiers(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(/`([^`\n]{1,40})`/g)) {
    const value = (match[1] ?? '').trim()
    if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value)) out.push(value)
  }
  return out
}

/** Code-shaped identifiers: snake_case, dotted, or camelCase. */
function codeIdentifiers(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_.]*/g)) {
    const value = match[0]
    if (value.length < 2) continue
    if (!(value.includes('_') || value.includes('.') || /[a-z][A-Z]|[A-Z][a-z]+[A-Z]/.test(value))) continue
    if (!out.includes(value)) out.push(value)
  }
  return out
}

/** Hangul runs of 2-40 syllables, before any suffix handling. */
function hangulTokens(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(/[가-힣]{2,40}/g)) {
    const value = match[0]
    if (!out.includes(value)) out.push(value)
  }
  return out
}

/** The raw token plus at most one particle-stripped or alias-stem variant. */
function stemsFor(raw: string, index: GroupIndex): string[] {
  const out: string[] = []
  if (NOISE.has(raw)) return out
  for (const particle of PARTICLES) {
    if (!raw.endsWith(particle)) continue
    const stem = raw.slice(0, -particle.length)
    // Never peel down to one syllable or repeatedly truncate the same stem.
    if (stem.length >= 2 && !out.includes(stem)) out.push(stem)
    break
  }
  for (const ending of REQUEST_ENDINGS) {
    if (!raw.endsWith(ending)) continue
    const stem = raw.slice(0, -ending.length)
    if (stem.length >= 2 && index.byMember.has(stem) && !out.includes(stem)) out.push(stem)
    break
  }
  // A short Korean suffix on a known alias stem (노드별, 검색어) is one
  // conservative variant, never a repeated character peel.
  for (const member of index.members) {
    if (!/^[가-힣]{2,}$/.test(member) || !raw.startsWith(member)) continue
    const suffix = raw.length - member.length
    if (suffix >= 1 && suffix <= 2 && !out.includes(member)) out.push(member)
  }
  return out
}

/** One parsed glossary row, or null when it is not an explicit token pair. */
function parseGlossaryRow(line: string): AliasGroup | null {
  if (line.startsWith('|')) {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
    if (cells.length !== 2) return null
    if (GLOSSARY_HEADERS.has(normalize(cells[0] ?? '')) || GLOSSARY_HEADERS.has(normalize(cells[1] ?? ''))) {
      return null
    }
    return aliasPair(cells[0] ?? '', cells[1] ?? '')
  }
  const body = line.replace(/^[-*+]\s+/, '')
  const colon = body.indexOf(':')
  if (colon <= 0) return null
  return aliasPair(body.slice(0, colon), body.slice(colon + 1))
}

/** Validates one left token plus one-to-four comma-delimited right tokens. */
function aliasPair(left: string, right: string): AliasGroup | null {
  const key = parseAliasToken(left)
  if (key === null) return null
  const values = right.split(',').map(parseAliasToken)
  if (values.length < 1 || values.length > 4) return null
  if (values.some(value => value === null)) return null
  const members = [key, ...(values as string[])]
  if (new Set(members.map(normalize)).size !== members.length) return null
  return members
}

/** One explicit Hangul/Latin identifier token, optionally backticked. */
function parseAliasToken(raw: string): string | null {
  let value = raw.trim()
  if (value.startsWith('`') || value.endsWith('`')) {
    if (!(value.startsWith('`') && value.endsWith('`') && value.length >= 2)) return null
    value = value.slice(1, -1).trim()
  }
  if (!/^[A-Za-z가-힣][A-Za-z0-9가-힣_-]*$/.test(value)) return null
  if (value.length > 40) return null
  return value
}

/** Table header cells that describe the format rather than a mapping. */
const GLOSSARY_HEADERS = new Set([
  'concept', 'term', 'terms', 'alias', 'aliases', 'key', 'value', 'meaning',
  '용어', '별칭', '의미', '개념', '설명', '키', '값',
])

/** Syntax that may never appear in an explicit glossary row. */
function hasUnsafeGlossarySyntax(line: string): boolean {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(line)) return true
  if (/:\/\/|[/\\]|\$|;|&&|\|\||[<>]|[()[\]{}]/.test(line)) return true
  return false
}

/** Deduplicates by surface form, keeping the highest-ranked occurrence. */
function dedupeTerms(terms: readonly SearchTerm[]): SearchTerm[] {
  const out: SearchTerm[] = []
  const seen = new Set<string>()
  for (const term of terms) {
    if (seen.has(term.text)) continue
    seen.add(term.text)
    out.push(term)
  }
  return out
}

/** A token safe to carry through search (no whitespace or control characters). */
function isSearchToken(value: string): boolean {
  return value !== '' && !/[\s\u0000-\u001f]/.test(value)
}

interface GroupIndex {
  /** Member surface to every group containing it, first occurrence order. */
  byMember: Map<string, number[]>
  /** Member surface to its first group's canonical key. */
  keyFor: Map<string, string>
  /** Every member surface, first occurrence order. */
  members: string[]
}

/**
 * Builds member and key indexes. A member may belong to several groups (a
 * project mapping on a built-in surface), so every owning group is recorded
 * and expanded once; canonical keys keep the first group's key.
 */
function groupIndex(groups: readonly AliasGroup[]): GroupIndex {
  const byMember = new Map<string, number[]>()
  const keyFor = new Map<string, string>()
  const members: string[] = []
  groups.forEach((group, index) => {
    const key = groupKeyOf(groups, index)
    for (const member of group) {
      const owners = byMember.get(member)
      if (owners === undefined) byMember.set(member, [index])
      else if (!owners.includes(index)) owners.push(index)
      if (!keyFor.has(member)) {
        keyFor.set(member, key)
        members.push(member)
      }
    }
  })
  return { byMember, keyFor, members }
}

/** Canonical key for a merged group: built-ins keep their concept key. */
function groupKeyOf(groups: readonly AliasGroup[], group: number): string {
  return canonicalGroupKey(groups[group] ?? [])
}
