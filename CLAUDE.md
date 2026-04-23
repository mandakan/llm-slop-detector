# LLM Slop Detector

VS Code extension and CLI that flag invisible Unicode, AI-style punctuation, and LLM-telltale phrases in `markdown` and `plaintext` files.

- Extension entry: `src/extension.ts`
- CLI entry: `src/cli.ts` (shipped as `llm-slop` via the `bin` field; same rule engine as the extension)
- Pure core (no `vscode` import): `src/core/types.ts`, `src/core/rules.ts`, `src/core/scan.ts`, `src/core/comments.ts`. Shared by extension and CLI so they always produce identical findings.
- VS Code adapter: `src/rules.ts` reads workspace config and delegates to `src/core/rules.ts`; `severityToVscode()` maps the pure `Severity` string union to `vscode.DiagnosticSeverity`
- Built-in rule list: `builtin-rules.json` at repo root
- Pre-commit hook: `.pre-commit-hooks.yaml` at repo root
- No bundler: `tsc` outputs to `out/`; `compile` also `chmod +x out/cli.js`

## Build & run

- `npm run compile`: one-shot TypeScript build
- `npm run watch`: incremental rebuild
- `npm run package`: produces `llm-slop-detector-<version>.vsix` locally
- `npm run slop -- <paths>`: run the CLI from source against files/dirs

The fast dev loop is **F5 in VS Code**. Launches an Extension Development Host with the extension loaded (`.vscode/launch.json` starts the watcher via `preLaunchTask`). Edit, save, `Cmd+R` in the dev window.

## Architecture

Four pieces of user-visible surface, all wired up in `activate()`:

1. **Diagnostics**: `scanDocument()` runs on open/change, reads from module-level `RULES` (a `RuleSet` returned by `loadRules()`), emits `vscode.Diagnostic`s with `source = 'LLM Slop'` and `code` of `'char'` or `'phrase'`.
2. **Code actions**: `SlopCodeActionProvider` offers per-diagnostic quick fixes (when a `CharRule` has a `replacement`) and a "Fix all LLM slop characters in file" action. Gated on the cursor's current diagnostic context containing a fixable char, otherwise the fix-all lightbulb appears on phrase diagnostics too.
3. **Status bar**: right-aligned item shows slop count for the active `markdown`/`plaintext` editor. Warning background when there are issues, check icon when clean, circle-slash when the extension is disabled. Click calls `llmSlopDetector.toggle`.
4. **Commands**: `llmSlopDetector.toggle` and `llmSlopDetector.showRuleSources`.

## Rule sources

Rules (chars + phrases) load from these layers, merged in order. Later layers override earlier on the same char or pattern.

1. **Built-in core**: `builtin-rules.json` at repo root, shipped in the vsix, read at activation from `context.extensionUri`. Disable via `llmSlopDetector.useBuiltinRules: false`. Contains no third-party content.
2. **Built-in packs** (opt-in): JSON files in `builtin-packs/`, loaded when their name appears in `llmSlopDetector.enabledPacks`. Current packs: `academic`, `cliches`, `fiction`, `claudeisms`, `structural`. Whitelist is in `BUILTIN_PACKS` in `src/rules.ts` -- unknown names are ignored. Attribution for each pack is in `THIRD_PARTY_NOTICES.md`.
3. **Local**: `.llmsloprc.json` in a workspace folder's root. Same schema as the built-in file. Auto-loaded if present, live-reloaded via `vscode.workspace.createFileSystemWatcher`.
4. **User settings**: `llmSlopDetector.phrases` (additive list of regex strings) and `llmSlopDetector.charReplacements` (map of char to replacement, overrides earlier layers).

`loadRules(extensionUri)` returns a `RuleSet { chars, phrases, sources }`. `extension.ts` stores it in module-level `RULES` and rebuilds `CHAR_REGEX` on every reload. Reload is triggered by the file watcher, workspace-folder changes, and config changes.

### Adding a phrase (the recurring edit)

- **Built-in** (shared with everyone): edit `builtin-rules.json`, add `{ "pattern": "...", "reason": "..." }` under `phrases`. Commit as `feat: add "<phrase>" to built-in rules`.
- **Workspace-local**: create `.llmsloprc.json` at the workspace root with the same shape. Don't commit it unless it's meant to be shared.
- **Personal, across workspaces**: add to `llmSlopDetector.phrases` in user `settings.json`.

Regex is JS `RegExp` with `gi` flags applied by the loader. Use `\\b` for word boundaries. Invalid regexes are skipped with a `console.warn` rather than crashing the extension.

### Rule schema (`builtin-rules.json` / `.llmsloprc.json`)

```json
{
  "name": "built-in",
  "version": "0.2.0",
  "description": "optional, shown in the rule-sources quick pick",
  "chars": [
    { "char": "--", "name": "EM DASH", "severity": "information", "replacement": "-" },
    { "char": ".", "name": "MIDDLE DOT", "severity": "information", "suggestion": "legit in Catalan" }
  ],
  "phrases": [
    { "pattern": "\\bdelve(s|d|ing)?\\b", "reason": "LLM filler", "severity": "information" }
  ]
}
```

Fields: `severity` is one of `error | warning | information | hint`. `replacement` (if present) is what the quick fix writes. `suggestion` is a freeform message shown when there's no deterministic fix. Diagnostics surface provenance with a `[<source name>]` suffix in the message.

### Char severity defaults

`defaultCharSeverity()` in `rules.ts` picks Warning for invisibles (zero-width, NBSP, separators, BOM) and Information for visible punctuation when a rule file omits `severity`. Phrase matches default to Information to keep the Problems panel non-noisy.

## Commit convention

**Conventional Commits required.** Which commit release-please parses depends on how you merge.

- `feat: ...`: minor bump (e.g. 0.2.0 -> 0.3.0)
- `fix: ...`: patch bump (e.g. 0.2.0 -> 0.2.1)
- `feat!: ...` or `BREAKING CHANGE:` in body: minor bump (pre-1.0 rule, see below)
- `chore: ...`, `docs: ...`, `ci: ...`, `refactor: ...`, `test: ...`: no version bump, may appear in CHANGELOG "Other" section
- Non-conventional commits are silently ignored by release-please. Don't use them for user-facing changes.

### Merge strategy

**Default: squash-merge.** One commit per PR lands on `main`, with the squash commit's subject set from the PR title. The PR title must be a Conventional Commit (`feat:`/`fix:`/etc.) -- that's what release-please reads. `amannn/action-semantic-pull-request` enforces it on the PR.

**Exception: merge-commit** for the occasional PR that genuinely contains multiple distinct changes you want to surface as separate CHANGELOG entries (e.g. a `feat:` plus an unrelated `fix:` plus a `docs:` in one branch). Pick "Create a merge commit" in the GitHub UI on that specific PR. When you do:

- Every commit on the branch must itself be a Conventional Commit, since each one lands on `main` and each one is scanned by release-please.
- **The PR title must be plain English, not conventional-commit form.** GitHub embeds the PR title into the merge commit's body, and release-please's parser treats that body as an additional conventional commit. A `feat: ...` PR title on a merge-commit PR produces a phantom duplicate entry in the CHANGELOG.
- The semantic-PR-title check will fail on a non-conventional title. Either bypass it for that PR or relax the action's config.

Rebase-merge stays disabled -- too easy to re-order commits accidentally.

### Branch hygiene before merge

Squash-merge absorbs most sins: scratch commits, wip pushes, and typo fixups all collapse into one clean commit tied to the PR title. So branch hygiene matters primarily for reviewers and for the merge-commit exception.

For squash-merge PRs:

1. The PR title is the only thing that lands on `main`. Make it a clear Conventional Commit.
2. Commit messages on the branch are for reviewers. Keep them readable but don't obsess.

For merge-commit PRs (the exception):

1. Every commit message starts with a Conventional Commit type. Messages that don't are invisible to release-please and just clutter `main`.
2. No `wip`, `fix typo`, `address review`, `.`, or similar scratch commits. Fold them into the commit they fix up via `git commit --fixup <sha>` + `git rebase -i --autosquash origin/main`.
3. Each commit should be a self-contained, buildable unit -- prefer several small `feat:` / `fix:` / `refactor:` commits over one giant one, but don't ship broken intermediate states either.
4. Rewrite history only on the feature branch, never on `main`. Push rewrites with `git push --force-with-lease`, never plain `--force`.
5. `git log --oneline origin/main..HEAD` should read like a clean CHANGELOG preview. If it doesn't, rebase.

### Pre-1.0 bumping

`release-please-config.json` sets `bump-minor-pre-major: true`, so while version is 0.x, breaking changes bump minor instead of jumping to 1.0. Graduate to 1.0.0 manually when the API is intentionally stabilized.

## Release flow (automated)

Managed by `.github/workflows/release-please.yml`. Do not bump `version` in `package.json` manually, do not tag manually.

1. Work on a feature branch with a Conventional Commit PR title, let CI pass, and **squash-merge** (the default). The PR title becomes the commit subject on `main` and is the only input release-please sees for this PR. For the rare PR that genuinely needs multiple CHANGELOG entries, pick "Create a merge commit" instead and follow the merge-commit rules in "Merge strategy" above.
2. release-please opens (or updates) a **Release PR** titled "chore(main): release X.Y.Z" with the proposed version bump and CHANGELOG diff.
3. When ready to ship, merge the Release PR.
4. release-please creates the tag, the GitHub Release, and updates `CHANGELOG.md` on `main`.
5. Same workflow then builds the vsix, uploads it to the GitHub Release, and publishes it to the VS Code Marketplace under publisher `thias-se`.
6. Install from Marketplace, or sideload: `code --install-extension llm-slop-detector-X.Y.Z.vsix`.

Marketplace publish uses an Azure DevOps PAT stored as the `VSCE_PAT` repo secret. release-please itself runs with a GitHub fine-grained PAT stored as `RELEASE_PLEASE_TOKEN` so that the Release-PR merge actually triggers downstream workflow steps (the default `GITHUB_TOKEN` does not, by design).

## Versions & targets

- `engines.vscode`: `^1.95.0` (sensible floor, don't chase bleeding edge)
- TypeScript: `^5.7`, `target: ES2022`, `module: commonjs` (extension host loads CJS, don't switch to ESM)
- `@types/node`: `^22` (matches CI Node 22 LTS)
- No bundler. If startup ever matters, switch to esbuild (`platform: node`, `format: cjs`, `external: ['vscode']`).

## Packaging

`.vscodeignore` keeps the vsix lean: `builtin-rules.json`, `builtin-packs/`, `package.json`, `README.md`, `THIRD_PARTY_NOTICES.md`, `LICENSE`, root governance files, and `out/` ship. Dev files, release-please config, `src/`, `.github/`, `.claude/`, and CLAUDE.md are excluded.

Third-party-licensed content lives only in `builtin-packs/*.json`. `THIRD_PARTY_NOTICES.md` must ship alongside any pack that contains derivative content. When adding a new pack sourced from a third-party project, also add its license block to `THIRD_PARTY_NOTICES.md` in the same commit.

## What's out of scope

- Don't add ESLint/Prettier/Biome unless asked. The code is small enough that tooling ceremony isn't worth it yet.
- Don't add tests for regex patterns unless asked. Regressions are cheap to catch by eye.
- Don't bundle or add runtime dependencies unless there's a concrete reason.

## Writing style in prose / commits / docs

Per the user's global style guide: ASCII punctuation only (`--` not an em dash, `...` not an ellipsis glyph, straight quotes). Avoid LLM-flavoured words (delve, leverage, seamless, robust, paradigm shift, etc.). This matters especially here, since the extension itself flags them. The project is its own linter.
