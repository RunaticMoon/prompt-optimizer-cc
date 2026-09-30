#!/usr/bin/env node
// Packaging check: the repository must not track generated CLI declarations or
// the read-only reference material they came from. `claude plugin validate`
// does not catch this, and a `git add -A` after a local load would.
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const FORBIDDEN = [
  {
    pattern: /(^|\/)\.claude-plugin\/types\//,
    label: 'generated CLI declarations (.claude-plugin/types/)',
  },
  { pattern: /cc-mods-ref/, label: 'reference experiments (cc-mods-ref)' },
  { pattern: /claude-code\.d\.ts$/, label: 'official declarations (claude-code.d.ts)' },
  { pattern: /claude-code-plugins\//, label: 'plugin type contracts (claude-code-plugins/)' },
  { pattern: /claude-code-mcp\.d\.ts$/, label: 'MCP declarations (claude-code-mcp.d.ts)' },
]

const result = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8' })

if (result.status !== 0) {
  console.error('Could not list tracked files: `git ls-files` failed.')
  console.error(result.stderr || '')
  process.exit(1)
}

const files = result.stdout.split('\0').filter(Boolean)
const hits = []
for (const file of files) {
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(file)) hits.push(`${file}  (${rule.label})`)
  }
}

if (hits.length > 0) {
  console.error('Packaging check failed: tracked file(s) must not be committed:')
  for (const hit of hits) console.error(`  - ${hit}`)
  process.exit(1)
}

console.log(`Packaging check passed: ${files.length} tracked file(s), no generated types or references.`)
