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
- `llmSlopDetector.phrases` — array of regex patterns (case-insensitive). Edit in `settings.json` to add your own.

## Toggle command

`Cmd/Ctrl+Shift+P` → "LLM Slop Detector: Toggle"

## Adding your own phrases

```json
"llmSlopDetector.phrases": [
  "\\bdelve(s|d|ing)?\\b",
  "\\byour own pet phrase\\b"
]
```

Use `\\b` for word boundaries. Patterns are JavaScript regex, case-insensitive.
