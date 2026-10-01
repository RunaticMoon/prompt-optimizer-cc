#!/usr/bin/env node
// Bumps the plugin version everywhere it is recorded. `.claude-plugin/plugin.json`
// is the source of truth; package.json and package-lock.json are synced to it.
// `--check` reports whether the four copies already agree, without writing.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const PLUGIN_FILE = path.join(root, '.claude-plugin', 'plugin.json')
const PACKAGE_FILE = path.join(root, 'package.json')
const LOCK_FILE = path.join(root, 'package-lock.json')

const USAGE = 'Usage: node scripts/bump-version.mjs <major|minor|patch|X.Y.Z|--check>'
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function fail(message) {
  console.error(message)
  process.exit(1)
}

function readJson(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    fail(`Could not read ${path.relative(root, file)}: ${error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    fail(`Could not parse ${path.relative(root, file)}: ${error.message}`)
  }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function parseVersion(version) {
  const match = typeof version === 'string' ? SEMVER.exec(version) : null
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compare(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

function nextVersion(current, argument) {
  const parsed = parseVersion(current)
  if (parsed === null) {
    fail(
      `Invalid current version in ${path.relative(root, PLUGIN_FILE)}: ${JSON.stringify(current)} (expected X.Y.Z).`,
    )
  }
  if (argument === 'major') return `${parsed[0] + 1}.0.0`
  if (argument === 'minor') return `${parsed[0]}.${parsed[1] + 1}.0`
  if (argument === 'patch') return `${parsed[0]}.${parsed[1]}.${parsed[2] + 1}`

  const explicit = parseVersion(argument)
  if (explicit === null) {
    fail(`Invalid argument: ${JSON.stringify(argument)}.\n${USAGE}`)
  }
  if (compare(explicit, parsed) <= 0) {
    fail(`Explicit version ${argument} must be greater than the current version ${current}.`)
  }
  return `${explicit[0]}.${explicit[1]}.${explicit[2]}`
}

const args = process.argv.slice(2)
if (args.length !== 1) fail(USAGE)
const argument = args[0]

const plugin = readJson(PLUGIN_FILE)
const pkg = readJson(PACKAGE_FILE)
const lock = readJson(LOCK_FILE)
const lockRoot = lock.packages ? lock.packages[''] : undefined
const current = plugin.version

if (argument === '--check') {
  const entries = [
    [path.relative(root, PLUGIN_FILE), plugin.version],
    [path.relative(root, PACKAGE_FILE), pkg.version],
    [`${path.relative(root, LOCK_FILE)} version`, lock.version],
    [`${path.relative(root, LOCK_FILE)} packages[""].version`, lockRoot ? lockRoot.version : undefined],
  ]
  if (entries.every(([, value]) => value === current)) {
    console.log(current)
    process.exit(0)
  }
  console.error('Version mismatch:')
  for (const [label, value] of entries) console.error(`  - ${label}: ${JSON.stringify(value)}`)
  process.exit(1)
}

if (lockRoot === undefined || typeof lockRoot.version !== 'string') {
  fail(`Missing ${path.relative(root, LOCK_FILE)} packages[""].version.`)
}

const version = nextVersion(current, argument)

const mismatches = []
if (pkg.version !== current) mismatches.push(`${path.relative(root, PACKAGE_FILE)}=${JSON.stringify(pkg.version)}`)
if (lock.version !== current) mismatches.push(`${path.relative(root, LOCK_FILE)}=${JSON.stringify(lock.version)}`)
if (lockRoot.version !== current) {
  mismatches.push(`${path.relative(root, LOCK_FILE)} packages[""]=${JSON.stringify(lockRoot.version)}`)
}
if (mismatches.length > 0) {
  console.error(
    `Warning: version differs from ${path.relative(root, PLUGIN_FILE)} (${current}); syncing ${mismatches.join(', ')}`,
  )
}

plugin.version = version
pkg.version = version
lock.version = version
lockRoot.version = version

writeJson(PLUGIN_FILE, plugin)
writeJson(PACKAGE_FILE, pkg)
writeJson(LOCK_FILE, lock)

console.log(version)
