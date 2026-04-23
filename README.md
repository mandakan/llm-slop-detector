# LLM Slop Detector

A VS Code extension that flags invisible Unicode, AI-style punctuation, and telltale LLM phrases in `markdown` and `plaintext` files.

## What it flags

**Warnings (yellow):** zero-width characters, non-breaking spaces, BOM, line/paragraph separators — stuff that hides in the text and wrecks diffs.

**Info (blue, non-intrusive):** em/en dashes, curly quotes, horizontal ellipsis, angle quotes, and a configurable list of phrase regexes like `delve`, `it's worth noting`, `tapestry of`, `leverage`, etc.

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

Reload VS Code. Open any `.md` or `.txt` file — diagnostics appear in the Problems panel and as squiggles inline.

## Configuration

Settings (Cmd/Ctrl+, → search "LLM Slop"):

- `llmSlopDetector.enabled` — toggle on/off
- `llmSlopDetector.useBuiltinRules` — load the shipped built-in list (default `true`). Turn off to rely only on local rule files / user settings.
- `llmSlopDetector.phrases` — additional regex patterns, appended to the built-in list.
- `llmSlopDetector.charReplacements` — override quick-fix replacements per character.

## Commands

`Cmd/Ctrl+Shift+P` →
- **LLM Slop Detector: Toggle** — enable/disable
- **LLM Slop Detector: Show loaded rule sources** — quick pick listing every active source with name, version, and rule counts

## Rule sources

Rules merge from three layers (later overrides earlier on the same char/pattern):

1. Built-in list shipped with the extension
2. Local `.llmsloprc.json` in a workspace folder's root (auto-loaded, live-reloaded)
3. User settings

### `.llmsloprc.json` format

```json
{
  "name": "my-project",
  "version": "1.0.0",
  "description": "Extra phrases for this repo",
  "chars": [
    { "char": "—", "name": "EM DASH", "severity": "information", "replacement": " - " }
  ],
  "phrases": [
    { "pattern": "\\bour pet phrase\\b", "reason": "we banned this" }
  ]
}
```

Each char rule: `char` required; `name`, `severity` (`error | warning | information | hint`), `replacement`, `suggestion` optional. Each phrase rule: `pattern` required; `reason`, `severity` optional. Patterns are JavaScript regex, case-insensitive. Use `\\b` for word boundaries.

### Quick user overrides (no rule file needed)

```json
"llmSlopDetector.phrases": ["\\byour own pet phrase\\b"],
"llmSlopDetector.charReplacements": { "—": " - " }
```
