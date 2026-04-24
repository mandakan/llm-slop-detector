# Browser-extension store submission metadata

Copy-paste targets for the Chrome Web Store, Firefox AMO, and Edge Add-ons
listings. Keep this file up-to-date with whatever the listings say so the
source of truth lives in the repo, not in three store dashboards.

## Build the zip

```sh
npm run package:browser
# -> llm-slop-detector-browser-<version>.zip at repo root
```

Upload the same zip to all three stores.

## Short description (132 char max, Chrome)

> Flags invisible Unicode, AI-style punctuation, and telltale LLM phrases as you type -- or in any page you're reading. Local only.

(127 chars.)

## Long description

```
LLM Slop Detector highlights the things that give AI-generated writing
away: invisible Unicode smuggled inside text, em dashes and curly
quotes that spell-checkers ignore, and phrases like "delve into",
"tapestry of", "it's worth noting", or "game-changing" that appear
far more often in LLM output than in human writing.

It works in two ways:

As you write
- Scans every textarea, text input, and contenteditable on any webpage.
- Inline wavy underlines mark flagged words and phrases. A floating
  badge shows the count. Click it for per-finding explanations.
- One-click fixes for deterministic characters (em dash -> hyphen,
  curly quotes -> straight, zero-width spaces -> deleted). The fix
  goes through the host editor's native undo stack, so Cmd+Z works.
- Tested in Gmail compose, Proton Mail compose, GitHub issue forms,
  Reddit, Substack, and anything else built on plain contenteditable.

As you read
- Click the "Scan this page" button in the toolbar popup to highlight
  slop in any article, blog post, or thread you're reading. Wavy
  underlines go under flagged words; a floating results panel lists
  every finding and jumps you to it on click.
- One-shot, click-to-scan only. No background scanning.

Rules are configurable
- ~40 built-in core rules plus eleven opt-in packs covering academic
  writing, general LLM cliches, fiction tells, Claude-specific
  mannerisms, structural patterns ("not X but Y"), invisible-Unicode
  security threats, and model-specific tells for Gemini, DeepSeek,
  Llama, Qwen, and Grok -- 500+ curated regex patterns in total.
- Enable only the packs you care about. Per-site disable in one click.

Privacy
- Nothing you type, read, or scan is ever transmitted, logged, or
  persisted. All scanning runs locally inside the extension's
  sandboxed JS.
- No telemetry, no analytics, no remote rule updates. The rules are
  bundled at build time and ship with each extension release.
- Storage is chrome.storage.local only; your settings don't leave
  this device.
- No "cloud assist" toggle. Never has been. Never will be.

Open source (MIT) at github.com/mandakan/llm-slop-detector. Also
available as a VS Code extension, an npm CLI, and a web playground
for paste-and-check. Same rule engine across all of them.
```

## Permission justifications

Stores ask you to justify each permission declared in the manifest. Have these
answers ready to paste into the form:

- **`storage`**: "Persist the user's preferences -- which rule packs are
  enabled, which hosts they've disabled the extension on, and whether
  read-only page scanning is enabled. Stored locally only via
  `chrome.storage.local`; `storage.sync` is deliberately not used."

- **`host_permissions` for `http://*/*` and `https://*/*`**: "Inject the
  content script so the extension can detect editors (textareas, inputs,
  contenteditables) and mark flagged text inline as the user types. The
  content script only reads editor contents; it does not transmit them
  anywhere."

- **`all_frames: true` on content scripts**: "Email clients like Gmail and
  Proton Mail render their compose bodies in same-origin iframes. Without
  `all_frames: true` the content script would miss those editors."

- **`match_about_blank: true`**: "Proton Mail's compose body lives in an
  `<iframe src=\"about:blank\">` that is populated dynamically. Chrome
  MV3 requires this flag for the content script to reach those frames."

## URLs

- Privacy policy: `https://mandakan.github.io/llm-slop-detector/privacy.html`
- Support site / homepage: `https://github.com/mandakan/llm-slop-detector`
- Source code: same as above (MIT-licensed)
- Web playground (alternative way to try the rule engine): `https://mandakan.github.io/llm-slop-detector/`

## Category per store

- **Chrome Web Store**: Productivity -> Writing
- **Firefox AMO**: Privacy & Security (the local-only story is a real
  differentiator; no other "AI detector" extension I've seen makes that
  promise)
- **Edge Add-ons**: Productivity / Writing & Language

## Tags / keywords

`llm, ai, slop, writing, chatgpt, claude, gemini, delve, em-dash, unicode, lint, editor, gmail, proton, privacy, local-only`

## Screenshots (upload in this order)

Hero first. Store listings show the hero largest and the rest in a thumbnail
row below.

1. `docs/screenshots/rendered/01-hero-compose.png` -- inline marks on a
   compose-style body. Badge visible in the corner.
2. `docs/screenshots/rendered/02-popover.png` -- popover open with per-finding
   details.
3. `docs/screenshots/rendered/03-page-scan.png` -- article scan with wavy
   underlines and the results panel.
4. `docs/screenshots/rendered/05-fix-all.png` -- before/after char fix-all.
5. `docs/screenshots/rendered/04-options.png` -- options page with packs and
   the privacy bullet list (the "trust" shot).

All are 1280x800 PNGs. Chrome displays hero 1280-wide; AMO displays up to
1200-wide and scales gracefully.

## Icon

Pulled automatically from the zip's `icons/icon-128.png`. No manual upload
needed.

## After submission

- **Chrome Web Store**: first submission typically 1-3 weeks. The dashboard
  shows status. If rejected, the reason lives in the "Review" tab; address,
  resubmit.
- **Firefox AMO**: automated scan first (seconds to minutes); manual review
  only when the scan flags something. Listed live in hours to 3 days.
- **Edge Add-ons**: similar to AMO timeline. Edge accepts the Chrome zip
  unchanged.

## Version bumps

Each store enforces monotonically-increasing version numbers. Our
`manifest.json` version is wired into release-please's `extra-files`, so the
Release PR that bumps `package.json` also bumps the extension. After a
Release PR merges:

1. GitHub Release is created with the new version
2. `npm run package:browser` produces a new zip at the new version
3. Upload the new zip to each store dashboard under the existing listing
4. (Optional) include a short changelog note per store; Chrome shows this
   to users who expand "See changes" on the listing
