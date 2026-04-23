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
- Work on a feature branch, open a PR, let CI pass, merge via **squash and merge**.
- PR titles must follow Conventional Commits (see below). The title becomes the squashed commit message and drives the changelog.

## Commit / PR title convention

Conventional Commits. `release-please` reads these to cut versions and update `CHANGELOG.md`.

- `feat: ...` minor bump (pre-1.0, stays on 0.x)
- `fix: ...` patch bump
- `feat!: ...` or `BREAKING CHANGE:` in body: minor bump on 0.x, major once 1.0.0
- `docs: ...`, `chore: ...`, `ci: ...`, `refactor: ...`, `test: ...` no version bump

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
