# Contributing

Thanks for your interest. This repo is small enough that the rules are short.

## Dev loop

```bash
npm install
npm run compile
```

F5 in VS Code launches an Extension Development Host with the extension loaded. Edit `src/extension.ts` or `src/rules.ts`, save, and hit `Cmd/Ctrl+R` in the dev window to reload.

## Branching and PRs

- `main` is protected. No direct pushes.
- Work on a feature branch, open a PR, let CI pass, merge via **merge commit** (the repo has squash and rebase disabled -- this is intentional).
- Every commit on your feature branch ends up on `main` individually, so **every commit message must be a Conventional Commit** -- not just the PR title.
- The PR title must also be a Conventional Commit (enforced by the `pr-title` CI check).

## Cleaning up your branch before merge

This repo uses merge-commit merging, so **the commits you push are the commits that end up on `main` and in the CHANGELOG**. There is no squash step to paper over messy history. Clean the branch yourself before merging.

Before hitting "Merge":

1. Every commit message must start with a Conventional Commit type (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `refactor:`, `test:`). Non-conventional messages are silently dropped by release-please -- they won't show up in the CHANGELOG at all.
2. No `wip`, `.`, `fix typo`, `address review`, or similar placeholder commits may remain. Fold them into the commit they fix up.
3. Each commit should be a self-contained, buildable unit that passes CI on its own if possible.

How to clean up:

```bash
# Rewrite the last N commits (reorder, squash, reword).
git rebase -i origin/main

# Or target a specific commit for fixup while you're still working.
git commit --fixup <sha>
git rebase -i --autosquash origin/main

# Rewrite just the most recent message.
git commit --amend

# Push the rewritten history.
git push --force-with-lease
```

Use `--force-with-lease` (not `--force`) when you've rewritten history -- it refuses the push if someone else has updated the branch remotely, saving you from clobbering their work.

Do **not** rewrite history on `main` -- only on your feature branch, only before merge.

A quick self-check before clicking merge: `git log --oneline origin/main..HEAD` should show a list of commits that would each read sensibly as CHANGELOG entries.

## Commit / PR title convention

Conventional Commits. `release-please` scans every commit landing on `main` to cut versions and update `CHANGELOG.md`.

- `feat: ...` minor bump (pre-1.0, stays on 0.x)
- `fix: ...` patch bump
- `feat!: ...` or `BREAKING CHANGE:` in body: minor bump on 0.x, major once 1.0.0
- `docs: ...`, `chore: ...`, `ci: ...`, `refactor: ...`, `test: ...` no version bump, but still appear in CHANGELOG under "Other" if the type is recognised
- Non-conventional commits are silently ignored by release-please and won't appear in the CHANGELOG. Don't use them for user-facing changes.

Examples for this repo:
- `feat: add "paradigm shift" to built-in phrase list`
- `fix: avoid duplicate diagnostics when two rule sources define the same char`
- `docs: clarify .llmsloprc.json schema`

## Adding a phrase or char rule

Easiest paths:
- **Shared with everyone**: edit `builtin-rules.json`, add an entry under `phrases` or `chars`. Commit as `feat: add ... to built-in rules`.
- **Just for your workspace**: create `.llmsloprc.json` at the workspace root (see the schema in `README.md`). No commit needed.
- **Just for you, across workspaces**: add to `llmSlopDetector.phrases` in user `settings.json`.

## Releases

Automated via `release-please`. Do not bump the version in `package.json` manually and do not create tags.

1. Your PR merges to `main`.
2. `release-please` opens or updates a Release PR.
3. When ready, merge the Release PR.
4. Tag, GitHub Release, and `.vsix` upload happen automatically.

## Running the full packaging check locally

```bash
npm run compile
npm run package
```

Should produce `llm-slop-detector-<version>.vsix` with only `builtin-rules.json`, `package.json`, `readme.md`, `LICENSE.txt`, and `out/` inside.

## Writing style

This extension flags LLM-style punctuation and phrases. Code and prose in the repo should practice what it preaches: ASCII only (`--` not an em dash, `...` not an ellipsis glyph, straight quotes), and avoid the phrases in `builtin-rules.json`.
