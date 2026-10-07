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
})
