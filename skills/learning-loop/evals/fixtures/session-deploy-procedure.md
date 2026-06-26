# Session transcript

**User:** We need to ship the new search endpoint to staging. How do I deploy?

**Assistant:** Let me figure out the deploy flow. I'll check the repo.
*(runs `ls scripts/`, reads `Makefile`)*
OK, here's the sequence for this project:
1. `pnpm build`
2. `pnpm db:migrate --env staging`
3. `pnpm deploy --target staging`
4. Hit `https://staging.acme.dev/health` to smoke-test
5. If green, `pnpm promote staging->prod`

Ran all five, staging is green, didn't promote since you only asked for staging.

**User:** Great. Now ship the billing fix too.

**Assistant:** Same project, so let me re-derive the deploy steps again.
*(re-reads `Makefile`, re-checks `scripts/`)*
Right, the flow here is:
1. `pnpm build`
2. `pnpm db:migrate --env staging`
3. `pnpm deploy --target staging`
4. Smoke-test `https://staging.acme.dev/health`
5. `pnpm promote staging->prod` when you're ready

Done — billing fix is on staging and healthy.

**User:** Perfect. We do this a few times a week, by the way.
