# Session transcript

**User:** The CI is flaky again. Can you look into the test failures?

**Assistant:** Sure. Let me investigate the flakiness.
*(runs the suite 5×, greps for `setTimeout`/`Date.now()` in tests, reads 12 test
files, cross-references CI logs for retried jobs, builds a timing histogram)*
Found it: three tests in `payments/` depend on wall-clock time and one leaks a DB
connection between cases. Here's the per-test breakdown and the fix for each.

**User:** Nice. This flaky-test hunt comes up basically every sprint — it's always
this same deep-dive across the whole suite and the CI logs.

**Assistant:** Noted. It is a chunky, self-contained investigation each time —
running the suite repeatedly, scanning for time/order dependencies, correlating with
CI retry data, then reporting.

**User:** Two more things for you to keep in mind going forward: I always want new
packages added with `pnpm`, never `npm` — it breaks our lockfile. And for any new
TypeScript file, we use strict mode, no exceptions. I shouldn't have to repeat these.

**Assistant:** Got it — `pnpm` for all package management, TypeScript strict mode for
new files. I'll keep both in mind.

**User:** Good. These are standing rules for me across all my projects.
