import type { FsEntry, FsStat } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { CONTEXT_PROJECT_CHARS, type EnginePorts } from '../hooks/contracts'
import {
  PROJECT_MAX_DIRECTORIES,
  PROJECT_MAX_ENTRIES,
  PROJECT_MAX_FILES,
  PROJECT_MAX_FILE_BYTES,
  PROJECT_MAX_READ_BYTES,
  PROJECT_MAX_STATS,
  collectProjectEvidence,
  collectProjectEvidenceSnapshot,
} from '../hooks/project-context'

function filesystem(
  files: Record<string, string>,
  options: {
    sizes?: Record<string, number>
    stats?: Record<string, Partial<FsStat>>
    list?: boolean
    failRead?: string
  } = {},
): { ports: EnginePorts; reads: string[]; lists: string[]; stats: string[] } {
  const reads: string[] = []
  const lists: string[] = []
  const stats: string[] = []
  const dirs = new Map<string, Map<string, FsEntry>>()
  dirs.set('/repo', new Map())
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split('/').filter(Boolean)
    for (let i = 1; i < parts.length; i += 1) {
      const parent = `/${parts.slice(0, i).join('/')}`
      const name = parts[i] ?? ''
      const child = `${parent}/${name}`
      const isFile = i === parts.length - 1
      if (!dirs.has(parent)) dirs.set(parent, new Map())
      const stat = options.stats?.[child]
      dirs.get(parent)?.set(name, {
        name, kind: stat?.isLink ? 'other' : isFile ? 'file' : 'dir',
        size: isFile ? options.sizes?.[child] ?? text.length : 0,
        mtimeMs: 0, isLink: stat?.isLink ?? false,
      })
    }
  }
  const fs = {
    stat: async (path: string): Promise<FsStat> => {
      stats.push(path)
      if (!dirs.has(path) && files[path] === undefined) throw new Error('ENOENT')
      return {
        kind: dirs.has(path) ? 'dir' : 'file', size: options.sizes?.[path] ?? files[path]?.length ?? 0,
        isLink: false, mtimeMs: 0, realPath: path, ...options.stats?.[path],
      }
    },
    read: async (path: string): Promise<string> => {
      reads.push(path)
      if (path === options.failRead || files[path] === undefined) throw new Error('denied')
      return files[path] ?? ''
    },
    ...(options.list === false ? {} : {
      list: async (path = '/repo'): Promise<FsEntry[]> => {
        lists.push(path)
        return [...(dirs.get(path)?.values() ?? [])]
      },
    }),
  }
  return { ports: { fs } as unknown as EnginePorts, reads, lists, stats }
}

describe('collectProjectEvidence', () => {
  test('grounds a Korean API request with line-labelled code, vocabulary, decisions, and real scripts', async () => {
    const { ports, reads } = filesystem({
      '/repo/GLOSSARY.md': '# Domain\nNode: resolved graph object\nImage: deployment image reference',
      '/repo/package.json': JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'vitest run' }, privateToken: 'do not expose this field' }),
      '/repo/docs/adr/0001-history.md': '# Image baseline\nDecision: keep the previous image in change history.',
      '/repo/backend/src/mcp.ts': '// MCP tools\nexport const tools = [getNodeImages]\n// shared registry',
      '/repo/backend/src/node-images.ts': 'export type Node = { properties: Record<string, string> }\nexport function previousImage(history: Change[]) {}',
      '/repo/unrelated.ts': '// not relevant',
    })

    const text = await collectProjectEvidence(ports, '/repo', '/repo', '노드별 property와 image diff API를 swagger mcp에도 추가')

    expect(text).toContain('Partial excerpts only')
    expect(text).toContain('GLOSSARY.md\n1: # Domain')
    expect(text).toContain('package.json (declared scripts; not executed)')
    expect(text).toContain('typecheck: tsc --noEmit')
    expect(text).toContain('backend/src/mcp.ts')
    expect(text).toContain('2: export const tools = [getNodeImages]')
    expect(text).toContain('docs/adr/0001-history.md')
    expect(text).not.toContain('do not expose this field')
    expect(reads).toContain('/repo/backend/src/node-images.ts')
    expect(text.length).toBeLessThanOrEqual(CONTEXT_PROJECT_CHARS)
  })

  test('extracts relevant lines from the middle instead of treating a file header as evidence', async () => {
    const { ports } = filesystem({ '/repo/src/image.ts': `${'// filler\n'.repeat(40)}export const imageBaseline = previousRevision\n` })
    const text = await collectProjectEvidence(ports, '/repo', '/repo', '이미지 baseline 정의')
    expect(text).toContain('41: export const imageBaseline = previousRevision')
  })

  test('reserves reads for source and commands when many unrelated ADRs compete', async () => {
    const files: Record<string, string> = {
      '/repo/image.ts': 'export const imageBaseline = previousRevision',
      '/repo/package.json': '{"scripts":{"test":"vitest run"}}',
    }
    for (let i = 0; i < 30; i += 1) files[`/repo/ADR-${i}.md`] = 'Decision: unrelated database convention'
    const { ports, reads } = filesystem(files)
    const text = await collectProjectEvidence(ports, '/repo', '/repo', 'image diff API')
    expect(reads).toContain('/repo/image.ts')
    expect(reads).toContain('/repo/package.json')
    expect(text).toContain('imageBaseline = previousRevision')
    expect(text).toContain('test: vitest run')
  })

  test('does not read dependencies, hidden/secret files, large files, binaries or links', async () => {
    const { ports, reads, lists } = filesystem({
      '/repo/src/image.ts': 'export const image = "safe"',
      '/repo/node_modules/image/index.ts': 'dependency',
      '/repo/.env': 'SECRET=hidden',
      '/repo/src/image-secrets.ts': 'password',
      '/repo/src/image.png': 'binary',
      '/repo/src/image-huge.ts': 'huge',
      '/repo/src/image-link.ts': 'linked file',
      '/repo/linked/image.ts': 'linked directory',
      '/repo/src/image-escaped.ts': 'escaped parent',
      '/repo/src/image-bytes.ts': '\0binary',
    }, {
      sizes: { '/repo/src/image-huge.ts': PROJECT_MAX_FILE_BYTES + 1 },
      stats: {
        '/repo/src/image-link.ts': { isLink: true, realPath: '/elsewhere/image.ts' },
        '/repo/linked': { isLink: true, realPath: '/elsewhere' },
        '/repo/src/image-escaped.ts': { realPath: '/repo-other/image.ts' },
      },
    })

    const text = await collectProjectEvidence(ports, '/repo', '/repo', 'image API')
    expect(reads).toEqual(['/repo/src/image-bytes.ts', '/repo/src/image.ts'])
    expect(lists).not.toContain('/repo/node_modules')
    expect(lists).not.toContain('/repo/linked')
    expect(text).not.toContain('binary')
    expect(text).not.toContain('password')
  })

  test('uses canonical project boundaries and skips evidence when resolution is unavailable', async () => {
    const { ports, reads, lists } = filesystem({ '/repo/README.md': 'docs' }, {
      stats: { '/repo': { realPath: undefined } },
    })
    const text = await collectProjectEvidence(ports, '/repo', '/repo', 'API')
    expect(text).toContain('inspection unavailable')
    expect(reads).toEqual([])
    expect(lists).toEqual([])
  })

  test('compares Windows canonical paths with consistent separators', async () => {
    const { ports } = filesystem({ '/repo/src/image.ts': 'export const image = "safe"' }, {
      stats: {
        '/repo': { realPath: 'C:\\repo' },
        '/repo/src': { realPath: 'C:\\repo\\src' },
        '/repo/src/image.ts': { realPath: 'C:\\repo\\src\\image.ts' },
      },
    })
    expect(await collectProjectEvidence(ports, '/repo', '/repo', 'image')).toContain('src/image.ts')
  })

  test('falls back to conventional docs without fs.list and isolates failed reads', async () => {
    const { ports, reads } = filesystem({
      '/repo/README.md': 'unreadable',
      '/repo/GLOSSARY.md': 'Image: immutable artifact',
      '/repo/GLOSSARY-MAP.md': 'Image aggregate belongs to the deployment context',
      '/repo/package.json': '{invalid',
    }, { list: false, failRead: '/repo/README.md' })
    const text = await collectProjectEvidence(ports, '/repo', '/repo', 'image')
    expect(text).toContain('GLOSSARY.md')
    expect(text).toContain('GLOSSARY-MAP.md')
    expect(text).toContain('0 directories listed')
    expect(reads).toContain('/repo/README.md')
    expect(text).not.toContain('unreadable')
  })

  test('bounds directory traversal, file reads, total bytes and output characters', async () => {
    const files: Record<string, string> = {}
    const sizes: Record<string, number> = {}
    for (let i = 0; i < 80; i += 1) {
      const path = `/repo/image-${i}/image.ts`
      files[path] = 'export const image = "x"\n'.repeat(100)
      sizes[path] = 40000
    }
    const { ports, reads, lists } = filesystem(files, { sizes })
    const text = await collectProjectEvidence(ports, '/repo', '/repo', 'image')
    expect(reads.length).toBeLessThanOrEqual(PROJECT_MAX_FILES)
    expect(reads.reduce((sum, path) => sum + (sizes[path] ?? 0), 0)).toBeLessThanOrEqual(PROJECT_MAX_READ_BYTES)
    expect(lists.length).toBeLessThanOrEqual(PROJECT_MAX_DIRECTORIES)
    expect(text.length).toBeLessThanOrEqual(CONTEXT_PROJECT_CHARS)
    expect(text).toContain('Partial excerpts only')
  })

  test('bounds files read even when all candidates are tiny and relevant', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < PROJECT_MAX_ENTRIES + 5; i += 1) files[`/repo/image-${i}.ts`] = 'image'
    const { ports, reads } = filesystem(files)
    await collectProjectEvidence(ports, '/repo', '/repo', 'image')
    expect(reads).toHaveLength(PROJECT_MAX_FILES)
  })

  test('bounds stat attempts when files disappear after discovery', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 200; i += 1) files[`/repo/image-${i}.ts`] = 'image'
    const { ports, stats } = filesystem(files)
    const stat = ports.fs.stat
    ports.fs.stat = async (path, options) => {
      const result = await stat(path, options)
      if (result.kind === 'file') throw new Error('file disappeared')
      return result
    }
    const text = await collectProjectEvidence(ports, '/repo', '/repo', 'image')
    expect(stats.length).toBeLessThanOrEqual(PROJECT_MAX_STATS)
    expect(text).toContain('No usable evidence found')
  })

  test('reports insufficient evidence without inventing files or commands', async () => {
    const { ports } = filesystem({ '/repo/note.md': 'nothing relevant' })
    const text = await collectProjectEvidence(ports, '/repo', '/repo', 'image API')
    expect(text).toContain('No usable evidence found')
    expect(text).toContain('verification commands remain unverified')
  })

  test('does no repository IO without a current request', async () => {
    const { ports, reads, lists } = filesystem({ '/repo/README.md': 'docs' })
    expect(await collectProjectEvidence(ports, '/repo', '/repo', '')).toBe('')
    expect(reads).toEqual([])
    expect(lists).toEqual([])
  })

  test('times out a hanging stat and prevents follow-up IO after it settles late', async () => {
    const { ports, reads, lists } = filesystem({ '/repo/README.md': 'image docs' })
    let finishStat: ((value: FsStat) => void) | undefined
    let expire: (() => void) | undefined
    let timerSignal: AbortSignal | undefined
    ports.fs.stat = () => new Promise(resolve => { finishStat = resolve })
    ports.clock = { sleep: (_ms, options) => {
      timerSignal = options?.signal
      return new Promise<void>(resolve => { expire = resolve })
    } }
    const pending = collectProjectEvidence(ports, '/repo', '/repo', 'image')
    expire?.()
    const text = await pending
    expect(text).toContain('inspection timed out')
    expect(timerSignal?.aborted).toBe(true)
    finishStat?.({ kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: '/repo' })
    await Promise.resolve()
    await Promise.resolve()
    expect(reads).toEqual([])
    expect(lists).toEqual([])
  })

  test('aborts its timer when inspection succeeds', async () => {
    const { ports } = filesystem({ '/repo/GLOSSARY.md': 'Image: artifact' })
    let timerSignal: AbortSignal | undefined
    ports.clock = { sleep: (_ms, options) => {
      timerSignal = options?.signal
      return new Promise<void>(() => {})
    } }
    const text = await collectProjectEvidence(ports, '/repo', '/repo', 'image')
    expect(text).toContain('GLOSSARY.md')
    expect(timerSignal?.aborted).toBe(true)
  })

  test('an optional caller signal stops traversal without new IO after a late read', async () => {
    const { ports, reads, lists } = filesystem({ '/repo/README.md': 'image docs' })
    let finishStat: ((value: FsStat) => void) | undefined
    ports.fs.stat = () => new Promise(resolve => { finishStat = resolve })
    ports.clock = { sleep: () => new Promise<void>(() => {}) }
    const controller = new AbortController()

    const pending = collectProjectEvidence(ports, '/repo', '/repo', 'image', controller.signal)
    await Promise.resolve()
    controller.abort()
    // The hung read still decides how soon this promise settles, but an
    // already-aborted signal skips the work entirely on the next call.
    finishStat?.({ kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: '/repo' })
    const text = await pending

    expect(text).toContain('inspection unavailable')
    expect(reads).toEqual([])
    expect(lists).toEqual([])
  })
})

describe('collectProjectEvidenceSnapshot — source records', () => {
  test('records the collector path and the final excerpt of every selected file', async () => {
    const { ports, reads } = filesystem({
      '/repo/GLOSSARY.md': '# Domain\nNode: resolved graph object',
      '/repo/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
    })

    const { text, sources } = await collectProjectEvidenceSnapshot(ports, '/repo', '/repo', 'image API')

    expect(sources.map(source => source.path).sort()).toEqual(['GLOSSARY.md', 'package.json'])
    const glossary = sources.find(source => source.path === 'GLOSSARY.md')
    expect(glossary?.kind).toBe('domain')
    expect(glossary?.excerpt).toContain('1: # Domain')
    const scripts = sources.find(source => source.path === 'package.json')
    expect(scripts?.kind).toBe('scripts')
    expect(scripts?.excerpt).toContain('test: vitest run')
    // Every record is the excerpt that actually landed in the text, from a
    // file the collector really read.
    for (const source of sources) {
      expect(text).toContain(source.excerpt)
      expect(reads).toContain(`/repo/${source.path}`)
    }
  })

  test('failed, linked, escaping and binary reads never become source records', async () => {
    const { ports } = filesystem({
      '/repo/README.md': 'unreadable',
      '/repo/GLOSSARY.md': 'Image: artifact',
      '/repo/src/image-link.ts': 'linked file',
      '/repo/src/image-escaped.ts': 'escaped parent',
      '/repo/src/image-bytes.ts': '\0binary',
    }, {
      failRead: '/repo/README.md',
      stats: {
        '/repo/src/image-link.ts': { isLink: true, realPath: '/elsewhere/image.ts' },
        '/repo/src/image-escaped.ts': { realPath: '/repo-other/image.ts' },
      },
    })

    const { text, sources } = await collectProjectEvidenceSnapshot(ports, '/repo', '/repo', 'image')

    expect(sources.map(source => source.path)).toEqual(['GLOSSARY.md'])
    expect(text).not.toContain('unreadable')
    expect(text).not.toContain('binary')
  })

  test('a fake path inside a file body cannot create a source record', async () => {
    const { ports } = filesystem({
      '/repo/src/real.ts': 'export const real = 1\n// see also: docs/fake-adr.md and missing/fake.ts',
    })

    const { sources } = await collectProjectEvidenceSnapshot(ports, '/repo', '/repo', 'real fake')

    expect(sources.map(source => source.path)).toEqual(['src/real.ts'])
    expect(sources.some(source => source.path.includes('fake'))).toBe(false)
  })

  test('a timeout leaves the records empty and a late scan cannot add them', async () => {
    const { ports, reads, lists } = filesystem({ '/repo/README.md': 'image docs' })
    let finishStat: ((value: FsStat) => void) | undefined
    let expire: (() => void) | undefined
    let timerSignal: AbortSignal | undefined
    ports.fs.stat = () => new Promise(resolve => { finishStat = resolve })
    ports.clock = { sleep: (_ms, options) => {
      timerSignal = options?.signal
      return new Promise<void>(resolve => { expire = resolve })
    } }
    const pending = collectProjectEvidenceSnapshot(ports, '/repo', '/repo', 'image')
    expire?.()
    const result = await pending
    expect(result.text).toContain('inspection timed out')
    expect(result.sources).toEqual([])
    expect(timerSignal?.aborted).toBe(true)
    finishStat?.({ kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: '/repo' })
    await Promise.resolve()
    await Promise.resolve()
    expect(result.sources).toEqual([])
    expect(reads).toEqual([])
    expect(lists).toEqual([])
  })

  test('the compatibility wrapper returns the snapshot text with the same single scan', async () => {
    const files = {
      '/repo/GLOSSARY.md': '# Domain\nNode: resolved graph object',
      '/repo/package.json': '{"scripts":{"test":"vitest run"}}',
    }
    const scanned = filesystem(files)
    const wrapped = filesystem(files)

    const snapshot = await collectProjectEvidenceSnapshot(scanned.ports, '/repo', '/repo', 'image API')
    const text = await collectProjectEvidence(wrapped.ports, '/repo', '/repo', 'image API')

    expect(text).toBe(snapshot.text)
    expect(wrapped.reads).toEqual(scanned.reads)
  })
})

describe('collectProjectEvidence — bilingual ranking and refreshed limits', () => {
  test('selects the login source for the issue Korean-only request', async () => {
    const { ports } = filesystem({
      '/repo/src/auth/login.ts': 'export async function login(email, password) {\n  return validateCredentials(email, password)\n}',
      '/repo/src/cart/cart.ts': 'export function addCartItem(item) { return cart.add(item) }',
    })
    const text = await collectProjectEvidence(ports, '/repo', '/repo', '로그인 오류를 고쳐줘')
    expect(text).toContain('src/auth/login.ts')
    expect(text).toContain('export async function login')
    expect(text).not.toContain('src/cart/cart.ts')
  })

  test('selects the cart source for the issue Korean-only request', async () => {
    const { ports } = filesystem({
      '/repo/src/auth/login.ts': 'export async function login(email, password) {\n  return validateCredentials(email, password)\n}',
      '/repo/src/cart/cart.ts': 'export function addCartItem(item) { return cart.add(item) }',
    })
    const text = await collectProjectEvidence(ports, '/repo', '/repo', '장바구니 담기 기능을 추가해줘')
    expect(text).toContain('src/cart/cart.ts')
    expect(text).toContain('addCartItem')
    expect(text).not.toContain('src/auth/login.ts')
  })

  test('matches Korean comments and identifiers in source', async () => {
    const { ports } = filesystem({
      '/repo/src/wish.ts': '// 찜목록을 화면에 보여준다\nexport function showWishlist() {}\n',
    })
    const text = await collectProjectEvidence(ports, '/repo', '/repo', '찜목록을 보여줘')
    expect(text).toContain('1: // 찜목록을 화면에 보여준다')
  })

  test('an English-only request still finds Korean source comments', async () => {
    const { ports } = filesystem({
      '/repo/src/order.ts': '// 주문을 생성한다\nexport function createOrder() {}\n',
    })
    const text = await collectProjectEvidence(ports, '/repo', '/repo', 'order API')
    expect(text).toContain('1: // 주문을 생성한다')
  })

  test('a project glossary term prioritizes its English source line', async () => {
    const { ports } = filesystem({
      '/repo/GLOSSARY.md': '# Glossary\n찜목록: wishList\n',
      '/repo/src/wish.ts': `${'// filler\n'.repeat(40)}export const wishList = true\n`,
    })
    const text = await collectProjectEvidence(ports, '/repo', '/repo', '찜목록 화면')
    expect(text).toContain('GLOSSARY.md')
    expect(text).toContain('41: export const wishList = true')
  })

  test('the two glossary prepass reads count toward the read budget and are not repeated', async () => {
    const { ports, reads } = filesystem({
      '/repo/GLOSSARY.md': '찜목록: wishList\n',
      '/repo/GLOSSARY-MAP.md': '주문: order\n',
      '/repo/src/wish.ts': 'export const wishList = true\n',
      '/repo/src/order.ts': 'export const order = true\n',
    })
    await collectProjectEvidence(ports, '/repo', '/repo', '찜목록 주문', {
      limits: { maxFiles: 3 },
    })
    expect(reads.length).toBeLessThanOrEqual(3)
    expect(reads).toContain('/repo/GLOSSARY.md')
    expect(reads).toContain('/repo/GLOSSARY-MAP.md')
    expect(new Set(reads).size).toBe(reads.length)
  })

  test('an explicit path outranks a broad alias before the read budget is spent', async () => {
    const { ports, reads } = filesystem({
      '/repo/src/auth/login.ts': 'export const login = true\n',
      '/repo/src/cart/cart.ts': 'export const cart = true\n',
    })
    const text = await collectProjectEvidence(ports, '/repo', '/repo', '로그인 관련 src/cart/cart.ts 확인', {
      limits: { maxFiles: 1 },
    })
    expect(reads).toEqual(['/repo/src/cart/cart.ts'])
    expect(text).toContain('src/cart/cart.ts')
  })

  test('a directly named identifier outranks a broad alias', async () => {
    const { ports, reads } = filesystem({
      '/repo/src/shop/basket.ts': 'export const basket = true\n',
      '/repo/src/cart/addCartItem.ts': 'export const addCartItem = true\n',
    })
    await collectProjectEvidence(ports, '/repo', '/repo', '장바구니 addCartItem', {
      limits: { maxFiles: 1 },
    })
    expect(reads).toEqual(['/repo/src/cart/addCartItem.ts'])
  })

  test('malformed mappings stay inert and never select their English source', async () => {
    const { ports } = filesystem({
      '/repo/GLOSSARY.md': 'This is prose, not a mapping.\n찜목록: wishList extra tokens here\nscript: $(rm -rf /)\n',
      '/repo/src/wish.ts': 'export const wishList = true\n',
    })
    const text = await collectProjectEvidence(ports, '/repo', '/repo', '찜목록')
    expect(text).not.toContain('export const wishList = true')
  })

  test('lower limits and an aborted signal stop further IO', async () => {
    const { ports, reads, lists, stats } = filesystem({
      '/repo/GLOSSARY.md': '찜목록: wishList\n',
      '/repo/src/wish.ts': 'export const wishList = true\n',
    })
    const controller = new AbortController()
    controller.abort()
    const aborted = await collectProjectEvidence(ports, '/repo', '/repo', '찜목록', { signal: controller.signal })
    expect(aborted).toContain('inspection unavailable')
    expect(reads).toEqual([])
    expect(lists).toEqual([])
    expect(stats).toEqual([])

    const text = await collectProjectEvidence(ports, '/repo', '/repo', '찜목록', {
      limits: { maxFiles: 1, maxDirectories: 0, maxChars: 160 },
    })
    expect(text.length).toBeLessThanOrEqual(160)
    expect(lists).toEqual([])
    // The root stat and up to one glossary prepass stat are allowed.
    expect(stats.length).toBeLessThanOrEqual(2)
  })

  test('overrides cannot enlarge defaults or split a surrogate in the output', async () => {
    const { ports, reads } = filesystem({
      '/repo/src/wish.ts': `// 찜목록 😀😀😀\n${'export const wishList = true\n'.repeat(20)}`,
    })
    const text = await collectProjectEvidence(ports, '/repo', '/repo', '찜목록', {
      limits: {
        maxFiles: 999,
        maxDirectories: 999,
        maxEntries: 99999,
        maxStats: 9999,
        maxReadBytes: 9999999,
        maxChars: 99999,
      },
    })
    expect(reads.length).toBeLessThanOrEqual(PROJECT_MAX_FILES)
    expect(text.length).toBeLessThanOrEqual(CONTEXT_PROJECT_CHARS)
    expect(text.endsWith('\uD83D')).toBe(false)
  })

  test('a zero file or stat allowance starts no corresponding operation', async () => {
    const files = { '/repo/src/wish.ts': 'export const wishList = true\n' }
    const noFiles = filesystem(files)
    expect(await collectProjectEvidence(noFiles.ports, '/repo', '/repo', '찜목록', { limits: { maxFiles: 0 } }))
      .toContain('No usable evidence found')
    expect(noFiles.reads).toEqual([])

    const noStats = filesystem(files)
    expect(await collectProjectEvidence(noStats.ports, '/repo', '/repo', '찜목록', { limits: { maxStats: 0 } }))
      .toContain('inspection unavailable')
    expect(noStats.stats).toEqual([])
    expect(noStats.reads).toEqual([])
  })
})
