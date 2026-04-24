# Changelog

## [0.6.2](https://github.com/mandakan/llm-slop-detector/compare/llm-slop-detector-v0.6.1...llm-slop-detector-v0.6.2) (2026-04-24)


### Bug Fixes

* run npm publish via npx instead of upgrading in place ([#58](https://github.com/mandakan/llm-slop-detector/issues/58)) ([ae3a370](https://github.com/mandakan/llm-slop-detector/commit/ae3a3702cc9ccb5014f06905b8ae7d4158a308f3))

## [0.6.1](https://github.com/mandakan/llm-slop-detector/compare/llm-slop-detector-v0.6.0...llm-slop-detector-v0.6.1) (2026-04-24)


### Bug Fixes

* publish to npm from release workflow via OIDC ([#56](https://github.com/mandakan/llm-slop-detector/issues/56)) ([f249939](https://github.com/mandakan/llm-slop-detector/commit/f24993950227a7b1ee9a2a9af48591f4235e2cf0))

## [0.6.0](https://github.com/mandakan/llm-slop-detector/compare/llm-slop-detector-v0.5.0...llm-slop-detector-v0.6.0) (2026-04-24)


### Features

* add .slopignore and llmSlopDetector.exclude for file-glob skips ([#46](https://github.com/mandakan/llm-slop-detector/issues/46)) ([836f081](https://github.com/mandakan/llm-slop-detector/commit/836f08165405311d4adc1457d9bf6e03ea37a4ef))
* add llmSlopDetector.severityOverrides for per-rule tuning ([#47](https://github.com/mandakan/llm-slop-detector/issues/47)) ([d4d8750](https://github.com/mandakan/llm-slop-detector/commit/d4d87505ccd7593ea77cceb03be5c1f199c46e2a)), closes [#37](https://github.com/mandakan/llm-slop-detector/issues/37)
* add Scan workspace command ([#53](https://github.com/mandakan/llm-slop-detector/issues/53)) ([26e3270](https://github.com/mandakan/llm-slop-detector/commit/26e32708d9903efc7a87632f87495eacbfaf9114))
* expose detector as stdio MCP server for agent self-linting ([#51](https://github.com/mandakan/llm-slop-detector/issues/51)) ([bdd7e29](https://github.com/mandakan/llm-slop-detector/commit/bdd7e29fcd0e067dc5086997ac476193eb7a0da4))
* publish CLI to npm ([#55](https://github.com/mandakan/llm-slop-detector/issues/55)) ([fe529e7](https://github.com/mandakan/llm-slop-detector/commit/fe529e764731bafad2553fc1268c2696741e4fcd))
* scan git commit messages and SCM input box ([#44](https://github.com/mandakan/llm-slop-detector/issues/44)) ([3e3196e](https://github.com/mandakan/llm-slop-detector/commit/3e3196e7ebc14614d27eee35c3c051effb176591)), closes [#40](https://github.com/mandakan/llm-slop-detector/issues/40)
* ship JSON Schema for .llmsloprc.json ([#45](https://github.com/mandakan/llm-slop-detector/issues/45)) ([96c2e0b](https://github.com/mandakan/llm-slop-detector/commit/96c2e0bd0bce338333d24fc71771209a62c19d0c)), closes [#36](https://github.com/mandakan/llm-slop-detector/issues/36)


### Performance Improvements

* debounce document scanning on keystrokes ([#42](https://github.com/mandakan/llm-slop-detector/issues/42)) ([0ddb4ca](https://github.com/mandakan/llm-slop-detector/commit/0ddb4cacfc9205ac44bb9a997bbf5bea3c005731)), closes [#41](https://github.com/mandakan/llm-slop-detector/issues/41)

## [0.5.0](https://github.com/mandakan/llm-slop-detector/compare/llm-slop-detector-v0.4.0...llm-slop-detector-v0.5.0) (2026-04-23)


### Features

* add "Scan selection" command for one-off checks ([#32](https://github.com/mandakan/llm-slop-detector/issues/32)) ([88ccd41](https://github.com/mandakan/llm-slop-detector/commit/88ccd41ace395bb6cc59b822ed0a626fa4e20dcc))
* link diagnostics to rule documentation ([#34](https://github.com/mandakan/llm-slop-detector/issues/34)) ([683fefb](https://github.com/mandakan/llm-slop-detector/commit/683fefb0098359baca7e6139362d154ed7364e4a))
* opt-in scanning of code comments and docstrings ([#30](https://github.com/mandakan/llm-slop-detector/issues/30)) ([cd73cdd](https://github.com/mandakan/llm-slop-detector/commit/cd73cdd701a55d2112ef20f3e254f22e4c8ae547))
* ship CLI and pre-commit hook sharing the extension's rule engine ([#28](https://github.com/mandakan/llm-slop-detector/issues/28)) ([37575cb](https://github.com/mandakan/llm-slop-detector/commit/37575cb6c2ed2283b3c455d1df486603b489dc5c))
* show rule selector and ignore snippet on hover ([#33](https://github.com/mandakan/llm-slop-detector/issues/33)) ([6a36158](https://github.com/mandakan/llm-slop-detector/commit/6a36158536eac724654d73fc06e980fe6e6b16ec))
* skip code fences, link URLs, and ignore directives in markdown ([#26](https://github.com/mandakan/llm-slop-detector/issues/26)) ([26b5f40](https://github.com/mandakan/llm-slop-detector/commit/26b5f40d17b0097a24b727e219b4112af31d5f78))


### Bug Fixes

* list all six built-in packs in the onboarding toast ([#31](https://github.com/mandakan/llm-slop-detector/issues/31)) ([b3e8c67](https://github.com/mandakan/llm-slop-detector/commit/b3e8c67ed956614173a09677b3fc4923fc15ca32))
* skip local rule files on untrusted workspaces ([#35](https://github.com/mandakan/llm-slop-detector/issues/35)) ([c0e217e](https://github.com/mandakan/llm-slop-detector/commit/c0e217e206faa73ac01571402f2b97dc501f2f3a))

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
