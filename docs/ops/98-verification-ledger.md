# Verification Ledger

Date: 2026-06-06

This ledger records the cross-verification evidence for the long-run hardening pass. It is intentionally audit-oriented: commands listed as PASS were run locally; static checks are marked separately; opt-in live tests are not claimed as run.

## Repository Baseline

| Item | Evidence |
|---|---|
| Repository root | `/Users/peachy/Documents/alaya` |
| Branch / commit | `main` at `c12c4c15e242b7171e0cefbad286380f6f95d8fd`; worktree intentionally dirty for this uncommitted hardening review. |
| Package layout | Root package plus `alaya-core/package.json` and `alaya-app/package.json`. |
| Runtime environment | Node `v22.22.1`, npm `10.9.4`, Darwin arm64 `25.5.0`. |
| Main app entry | `alaya-app/server/index.ts` starts Express, registers routes, serves static assets and starts the scheduler when allowed. |
| Production entry | `npm --prefix alaya-app run build`, then `npm --prefix alaya-app run start`; Docker uses the built `dist/index.cjs`. |
| Scheduler entry | `startCycleScheduler()` in `alaya-app/server/scheduler.ts`, gated by `scheduler_loop` in `alaya-app/server/index.ts`. |
| Route registration | `registerRoutes()` in `alaya-app/server/routes.ts`. |
| LLM path | `callLlm()` in `alaya-app/server/llm.ts`, gated by `llm_call`; provider fetches also pass through unknown-network checks. |
| Trace path | `recordTrace()` in `alaya-app/server/trace.ts`; attributes are redacted before persistence. |
| Action ledger path | `recordActionProposal()` and capability audits write `action_ledger`; payloads are redacted before persistence. |

## Safety Fixes From Cross-Review

| Finding | Fix | Verification |
|---|---|---|
| Long-run mutating APIs were only intercepted in `shadow`; `production`/`staging` route writes could bypass the capability gate. | `alaya-app/server/routes.ts` now gates non-read-only API methods in all long-run modes. `shadow` dry-runs; `staging`/`production` deny unless explicitly allowed. | `npm --prefix alaya-app test` includes `production mode rejects mutating API requests before handlers write`. |
| `storage.ts` opened the default DB before env validation could fail on invalid production env. | `assertEnvValid()` now runs before opening SQLite. | `npm --prefix alaya-app test` includes `storage import fails fast on invalid production env before opening the default DB`. |
| Trace attributes, generic action-ledger payloads and event-log before/after values could persist raw secret-like fields. | `trace.ts`, `actionLedger.ts`, and `storage.ts` now use centralized redaction before audit persistence. | `npm --prefix alaya-app test` includes `trace and action ledger persistence redact secret payloads`. |
| `secret:scan` previously allowed every file under tests. | The blanket tests-directory allow was removed; only explicit placeholder markers are ignored. | `npm run secret:scan` must pass after this ledger update. |
| `restore-state.mjs` calculated parent dirs via `resolve(item.to, "..")`. | It now uses `dirname(item.to)`. | Backup/restore smoke commands listed below. |
| Migration failure text referenced the wrong env var name. | Message now uses `ALAYA_CAP_DATABASE_MIGRATION`. | Covered by code review and app tests importing `storage.ts`. |
| Startup schema migration was still part of normal long-run startup. | Long-run startup now validates schema readiness when migration capability is false; schema DDL is run through `npm run ops:migrate` or `dist/migrate.cjs` with explicit `ALAYA_CAP_DATABASE_MIGRATION=true`. | `npm --prefix alaya-app test` includes steady-state and missing-schema import checks; Docker validation runs the explicit migration before service startup. |
| LLM metrics only had aggregate `token_count`. | `llm_calls` now stores `input_token_count` and `output_token_count`; metrics, API summary and UI read the split. | `npm --prefix alaya-app test` checks split token persistence. |

## Command Evidence

| Command | Result | Notes |
|---|---|---|
| `npm --prefix alaya-app test` | PASS | 92/92 app tests after cross-review fixes. |
| `npm --prefix alaya-app run check` | PASS | TypeScript check passed after cross-review fixes. |
| `npm run secret:scan` | PASS | No high-confidence secrets found; scanner no longer blanket-skips tests. |
| `npm --prefix alaya-core test` | PASS | 50/50 earlier in the hardening run. |
| `npm run test:scripts` | PASS | 18/18 earlier in the hardening run. |
| `npm run test:all` | PASS | Core, app and script tests earlier in the hardening run. |
| `npm run typecheck` | PASS | Root typecheck rerun after cross-review fixes. |
| `npm run guard` | PASS | 17/17 principles checks earlier in the hardening run. |
| `npm run build` | PASS | Rerun after cross-review fixes; existing PostCSS `from` warning only. |
| `npm run benchmark:smoke` | PASS | 7/7 benchmark cases. |
| `npm run flywheel` | PASS | Mock flywheel accepted. |
| `npm run e2e:long-evolution` | PASS | 20-cycle long evolution run. |
| `npm run ops:pre-upgrade` | PASS | Env/state/readiness precheck passed. |
| `npm run ops:backup -- --out tmp/alaya-backups/verify-backup-cross` | PASS | Copied DB/WAL/SHM during smoke. |
| `npm run ops:restore -- --backup tmp/alaya-backups/verify-backup-cross` | PASS | Dry-run restore; no state overwritten. |
| `npm run ops:post-upgrade` | PASS | Guard and core tests passed; HTTP probes skipped because `ALAYA_BASE_URL` was unset. |
| `npm run shadow:report -- --out tmp/shadow-report-cross.md` | PASS | Wrote the requested report file after fixing `--out <path>` parsing; temporary output removed after verification. |
| `docker compose -f deploy/docker-compose.shadow.yml config` | PASS | Shadow compose rendered successfully. |
| `docker build -t alaya:local .` | PASS | Rerun after cross-review fixes; Docker build succeeded. |
| `docker image inspect alaya:local --format ...` | PASS | Runtime image uses `user=alaya`, `workdir=/app/alaya-app`, `cmd=["node","dist/index.cjs"]`. |
| `ALAYA_SHADOW_PORT=5055 docker compose -f deploy/docker-compose.shadow.yml up -d --no-build` plus `curl /healthz /readyz /metrics` | PASS | Health `ok`, ready `ready`, metrics emitted; service was stopped afterward. |
| Shadow container dry-run write probe | PASS | `POST /api/knowledge` returned `202 dry_run`; `/api/action-ledger?limit=5` showed `capability.knowledge_write` with `status=dry_run`; service was stopped afterward. |

## Anti-Fake-Completion Answers

1. Env validation is called in `alaya-app/server/index.ts` and now also before SQLite opens in `alaya-app/server/storage.ts`.
2. Redaction is applied in Express logging/error handling, capability audit payloads, generic action-ledger payloads, trace attributes and event-log before/after fields. Metrics expose counters and mode labels only.
3. Capability gate is not just a pure-function test: real mutating API middleware, scheduler startup, LLM calls and unknown-network paths are wired to it. GitHub write, shell execution and external notification adapters are not present in this app and remain default-deny if introduced.
4. Shadow-mode high-risk API write simulation is tested with `POST /api/knowledge` in both integration tests and the shadow container; it returns `202 dry_run`, does not execute the handler write, and writes `action_ledger`.
5. Production default deny is tested against a real Express route with `POST /api/projects`; it returns `403` before handler writes.
6. Deny and dry-run decisions write `action_ledger` rows via `auditCapabilityDecision()`.
7. `/healthz` is liveness; `/readyz` validates config, DB and writable state.
8. Metrics are backed by DB counts and runtime scheduler counters. LLM input/output token split is now stored in `llm_calls` and exposed through `/metrics`.
9. Dockerfile uses a Node 20 runtime stage and non-root `node` user.
10. `.dockerignore` excludes `.env`, `node_modules`, `.git`, logs, tmp, cache and coverage. Docker image inspection should be repeated before final release.
11. Shadow compose mounts only bounded state/log/cache/data volumes and does not mount the host root.
12. Backup excludes `.env` and secret dumps; restore is dry-run unless `--confirm` is supplied.
13. CI defaults to mock/no-secret paths; live LLM/GitHub checks are opt-in and skipped without configured secrets.
14. Commands in this ledger are split into actually run PASS entries and explicitly noted opt-in/not-run items.
15. Remaining P1 risks are listed below; no P0 blocker is currently known after rerunning final checks.

## Remaining Risks

| Severity | Risk | Handling |
|---|---|---|
| P1 | GitHub live E2E and real LLM validation were not rerun in this pass because they need real secrets. | Keep opt-in; run only with scoped secrets in a controlled environment. |
| P2 | SQLite backup consistency is strongest when service is stopped or WAL is checkpointed. | Use pre-upgrade backup procedure and stop shadow service for critical restores. |
