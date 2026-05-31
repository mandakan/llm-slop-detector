# Slop-list and detection-algorithm review -- 2026-05-30

A research pass to decide whether the rule lists and the detection engine need
updating. Run as a five-angle web-research sweep (new model packs, phrase/word
lists, Unicode/punctuation, detection algorithm, comparable open-source
projects), with cross-source verification. Example tells are written in
`backticks` throughout so this document does not flag against the detector's own
markdown scan.

Baseline scanned: `builtin-rules.json` (36 chars, 39 phrases), 10 phrase packs
(~525 phrases), and the `security` pack (352 confusables). Engine reviewed:
`src/core/scan.ts`, `src/core/rules.ts`.

## Verdict

**Yes, an update is warranted -- additive, not a rewrite.** The deterministic
regex + Unicode approach is sound for 2026 and should stay. The gaps are
content (missing model pack, missing newer phrases, missing hidden-text Unicode
ranges) plus two optional engine refinements (density scoring, severity
calibration). Nothing here calls for an ML classifier; the research is clear
that statistical AI-text detectors are unreliable and bias-prone, and that a
findings-not-verdict tool is the defensible design.

Priority order:

1. **Add an `openai` / `chatgpt` pack** -- the single biggest coverage gap.
2. **Add citation-artifact tokens** (`oaicite`, `contentReference`, `grok_card`) -- highest-precision tells anywhere, near-zero false positives.
3. **Add a hidden-text Unicode pack** (Tag block + variation selectors + invisible math operators) -- a class the tool misses entirely.
4. **Extend phrase lists** with newer, well-documented tells (negative parallelism, conversational scaffolding, newer vocabulary surges).
5. **Augment existing packs**: `claudeisms`, `grok`, `deepseek`.
6. **Optional engine work**: density scoring and severity calibration for perishable, high-false-positive tells.

---

## 1. New model packs

### 1a. Missing `openai` / `chatgpt` pack (HIGH priority)

The tool ships per-model packs for Claude, Gemini, DeepSeek, Llama, Qwen, and
Grok, but has **no OpenAI/GPT pack** despite GPT being the most-documented model
for stylistic tells. The GPT-distinctive value is in conversational scaffolding
and artifact tokens, not the vocabulary words (those overlap existing
`cliches`/`academic`/`structural` packs). Candidate clusters, all high
confidence:

- **Self-reference / boilerplate** (strongest single giveaways): `as an AI language model`, `as a large language model`, `as of my last knowledge update`, `my training data`, `knowledge cutoff`, `I cannot fulfill this request`.
- **Openers**: `Certainly!`, paragraph-initial `Absolutely!`, `Sure! Here's`, `Of course! Let me`, `Great question!`, `I'd be happy to help`, `Let me break this down for you`.
- **Closers**: `I hope this helps!`, `Let me know if you need anything else`, `Let me know if you'd like me to elaborate`, `Feel free to reach out`, `Is there anything else I can help you with?`, `Don't hesitate to ask`.
- **Hedging**: `it should be noted that`, `it's worth mentioning that`, `generally speaking`, `depending on the context`.

Sources: Originality.ai 10M-word analysis (<https://originality.ai/blog/obvious-chatgpt-sayings>),
Sapling n-gram study (<https://sapling.ai/devblog/chatgpt-phrases/>),
DeGPT tells list (<https://www.degpt.app/blog/chatgpt-tells-phrases-list>),
The Decoder / Reddit compilation (<https://the-decoder.com/reddit-users-compile-list-of-words-and-phrases-that-unmask-chatgpts-writing-style/>).

### 1b. Citation-artifact leak tokens (HIGH priority, near-zero false positives)

Literal markup that LLMs leak into pasted output. Deterministic, almost never
appears in genuine human prose. Wikipedia's "Signs of AI writing" guide lists
these as near-certain markers:

- `oaicite`, `oai_citation`, `contentReference`, `:contentReference[oaicite:` (ChatGPT)
- `grok_card` (Grok)
- `utm_source=` in reference URLs (weaker, more false positives)

These belong either in the `openai`/`grok` packs or in a small shared
`artifacts` pack. Source: <https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing>.

### 1c. Augment existing packs

- **`claudeisms`**: add the `You're absolutely right` family (`You're absolutely right`, `You're absolutely correct`, `You're right to`, `Great catch!`). The signature 2025 Claude sycophancy tell; Anthropic itself tuned 4.5 to "apologize less needlessly / agree less," confirming the prior pattern. Sources: <https://www.theregister.com/software/2025/08/13/claude-codes-endless-sycophancy-annoys-customers/>, <https://www.anthropic.com/news/claude-sonnet-4-5>.
- **`grok`**: add `grok_card` (see 1b). Community consensus is Grok 3/4 prose is otherwise "flat / unremarkable," so few other Grok-specific phrase tells are documented.
- **`deepseek`**: medium-confidence option -- chain-of-thought language-mixing (stray CJK in English output) and CoT openers `Wait,` / `Hmm,` / `Let's think`. Narrower utility (reasoning traces, not final prose). Sources: DeepSeek R1 paper <https://arxiv.org/pdf/2501.12948>.

### 1d. Skip for now

No well-documented, quotable, model-attributable phrase tells found for
**Mistral**, or net-new for **Gemini / Llama / Qwen**. Gemma creative-writing
tells (the name `Elara`, etc.) overlap the existing `fiction` pack. Not worth
new packs yet. Source: Antislop paper <https://arxiv.org/abs/2510.15061>,
EQ-Bench antislop-sampler <https://github.com/sam-paech/antislop-sampler>.

---

## 2. Phrase / word lists

Newer or commonly-cited tells **not** already in the built-in list or packs.
Confidence reflects how many independent sources name each one.

### 2a. Rhetorical structures (HIGH value, regex-tractable, low false positive)

The single most-documented *new* (2025) tell is **negative parallelism /
contrastive negation**:

- `It's not X, it's Y` / `It's not just X, it's Y` -- regex: `\bit'?s not (just )?.{1,40}?,? it'?s\b`
- `Not only X, but also Y` / `Not X, but Y` -- regex: `\bnot only\b.{1,40}?\bbut also\b`
- "-ing" superficial-analysis tails: `highlighting its importance`, `reflecting broader trends`, `underscoring its significance` -- regex: `\b(highlighting|reflecting|underscoring|emphasizing|showcasing) (its|the|a) \w+`
- Copula avoidance (replaces is/are): `serves as`, `stands as`, `holds the distinction of being`
- Formulaic transition cycling: `Moreover,` / `Furthermore,` / `Additionally,` (sentence-initial)

Sources: Wikipedia Signs of AI writing (<https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing>),
Reissmann on contrastive negation (<https://olereissmann.com/contrastive-negation-used-to-be-a-rhetorical-device-now-it-screams-i-used-chatgpt/>).

### 2b. Conversational-assistant phrases (HIGH precision -- rare in human prose)

- `You're absolutely right`, `Great question!`, `That's a great question`
- `Certainly!`, `Of course!` (as a response opener)
- `I hope this email finds you well`
- `I apologize for any confusion`
- `Let me know if you have any questions`, `Feel free to`
- `Rest assured`, `I understand where you're coming from`

Source: <https://ai.gopubby.com/is-it-ai-the-words-and-phrases-that-give-chatgpt-away-1a57f417a9c7>.

### 2c. Multi-word phrases (HIGH confidence)

- `stands as a testament`, `serves as a testament` (built-in only has `a testament to`)
- `plays a vital role`, `plays a significant role` (built-in only has `crucial role`)
- `rich cultural heritage`, `nestled in the heart of`, `in the realm of`, `in the heart of`
- `leaves an indelible mark`, `enduring legacy`, `valuable insights`, `deeply rooted`
- `let's dive in`, `let's unpack this`, `let's break it down` (built-in only has `dive into`)
- `here's the thing`, `here's where it gets interesting`, `here's what most people miss`
- `in essence`, `in summary`, `to sum up` (built-in only has `in conclusion`)

### 2d. Single words (HIGH confidence -- documented vocabulary surges)

From two arXiv excess-vocabulary studies and the Wikipedia list:

- `intricate` / `intricacies`, `showcasing` / `showcase`, `pivotal`, `realm`, `commendable`, `notably`, `comprehensive`, `garner` / `garnered`, `boasts`, `nestled`, `vibrant`, `enduring`, `interplay`, `enhance` / `enhancing`, `bolstered`

Frequency evidence: `delves` r=25.2, `showcasing` r=9.2, `underscores` r=9.1
(Kobak et al., Science Advances 2025, arXiv 2406.07016
<https://arxiv.org/html/2406.07016v1>); `delve` +1,375%, `boasts` +918%,
`intricate` +611% from 2020-2024 (arXiv 2412.11385
<https://arxiv.org/html/2412.11385v1>). Wikipedia coverage via NPR
(<https://www.npr.org/2025/09/04/nx-s1-5519267/wikipedia-editors-publish-new-guide-to-help-readers-detect-entries-written-by-ai>).

### 2e. Lower-confidence / noisy (add as `information`/`hint` only, if at all)

`utilize`, `streamline`, `elevate`, `unleash`, `labyrinth`, `enigma`, magic
adverbs (`quietly`, `fundamentally`, `arguably`). These appear in normal prose
and will be noisy.

### Cross-check with comparable lists

- FareedKhan-dev/Detect-AI-text-Easily 74-word list (<https://github.com/FareedKhan-dev/Detect-AI-text-Easily>)
- jalaalrd/anti-ai-slop-writing (<https://github.com/jalaalrd/anti-ai-slop-writing>)
- SicariusSicariiStuff/SLOP_Detector -- fiction/RP slop, overlaps `fiction` pack (<https://github.com/SicariusSicariiStuff/SLOP_Detector>)
- proselint / write-good weasel + cliche dictionaries (<https://github.com/amperser/proselint>)

---

## 3. Unicode / punctuation

The classic set (zero-width, bidi, NBSP, narrow NBSP `U+202F`, em/en dash,
smart quotes, ellipsis) is well covered. `U+202F` is correctly the headline
AI-style spacing tell (confirmed across multiple 2025 sources: GPT-5
non-reasoning emits it before punctuation). The gaps fall in two groups.

### 3a. Hidden-text / smuggling ranges (HIGH priority -- a missing class)

The `security` pack is homoglyph-focused and misses the invisible-instruction /
steganography vectors entirely. These are the 2024-2025 prompt-injection
research findings (Goodside, Butler, Thacker; flagged by AWS and Cisco):

| Range | Name | Why |
|---|---|---|
| `U+E0000`-`U+E007F` | Tag characters | ASCII smuggling -- `U+E0020`-`U+E007E` map 1:1 to printable ASCII, hiding invisible instructions an LLM still reads. Highest priority. |
| `U+FE00`-`U+FE0F` | Variation selectors 1-16 | Emoji variation-selector steganography (Butler, Feb 2025); encode hidden bytes through copy-paste. |
| `U+E0100`-`U+E01EF` | Variation selectors supplement | Completes the 256-byte channel. Used in-the-wild (May 2025 `os-info-checker-es6` npm C2). |
| `U+2061`-`U+2064` | Invisible math operators | No legitimate prose use; "Sneaky Bits" encodes data with `U+2062`/`U+2064`. |
| `U+034F` | Combining grapheme joiner | Default-ignorable, used to break up tokens / hide text. |
| `U+206A`-`U+206F` | Deprecated format chars | Invisible, no legit modern use. |
| `U+180B`-`U+180D` | Mongolian free variation selectors | Additional invisible variation selectors. |
| `U+2800` | Braille pattern blank | Renders blank but classified as Symbol, slips whitespace filters. |

Recommend a dedicated opt-in pack (e.g. `smuggling` or `invisible`) at `warning`
severity, separate from the homoglyph `security` pack, since aggressive
variation-selector flagging will false-positive on legitimate emoji.

Sources: Embrace The Red ASCII Smuggler (<https://embracethered.com/blog/posts/2025/sneaky-bits-and-ascii-smuggler/>),
Paul Butler emoji steganography (<https://paulbutler.org/2025/smuggling-arbitrary-data-through-an-emoji/>),
AWS (<https://aws.amazon.com/blogs/security/defending-llm-applications-against-unicode-character-smuggling/>),
Cisco (<https://blogs.cisco.com/ai/understanding-and-mitigating-unicode-tag-prompt-injection>),
Veracode npm C2 writeup (<https://www.veracode.com/resources/sophisticated-npm-attack-leveraging-unicode-steganography-and-google-calendar-c2-2/>),
Originality.ai invisible-text detector (<https://originality.ai/blog/invisible-text-detector-remover>).

### 3b. Extra spacing characters (MEDIUM/LOW, completeness)

The rest of the General Punctuation space block, which AI-cleanup tools
normalize wholesale to `U+0020`: `U+2007` figure space, `U+2009` thin space,
`U+200A` hair space, `U+2005` four-per-em, `U+205F` medium math space, plus
`U+3000` ideographic space. Adding the whole `U+2000`-`U+200A` run rounds out
the spacing-normalization story. Source: <https://invisible-characters.com/>.

### Engine note

`buildCharRegex` in `src/core/rules.ts` keys on `codePointAt(0)` and builds a
single-codepoint character class, so multi-codepoint sequences cannot be
expressed as char rules. The smuggling ranges above are all single code points,
so they fit the existing model. But "narrow-NBSP *before punctuation*" as a
contextual rule would need a phrase regex, not a char rule -- worth noting if a
context-sensitive spacing rule is ever wanted.

---

## 4. Detection algorithm

**The deterministic regex + Unicode approach is sound for 2026.** Evidence:

- **ML classifiers are unreliable.** OpenAI discontinued its own classifier (July 2023) for low accuracy (~26% true-positive). Source: <https://openai.com/index/new-ai-classifier-for-indicating-ai-written-text/>.
- **ML classifiers are bias-prone.** Liang et al. (Stanford, Patterns 2023, arXiv:2304.02819) found GPT detectors misclassified ~61% of non-native-English TOEFL essays as AI. Institutions (Yale, Vanderbilt, Northwestern) disabled Turnitin's AI detection over false positives. Source: <https://arxiv.org/abs/2304.02819>.
- **Surfacing findings, not a verdict, is the right call.** A tool that emits information/warning findings with severity tiers sidesteps the false-accusation failure mode that sank the ML detectors.
- **The Unicode layer is the most defensible component** -- exact string matching, near-100% reliable detection. Caveat: an invisible-char hit means "anomalous / possibly pasted," not "AI." Most invisible-char hits in practice are copy-paste artifacts.

Two evidence-backed refinements worth considering (both optional):

1. **Density / scoring layer.** The most discriminative interpretable features in the research are *densities* (connector density, AI-phrase density), not single hits. One `delve` is noise; ten tells in a paragraph is signal. Keep per-hit findings for transparency, but add a document-level density signal that escalates severity. Sources: CEUR autextification (<https://ceur-ws.org/Vol-3496/autextification-paper9.pdf>).
2. **Severity calibration for perishable tells.** The "ban-list arms race" is real: after em-dash became a known tell, humans began avoiding it and OpenAI shipped a fix (Nov 14, 2025) so ChatGPT honors "don't use em dashes." Keep em-dash and `delve` at `information` (or opt-in packs); reserve higher severity for invisible Unicode and multi-tell density. Treat phrase lists as decaying -- the existing pack/versioning model is the right structure; budget for periodic pruning. Source: <https://techcrunch.com/2025/11/14/openai-says-its-fixed-chatgpts-em-dash-problem/>.

No change is needed to the core thesis (deterministic over ML). The upside is in
aggregation and calibration, not in adding a classifier.

---

## Actionable add-list (summary)

| # | Change | Type | Priority | False-positive risk |
|---|---|---|---|---|
| 1 | New `openai` pack (boilerplate, openers, closers, hedging) | pack | HIGH | low (boilerplate cluster) |
| 2 | Artifact tokens `oaicite` / `contentReference` / `grok_card` | phrases | HIGH | near-zero |
| 3 | New `smuggling` pack: `U+E0000`-`U+E007F`, `U+FE00`-`U+FE0F`, `U+E0100`-`U+E01EF`, `U+2061`-`U+2064`, `U+034F`, `U+206A`-`U+206F`, `U+180B`-`U+180D`, `U+2800` | chars | HIGH | low (opt-in, warning) |
| 4 | Negative parallelism + copula-avoidance phrases | phrases | HIGH | low (structural) |
| 5 | Conversational-assistant phrases | phrases | HIGH | low |
| 6 | Multi-word phrases (2c) + single words (2d) | phrases | MEDIUM | medium |
| 7 | `claudeisms`: `You're absolutely right` family | phrases | MEDIUM | low |
| 8 | Extra spacing chars `U+2007`/`U+2009`/`U+200A`/`U+3000` etc. | chars | LOW | low |
| 9 | `deepseek` CoT-leak phrases; noisy single words (2e) | phrases | LOW | medium-high |
| 10 | Engine: density scoring | engine | OPTIONAL | n/a |
| 11 | Engine: severity calibration / pack pruning policy | engine | OPTIONAL | n/a |

## Method

Five parallel web-research agents (one per angle), each running multiple
searches and fetching primary sources, followed by cross-source verification.
Claims that appear in two or more independent angles are treated as high
confidence: the missing OpenAI pack, negative parallelism, the Tag-block and
variation-selector smuggling ranges, and the citation-artifact tokens each
triangulate across multiple agents. Sources are inline above; prioritized
2024-2026 material.
