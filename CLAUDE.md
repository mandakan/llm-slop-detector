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

## Release flow

1. Edit phrases / code, commit, push.
2. Bump `version` in `package.json`.
3. `git tag vX.Y.Z && git push --tags`.
4. `.github/workflows/release.yml` runs: `npm ci` → compile → `vsce package` → attaches the `.vsix` to a GitHub Release.
5. Install locally with `code --install-extension llm-slop-detector-X.Y.Z.vsix`.

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
