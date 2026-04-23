# LLM Slop Detector

A VS Code extension that flags invisible Unicode, AI-style punctuation, and telltale LLM phrases in `markdown` and `plaintext` files.

## What it flags

**Warnings (yellow):** zero-width characters, non-breaking spaces, BOM, line and paragraph separators. Stuff that hides in the text and wrecks diffs.

**Info (blue, non-intrusive):** em and en dashes, curly quotes, horizontal ellipsis, angle quotes, and a configurable list of phrase regexes like `delve`, `it's worth noting`, `tapestry of`, `leverage`, etc.

Diagnostics show which rule source flagged a match (`[built-in]`, `[your-list-name]`) so you can tell where a rule came from.

## Quick fixes

Most flagged characters have deterministic fixes available via the lightbulb menu (`Cmd/Ctrl+.`):

- zero-width, BOM, joiners: delete
- no-break / narrow no-break space: regular space
- line / paragraph separator: newline
- em dash, en dash: hyphen
- ellipsis: three dots
- curly quotes: straight quotes

No default fix for angle quotes (`« »`), primes (`′ ″`), or middle dot (`·`). These are legitimate punctuation in many locales. You can still force a fix via the `llmSlopDetector.charReplacements` setting.

Phrases have no quick fix by design. No deterministic replacement exists for "delve".

A **Fix all LLM slop characters in file** action is offered whenever the cursor is on a fixable character diagnostic.

## Status bar

Right-aligned status bar item shows the slop count for the active `markdown` or `plaintext` file:

- `$(warning) N slop` with a warning background when issues exist
- `$(check) No slop` when the file is clean
- `$(circle-slash) Slop off` when disabled

Click toggles the detector. Hidden when the active editor is a different language.

## Install (from a GitHub Release)

Grab the latest `.vsix` from [Releases](https://github.com/mandakan/llm-slop-detector/releases), then:

```bash
code --install-extension llm-slop-detector-<version>.vsix
```

## Install (from source)

```bash
git clone https://github.com/mandakan/llm-slop-detector.git
cd llm-slop-detector
npm install
npm run compile
npm run package
code --install-extension llm-slop-detector-*.vsix
```

Reload VS Code. Open any `.md` or `.txt` file. Diagnostics appear in the Problems panel and as squiggles inline.

## Configuration

Settings (Cmd/Ctrl+, then search "LLM Slop"):

- `llmSlopDetector.enabled`: toggle on/off
- `llmSlopDetector.useBuiltinRules`: load the shipped built-in list (default `true`). Turn off to rely only on local rule files and user settings.
- `llmSlopDetector.enabledPacks`: opt-in extra rule packs, see [Rule packs](#rule-packs) below. Default: `[]`.
- `llmSlopDetector.phrases`: additional regex patterns, appended to the built-in list.
- `llmSlopDetector.charReplacements`: override quick-fix replacements per character.

## Rule packs

The core list (`builtin-rules.json`) is deliberately conservative: ~40 phrase rules covering the buzzwords everyone agrees on (`delve`, `leverage`, `seamless`, `paradigm shift`, etc.). For more coverage, opt into one or more packs via `llmSlopDetector.enabledPacks`:

- **`academic`** -- words over-represented in LLM-authored academic writing (`bolster`, `elucidate`, `facilitate`, `showcase`, `noteworthy`, ~90 entries). Severity `hint` so the Problems panel stays usable. Derived from [`berenslab/llm-excess-vocab`](https://github.com/berenslab/llm-excess-vocab) (MIT).
- **`cliches`** -- general LLM cliche vocabulary (`captivating`, `pinnacle`, `galvanize`, journey/landscape/symphony metaphors). Derived from [`nanxstats/llm-cliches`](https://github.com/nanxstats/llm-cliches) (MIT).
- **`fiction`** -- fiction and creative-writing tells (breath hitched, heart hammering, shivers down spine, chestnut eyes, LLM-cliche character names). **Includes adult-fiction markers.** Derived from [`SicariusSicariiStuff/SLOP_Detector`](https://github.com/SicariusSicariiStuff/SLOP_Detector) (Apache-2.0).
- **`claudeisms`** -- Claude-specific mannerisms: sycophantic openers, consent-theater phrasing, "important to note that" hedges. Derived from SLOP_Detector.
- **`structural`** -- structural LLM tells: "not X but Y" negation pivots, sycophantic line openers, "in this section we'll" meta-commentary, "at the end of the day" closers. Original content.

Enable one or more in your settings:

```json
"llmSlopDetector.enabledPacks": ["academic", "structural"]
```

Attribution and license texts for each pack's source are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

### Tuning a pack

Packs are merged after the core list, so a pack entry wins if it targets the same char as core. Phrase rules accumulate. If a specific pack rule is too noisy for your writing, either:

1. Disable the whole pack (remove from `enabledPacks`), or
2. Keep the pack enabled and override locally via a `.llmsloprc.json` file at your workspace root -- a later layer's chars override earlier layers on the same character; phrases are additive, so there's no way to silence a single phrase without forking the pack.

If a whole pack is unusable in your workflow, file an issue.

## Commands

`Cmd/Ctrl+Shift+P`:
- **LLM Slop Detector: Toggle**: enable/disable
- **LLM Slop Detector: Show loaded rule sources**: quick pick listing every active source with name, version, and rule counts

## Rule sources

Rules merge from these layers (later overrides earlier on the same char or pattern):

1. Built-in core list shipped with the extension
2. Optional built-in packs listed in `llmSlopDetector.enabledPacks`
3. Local `.llmsloprc.json` in a workspace folder's root (auto-loaded, live-reloaded)
4. User settings

### `.llmsloprc.json` format

```json
{
  "name": "my-project",
  "version": "1.0.0",
  "description": "Extra phrases for this repo",
  "chars": [
    { "char": "--", "name": "EM DASH", "severity": "information", "replacement": " - " }
  ],
  "phrases": [
    { "pattern": "\\bour pet phrase\\b", "reason": "we banned this" }
  ]
}
```

Each char rule: `char` required. `name`, `severity` (`error | warning | information | hint`), `replacement`, `suggestion` optional.

Each phrase rule: `pattern` required. `reason`, `severity` optional.

Patterns are JavaScript regex, case-insensitive. Use `\\b` for word boundaries.

### Quick user overrides (no rule file needed)

```json
"llmSlopDetector.phrases": ["\\byour own pet phrase\\b"],
"llmSlopDetector.charReplacements": { "--": " - " }
```
