# Alaya Validation Report

Date: 2026-06-04

## Secret Handling

- GitHub and MiniMax credentials were kept outside the repository in a local temp file with `0600` permissions.
- The temp file now exposes local aliases for the same values: `GITHUB_TOKEN`, `GH_PAT`, `ALAYA_GITHUB_TOKEN`, `MINIMAX_API_KEY`, `LLM_API_KEY`, and `OPENAI_API_KEY`.
- No secret values were printed, written into tracked files, or added to GitHub workflow files.
- Exact-value scan of the worktree found neither the GitHub token nor the MiniMax key.
- CI expects Actions secrets named `LLM_API_KEY` and `GH_PAT`. Do not create a custom secret named `GITHUB_TOKEN`; that name is reserved by GitHub Actions.

## Environment Self-Check

- `node -v && npm -v`: Node `v22.22.1`, npm `10.9.4`. The mission expected Node 20.x; repo `package.json` requires `>=20`, and CI pins Node 20.
- Current HEAD: `888467f refactor: improve web UI governance flows`.
- Workspaces/packages found: `package.json`, `alaya-app/package.json`, `alaya-core/package.json`.
- Actual test framework: Node built-in `node:test`, invoked through `node --import tsx --test ...`; not Jest/Vitest.
- Actual flywheel script: `npm --prefix alaya-core run flywheel`.
- Live script: `alaya-app` now has `flywheel:live`, delegating to root `npm run e2e:live`.
- `.env`: absent and ignored by Git.

## Pre-Read Summary

- Round implementation: `alaya-app/server/flywheel.ts` has explicit scenario entries for rounds 1-4; round 4 is rollback/audit-specific at lines 85-99 and `scenarioForCycle()` no longer reuses round 3.
- Knowledge injection before task execution: implemented in `alaya-app/server/knowledgeInjection.ts`; `flywheel.ts` passes `knowledgeSummary` into LLM calls; `llm.ts` prepends it to system instructions.
- `knowledge_items` fields: `id`, `project_id`, `type`, `title`, `content`, `source_type`, `source_ref`, `evidence_alpha`, `evidence_beta`, `confidence_score`, `confidence_level`, `status`, `human_approved_count`, `external_verified_count`, `valid_from`, `valid_until`, `last_validated_cycle`, `created_by_cycle`, `created_by`, `approved_by`, `usage_count`, `last_injected_at`, `last_verified_at`, `storage_strength`, `novelty_score`, `source_round`, `tags`, `notes`, `superseded_by`, `semantic_key`, `version`.
- PRINCIPLES bottom lines: pure core functions only; `active -> strong` requires human gate; writes must go through `event_log` with `actor`; `stale/expired/quarantined/conflict` knowledge is excluded from high-risk evidence; gray-zone feedback weakly accumulates and can trigger meaning gates; LLM calls stay behind `LLMProvider`.
- Existing test files: app `evolution_engine`, `external_feedback_scheduler`, `flywheel.round4`, `flywheelHealth.api`, `knowledgeInjection`, `principles.guard`, `schema_migration`, `update_confidence.decay`; core `classify_error`, `compute_error`, `confidence`, `flywheel_4_cycle`, `llm_agent_outputs`, `llm_provider`.
- Top issues found and handled: missing knowledge schema fields; missing task-time knowledge injection; round 4 scenario reuse risk; no health observability API/UI; no time decay; missing CI/live script alias; 24h runner initially produced `delta=NA` without a running health endpoint.

## Task Status

| Task | Status | Notes |
| --- | --- | --- |
| TASK-01 round 4 scenario | Complete | Cycle 4 now has independent rollback/audit scenario and regression coverage. |
| TASK-02 knowledge injection | Complete | Added FTS-backed `[PRIOR KNOWLEDGE]` injection, strict active/strong filtering, usage/last-injected tracking, and LLM system prepending. |
| TASK-03 principles guards | Complete | Added machine guard tests for all 6 PRINCIPLES bottom lines. |
| TASK-04 health dashboard/API | Complete | Added `/api/flywheel/health`, API tests, and `client/src/FlywheelHealth/*` dashboard components. |
| TASK-05 Bjork decay | Complete | Added pure `applyTimeDecay`, `last_verified_at`, scheduler `decayStaleKnowledge`, and app/core tests. |
| TASK-06 GitHub Actions CI | Complete | Added `.github/workflows/ci.yml` with actual Node test commands and live validation hook. |
| TASK-07 24h validation script | Implemented, health-smoke-tested, 24h run started | Added executable `scripts/24h_validation.sh` plus `scripts/validation-summary.mjs`; local smoke ran 2 rounds with health `delta=2`; network-blocked live smoke recorded `SKIP_NET` instead of failing ambiguously. A full 24h run is now active in detached screen session `72414.alaya-24h-validation`. |
| TASK-08 knowledge schema fields | Complete | Added migration/default handling for injection/maturity fields and later `last_verified_at` for TASK-05. |

## Bottom-Line Guard Status

- `npm run guard`: 17/17 checks passed.
- `alaya-app/tests/principles.guard.test.ts`: 6/6 tests passed.
- No `it.todo`, skipped, or placeholder tests were added.

## Compounding Metrics

Fresh temp DB, 4 mock flywheel cycles:

```json
{
  "round1vs4KnowledgeDelta": 2,
  "principleNoveltyRate": 1,
  "injectionEffectiveness": 1
}
```

Short validation smoke with isolated 4-cycle health DB:

```csv
round,timestamp,guard,sim,live,delta
1,17:37:49,PASS,PASS,SKIP,2
2,17:37:49,PASS,PASS,SKIP,2
```

Smoke totals: 2 rounds, 0 errors. First `delta > 0`: round 1.

Network-blocked live smoke:

```csv
round,timestamp,guard,sim,live,delta
1,17:47:46,PASS,PASS,SKIP,NA
2,17:47:46,PASS,PASS,SKIP,NA
3,17:47:47,PASS,PASS,SKIP_NET,NA
4,17:47:47,PASS,PASS,SKIP,NA
5,17:47:48,PASS,PASS,SKIP,NA
6,17:47:48,PASS,PASS,SKIP_NET,NA
7,17:47:48,PASS,PASS,SKIP,NA
```

Smoke totals: 7 rounds, 0 errors. Live steps were skipped with `SKIP_NET` because connectivity URLs were intentionally pointed at `127.0.0.1:9`.

Active 24h run, latest observed checkpoint:

```csv
round,timestamp,guard,sim,live,delta
1,17:50:55,PASS,PASS,SKIP,2
2,18:00:56,PASS,PASS,SKIP,2
3,18:10:56,PASS,PASS,SKIP_NET,2
4,18:21:07,PASS,PASS,SKIP,2
5,18:31:08,PASS,PASS,SKIP,2
6,18:41:09,PASS,PASS,SKIP_NET,2
7,18:51:19,PASS,PASS,SKIP,2
8,19:01:21,PASS,PASS,SKIP,2
9,19:11:21,PASS,PASS,SKIP_NET,2
10,19:21:32,PASS,PASS,SKIP,2
11,19:31:32,PASS,PASS,SKIP,2
12,19:41:33,PASS,PASS,SKIP_NET,2
```

Active checkpoint totals: 12 rounds, 0 guard/sim errors, health `delta=2` in every recorded round, live `SKIP_NET` on rounds 3/6/9/12 due API connectivity. Active run details: screen session `72414.alaya-24h-validation`, screen log `/tmp/alaya-24h-validation-screen.log`, health server log `/tmp/alaya-24h-health-server.log`, summary `validation-logs/20260604_175045/SUMMARY.csv`. This is in progress and is not yet a completed 24h validation result.

Machine summary for the active run:

```json
{
  "totalRounds": 12,
  "errors": 0,
  "firstDeltaPositiveRound": 1,
  "lastRound": 12,
  "lastTimestamp": "19:41:33",
  "lastDelta": "2",
  "statusCounts": {
    "guard": { "PASS": 12 },
    "sim": { "PASS": 12 },
    "live": { "SKIP": 8, "SKIP_NET": 4 }
  }
}
```

## Verification Commands

- `npm --prefix alaya-app test`: 65/65 passed.
- `npm --prefix alaya-app run check`: passed.
- `npm --prefix alaya-core test`: 46/46 passed.
- `npm --prefix alaya-core run typecheck`: passed.
- `npm --prefix alaya-core run flywheel`: passed.
- `npm run guard`: 17/17 passed.
- `npm run test:scripts`: 15/15 passed.
- `npm run validation:summary -- validation-logs/20260604_175045/SUMMARY.csv`: total rounds 12, errors 0, first positive delta round 1.
- `npm --prefix alaya-app run build`: passed after restoring the active client entry files.
- `ALAYA_VALIDATION_DURATION_SECONDS=1 ALAYA_VALIDATION_SLEEP_SECONDS=0 ALAYA_HEALTH_URL=http://127.0.0.1:5123/api/flywheel/health?projectId=proj_health_four_rounds ./scripts/24h_validation.sh`: 2 smoke rounds, guard/sim passed, health `delta=2`.
- `ALAYA_VALIDATION_DURATION_SECONDS=4 ALAYA_VALIDATION_SLEEP_SECONDS=0 ALAYA_CONNECT_TIMEOUT_SECONDS=1 ALAYA_LLM_CONNECTIVITY_URL=http://127.0.0.1:9 ALAYA_GITHUB_CONNECTIVITY_URL=http://127.0.0.1:9 LLM_API_KEY=<fake> GH_PAT=<fake> ./scripts/24h_validation.sh`: 7 smoke rounds, 0 errors, live `SKIP_NET` on rounds 3 and 6.
- `/tmp/alaya-24h-validation-wrapper.sh` in detached `screen`: active 24h run started at 17:50:45 CST; first row guard/sim passed with health `delta=2`.
- `OPENAI_BASE_URL=https://api.minimax.io/openai OPENAI_MODEL=MiniMax-M3 npm run e2e:live`: attempted once; failed during real LLM preflight with `fetch failed` before any GitHub issue step.
- Connectivity probes from local shell: `api.minimax.io:443`, `api.minimaxi.com:443`, `api.openai.com:443`, and `api.github.com:443` all timed out on TCP connect. Rechecked at 19:44 CST: `api.github.com:443` and `api.minimax.io:443` still timed out.
- Exact secret scan: GitHub token not found in worktree; MiniMax key not found in worktree.
- Browser verification: `http://127.0.0.1:5123/#/health` rendered Flywheel Health, Compounding Proof, Round Timeline, Knowledge State, and Human Gate Queue. Screenshot: `alaya-app/.codex-screenshots/flywheel-health.png`.

Build note: the active `alaya-app/client` tree had lost its four Vite entry files while an untracked `alaya-app/client 2/` held those same files. I restored the active entry files from that local copy, wired the Flywheel Health route, and verified production build.

## Document Assumptions vs Actual Repo

| Document assumption | Actual / action |
| --- | --- |
| Node 20.x | Local runtime is Node 22.22.1; CI uses Node 20. |
| Jest/Vitest-style test filtering and coverage | Repo uses Node built-in `node:test`; CI uses explicit test paths and full suite, no fake coverage flag. |
| `flywheel:live` exists | It did not. Added `alaya-app` script alias to root `npm run e2e:live`. |
| `buildKnowledgeContext` exists | It did not. Added `alaya-app/server/knowledgeInjection.ts`. |
| Knowledge injection already enters system prompt | It did not. `llm.ts` now prepends prior knowledge to provider system instructions. |
| `applyTimeDecay` exists | It did not. Added pure function to app shared core and standalone core. |
| `lastVerifiedAt` field exists | It did not. Added nullable `last_verified_at` with migration and storage mapping. |
| `.github/workflows/ci.yml` exists | It did not. Added it; existing `principles-guard.yml` remains unchanged. |
| 24h runner health endpoint fixed at localhost:5000 | Made configurable through `ALAYA_HEALTH_URL` so validation can target a known server/DB. |
| Local secret names vary (`MINIMAX_API_KEY`, `LLM_API_KEY`, `OPENAI_API_KEY`, `GH_PAT`) | Runner now normalizes aliases without printing values. |
| Live step with credentials but no API network | Runner now records `SKIP_NET` and keeps validating guard/sim/health until connectivity returns. |
| Final report requires SUMMARY.csv statistics | Added `npm run validation:summary -- <SUMMARY.csv>` to compute total rounds, errors, first positive delta, and status counts. |

## Issues And Handling

- Client build blocker: resolved by restoring `client/index.html`, `client/src/App.tsx`, `client/src/index.css`, and `client/src/main.tsx` from the local `client 2/` copy and adding the health route/sidebar link.
- Full 24h validation is currently running and cannot be marked complete until the 24-hour wall-clock run finishes and its final `SUMMARY.csv` is inspected.
- Live external validation was attempted once. It failed at real LLM preflight because outbound HTTPS connections to MiniMax/OpenAI/GitHub APIs time out from this local environment. The run stopped before the GitHub issue creation step, so no live GitHub mutation occurred.

## Post-Review Fixes

- FTS migration now rebuilds `knowledge_fts` during startup migration, so active/strong knowledge rows created before the FTS table existed are immediately available to knowledge injection. Added a legacy-DB migration regression test.
- Scheduler now calls `decayStaleKnowledge()` on each project tick. Time decay records `last_decayed_at` and uses it as an incremental anchor so repeated ticks do not reapply the full historical decay window. Explicit `validUntil` expiry remains under Librarian stale/conflict audit instead of being silently masked by time decay.
- Flywheel Health now waits for the Layout project context and calls `/api/flywheel/health?projectId=...` plus `/api/human-gates?projectId=...`, avoiding mixed first-project/all-project data.
- `scripts/24h_validation.sh` now exits non-zero whenever any guard/sim/live step records `FAIL`.
- README was updated with current health dashboard, knowledge injection, FTS backfill, time decay, CI, and 24h validation behavior.

Post-review verification:

- `npm --prefix alaya-app test`: 68/68 passed.
- `npm --prefix alaya-core test`: 46/46 passed.
- `npm run test:scripts`: 15/15 passed.
- `npm run typecheck`: passed.
- `npm run guard`: 17/17 passed.
- `npm run build`: passed; PostCSS `from` option warning still present.
- `npm run flywheel`: passed.
- `npm run e2e:long-evolution`: passed, 20 cycles.
- Browser smoke: `http://127.0.0.1:5001/#/health` rendered Flywheel Health and only issued project-scoped health/gate requests.
