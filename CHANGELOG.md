# Changelog

All notable changes to this project are documented here.

This file is generated. On push to `main`, `.github/workflows/release.yml` tags
the next semver from [Conventional Commits](https://www.conventionalcommits.org),
publishes a [GitHub Release](https://github.com/vinicius91carvalho/harness-engineering/releases),
and prepends the release's notes below — don't hand-edit released sections. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### [0.14.2](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.14.1...v0.14.2) (2026-06-30)


### Bug Fixes

* replace realpathSync with path.resolve in runGoalReview to avoid ENOENT on CI ([5dfa7a4](https://github.com/vinicius91carvalho/harness-engineering/commit/5dfa7a4f6cf4385a43b75e3ad0ed855fa787fc19))

### [0.14.1](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.14.0...v0.14.1) (2026-06-30)


### Bug Fixes

* stabilize pages and goal review workflows ([4203e66](https://github.com/vinicius91carvalho/harness-engineering/commit/4203e66cf96073bc57198e359a9cde3dc3adeb88))

## [0.14.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.13.0...v0.14.0) (2026-06-30)


### Features

* add project website and workflow docs ([9ad23ed](https://github.com/vinicius91carvalho/harness-engineering/commit/9ad23ed3339d8d4f35a7cecd1ec69c6f2b2426b9))

## [0.13.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.12.7...v0.13.0) (2026-06-30)


### Features

* replace host-specific plugins with portable integrations ([9678266](https://github.com/vinicius91carvalho/harness-engineering/commit/967826645d11a93210f60d6cee565abeb3593d64))


### Documentation

* list both Anthropic harness articles in references ([cc5d5db](https://github.com/vinicius91carvalho/harness-engineering/commit/cc5d5dbc2caca02790dfeccfb55cf4d91d8551d9))

### [0.12.7](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.12.6...v0.12.7) (2026-06-28)


### Bug Fixes

* install ponytail via npm, register in OpenCode plugin config ([bc4d3d3](https://github.com/vinicius91carvalho/harness-engineering/commit/bc4d3d3af02e514eb0de7a2c8d801892e78ccd9e))

### [0.12.6](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.12.5...v0.12.6) (2026-06-28)


### Bug Fixes

* install plugins and MCP servers across hosts ([a4f2057](https://github.com/vinicius91carvalho/harness-engineering/commit/a4f20570d4beadb921cf5051ad23d96f2a6ce908))

### [0.12.5](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.12.4...v0.12.5) (2026-06-27)


### Bug Fixes

* **claim:** use \${BASHPID:-$$} for bash 3.2 compatibility on macOS ([af7ef11](https://github.com/vinicius91carvalho/harness-engineering/commit/af7ef112f3f24eef66aec62461ae6dd8d122eb68))

### [0.12.4](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.12.3...v0.12.4) (2026-06-27)


### Bug Fixes

* **test:** use shasum -a 256 for portable checksums on macOS ([3196be4](https://github.com/vinicius91carvalho/harness-engineering/commit/3196be42431c2b500cf9d117359e39b19b5dd9a5))

### [0.12.3](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.12.2...v0.12.3) (2026-06-27)


### Bug Fixes

* **test:** pin XDG_CONFIG_HOME in install_test to prevent CI env bleed ([83a2255](https://github.com/vinicius91carvalho/harness-engineering/commit/83a225566cbdc4da92f74ceba9f76d3e601bbd49))

### [0.12.2](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.12.1...v0.12.2) (2026-06-27)


### Bug Fixes

* **ci:** align test and docs with renamed marketplace, fix PS1 variable syntax ([c198d45](https://github.com/vinicius91carvalho/harness-engineering/commit/c198d458773be8cd509ac623008618eac0887376))

### [0.12.1](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.12.0...v0.12.1) (2026-06-27)


### Bug Fixes

* **install:** questions rendering and marketplaces for codex ([28c7508](https://github.com/vinicius91carvalho/harness-engineering/commit/28c75080d49c035e06a8d8b5c1216c1574ec9654))

## [0.12.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.11.0...v0.12.0) (2026-06-27)


### Features

* **workflows:** restore Claude-native workflow runner alongside portable fallback ([64e966d](https://github.com/vinicius91carvalho/harness-engineering/commit/64e966dc811c9c15263d6db3dffa3377dfe603fb))

## [0.11.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.10.0...v0.11.0) (2026-06-26)


### Features

* **installer:** support native multi-host installation ([bccb943](https://github.com/vinicius91carvalho/harness-engineering/commit/bccb9434cd3e38534c3de1a5fc111504334a6d62))
* **workflows:** make spec build and QA portable ([a29e2db](https://github.com/vinicius91carvalho/harness-engineering/commit/a29e2db8a6769c6c502fffd6aa2f6d614aa3f2fd))


### Bug Fixes

* **release:** synchronize plugin manifest versions ([62a3626](https://github.com/vinicius91carvalho/harness-engineering/commit/62a36268b573bf118ee5d1461c0e8aec0db4779c))
* **workflows:** serialize concurrent feature claims ([00572f5](https://github.com/vinicius91carvalho/harness-engineering/commit/00572f5d5331a15293ec5c3533c7d93970ec2e4d))


### Continuous Integration

* validate portable installer contracts ([cc9f976](https://github.com/vinicius91carvalho/harness-engineering/commit/cc9f9768a216481a4995027ed3e4180c15a25cae))


### Documentation

* describe portable installer and integrations ([7e5121a](https://github.com/vinicius91carvalho/harness-engineering/commit/7e5121a114629dea9b9c3d622142d33f0ecaae35))

## [0.10.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.9.0...v0.10.0) (2026-06-26)


### Features

* add playwright MCP server to config ([6fbebc2](https://github.com/vinicius91carvalho/harness-engineering/commit/6fbebc200256e929f95d41c45e4d24afd1cfe3a7))
* make external plugins optional in installer ([bbfd469](https://github.com/vinicius91carvalho/harness-engineering/commit/bbfd4693f198edd6d27c3da3d9b27aae2a0fe67a))


### Documentation

* move plugins, extras, installer options, and backup sync to docs/ ([b239ede](https://github.com/vinicius91carvalho/harness-engineering/commit/b239ede13b0b751f470481afcdf2d2fdd8398499))
* update agent and skill instructions for optional plugins ([700c28c](https://github.com/vinicius91carvalho/harness-engineering/commit/700c28c00fbc5752edf0cdc2e6ba1c796048ed95))

## [0.9.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.8.0...v0.9.0) (2026-06-26)


### Features

* add codebase-memory-mcp plugin, remove OpenCode plugins, update install scripts ([dac9da5](https://github.com/vinicius91carvalho/harness-engineering/commit/dac9da5e5ce8a83a195e1f3414b7dbe4a058d399))


### Documentation

* clarify installation scope applies to all CLIs ([9b77d93](https://github.com/vinicius91carvalho/harness-engineering/commit/9b77d93a74838f66cf25da67d39e8a508717bc9d))

## [0.8.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.7.1...v0.8.0) (2026-06-26)


### Features

* add codebase-memory-mcp plugin to marketplace ([085e86f](https://github.com/vinicius91carvalho/harness-engineering/commit/085e86fbea298479688141544bdc09186de8a8d9))

### [0.7.1](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.7.0...v0.7.1) (2026-06-26)


### Bug Fixes

* **opencode:** add skills.paths to load harness skills ([feb0744](https://github.com/vinicius91carvalho/harness-engineering/commit/feb0744415d73d4261b89ed7541f6d99b770a65e))

## [0.7.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.6.0...v0.7.0) (2026-06-26)


### Features

* add Opencode and Codex plugin compatibility ([c0ed1cc](https://github.com/vinicius91carvalho/harness-engineering/commit/c0ed1cc17e364ed7002effbfeb2fa16ea343ba45))

## [0.6.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.5.0...v0.6.0) (2026-06-26)


### Features

* **harness:** add learning-loop skill for session-driven self-improvement ([6873090](https://github.com/vinicius91carvalho/harness-engineering/commit/6873090ab7f6bc431e39e98458b172a11e853e4a))


### Continuous Integration

* bump plugin.json version on release ([7b00ec7](https://github.com/vinicius91carvalho/harness-engineering/commit/7b00ec798fa12507ae00e460a1ebf1b1b6def2ec))


### Documentation

* update CHANGELOG for v0.5.0 [skip ci] ([870bb3d](https://github.com/vinicius91carvalho/harness-engineering/commit/870bb3dc105d08e83a08f9694e46ba9477d1e246))

## [0.5.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.4.0...v0.5.0) (2026-06-26)


### Features

* **harness:** bundle spec-build-QA pipeline in the plugin ([c577258](https://github.com/vinicius91carvalho/harness-engineering/commit/c57725852004cb95fb06ab519657c7b62856bbe9))


### Documentation

* document the pipeline and third-party skill restore ([84f1efb](https://github.com/vinicius91carvalho/harness-engineering/commit/84f1efb2c440c1f159d4fb2e9f81be3c38470e89))
* update CHANGELOG for v0.4.0 [skip ci] ([23ee159](https://github.com/vinicius91carvalho/harness-engineering/commit/23ee159298ae8d48dcc3c05e19eca6bd9dc11ce6))

## [0.4.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.3.0...v0.4.0) (2026-06-25)


### Features

* **mcp:** add MCP server backup and interactive installer step ([0213d07](https://github.com/vinicius91carvalho/harness-engineering/commit/0213d07b8ec2c86e83dd268bb8f22e3218892ae6))


### Documentation

* update CHANGELOG for v0.3.0 [skip ci] ([dd428ed](https://github.com/vinicius91carvalho/harness-engineering/commit/dd428edbdae7a468517bcba1d96f835b3b5925ea))

## [0.3.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.2.1...v0.3.0) (2026-06-24)


### Features

* **install:** replace per-plugin prompts with arrow-key checklist ([1af951b](https://github.com/vinicius91carvalho/harness-engineering/commit/1af951bfbeb4c7804609f9cf1892c0b31194cf10))


### Documentation

* add banner, revamp README, and Gandalf quotes per section ([09361e9](https://github.com/vinicius91carvalho/harness-engineering/commit/09361e9b3ae218b3bbddeb5b5eb85d7874720f71))
* update CHANGELOG for v0.2.1 [skip ci] ([5b1a313](https://github.com/vinicius91carvalho/harness-engineering/commit/5b1a313a283832965f66d0ccbbf4643b336d0cee))

### [0.2.1](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.2.0...v0.2.1) (2026-06-24)


### Bug Fixes

* skip CHANGELOG commit when diff is empty ([ad186af](https://github.com/vinicius91carvalho/harness-engineering/commit/ad186af13cf66ca491ec4ccad37f3303c520d3be))


### Continuous Integration

* auto-generate CHANGELOG.md on release ([efb04ac](https://github.com/vinicius91carvalho/harness-engineering/commit/efb04ac5f27681bca5f9ecede374bb4abcbfc92f))


### Documentation

* drop manual per-plugin install from README ([603560c](https://github.com/vinicius91carvalho/harness-engineering/commit/603560caacea199174fe2531a24008f77b60b5c8))
* promote CHANGELOG [Unreleased] to v0.2.0 ([c543a46](https://github.com/vinicius91carvalho/harness-engineering/commit/c543a46d2ba894b5ede8923302a09c807819e752))

## [0.2.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.1.0...v0.2.0) - 2026-06-24

### Added
- `codex` plugin (optional) re-exposed from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc),
  wired into the marketplace, both installers, and the README. Used for
  adversarial reviews; configure with `/codex:setup` (requires an OpenAI account).

### Changed
- `/harness:update-project` now asks whether each newly added plugin is required
  or optional instead of guessing, and runs the CI checks locally before finishing.

## 0.1.0 - 2026-06-24

Initial release.

### Added
- Plugin marketplace (`vinicius91carvalho`) plus the in-repo `harness` plugin.
- One-command installers (`install.sh`, `install.ps1`) with required/optional
  plugin prompts, `--yes`/`--no` flags, and `jq` auto-install.
- Bundled `scripts/statusline.sh` (two-line status line) and `scripts/sync-config.sh`
  (shareable config subset extractor), both with `--selftest`.
- Shareable config backup (`config/settings.json`) and loose-content backup
  (`config/home/`) restored by the installer.
- `/harness:update-project` skill — full backup of the live Claude Code setup.
- CI (`ci.yml`) for JSON/shell/selftest/frontmatter validation and semantic
  release (`release.yml`) with version + last-update badges.
