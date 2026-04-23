# Changelog

## [0.4.0](https://github.com/mandakan/llm-slop-detector/compare/llm-slop-detector-v0.3.1...llm-slop-detector-v0.4.0) (2026-04-23)


### Features

* add security rule pack for LLM-weaponized invisibles ([b90c4fb](https://github.com/mandakan/llm-slop-detector/commit/b90c4fbfc07f5280acea0b45c4d39be01ded9d7c))
* expand built-in char set with invisible-char safeguards ([f264cfb](https://github.com/mandakan/llm-slop-detector/commit/f264cfbee2e4c8862b5bcc22d83eaf66694f5b03))
* expand built-in char set with invisible-char safeguards ([f41945f](https://github.com/mandakan/llm-slop-detector/commit/f41945fcd7f47f8a9238453ad63953e2e0d311be))


### Bug Fixes

* exclude docs/ from vsix ([40e2292](https://github.com/mandakan/llm-slop-detector/commit/40e2292a27658f44bd5edf081164c7a6de08faa6))
* exclude docs/ from vsix ([13ad9cb](https://github.com/mandakan/llm-slop-detector/commit/13ad9cb20c81458b5fe64515d241fbb7286d66a4)), closes [#14](https://github.com/mandakan/llm-slop-detector/issues/14)

## [0.3.1](https://github.com/mandakan/llm-slop-detector/compare/llm-slop-detector-v0.3.0...llm-slop-detector-v0.3.1) (2026-04-23)


### Bug Fixes

* stop structural negation-pivot from crossing sentence boundaries ([c6aa3cb](https://github.com/mandakan/llm-slop-detector/commit/c6aa3cb3de8b390bb9ab157d9e95722440d72073))
* stop structural negation-pivot from matching across sentences ([203cac1](https://github.com/mandakan/llm-slop-detector/commit/203cac1c7706d8b99ec77407f41558dfbf3318e2))

## [0.3.0](https://github.com/mandakan/llm-slop-detector/compare/llm-slop-detector-v0.2.0...llm-slop-detector-v0.3.0) (2026-04-23)


### Features

* add "Open settings" command ([3de9da1](https://github.com/mandakan/llm-slop-detector/commit/3de9da103a888d251e01df6972b7b438b369e7aa))
* add opt-in rule packs (academic, cliches, fiction, claudeisms, structural) ([1b7f4bb](https://github.com/mandakan/llm-slop-detector/commit/1b7f4bbf5bd90490fe8ee6331d80947ed68449a0))
* first-run onboarding toast and README reorder ([e69500d](https://github.com/mandakan/llm-slop-detector/commit/e69500dc86800763c6c2d77b1266715c669d4853))
* rule packs, onboarding, and marketplace publish prep ([4bb3cce](https://github.com/mandakan/llm-slop-detector/commit/4bb3cce2197ae083d71b2640c066ba559a7bca2b))

## [0.2.0](https://github.com/mandakan/llm-slop-detector/compare/llm-slop-detector-v0.1.0...llm-slop-detector-v0.2.0) (2026-04-23)


### Features

* add code action quick fixes for auto-fixable characters ([f57b7d6](https://github.com/mandakan/llm-slop-detector/commit/f57b7d6d08b4153ddfee12817fdb7f595226367f))
* add status bar indicator with slop count ([5f856e9](https://github.com/mandakan/llm-slop-detector/commit/5f856e9842c777f8f3afa39bc3ab17453fcaf586))
* layered rule sources with provenance and local rule files ([c0096da](https://github.com/mandakan/llm-slop-detector/commit/c0096dacdfcc112cd1a414eb4077c21e020b36d1))


### Bug Fixes

* only offer "Fix all" action on fixable char diagnostics ([68ac4c5](https://github.com/mandakan/llm-slop-detector/commit/68ac4c5b31f9c6f3372077e290a8b0372f791486))
