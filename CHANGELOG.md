# Changelog

All notable changes to this project are documented here.

This file is generated. On push to `main`, `.github/workflows/release.yml` tags
the next semver from [Conventional Commits](https://www.conventionalcommits.org),
publishes a [GitHub Release](https://github.com/vinicius91carvalho/harness-engineering/releases),
and prepends the release's notes below — don't hand-edit released sections. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
