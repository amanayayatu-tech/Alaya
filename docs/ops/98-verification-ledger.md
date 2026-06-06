# Verification Ledger

Date: 2026-06-06

This ledger records the evidence for the merged audit hardening pass. Commands marked `PASS` were run locally. Commands marked `N/A` do not exist in this repository. Live external checks are explicitly separated from default mock verification.

## Repository Baseline

| Item | Evidence |
|---|---|
| Repository root | `/Users/peachy/Documents/alaya` |
| Branch / commit | `main` at `d9ec48069529ac491b143aa57777fa4c085c6cc1`; worktree intentionally dirty for this uncommitted hardening pass. |
| Package layout | Root package plus `alaya-core/package.json` and `alaya-app/package.json`. |
| Runtime environment | Node `v22.22.1`, npm `10.9.4`, Darwin arm64 `25.5.0`. |
| Main app entry | `alaya-app/server/index.ts` starts Express, registers security middleware, registers routes, serves static assets and starts scheduler when allowed. |
| Route registration | `registerRoutes()` in `alaya-app/server/routes.ts`. |
| API auth | `apiAuthMiddleware` in `alaya-app/server/security/auth.ts`, mounted on `/api`. |
| Metrics access | `metricsAccessMiddleware` in `alaya-app/server/security/auth.ts`, mounted on `/metrics`. |
| HTTP hardening | `securityHeadersMiddleware`, `corsMiddleware`, and rate-limit helpers in `alaya-app/server/security/http.ts`. |
| Scheduler entry | `startCycleScheduler()` and `schedulerTickProject()` in `alaya-app/server/scheduler.ts`, gated by `scheduler_loop`. |
| LLM path | `callLlm()` in `alaya-app/server/llm.ts`; core provider in `alaya-core/src/llm/provider.ts`. |
| Trace path | `recordTrace()` in `alaya-app/server/trace.ts`; attributes are redacted before persistence. |
| Action ledger path | `recordActionProposal()` and capability audits write `action_ledger`; payloads are redacted before persistence. |

## Phase 0: Baseline Audit

### Code Access Evidence

- Read and cross-checked runtime, route, scheduler, storage, LLM, redaction, capability, observability, Docker, CI, scripts, test and docs paths required by the prompt.
- Confirmed package roots: `package.json`, `alaya-app/package.json`, `alaya-core/package.json`.
- Confirmed current HEAD differs from one old audit source and matches the other: `d9ec48069529ac491b143aa57777fa4c085c6cc1`.

### Commands

| Command | Result | Notes |
|---|---|---|
| `git rev-parse --show-toplevel` | PASS | `/Users/peachy/Documents/alaya`. |
| `git status --short --branch` | PASS | `main...origin/main`, dirty with this pass. |
| `git rev-parse HEAD` | PASS | `d9ec48069529ac491b143aa57777fa4c085c6cc1`. |
| `node --version` | PASS | `v22.22.1`. |
| `npm --version` | PASS | `10.9.4`. |
| `find . -maxdepth 3 -name package.json -not -path './node_modules/*'` | PASS | Found root, app and core packages. |

## Phase 1: Critical Security Fixes

| Finding | Fix | Verification |
|---|---|---|
| `/api/*` had no auth. | Added API key/Bearer auth with constant-time SHA256 comparison; long-run modes require auth. | `tests/security.http.test.ts` covers no auth 401, wrong auth 401, valid auth 200, health public. |
| GitHub/API/LLM secrets could enter persistence. | Expanded centralized redaction and kept tokens out of scripts/docs; persistence paths redact payloads. | `tests/secret.redaction.test.ts`, `npm run secret:scan`, focused route tests. |
| `/metrics` was public. | Added loopback/CIDR access middleware; `X-Forwarded-For` only trusted with `ALAYA_TRUST_PROXY=true`. | Unit/integration tests and Docker negative host probe. |
| Hardcoded `/private/tmp` secret fallbacks. | Removed app/core fallback paths; scripts use explicit env/file paths under local config by default. | Repo grep after edits finds no active fallback path in runtime code or scripts; docs mention the old path only as historical audit context. |
| Main write routes lacked schema validation. | Added Zod schemas for predictions, knowledge, human gates and scheduler tick; route id validation. | `tests/routes.validation.test.ts`. |
| Scheduler tick could overlap. | Added per-project in-process concurrency guard with skipped event/trace/metric observation. | `tests/scheduler.concurrency.test.ts`. |

### Negative Tests

| Scenario | Expected | Evidence |
|---|---|---|
| `GET /api/projects` without auth in long-run/auth-required mode | 401 | `security.http.test.ts`. |
| `GET /api/projects` with wrong Bearer token | 401 | `security.http.test.ts`. |
| Valid Bearer key | not 401 | `security.http.test.ts`; Docker runtime returned 200. |
| `/healthz` without auth | 200 | `security.http.test.ts`; Docker runtime returned ok. |
| Non-allowlisted metrics source | 403 | `security.http.test.ts`; Docker host `/metrics` returned 403. |
| Invalid route id | 400 | `routes.validation.test.ts`. |
| Body tries to override human gate decision | ignored | `routes.validation.test.ts`. |
| Concurrent scheduler tick | skipped with `tick_in_progress` evidence | `scheduler.concurrency.test.ts`. |

## Phase 2: Short-Term Hardening

| Finding | Fix | Verification |
|---|---|---|
| No CORS boundary. | Added `ALAYA_CORS_ORIGINS`; local dev origins allowed only outside production-like modes. | `security.http.test.ts`. |
| Missing security headers. | Added CSP, nosniff, frame deny, referrer policy, permissions policy, COOP, and production-like HSTS. | `security.http.test.ts`. |
| Costly endpoints unlimited. | Added per-client in-memory rate limits for `run-full` and scheduler tick. | `security.http.test.ts`. |
| Dynamic PRAGMA table names. | Added required-table whitelist and required-column key validation. | App test suite and typecheck. |
| Unused dependencies. | Removed unused session/passport/Supabase dependencies and build allowlist entries. | `npm install`, app build/test, Docker build, npm audit. |
| Secret scan coverage. | Added high-confidence patterns for MiniMax-like keys, bearer tokens, DB URLs and cookie secrets. | `npm run secret:scan`. |
| `rowToKnowledge(any)`. | Changed mappings to accept `unknown` and assert object shape. | App test suite and typecheck. |
| Silent JSON parse catch. | Added warning on parse failure. | App test suite. |
| `resolveGate` decision from body. | Decision now derives from route path. | `routes.validation.test.ts`. |
| LLM retry/backoff. | App OpenAI-compatible calls retry 429/5xx with bounded exponential backoff. | App LLM tests and full app suite. |
| CI lacked audit gate. | Added app/core `npm audit --audit-level=high` to CI/deploy-readiness. | Local audit commands pass with 0 vulnerabilities. |

## Phase 3: Deployment And Ops

| Area | Evidence |
|---|---|
| Docker build | `docker build -t alaya:local .` passed. |
| Runtime user | `docker image inspect` showed `user=alaya`, `workdir=/app/alaya-app`, `cmd=["node","dist/index.cjs"]`. |
| Compose config | `ALAYA_API_KEY=<local-test-key> docker compose -f deploy/docker-compose.shadow.yml config` passed and showed API key env override plus `no-new-privileges:true`. |
| Explicit migration | `docker compose run --rm -e ALAYA_CAP_DATABASE_MIGRATION=true alaya node dist/migrate.cjs` passed with schema migrated JSON. |
| Docker health | Shadow service returned `/healthz` ok and `/readyz` ready. |
| Docker metrics | Host port `/metrics` returned 403 by default; container-internal loopback `/metrics` returned Prometheus text. |
| Docker auth | No auth and wrong auth returned 401; valid local test auth returned 200. |
| Backup/restore | `npm run ops:backup -- --out tmp/alaya-backups/verify-goal` passed; restore dry-run passed. |
| Shadow report | `npm run shadow:report -- --out tmp/shadow-report-goal.md` passed; temporary report was removed. |

## Command Evidence

| Command | Result | Notes |
|---|---|---|
| `npm install --package-lock=false` | PASS | Root install successful. |
| `npm --prefix alaya-app install` | PASS | App install successful after dependency removal. |
| `npm --prefix alaya-core install` | PASS | Core install successful. |
| `npm --prefix alaya-app run check` | PASS | TypeScript check passed. |
| Interim `npm --prefix alaya-app test` during review-fix pass | FAIL -> FIXED | `capabilityGate.test.ts` imported storage in shadow mode without `ALAYA_API_KEY`; test fixture now sets `unit-api-key-for-capability-gate` and the full app suite reran green. |
| `cd alaya-app && node --import tsx --test tests/security.http.test.ts tests/env.validation.test.ts tests/secret.redaction.test.ts` | PASS | Focused review-fix suite passed, 16/16. |
| `npm --prefix alaya-app test` | PASS | 104/104 app tests after adding the shadow API key fixture. |
| `npm --prefix alaya-core test` | PASS | 50/50 core tests. |
| `npm --prefix alaya-core run typecheck` | PASS | Core TypeScript check passed. |
| `npm run test:scripts` | PASS | 18/18 script tests. |
| `npm run test:all` | PASS | Core + app + scripts passed. |
| `npm run typecheck` | PASS | Core typecheck + app check passed. |
| `npm run guard` | PASS | 17 principles checks passed. |
| `npm run secret:scan` | PASS | No high-confidence secrets found in repository. |
| `git grep -nE "(api[_-]?key\|apikey\|secret\|token\|password\|private key\|BEGIN .*PRIVATE KEY\|AKIA\|Authorization\|Bearer\|DATABASE_URL\|postgres://\|mysql://\|mongodb://\|ghp_)" -- . ':!package-lock.json' ':!node_modules' || true` | PASS | 448 keyword matches reviewed as env names, GitHub Actions secret references, scanner/redaction code, docs, package metadata or test placeholders; no real secret value identified. |
| `npm --prefix alaya-app audit --audit-level=high` | PASS | 0 vulnerabilities. |
| `npm --prefix alaya-core audit --audit-level=high` | PASS | 0 vulnerabilities. |
| `npm run build` | PASS | App build passed; existing PostCSS `from` warning only. |
| `npm --prefix alaya-app run build` | PASS | App build passed; same PostCSS warning. |
| `npm --prefix alaya-core run build` | N/A | Core package has no `build` script; `npm --prefix alaya-core run typecheck` is the substitute. |
| `npm run lint` | N/A | Root package has no `lint` script; typecheck, tests and guard were run instead. |
| `npm run benchmark:smoke` | PASS | 7/7 benchmark cases. |
| `npm run flywheel` | PASS | Mock 4-cycle flywheel accepted. |
| `OPENAI_API_KEY_FILE=$HOME/.config/alaya/openai-api-key OPENAI_BASE_URL=https://api.minimax.io/openai OPENAI_MODEL=MiniMax-M3 OPENAI_API_MODE=chat npm run e2e:llm` | PASS | Real OpenAI-compatible preflight succeeded; schema valid, retry count 0, estimated cost about `$0.000173`; no key value printed. |
| `OPENAI_API_KEY_FILE=... GITHUB_TOKEN_FILE=... npm run audit:upgrade` | PASS | Live-readiness audit passed with local key-file paths, 13/13 checks. |
| `npm run setup:secrets:check` | PASS | Local key files exist outside repo with mode `0600`; values not recorded. |
| `npm run ops:pre-upgrade` | PASS | Precheck passed; reported dirty worktree as expected. |
| `npm run ops:backup -- --out tmp/alaya-backups/verify-goal` | PASS | Backup written under `tmp/`. |
| `npm run ops:restore -- --backup tmp/alaya-backups/verify-goal` | PASS | Dry-run restore, no state overwritten. |
| `npm run ops:post-upgrade` | PASS | Guard/core tests passed; HTTP probes skipped because `ALAYA_BASE_URL` was unset. |
| `docker build -t alaya:local .` | PASS | Docker image built. |
| `docker compose -f deploy/docker-compose.shadow.yml config` | PASS | Shadow compose rendered. |
| Docker migration + `up -d --no-build` + curl probes | PASS | Health/ready/auth/metrics controls behaved as expected; compose service stopped afterward. |

## Security Grep And Secret Handling

- `npm run secret:scan` passed after local secrets were stored outside the repository.
- Active runtime code and scripts no longer contain `/private/tmp/alaya-minimax-key` or `/private/tmp/alaya-github-token` fallbacks. Ops docs mention those strings only as historical audit findings.
- `git grep` style secret keywords are expected to match env variable names, redaction code, scanner patterns and placeholder tests. No real secret value is required or recorded in repository files.
- Real local secrets used for tests are in `$HOME/.config/alaya/*` with `0600` permissions. Their values are intentionally omitted from this ledger.

## Opt-In / Not Run

| Check | Status | Reason |
|---|---|---|
| `npm run e2e:llm-flywheel` | NOT RUN | Higher-cost live multi-cycle LLM check; single-call live preflight passed. |
| `npm run e2e:github` | NOT RUN | Script creates and closes a real GitHub issue; avoid remote repository mutation during this pass. |
| `npm run e2e:github-autonomous` | NOT RUN | Script creates and closes a real GitHub issue and requires a live app scheduler. |
| 7-day shadow run | NOT RUN | This pass validates readiness; actual 7-day run is an operational follow-up. |

## Anti-Fake-Completion Answers

1. Env validation is called in `alaya-app/server/index.ts` and before SQLite opens in `alaya-app/server/storage.ts`.
2. API auth is mounted before `/api` route handling; capability gates remain separate authorization controls.
3. Redaction is applied in Express logging/error handling, capability audit payloads, generic action-ledger payloads, trace attributes and event-log before/after fields.
4. Metrics expose counters and mode labels only and are loopback/CIDR controlled.
5. Shadow-mode high-risk API write simulation is tested with mutating route coverage and Docker auth probes; capability decisions write `action_ledger`.
6. Production default deny is tested against real Express routes and env validation tests.
7. `/healthz` is liveness; `/readyz` validates config, DB and writable state.
8. Metrics are backed by DB counts and runtime scheduler counters, including LLM input/output token split.
9. Docker uses a Node 20 runtime stage and non-root `alaya` user.
10. `.dockerignore` excludes `.env`, `node_modules`, `.git`, logs, tmp, cache and coverage.
11. Shadow compose mounts only bounded state/log/cache/data volumes and does not mount host root.
12. Backup excludes `.env` and secret dumps; restore is dry-run unless `--confirm` is supplied.
13. CI defaults to mock/no-secret paths; live LLM/GitHub checks are opt-in.
14. Failed/nonexistent commands are recorded as `N/A`, not claimed as passed.
15. No known P0 blocker remains after the local verification suite.

## Remaining Risks

| Severity | Risk | Handling |
|---|---|---|
| P1 | GitHub live E2E was not run because it mutates the remote repository by creating/closing issues. | Keep opt-in; run in a controlled window with a scoped token and API auth headers updated for the hardened server. |
| P2 | `rawDb` remains exported internally. | Plan a data-layer migration that preserves tests and audit/event contracts. |
| P2 | Docker base image is pinned by Node major/tag but not SHA digest. | Pin digest during release engineering after multi-arch CI validation. |
| P2 | Scheduler lock is in-process only. | Use a DB/distributed lock before multi-replica deployment. |
| P2 | SQLite backup consistency is strongest when service is stopped or WAL is checkpointed. | Follow pre-upgrade backup procedure and stop shadow service for critical restores. |
