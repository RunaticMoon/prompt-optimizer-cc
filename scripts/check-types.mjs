#!/usr/bin/env node
// Type-checks the mod against the declarations the Claude Code CLI generates.
//
// The CLI writes .claude-plugin/types/ (a tsconfig and
// claude-code/index.d.ts) when it loads a mod from a folder the person owns.
// That folder is gitignored and never committed, so this script fails with
// the local generation steps when it is missing.
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const typesFile = path.join(root, '.claude-plugin', 'types', 'claude-code', 'index.d.ts')

if (!existsSync(typesFile)) {
  console.error(
    [
      `Missing generated declarations: ${path.relative(root, typesFile)}`,
      '',
      'The Claude Code CLI writes them when it loads this mod from the folder you own.',
      'Generate them once, then re-run npm run typecheck:',
      '',
      '  claude --plugin-dir . -p "type generation" \\',
      '    --setting-sources "" --strict-mcp-config --mcp-config \'{"mcpServers":{}}\'',
      '',
      'Claude Code 2.1.292+ loads mods without a flag; on older releases prefix the command with CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1.',
      '',
      'Any real load works (a normal interactive session with --plugin-dir .',
      'writes them too); the command above is the headless form. It makes one',
      'short model call, so it uses a little of your account usage.',
      'The folder is gitignored, so regenerate it after a CLI update.',
    ].join('\n'),
  )
  process.exit(1)
}

const tscCandidates = [
  path.join(root, 'node_modules', 'typescript', 'lib', 'tsc.js'),
  path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
]
const tsc = tscCandidates.find(candidate => existsSync(candidate))

if (!tsc) {
  console.error('TypeScript is not installed. Run `npm install` (or `npm ci`) first.')
  process.exit(1)
}

const result = spawnSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.json')], {
  stdio: 'inherit',
})

process.exit(result.status ?? 1)
