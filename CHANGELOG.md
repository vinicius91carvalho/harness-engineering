# Changelog

All notable changes to this project are documented here.

This file is generated. On push to `main`, `.github/workflows/release.yml` tags
the next semver from [Conventional Commits](https://www.conventionalcommits.org),
publishes a [GitHub Release](https://github.com/vinicius91carvalho/harness-engineering/releases),
and prepends the release's notes below — don't hand-edit released sections. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.1.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v3.0.0...v3.1.0) (2026-07-16)


### Features

* **installer:** isolate project scope and exit cleanly on interrupt ([ed3d5fb](https://github.com/vinicius91carvalho/harness-engineering/commit/ed3d5fbda217681a5851e8048cb8231573e2d26a))

## [3.0.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v2.11.0...v3.0.0) (2026-07-16)


### ⚠ BREAKING CHANGES

* remove herdr runtime helpers and generator control-module
shims; skills/supervisor/lib is the sole home for control modules. Reinstall
after upgrade - no mid-flight migration from 2.x. Multi-host installer scopes
(user/project/local), catalog-driven hallmark skills acquisition, fail-closed
init.sh and spec finalize, and confirm-gated setup boundary detection.

Co-authored-by: Cursor <cursoragent@cursor.com>

### Features

* add init.sh lifecycle commands and drop herdr runtime helpers ([031f878](https://github.com/vinicius91carvalho/harness-engineering/commit/031f87800499a83f77b59732d9aa5d4988fe6603))
* clean-break v3 control plane, installer scopes, and init lifecycle ([9ca289e](https://github.com/vinicius91carvalho/harness-engineering/commit/9ca289e58019dac1226b10c7d9f07e353792e1f7))


### Bug Fixes

* **installer:** make scope paths and release-tag sort portable on macOS ([d9faf5c](https://github.com/vinicius91carvalho/harness-engineering/commit/d9faf5cfc55284b35f52fd89d7612432a6458247))
* **installer:** resolve CLI entry across macOS /var symlinks ([60d3e1b](https://github.com/vinicius91carvalho/harness-engineering/commit/60d3e1b3e33cf990d2b8b8568fb83439dcc9a1cd))
* **tests:** canonicalize paths for macOS /var TMPDIR layout ([4e4f0a3](https://github.com/vinicius91carvalho/harness-engineering/commit/4e4f0a3f1ca9e1d1f2132c250228848be24391ee))

## [2.11.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v2.10.0...v2.11.0) (2026-07-16)


### Features

* **installer:** add optional hallmark skill via npx skills ([1771f45](https://github.com/vinicius91carvalho/harness-engineering/commit/1771f452e685a85bed3463cb8e6bfec617e97560))

## [2.10.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v2.9.0...v2.10.0) (2026-07-16)


### Features

* harden planner review and CauseFlow ops learnings ([ef0ff9e](https://github.com/vinicius91carvalho/harness-engineering/commit/ef0ff9e0b1d126bb86ad7b6e5279337173d3b8f6))
* **supervisor:** harden runtime recovery and hot paths ([8f8f03b](https://github.com/vinicius91carvalho/harness-engineering/commit/8f8f03b5f2e8c268c8acd706c40c23c51f13f4ab))
* **supervisor:** hybrid empty-fleet recovery and fleet snapshot ops ([1f6e407](https://github.com/vinicius91carvalho/harness-engineering/commit/1f6e407a263214f50887997036ce4bbc497336a0))
* **supervisor:** Phase A orphan claims and re-export collapse ([da55995](https://github.com/vinicius91carvalho/harness-engineering/commit/da55995b2e3750957631269f73e282220051aa85))
* **supervisor-phase-c:** completion contract, host-death routing, malformed verdict retry ([30d625a](https://github.com/vinicius91carvalho/harness-engineering/commit/30d625ac87008cee118ec21678f3f1cc4479cdb6))


### Bug Fixes

* **supervisor:** close finished Cursor Task herdr tabs automatically ([df2059b](https://github.com/vinicius91carvalho/harness-engineering/commit/df2059b0c92e833c80b39305ddd427dc3a11dde7))
* **supervisor:** stop treating empty ghosts as repaired ([7cda64d](https://github.com/vinicius91carvalho/harness-engineering/commit/7cda64d29d118a22983327463b330b257fb4ffad))
* **tests:** tighten Integrated Verification match in shared role stubs ([6744ba7](https://github.com/vinicius91carvalho/harness-engineering/commit/6744ba75957145d169ed8e6cd0649cebc377ba6b))
* **tests:** tighten Integrated Verification stub match in orchestrator test ([e9a8d81](https://github.com/vinicius91carvalho/harness-engineering/commit/e9a8d8101ed3fb7fd202c3c1702755a976ec5977))

## [2.9.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v2.8.1...v2.9.0) (2026-07-11)


### Features

* **generator:** detect jobs already done via Execution Ledger ([2828cfb](https://github.com/vinicius91carvalho/harness-engineering/commit/2828cfb6403694e7c4b33404afb205e05b62d240))


### Bug Fixes

* **generator:** reopen only ACs named in Goal Review defects ([f83010d](https://github.com/vinicius91carvalho/harness-engineering/commit/f83010d9d746dc58a2500e77058c84ab1872f540))

### [2.8.1](https://github.com/vinicius91carvalho/harness-engineering/compare/v2.8.0...v2.8.1) (2026-07-11)


### Bug Fixes

* **generator:** ignore turbo/build caches in Goal Review dirt check ([237aca0](https://github.com/vinicius91carvalho/harness-engineering/commit/237aca08777c51b342fcd4d0f0af12cb94fd6c37))

## [2.8.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v2.7.1...v2.8.0) (2026-07-11)


### Features

* **generator:** reuse shared compose infra across workers ([da47f8b](https://github.com/vinicius91carvalho/harness-engineering/commit/da47f8b04c5718e00e581eea1fd0a97c9b7eab70))

### [2.7.1](https://github.com/vinicius91carvalho/harness-engineering/compare/v2.7.0...v2.7.1) (2026-07-11)


### Bug Fixes

* **supervisor:** steal dead Control Journal locks on start ([6e2f415](https://github.com/vinicius91carvalho/harness-engineering/commit/6e2f415440a316280a5984a10b4d69b099347c59))

## [2.7.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v2.6.1...v2.7.0) (2026-07-11)


### Features

* **observation-gate:** hard-exclude weak validation hosts and soft-align coding ([3d0100d](https://github.com/vinicius91carvalho/harness-engineering/commit/3d0100d1e283b897b337f3c2601661cb3cbbfd97))
* **single-goal-review-gate:** unify goalReviewAdmissible across supervisor and orchestrator ([2ec1df7](https://github.com/vinicius91carvalho/harness-engineering/commit/2ec1df7dc4def605fbd192c7872a73f6bf636686))
* add evidence corpus reader and control-host beacon stop policy ([290ffc7](https://github.com/vinicius91carvalho/harness-engineering/commit/290ffc76d79b889a58aff979a866733cb29178b9))
* add zero-token Wake Triage for Control Journal events ([9899c82](https://github.com/vinicius91carvalho/harness-engineering/commit/9899c82a3fe7847988db374a16382180bf1374e6))
* **fleet-ops:** add fleet snapshot module and finished-tab reaper libs ([2db96da](https://github.com/vinicius91carvalho/harness-engineering/commit/2db96da25f00db54ee0ac3fbcc5c72193ec3cbb5))
* **generator:** consolidate worker-outcome as canonical outcome module ([2b932d6](https://github.com/vinicius91carvalho/harness-engineering/commit/2b932d65d0da1c6866ba7f74156d72da5cd2960d))
* **generator:** deepen failure-policy as single recovery module ([a164aa4](https://github.com/vinicius91carvalho/harness-engineering/commit/a164aa4966f483ba265624b537b2d3b2b9bf29cd))
* **supervisor:** add fail-closed preflight before admission ([b5faa3e](https://github.com/vinicius91carvalho/harness-engineering/commit/b5faa3ef969228f048af515103eb30013f2cdfb1))


### Bug Fixes

* **failure-policy:** align SAFE_RECOVERY with repair-router semantics ([d126cf0](https://github.com/vinicius91carvalho/harness-engineering/commit/d126cf0cb886e80b04e4ce92307597c407e41573))
* **supervisor:** allow preflight without a worker host CLI ([a8c9083](https://github.com/vinicius91carvalho/harness-engineering/commit/a8c908366d6e89a41db2af89f24bd2e59527d508))
* **supervisor:** ignore untracked files in Goal Review dirty check ([5282339](https://github.com/vinicius91carvalho/harness-engineering/commit/5282339baee1c3fd4abce867bd014864710fa49b))


### Documentation

* **adr:** fleet ops automation waits on Fleet Snapshot ([957649a](https://github.com/vinicius91carvalho/harness-engineering/commit/957649aabdc3989525efb81e1b90742870ccabf9)), closes [#22](https://github.com/vinicius91carvalho/harness-engineering/issues/22)
* **skills:** capture no-redelegate and empty-fleet auto-recovery rules ([954cfcd](https://github.com/vinicius91carvalho/harness-engineering/commit/954cfcdffe44479e7f8ae84c31ff323991b1f464))

### [2.6.1](https://github.com/vinicius91carvalho/harness-engineering/compare/v2.6.0...v2.6.1) (2026-07-11)


### Bug Fixes

* **supervisor:** auto-recover empty fleet from dead merge locks ([aeee497](https://github.com/vinicius91carvalho/harness-engineering/commit/aeee4974b79fa4f70b1f2c1a7014e019d649a76a))

## [2.6.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v2.5.0...v2.6.0) (2026-07-11)


### Features

* add lavish-axi, no-mistakes, treehouse, and firstmate optionals ([b9009d0](https://github.com/vinicius91carvalho/harness-engineering/commit/b9009d000a9e95b8928947eb90f3bc3763314a88))
* mandate WI resource cleanup and fix Agent optional plugin pollution ([8765303](https://github.com/vinicius91carvalho/harness-engineering/commit/87653032657ed0d0dfc10113e1cbcd87297b1b6c))


### Bug Fixes

* **generator:** forbid nested Task re-delegation in worker prompts ([9db652c](https://github.com/vinicius91carvalho/harness-engineering/commit/9db652c9a2abda486703a7320e03ecdfb52bc123))
* **generator:** name in-flight tool in herdr pane heartbeats ([239854d](https://github.com/vinicius91carvalho/harness-engineering/commit/239854d9ba79fbccf77cfd216f95f50ffeb542e7))
* **generator:** stop redundant integrate loops; tidy README layout ([0c534b9](https://github.com/vinicius91carvalho/harness-engineering/commit/0c534b906f3991acd9c3ae046060008ccb372c35))
* **supervisor:** restore Control Journal ids and governor admission ([a8c0bb4](https://github.com/vinicius91carvalho/harness-engineering/commit/a8c0bb43317bee98041d0766360b594cfc99ddd1))
* **tests:** match qa-agent stubs before coding-agent ([42eeb45](https://github.com/vinicius91carvalho/harness-engineering/commit/42eeb45381821f1f934fee61a9c18c4ada6835be))
* **tests:** raise governor maxLoadRatio in dead-pid admission test ([2e6620e](https://github.com/vinicius91carvalho/harness-engineering/commit/2e6620ef0ffbb62639ceaea2adff566acc3cd4e1))


### Documentation

* **readme:** add live-run screenshots and reorder sections ([8671544](https://github.com/vinicius91carvalho/harness-engineering/commit/86715443d180e4a870bdc253ff28ab729aabd931))

## [2.5.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v2.4.0...v2.5.0) (2026-07-10)


### Features

* **planner:** add <domain> section for product vocabulary in specs ([4716c9e](https://github.com/vinicius91carvalho/harness-engineering/commit/4716c9e0f7afdf8c92ac432e72fe4132b2f9c3a2))

## [2.4.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v2.3.1...v2.4.0) (2026-07-10)


### ⚠ BREAKING CHANGES

* deepen workflow architecture and grill planning decisions

### Features

* deepen workflow architecture and grill planning decisions ([c2a58b9](https://github.com/vinicius91carvalho/harness-engineering/commit/c2a58b9b1876b442cc1aa99f3c05b0358bc4411d))
* installer blurbs, crawl4ai integration, and pipeline hardening ([beabe52](https://github.com/vinicius91carvalho/harness-engineering/commit/beabe5260860d5ada4746d030c4701f3a89523cf))


### Bug Fixes

* **governor:** allow explicit sub-128MB memory floors for tests ([e3b7f2b](https://github.com/vinicius91carvalho/harness-engineering/commit/e3b7f2b4ca78fc6cc4d3bd1d767c207db1b45e36))
* **supervisor:** clear pid on complete and reset ledger in e2e ([cd98531](https://github.com/vinicius91carvalho/harness-engineering/commit/cd98531292e36e7efe952a244d74c4ce18af2467))
* **test:** force mergecorrupt conflict after ledger cutover ([1a45087](https://github.com/vinicius91carvalho/harness-engineering/commit/1a450870acabd971374e4f57efb089fe0fc12bf4))
* **test:** make governor deny test independent of host free RAM ([d89643b](https://github.com/vinicius91carvalho/harness-engineering/commit/d89643bbac8bdcee8e5fb90f9aa1b9482ad01dc9))
* **test:** skip governor in orchestrator stubs for low-memory CI ([756f517](https://github.com/vinicius91carvalho/harness-engineering/commit/756f5177b8dbef993e8a47db35530ec568de4cfa))

### [2.3.1](https://github.com/vinicius91carvalho/harness-engineering/compare/v2.3.0...v2.3.1) (2026-07-09)


### Bug Fixes

* **supervisor:** do not auto-retry coding exhaustion ([4da3ae4](https://github.com/vinicius91carvalho/harness-engineering/commit/4da3ae4010f7dbe0a500ef0df205fe36b9b6d4aa))

## [2.3.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v2.2.0...v2.3.0) (2026-07-09)


### Features

* **supervisor:** one named herdr tab per worker and resilient monorepo ops ([3bb698f](https://github.com/vinicius91carvalho/harness-engineering/commit/3bb698f6205b088ccbab6ef90f7aab6ea1d65136))


### Bug Fixes

* **ci:** give macOS quota_wait poll a longer deadline ([c3fc59d](https://github.com/vinicius91carvalho/harness-engineering/commit/c3fc59dda824c662000606c67ef8964d6395cc04))
* **supervisor:** prune orphan Input Requests before auto-retry ([896e775](https://github.com/vinicius91carvalho/harness-engineering/commit/896e775f0990f35c9b1e11139630fe95edcb1ce1))

## [2.2.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v2.1.0...v2.2.0) (2026-07-09)


### Features

* deepen admission/attempt seams, auto herdr panes, open-source-first roles ([dad4943](https://github.com/vinicius91carvalho/harness-engineering/commit/dad49435ae923838b8a205c936fa8e1491701cfe))
* install Pi skills at user level and free-first role routing ([bd0645a](https://github.com/vinicius91carvalho/harness-engineering/commit/bd0645a8072f81c4890a272d578389bd74d1ac9c))

## [2.1.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v2.0.0...v2.1.0) (2026-07-09)


### Features

* **install:** stage latest GitHub release tag instead of main tip ([6982a93](https://github.com/vinicius91carvalho/harness-engineering/commit/6982a93ed99da31c390308ba070168ff53584fc8))


### Bug Fixes

* **docs:** clarify quickstart, plan branch, and file examples ([ffe7da3](https://github.com/vinicius91carvalho/harness-engineering/commit/ffe7da38375187ed53c78f267308ed1fad2a86da))

## [2.0.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v1.2.0...v2.0.0) (2026-07-09)


### ⚠ BREAKING CHANGES

* Merges and Goal Review target a configurable integration
branch (.harness/integration-branch or HARNESS_INTEGRATION_BRANCH) instead of
main. Planner and setup require interactive HTML spec review before writing
project_specs.xml. Herdr workers use one visible pane per context with
orchestrator and agent output; merge-lock waits no longer flood panes with
BUSY lines.

Co-authored-by: Cursor <cursoragent@cursor.com>

### Features

* herdr panes, spec review loop, and plan integration branch ([4e6aa3f](https://github.com/vinicius91carvalho/harness-engineering/commit/4e6aa3fa8628e9ec00b57536aed90a5ac076ad92))


### Bug Fixes

* align cursor plugin manifest version with other hosts ([90633f7](https://github.com/vinicius91carvalho/harness-engineering/commit/90633f7c663f85c3ac5f292015a91ed038b76ed2))
* **ci:** drain exhausted retries when capacity is zero ([9d2d768](https://github.com/vinicius91carvalho/harness-engineering/commit/9d2d768a905de08ca24486f752a41e9a66c65e86))
* **ci:** fast supervisor quota test path for macOS runners ([75173f3](https://github.com/vinicius91carvalho/harness-engineering/commit/75173f3a043474d8b3dcc7ac9072e4419173efaa))
* **ci:** give macOS quota supervisor test more time without GNU timeout ([6512ca2](https://github.com/vinicius91carvalho/harness-engineering/commit/6512ca258a6b02960aa7b17e80790573113b8644))
* **ci:** make supervisor quota test deterministic on macOS ([130de36](https://github.com/vinicius91carvalho/harness-engineering/commit/130de3698a5e8f97110aefbbbc9724d2d897a08a))
* **ci:** poll quota_wait with jq -e and reset cloned supervisor state ([d5ccfb4](https://github.com/vinicius91carvalho/harness-engineering/commit/d5ccfb449bd6beafaf162feb97ecddda75d796c0))
* **ci:** preserve complete status and harden namespaced supervisor check ([5455497](https://github.com/vinicius91carvalho/harness-engineering/commit/5455497005f6dde61d15319f7d2c08c2c4d6004d))
* **supervisor:** make --once true exit after exactly one tick ([fa33a69](https://github.com/vinicius91carvalho/harness-engineering/commit/fa33a69f4ca4579d88e56d48d387d32ae6ca91ca))

## [1.2.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v1.1.1...v1.2.0) (2026-07-09)


### ⚠ BREAKING CHANGES

* remove Omnigent, add herdr worker panes and native role routing

### Features

* **claim-lease:** deepen claim coordination into ESM module with thin claim.sh wrapper ([9ce6bd3](https://github.com/vinicius91carvalho/harness-engineering/commit/9ce6bd3f047d0169c4f8ddafb3cbeb327294fe44))
* **generator:** extract attempt workflow modules and redesign docs site ([b57e606](https://github.com/vinicius91carvalho/harness-engineering/commit/b57e6063e355e0e08e8a1e5fa73f441d55fcf84a))
* **generator:** extract integrate, worker-outcome, and supervisor tick libs ([2029bd4](https://github.com/vinicius91carvalho/harness-engineering/commit/2029bd4180c39569682cf04d6d8540f8ef4a2ff7))
* **install:** make Pi an installable harness alongside Claude/Codex/OpenCode ([e86f2f6](https://github.com/vinicius91carvalho/harness-engineering/commit/e86f2f6ba02f48cd59eaa65ebc633c6d4d895048))
* **omnigent:** add plan-feature.sh so feature-layering is a simple relay message ([92bb81c](https://github.com/vinicius91carvalho/harness-engineering/commit/92bb81c77cc327146a805f6e32bdab3ffa458a80))
* **omnigent:** fold reconcile.mjs into plan-feature.sh's own job ([f33f839](https://github.com/vinicius91carvalho/harness-engineering/commit/f33f83912ff32bf4a1b4fd085fb5c918953d71c2))
* **skills:** add worktree-git-recovery reference skill ([6da049d](https://github.com/vinicius91carvalho/harness-engineering/commit/6da049df15ed3989ce3525fcd5fe2447f17be82b))
* add Cursor Agent as a first-class harness host ([11b6d7d](https://github.com/vinicius91carvalho/harness-engineering/commit/11b6d7d88980cb72081bb8811b52fb79f82f2374))
* add skill-creator plugin from anthropics/skills, fix MCP secret prompt visibility ([9f466a9](https://github.com/vinicius91carvalho/harness-engineering/commit/9f466a92c97e5b145b4032f165ab5ec80fd7a07d))
* install skill-creator on all 4 tools (claude codex opencode pi) ([c23c41b](https://github.com/vinicius91carvalho/harness-engineering/commit/c23c41bd3c0f44e2440b487c912f9b041a86a210))
* remove Omnigent, add herdr worker panes and native role routing ([51f7d8d](https://github.com/vinicius91carvalho/harness-engineering/commit/51f7d8d1b7ca25f45dea6984b2ed5a1995ab67d4))


### Bug Fixes

* **agents:** forbid gitignoring harness-progress/ in the initializer ([0a1a727](https://github.com/vinicius91carvalho/harness-engineering/commit/0a1a72797fa071f37c2677dd312443baa424c4cf))
* **ci:** allow 30s for detached supervisor on slower macOS runners ([04476fc](https://github.com/vinicius91carvalho/harness-engineering/commit/04476fcdefb369c3ad720959cfe26a1bc36f86fa))
* **ci:** allow 60s for circuit-breaker supervisor test on macOS ([bf87306](https://github.com/vinicius91carvalho/harness-engineering/commit/bf873069008cb2d1323d6b2f6cbeed6c50b3d7a3))
* **ci:** make supervisor tests portable on macOS runners ([0c101ed](https://github.com/vinicius91carvalho/harness-engineering/commit/0c101ed5d0eb662eb790b730e8563092d38a7b19))
* **ci:** portable timeout for Omnigent scripts on macOS ([b38ffd5](https://github.com/vinicius91carvalho/harness-engineering/commit/b38ffd5938cf2e2f6763f4a62b3b74b6433e4dba))
* **ci:** use bash sleep/kill fallback instead of perl alarm on macOS ([f4b25b1](https://github.com/vinicius91carvalho/harness-engineering/commit/f4b25b16413721b6b4ed6802bba6bfbe03573182))
* **generator:** back off after a rate-limited coding/QA attempt instead of instantly retrying ([6037d4b](https://github.com/vinicius91carvalho/harness-engineering/commit/6037d4b96d2cafcd28627b94513b784129f290d2))
* **generator:** detect and undo a merge commit that still has conflict markers ([4605f46](https://github.com/vinicius91carvalho/harness-engineering/commit/4605f4699fa95ecf1b038ec5a4cc45fbf7bd64d2))
* **generator:** don't let syncing a worktree with main crash the worker ([9259d7b](https://github.com/vinicius91carvalho/harness-engineering/commit/9259d7b9f2c47f93ea7dd3ba1ea345c05bf26bb4))
* **generator:** extend the shared-root guardrail to INTEGRATION_QA too ([3a7346c](https://github.com/vinicius91carvalho/harness-engineering/commit/3a7346c3d555a7df800ed1cc72dcb87cbf8d77bd))
* **generator:** forbid destructive git commands in the autonomous MERGE agent ([3dce61c](https://github.com/vinicius91carvalho/harness-engineering/commit/3dce61c34d05df417b3fb132bd74e7d06c60f09b))
* **generator:** honor a 429's retry_after_seconds hint, add jitter to the backoff ([49e807d](https://github.com/vinicius91carvalho/harness-engineering/commit/49e807d89146aad08246e75a626242523f92901b))
* **generator:** make the merge-lock wait budget configurable, bump default to 30m ([38d71f3](https://github.com/vinicius91carvalho/harness-engineering/commit/38d71f3be5015bf28e70d0de6137ab87579d9ab9))
* **generator:** move pi adapter off OpenRouter's saturated free tier to NVIDIA NIM ([a328915](https://github.com/vinicius91carvalho/harness-engineering/commit/a328915a93362fcfd43d13260b85f7473dde41b4))
* **generator:** recover from a state lock left by a killed process ([1772625](https://github.com/vinicius91carvalho/harness-engineering/commit/1772625141360543d970b36add5b529292eafe31))
* **generator:** repair broken custom-provider model reference, move pi/opencode to OpenCode Go ([f67b3ff](https://github.com/vinicius91carvalho/harness-engineering/commit/f67b3ffc61944b585d4f77cb0cc61e6d50f8f5fb))
* **generator:** restore dirty tracked runtime logs before the integration merge ([3f2eac4](https://github.com/vinicius91carvalho/harness-engineering/commit/3f2eac4635f0cc933f6e96f3706e7ce2c9d920f8))
* **generator:** switch pi adapter to a free OpenRouter model ([754df43](https://github.com/vinicius91carvalho/harness-engineering/commit/754df43e57438e639140c9d867e8169cc4aa9b64))
* **generator:** warn MERGE/INTEGRATION_QA agents against parallel git commands ([0f7949c](https://github.com/vinicius91carvalho/harness-engineering/commit/0f7949c3a7a0d41c87070466f39d265cf3dd5e5c))
* **marketplace:** remove skill-creator from Claude plugin catalog ([9268835](https://github.com/vinicius91carvalho/harness-engineering/commit/9268835da08f8f9a718079214f39bb0cfad311e5))
* **omnigent:** bootstrap READY requires feature_list.json, not just the spec; bump timeout to 30m ([bc889b9](https://github.com/vinicius91carvalho/harness-engineering/commit/bc889b946ff9954ef04b0919d2f4abd5e569ceeb))
* **omnigent:** bootstrap scans the target repo, not the relay's cwd; bump summary cadence to 20m ([678dccb](https://github.com/vinicius91carvalho/harness-engineering/commit/678dccb7efd2cf97880d4596789c6259012723d3))
* **omnigent:** don't fold a byte-truncated UTF-8 log tail into relaunch prompts ([dc61199](https://github.com/vinicius91carvalho/harness-engineering/commit/dc61199e02e7794b3c997ee7a08bb4a681936856))
* **omnigent:** make supervisor bundle a strict relay and bundle the orchestrator ([7b06d0e](https://github.com/vinicius91carvalho/harness-engineering/commit/7b06d0e1faf144177b63d5eaaac633b830989635))
* **omnigent:** narrow bootstrap-setup.sh's no-sub-agent rule to siblings only ([5db2d98](https://github.com/vinicius91carvalho/harness-engineering/commit/5db2d985ab4a88ac8514f5cbfa9550e9097880eb))
* **omnigent:** point plan-feature.sh at the installed reconcile.mjs, not a filesystem search ([851185b](https://github.com/vinicius91carvalho/harness-engineering/commit/851185bc70ef57cd21930036d14a5d64fb6d1c39))
* **omnigent:** scope bootstrap-setup.sh's prompt to one subproject only ([b122313](https://github.com/vinicius91carvalho/harness-engineering/commit/b1223135a0800a825ba1cf850045dc159f19e537))
* **omnigent:** stop the relay from self-inspecting the repo at bootstrap ([5d592eb](https://github.com/vinicius91carvalho/harness-engineering/commit/5d592ebea640ffadb44b256a8fb45f45c7a86fac))
* **supervisor:** bound auto-recovery attempts for a context that crashes before any result ([c50dda2](https://github.com/vinicius91carvalho/harness-engineering/commit/c50dda283bc86b2fc70163b9150ec7f790fa2777))
* **supervisor:** GC orphaned pending Input Requests each tick ([0adfce2](https://github.com/vinicius91carvalho/harness-engineering/commit/0adfce2960686631386707e14a002004a8879279))
* **supervisor:** scope generator-claims.json reads to this subproject only ([eabd4e3](https://github.com/vinicius91carvalho/harness-engineering/commit/eabd4e325363076fac1722b0b1b9607eed2a5190))
* remove skill-creator from marketplace, make OpenCode-only ([b06455c](https://github.com/vinicius91carvalho/harness-engineering/commit/b06455c90ca8666495f487bb497ce618a03dd0de))
* **supervisor:** make herdr pane spawning opt-in via --display herdr ([7998750](https://github.com/vinicius91carvalho/harness-engineering/commit/799875096c7344f3df23b6b84fa2d319ab0e854a))
* **supervisor:** surface a worker crash's real log line, not just its exit code ([80cbfb7](https://github.com/vinicius91carvalho/harness-engineering/commit/80cbfb75fd079c83304030c9e3d92786d6c0f481))
* speed up macOS CI by avoiding detached supervisor leaks ([03d7f71](https://github.com/vinicius91carvalho/harness-engineering/commit/03d7f71765d4b508014cf2bc82881c7350508f41))
* stabilize orchestrator interrupt test on CI ([71e9daf](https://github.com/vinicius91carvalho/harness-engineering/commit/71e9daf49f88e55a98bdcbaa486080cd069c4d6a))


### Performance Improvements

* **supervisor:** calibrate default per-worker memory to 1GB ([429a4ef](https://github.com/vinicius91carvalho/harness-engineering/commit/429a4ef3a65630e72159f1b5a6f6f505b94c4c23))

### [1.1.1](https://github.com/vinicius91carvalho/harness-engineering/compare/v1.1.0...v1.1.1) (2026-07-03)


### Bug Fixes

* add verify false parameter on monorepo initialization ([673fc1c](https://github.com/vinicius91carvalho/harness-engineering/commit/673fc1c5fd6dea64e8106c5b22afbe79074a608f))

## [1.1.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v1.0.1...v1.1.0) (2026-07-03)


### Features

* **harness:** add command router, delimited verdict contract, and lease/worktree hardening ([f032e82](https://github.com/vinicius91carvalho/harness-engineering/commit/f032e821408a46dcd1d948ce33c826e1910083ca))
* **harness:** make pi a first-class harness pointing at GLM 5.2 ([de28742](https://github.com/vinicius91carvalho/harness-engineering/commit/de28742cf7834f026f9074bf97edce10be9bb1b8))

### [1.0.1](https://github.com/vinicius91carvalho/harness-engineering/compare/v1.0.0...v1.0.1) (2026-07-03)


### Bug Fixes

* **omnigent:** make pi a pure bridge; use SSE for brightdata MCP ([dfbe050](https://github.com/vinicius91carvalho/harness-engineering/commit/dfbe050a646a5a440752d2739290e590fba0e63b))

## [1.0.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.19.0...v1.0.0) (2026-07-03)


### ⚠ BREAKING CHANGES

* the control-host skill is renamed to supervisor; the slash
command /harness:control-host is now /harness:supervisor, and the
harness-control.mjs engine moves to skills/supervisor/scripts/.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LSBMWzp2s47atoXBA6AHM3
* **agents:** the harness:opencode:* subagent types disappear
from Claude Code's agent list. They were misleading anyway (Claude
ran them on Claude models, not OpenCode).

### Features

* model demotion, noCredits tier, pi relay Supervisor; rename Control Host→Supervisor ([c5579d8](https://github.com/vinicius91carvalho/harness-engineering/commit/c5579d87fc723326ec5fab3362834c2537162f35))
* **omnigent:** intake grilling gate and heartbeat relay cadence ([d2e5aab](https://github.com/vinicius91carvalho/harness-engineering/commit/d2e5aabb4c1c4a4afb2f70c51ff0b95aa3bd6e66))


### Bug Fixes

* **generator:** auto-fill omitted transitive dependencies for hand-authored Work Items ([21eb145](https://github.com/vinicius91carvalho/harness-engineering/commit/21eb145edd755c64f27301c8c807974ed997b3d6))
* **generator:** clear the per-run strike scoreboard when the last claim releases ([c2c45c8](https://github.com/vinicius91carvalho/harness-engineering/commit/c2c45c8d09f1906c3f82edbf471e9ef890f7ed4f))
* **generator:** route a coding decline to the next candidate ([de6cedf](https://github.com/vinicius91carvalho/harness-engineering/commit/de6cedf10c8eefa21f917820dc5239c605efdac9))
* **generator:** unique temp path for interrupted-state writes ([653c59b](https://github.com/vinicius91carvalho/harness-engineering/commit/653c59b2188f4468fea88f73b770b63a67fd1ef6))
* **supervisor:** bound retryQueue resume attempts ([d938825](https://github.com/vinicius91carvalho/harness-engineering/commit/d938825b10809fe6afe4f09fa52c0a051336171e))
* **supervisor:** defer completion while retryQueue is non-empty ([e176066](https://github.com/vinicius91carvalho/harness-engineering/commit/e176066119cf0610d160c6584a12adb80e6b0251))
* **supervisor:** defer completion while retryQueue is non-empty ([5d88380](https://github.com/vinicius91carvalho/harness-engineering/commit/5d88380b18e77ed7cfe874ec6171e0b377b42ce7))
* **supervisor:** drain in-flight worker-closed handlers before releasing the lease ([a0563b0](https://github.com/vinicius91carvalho/harness-engineering/commit/a0563b01d1bedc4409a1d7e92df26993470ffc9d))


### Code Refactoring

* **agents:** delete the dead codex/opencode role variants ([dac404e](https://github.com/vinicius91carvalho/harness-engineering/commit/dac404e171f3cfa9f501584416af5cce93f08f9a))


### Documentation

* clarify bounded contexts, claim step, backup files, and OSS model rationale ([1760363](https://github.com/vinicius91carvalho/harness-engineering/commit/17603634cc05e793826068c6218f1cf9dc579be2))
* complete the by-context who-does-what model ([4db0e38](https://github.com/vinicius91carvalho/harness-engineering/commit/4db0e383ad5e1a31f51eea91156a135aef810ae6))
* fix graph ([e13a472](https://github.com/vinicius91carvalho/harness-engineering/commit/e13a4721d8f51646832effcd13b3a19595ffd82f))

## [0.19.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.18.4...v0.19.0) (2026-07-03)


### Features

* add pi as a small-context coding harness with a context-budget fallback ([8794494](https://github.com/vinicius91carvalho/harness-engineering/commit/8794494fd4f65871052059d661a00f1419c2b6c2))


### Bug Fixes

* persist the statusline script so it survives installer cleanup ([9ce12fc](https://github.com/vinicius91carvalho/harness-engineering/commit/9ce12fc4a4f3ae349c559c8c1c4cba27e4322a19))


### Documentation

* make README and site friendlier for new users ([a2fffe9](https://github.com/vinicius91carvalho/harness-engineering/commit/a2fffe9289772936bb7975082cbc8e88d4cac257))

### [0.18.4](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.18.3...v0.18.4) (2026-07-02)


### Bug Fixes

* add section explainig that omnigent can't call opencode directly for supervisor role ([777cb13](https://github.com/vinicius91carvalho/harness-engineering/commit/777cb133195c6e68956874cd43fae73eaacf2d21))

### [0.18.3](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.18.2...v0.18.3) (2026-07-01)


### Bug Fixes

* gate release on ci success via workflow_run ([53a072b](https://github.com/vinicius91carvalho/harness-engineering/commit/53a072bfca4aafa811be15d87cec811e2f2d5b3a))

### [0.18.2](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.18.1...v0.18.2) (2026-07-01)


### Bug Fixes

* docs, workflow and scopes ([34e84b0](https://github.com/vinicius91carvalho/harness-engineering/commit/34e84b00e15b6eefeef8a3c43f309135c76331be))

### [0.18.1](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.18.0...v0.18.1) (2026-07-01)


### Bug Fixes

* make control-host test portable ([23085b3](https://github.com/vinicius91carvalho/harness-engineering/commit/23085b33d00cd684bdb6772271836108839d7865))

## [0.18.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.17.2...v0.18.0) (2026-07-01)


### Features

* add Omnigent control-host workflow ([3335dde](https://github.com/vinicius91carvalho/harness-engineering/commit/3335dde51212bc69bc63e688e05c7fdf6c5d4632))

### [0.17.2](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.17.1...v0.17.2) (2026-06-30)


### Bug Fixes

* operational merge failures are not misclassified as conflicts ([f569b16](https://github.com/vinicius91carvalho/harness-engineering/commit/f569b16e10eeba3479f41d62488f8dc07d6d3d8e))

### [0.17.1](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.17.0...v0.17.1) (2026-06-30)


### Bug Fixes

* canonicalize harness project paths ([9b4e935](https://github.com/vinicius91carvalho/harness-engineering/commit/9b4e9353b73b61f0a79371e856cf976ad822213f))

## [0.17.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.16.0...v0.17.0) (2026-06-30)


### Features

* support monorepo project workflows ([d1be776](https://github.com/vinicius91carvalho/harness-engineering/commit/d1be776bada0319bbac08eb0758e7b1766e677b7))

## [0.16.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.15.0...v0.16.0) (2026-06-30)


### Features

* add existing codebase setup mode ([4f42709](https://github.com/vinicius91carvalho/harness-engineering/commit/4f42709b9e85c8ee153cc0dd4f52f291423ca1e3))

## [0.15.0](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.14.6...v0.15.0) (2026-06-30)


### Features

* streamline setup guide and enforce spec context ([56d7c5d](https://github.com/vinicius91carvalho/harness-engineering/commit/56d7c5d1380b227e793e18690d966a109ca6f464))

### [0.14.6](https://github.com/vinicius91carvalho/harness-engineering/compare/v0.14.5...v0.14.6) (2026-06-30)


### Bug Fixes

* wait for supervisor shutdown in tests ([c7c08c1](https://github.com/vinicius91carvalho/harness-engineering/commit/c7c08c1aa0772095491c5fa900c30ac226a4c676))


### Documentation

* reorder sections ([f59c682](https://github.com/vinicius91carvalho/harness-engineering/commit/f59c6821dd2e00d070136678dcdec764fbaf2614))

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
