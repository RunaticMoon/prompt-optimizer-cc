/**
 * Synthetic composition fixtures for the paste-classification reasons (#35).
 *
 * Every case is **synthetic**: the strings and step lists describe event
 * shapes the documented 2.1.292 CLI contract and the published mod
 * declarations make possible (`prompt.edit` with/without `key`,
 * `prompt.autocomplete`, the box text). They are not measured terminal or
 * IME traces — no real terminal, IME or CLI version has been observed here,
 * so a passing test never proves a real environment classifies that way.
 * `docs/smoke.md` holds the manual procedure that must supply that evidence.
 *
 * A test folds each fixture's steps through `noteEditInput`/`noteBox`/
 * `noteAutocomplete` from `EMPTY_COMPOSITION` and expects the listed verdict.
 */

import type { PasteClassification } from '../../hooks/contracts'

/** One observation the host can hand the plugin for a draft. */
export type CompositionStep =
  | { kind: 'edit'; inputText: string; key?: unknown }
  | { kind: 'autocomplete'; text: string }
  | { kind: 'box'; text: string }

/** One documented-shape input scenario and the verdict it must produce. */
export interface CompositionCase {
  /** Stable id the smoke procedure refers to. */
  id: string
  /** Always `synthetic`: nothing here was measured in a real terminal. */
  source: 'synthetic'
  /** The event contract the steps are written against. */
  cliContract: '2.1.292 documented / published mod shape'
  /** No real terminal backs any fixture. */
  terminal: 'unverified'
  /** The human input method the steps stand in for. */
  inputMethod: string
  steps: readonly CompositionStep[]
  expected: PasteClassification
}

/** A synthetic key stroke, as `prompt.edit` carries it for human typing. */
const KEY = { key: 'a' }

export const COMPOSITION_CASES: readonly CompositionCase[] = [
  {
    id: 'korean-short-commit',
    source: 'synthetic',
    cliContract: '2.1.292 documented / published mod shape',
    terminal: 'unverified',
    inputMethod: 'Korean 2-set IME, short word committed with a carried key',
    steps: [{ kind: 'edit', inputText: '안녕', key: KEY }],
    expected: { pasted: false, reason: 'typed' },
  },
  {
    id: 'korean-long-commit',
    source: 'synthetic',
    cliContract: '2.1.292 documented / published mod shape',
    terminal: 'unverified',
    inputMethod: 'Korean 2-set IME, whole sentence committed at once (key-less)',
    steps: [{ kind: 'edit', inputText: '한국어입력확정문장' }],
    expected: { pasted: true, reason: 'keyless-long-insert' },
  },
  {
    id: 'japanese-long-conversion',
    source: 'synthetic',
    cliContract: '2.1.292 documented / published mod shape',
    terminal: 'unverified',
    inputMethod: 'Japanese IME, long conversion confirmed in one key-less edit',
    steps: [{ kind: 'edit', inputText: '日本語の長い変換確定' }],
    expected: { pasted: true, reason: 'keyless-long-insert' },
  },
  {
    id: 'keyless-burst-1',
    source: 'synthetic',
    cliContract: '2.1.292 documented / published mod shape',
    terminal: 'unverified',
    inputMethod: 'fast typing, 1-character key-less burst',
    steps: [{ kind: 'edit', inputText: 'a' }],
    expected: { pasted: false, reason: 'typed' },
  },
  {
    id: 'keyless-burst-6',
    source: 'synthetic',
    cliContract: '2.1.292 documented / published mod shape',
    terminal: 'unverified',
    inputMethod: 'fast typing, 6-character key-less burst (measured typing maximum)',
    steps: [{ kind: 'edit', inputText: 'abcdef' }],
    expected: { pasted: false, reason: 'typed' },
  },
  {
    id: 'keyless-burst-7',
    source: 'synthetic',
    cliContract: '2.1.292 documented / published mod shape',
    terminal: 'unverified',
    inputMethod: 'fast typing, 7-character key-less burst (last length below the threshold)',
    steps: [{ kind: 'edit', inputText: 'abcdefg' }],
    expected: { pasted: false, reason: 'typed' },
  },
  {
    id: 'keyless-burst-8-boundary',
    source: 'synthetic',
    cliContract: '2.1.292 documented / published mod shape',
    terminal: 'unverified',
    inputMethod: '8-character key-less insertion (exact PASTE_MIN_CHARS boundary)',
    steps: [{ kind: 'edit', inputText: 'abcdefgh' }],
    expected: { pasted: true, reason: 'keyless-long-insert' },
  },
  {
    id: 'keyed-long-commit',
    source: 'synthetic',
    cliContract: '2.1.292 documented / published mod shape',
    terminal: 'unverified',
    inputMethod: 'long insertion that still carries a key',
    steps: [{ kind: 'edit', inputText: '긴 문장도 키가 있으면 타이핑이다', key: KEY }],
    expected: { pasted: false, reason: 'typed' },
  },
  {
    id: 'short-paste-ambiguity',
    source: 'synthetic',
    cliContract: '2.1.292 documented / published mod shape',
    terminal: 'unverified',
    inputMethod: 'short paste under the threshold (indistinguishable from a burst)',
    steps: [{ kind: 'edit', inputText: 'abc' }],
    expected: { pasted: false, reason: 'typed' },
  },
  {
    id: 'long-paste',
    source: 'synthetic',
    cliContract: '2.1.292 documented / published mod shape',
    terminal: 'unverified',
    inputMethod: 'terminal paste of a long prompt',
    steps: [{ kind: 'edit', inputText: '붙여넣은 여러 줄 프롬프트 본문' }],
    expected: { pasted: true, reason: 'keyless-long-insert' },
  },
  {
    id: 'external-app-injection',
    source: 'synthetic',
    cliContract: '2.1.292 documented / published mod shape',
    terminal: 'unverified',
    inputMethod: 'another app (Orca) injecting text into the terminal',
    steps: [{ kind: 'edit', inputText: '다른 앱이 터미널에 넣은 텍스트' }],
    expected: { pasted: true, reason: 'keyless-long-insert' },
  },
  {
    id: 'placeholder-outranks-insert',
    source: 'synthetic',
    cliContract: '2.1.292 documented / published mod shape',
    terminal: 'unverified',
    inputMethod: 'long paste whose placeholder and an edit are both seen',
    steps: [
      { kind: 'autocomplete', text: '[Pasted text #1 +29 lines]' },
      { kind: 'edit', inputText: '붙여넣은 여러 줄 본문' },
    ],
    expected: { pasted: true, reason: 'paste-placeholder' },
  },
  {
    id: 'no-input-events',
    source: 'synthetic',
    cliContract: '2.1.292 documented / published mod shape',
    terminal: 'unverified',
    inputMethod: 'paste (or recall) followed by an immediate Enter, no event seen',
    steps: [],
    expected: { pasted: true, reason: 'no-input-events' },
  },
  {
    id: 'autocomplete-only',
    source: 'synthetic',
    cliContract: '2.1.292 documented / published mod shape',
    terminal: 'unverified',
    inputMethod: 'plain autocomplete display with no edit event',
    steps: [{ kind: 'autocomplete', text: '/optimize' }],
    expected: { pasted: false, reason: 'observed-other' },
  },
  {
    id: 'delete-move-only',
    source: 'synthetic',
    cliContract: '2.1.292 documented / published mod shape',
    terminal: 'unverified',
    inputMethod: 'key-less delete/move edits only (empty insertions)',
    steps: [
      { kind: 'edit', inputText: '' },
      { kind: 'edit', inputText: '' },
    ],
    expected: { pasted: false, reason: 'observed-other' },
  },
  {
    id: 'paste-then-one-key',
    source: 'synthetic',
    cliContract: '2.1.292 documented / published mod shape',
    terminal: 'unverified',
    inputMethod: 'paste corrected by one typed character',
    steps: [
      { kind: 'edit', inputText: '붙여넣은 원문 본문' },
      { kind: 'edit', inputText: 'x', key: KEY },
    ],
    expected: { pasted: false, reason: 'typed' },
  },
  {
    id: 'typing-then-paste',
    source: 'synthetic',
    cliContract: '2.1.292 documented / published mod shape',
    terminal: 'unverified',
    inputMethod: 'typed opening continued by a paste',
    steps: [
      { kind: 'edit', inputText: 'fix', key: KEY },
      { kind: 'edit', inputText: ' the whole log file' },
    ],
    expected: { pasted: false, reason: 'typed' },
  },
  {
    id: 'emptied-box-resets',
    source: 'synthetic',
    cliContract: '2.1.292 documented / published mod shape',
    terminal: 'unverified',
    inputMethod: 'pasted draft discarded by emptying the box',
    steps: [
      { kind: 'edit', inputText: 'a pasted sentence' },
      { kind: 'box', text: '' },
    ],
    expected: { pasted: true, reason: 'no-input-events' },
  },
]
