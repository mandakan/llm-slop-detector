# LLM Slop Detector

VS Code extension that flags invisible Unicode, AI-style punctuation, and LLM-telltale phrases in `markdown` and `plaintext` files. Entry point: `src/extension.ts`. Single-file extension, no bundler — `tsc` outputs to `out/`.

## Build & run

- `npm run compile` — one-shot TypeScript build
- `npm run watch` — incremental rebuild
- `npm run package` — produces `llm-slop-detector-<version>.vsix` locally

The fast dev loop is **F5 in VS Code** — launches an Extension Development Host with the extension loaded (`.vscode/launch.json` starts the watcher via `preLaunchTask`). Edit, save, `Cmd+R` in the dev window.

## Adding a phrase

The recurring edit. Phrases live in `package.json` under `contributes.configuration.properties.llmSlopDetector.phrases.default` as an array of JS regex strings. Case-insensitive (`gi` flag applied by the extension). Use `\\b` for word boundaries. Invalid regexes are skipped with a `console.warn`, not a crash — see `buildPhraseRegexes` in `src/extension.ts`.

## Character detection

Two lists in `src/extension.ts`:
- `INVISIBLES` — zero-width chars, NBSP, BOM, line/paragraph separators. Surfaced as **Warnings**.
- `SUSPICIOUS` — em/en dash, curly quotes, ellipsis, angle quotes, primes, middle dot. Surfaced as **Information**.

Phrase matches are always **Information** severity to keep the Problems panel non-noisy.

## Commit convention

**Conventional Commits required** — release-please parses commit messages to decide version bumps and CHANGELOG entries.

- `feat: ...` → minor bump (0.1.0 → 0.2.0)
- `fix: ...` → patch bump (0.1.0 → 0.1.1)
- `feat!: ...` or `BREAKING CHANGE:` in body → major bump
- `chore: ...`, `docs: ...`, `ci: ...`, `refactor: ...`, `test: ...` → no bump, may appear in CHANGELOG "Other" section
- Non-conventional commits are silently ignored by release-please — don't use them for user-facing changes

Most common for this repo: `feat: add "<phrase>" to default phrase list` when expanding `llmSlopDetector.phrases`.

## Release flow (automated)

Managed by `.github/workflows/release-please.yml`. Do not bump `version` manually, do not tag manually.

1. Commit with a Conventional Commits message and push to `main`.
2. release-please opens (or updates) a **Release PR** titled "chore(main): release X.Y.Z" with the proposed version bump + CHANGELOG diff.
3. When ready to ship, merge the Release PR.
4. release-please creates the tag + GitHub Release + updates `CHANGELOG.md` on `main`.
5. Same workflow then builds the vsix and uploads it to the release.
6. Install locally: `code --install-extension llm-slop-detector-X.Y.Z.vsix`.

Not published to the VS Code Marketplace. Distribution is vsix-via-GitHub-Releases.

## Versions & targets

- `engines.vscode`: `^1.95.0` (sensible floor; don't chase bleeding edge)
- TypeScript: `^5.7`, `target: ES2022`, `module: commonjs` (extension host loads CJS — don't switch to ESM)
- `@types/node`: `^22` (matches CI Node 22 LTS)
- No bundler: the extension is ~200 LOC and has no runtime deps. If startup ever matters, switch to esbuild (`platform: node`, `format: cjs`, `external: ['vscode']`).

## What's out of scope

- Don't add ESLint/Prettier/Biome unless asked — the code is small enough that tooling ceremony isn't worth it yet.
- Don't add tests for regex patterns unless asked — regressions are cheap to catch by eye.
- Don't bundle or add runtime dependencies unless there's a concrete reason.
