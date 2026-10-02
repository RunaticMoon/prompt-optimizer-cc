---
name: release-label
description: Pick and apply the release label (semver:major, semver:minor, or skip-release — otherwise patch) before you create, update, or merge a pull request targeting main, or whenever the user asks which release or version label a PR needs.
---

# Release label

Decide the release level of a pull request into `main` and label it with `gh`,
so the merged PR bumps the plugin version correctly. A PR carries at most one of
`semver:major`, `semver:minor`, `skip-release`; a patch release carries none.

## Why the label drives the version

After a PR merges, the `Version bump` workflow
(`.github/workflows/version-bump.yml`) bumps the version in
`.claude-plugin/plugin.json`, `package.json`, and `package-lock.json` and pushes
a `chore(release): vX.Y.Z` commit and tag. The level comes from the PR label:
`semver:major` → major, `semver:minor` → minor, no label → patch,
`skip-release` → no bump.

- Do **not** edit a `version` value in a PR; the workflow owns it.
- Claude Code identifies plugin updates by the `version` in `plugin.json`, so a
  user-facing change must bump the version for users to receive it.

## 1. Make sure the labels exist

Check first, then create only the missing ones with these exact values.

```bash
gh label list --search "semver:"
gh label list --search "skip-release"
```

```bash
gh label create "semver:major" --color b60205 --description "Bump the major version when this PR merges to main"
gh label create "semver:minor" --color fbca04 --description "Bump the minor version when this PR merges to main"
gh label create "skip-release" --color cfd3d7 --description "Do not bump the version when this PR merges to main"
```

## 2. Read the change

If a PR already exists:

```bash
gh pr view <n> --json number,title,labels,baseRefName,files
gh pr diff <n>
```

If not, diff the branch against `main`:

```bash
git fetch origin main
git diff --name-only origin/main...HEAD
git diff origin/main...HEAD
```

If the PR base (or the diff target) is not `main`, do not label it — tell the
user that only PRs into `main` are versioned.

## 3. Decide the label (first match wins)

Deployment-target files decide whether a release happens at all: `hooks/**` and
`.claude-plugin/plugin.json`. Everything else is not deployed — `README*`,
`docs/`, `.github/`, `.claude/`, `tests/`, `scripts/`, `LICENSE`,
`package.json` / `package-lock.json` (dev-only and `private`), `tsconfig.json`,
`.gitignore`, and `.claude-plugin/marketplace.json` (the marketplace listing
metadata, so changing it alone is not a deployment change).

1. **skip-release** — no deployment-target file changed. This wins even when a
   commit is marked breaking (`!` / `BREAKING CHANGE`): nothing ships, so
   nothing is released.
2. **semver:major** — a milestone release only: the user explicitly asks for a
   new major version (for example "make this v1.0.0" or "this is v2"), or the
   plugin is redesigned as a whole so that its core flow and most existing usage
   no longer apply. Do not choose major on your own because a change is
   incompatible; incompatible changes go to minor (rule 3) with a migration
   note. When a PR might deserve major, say why and ask the user — never apply
   it unasked.
3. **semver:minor** — a new user-visible feature, or a change to user-visible
   behavior, including incompatible changes: a new `userConfig` key or option
   value, a new command/subcommand/button/UI mode, or new behavior; removing or
   renaming a `userConfig` key or option value, changing a default so existing
   behavior changes, changing the meaning of a `/optimize` subcommand or a
   prefix (`raw`/`trigger`), raising the minimum Claude Code version, a `!` in
   the commit subject / `BREAKING CHANGE` in the body. A `feat:` commit that
   touches deployment-target files lands here by default. Any of these breaking
   changes must include a migration note in the PR body and README (how to keep
   the previous behavior).
4. **no label (patch)** — any other change to deployment-target files: bug
   fixes, refactors, performance, wording/prompt tweaks.

Major is reserved for the user's explicit request, so a call is never ambiguous
between minor and major: when in doubt, decide between minor and patch, state
your reasoning and ask. If the user names a label, follow it.

## 4. Apply it

A PR gets at most one release label. Add the chosen one, and remove only the
other release labels that are actually on the PR (check `labels` from
`gh pr view <n> --json labels`):

```bash
gh pr edit <n> --add-label "semver:minor" --remove-label "skip-release"
```

If `gh pr edit` fails with a "Projects (classic) is being deprecated" GraphQL
error (some `gh` versions), use the REST API instead:

```bash
gh api -X POST repos/{owner}/{repo}/issues/<n>/labels -f 'labels[]=semver:minor'
gh api -X DELETE repos/{owner}/{repo}/issues/<n>/labels/skip-release
```

For patch, remove whichever release labels are on the PR and add none. Leave
unrelated labels untouched. If no PR exists yet, pass `--label` to
`gh pr create` or apply the label right after creation.

## 5. Check safety before merging

- If the PR diff changes a `version` in `plugin.json`, `package.json`, or
  `package-lock.json`, warn and ask the author to revert it — the workflow bumps
  it after the merge.
- Right before merging, confirm the label stuck:

```bash
gh pr view <n> --json labels
```

## 6. Report

State the chosen label (or "patch — no label"), one to three files/changes that
drove the decision, and the version expected after the merge. Get the current
version with `npm run check:version`, then compute the next one.

## Examples

| Change in the PR | Label |
|---|---|
| Only `docs/` and `README.md` | `skip-release` |
| Bug fix in `hooks/model.ts` | none (patch) |
| New `userConfig` key in `plugin.json` | `semver:minor` |
| Renamed a `userConfig` key (old name gone) | `semver:minor` (+ migration note in PR/README) |
| Changed a default or a prefix's meaning | `semver:minor` (+ migration note) |
| User asks to release v1.0.0 / v2.0.0 | `semver:major` |
