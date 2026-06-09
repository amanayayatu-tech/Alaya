# Alaya Long-Run Readiness Report

Date: 2026-06-06

## Summary

This pass verified the current `main` HEAD, then hardened the app for long-running shadow/staging/production use: API auth, metrics access control, CORS, security headers, rate limits, schema validation, scheduler concurrency protection, stronger redaction, explicit key-file handling, Docker/CI audit gates, and updated ops evidence.

Detailed command evidence is in [98-verification-ledger.md](/Users/peachy/Documents/alaya/docs/ops/98-verification-ledger.md). Baseline audit status is in [00-baseline-audit.md](/Users/peachy/Documents/alaya/docs/ops/00-baseline-audit.md).

## Modified Files

- `.env.example`: added API auth, CORS, metrics, rate-limit and retry env examples.
- `.github/workflows/ci.yml`, `.github/workflows/deploy-readiness.yml`: added high-severity npm audit gates.
- `README.md`: moved local secret-file guidance to `$HOME/.config/alaya`.
- `alaya-app/.env.example`, `deploy/env/alaya.env.example`: added hardened runtime variables.
- `deploy/docker-compose.shadow.yml`: added API key env injection, metrics/rate envs and `no-new-privileges`.
- `alaya-app/package.json`, `alaya-app/package-lock.json`, `alaya-app/script/build.ts`: removed unused dependencies/build allowlist entries.
- `alaya-app/server/security/auth.ts`: new API auth and metrics access control middleware.
- `alaya-app/server/security/http.ts`: new CORS, security header and rate-limit middleware.
- `alaya-app/server/index.ts`: wired security/CORS middleware.
- `alaya-app/server/routes.ts`: wired `/api` auth, `/metrics` access control, route param validation, Zod body validation and costly endpoint rate limits.
- `alaya-app/server/llm.ts`: removed hardcoded key fallback, centralized redaction, added retry/backoff.
- `alaya-core/src/llm/provider.ts`: removed hardcoded key fallback.
- `alaya-app/server/externalFeedback.ts`: removed default token-file fallback.
- `alaya-app/server/scheduler.ts`: added per-project in-process tick concurrency guard.
- `alaya-app/server/storage.ts`: added PRAGMA table whitelist and safer row mapping.
- `alaya-app/server/knowledgeInjection.ts`: safer row mapping.
- `alaya-app/server/security/capabilities.ts`: startup-validated frozen network allowlist.
- `alaya-app/server/security/redact.ts`: broader token/private-key/database URL redaction.
- `scripts/setup-local-secrets.mjs`: writes local `0600` key files under `$HOME/.config/alaya` by default.
- `scripts/secret-scan.mjs`: expanded high-confidence secret patterns.
- `scripts/12h_validation.sh`, `scripts/24h_validation.sh`, `scripts/e2e-*.mjs`, `scripts/audit-upgrade-readiness.mjs`, `scripts/tests/live-readiness.test.mjs`: removed `/private/tmp` assumptions and updated key-file checks.
- `alaya-app/tests/security.http.test.ts`: API auth, metrics, headers, CORS and rate-limit coverage.
- `alaya-app/tests/routes.validation.test.ts`: write-route validation and human-gate decision coverage.
- `alaya-app/tests/scheduler.concurrency.test.ts`: overlapping tick skip coverage.
- `docs/ops/*.md`: updated baseline, env, deployment, backup, matrix, shadow-run, ledger and readiness docs.

## Audited But Not Reworked

- `PRINCIPLES.md`
- `docs/validation/VALIDATION_REPORT.md`
- `docs/PRD.md`
- `docs/architecture-review.md`
- `Dockerfile`, `.dockerignore`, `deploy/systemd/alaya.service`
- `alaya-app/server/flywheel.ts`
- `alaya-app/server/actionLedger.ts`
- `alaya-app/server/trace.ts`
- `alaya-app/server/observability/health.ts`
- `alaya-app/server/observability/metrics.ts`
- `alaya-app/server/knowledgeSimilarity.ts`
- `alaya-core/src/core/*`
- `alaya-app/shared/core/*`

## Old Audit Finding Status

| Area | Status |
|---|---|
| API auth | FIXED: `/api/*` uses API key/Bearer auth in long-run modes. |
| Hardcoded `/private/tmp` LLM/GitHub key paths | FIXED: active code/scripts use env or explicit key files. |
| CORS | FIXED: `ALAYA_CORS_ORIGINS` controls production-like origins. |
| Rate limits | FIXED: costly run-full and scheduler tick endpoints return 429 over threshold. |
| Security headers | FIXED: CSP, nosniff, frame deny, referrer policy, permissions policy, COOP and HSTS. |
| FTS5 query construction | PARTIAL: parameterized path verified; deeper escaping/fuzzing remains P2. |
| PRAGMA table interpolation | FIXED: table whitelist before PRAGMA. |
| Unused dependencies | FIXED: removed session/passport/Supabase packages. |
| Secret scan gaps | FIXED: scanner expanded and passes. |
| Docker digest pinning | DEFERRED: Node major tag pinned; digest pinning remains release follow-up. |
| GitHub token/action ledger leakage | FIXED: persistence boundaries redact secret-like values. |
| `/metrics` public exposure | FIXED: loopback/CIDR allowlist with guarded proxy trust. |
| Write-route schema validation | FIXED: predictions, knowledge, human gates and scheduler tick covered. |
| `ALAYA_ALLOWED_NETWORK_HOSTS` runtime risk | FIXED: parsed/validated once at startup. |
| Docker runtime ENV visibility | PARTIAL: only low-sensitivity defaults in image; real secrets injected outside image. |
| Route id validation | FIXED: `id` and `sourceId` constrained by regex/length. |
| Compose runtime hardening | FIXED: read-only rootfs, tmpfs, bounded writable volumes and no-new-privileges. |
| CI audit gate | FIXED: app/core high-severity npm audit added. |
| `rawDb` export | DEFERRED P2: still internal; needs broader data-layer migration. |
| Scheduler distributed lock | PARTIAL: in-process lock added; multi-replica lock remains P2. |
| Large modules / API versioning / core duplication / SQLite SPOF | DEFERRED: documented long-term architecture work. |

## Run Modes

- `development`: local debug, mock provider by default, API auth optional unless key or `ALAYA_REQUIRE_API_AUTH` is configured.
- `test`: deterministic tests, no real external services required by default.
- `shadow`: API auth required; demo seed disabled; mutating API writes dry-run or deny through capability gates; metrics restricted.
- `staging`: API auth required; demo seed disabled; high-risk capabilities denied unless explicitly enabled.
- `production`: fail-fast env validation, no demo seed, API auth required, high-risk capabilities off unless explicitly enabled.

## API Auth Model

`/api/*` accepts `Authorization: Bearer <ALAYA_API_KEY>` or `X-Alaya-API-Key`. Comparison uses Node `crypto.timingSafeEqual` over SHA-256 digests. `shadow`, `staging`, and `production` fail env validation when `ALAYA_API_KEY` is missing; the middleware still returns 503 as a defense-in-depth fallback if mounted without startup validation. Missing/wrong credentials return 401. `/healthz` and `/readyz` remain unauthenticated. `/metrics` uses source allowlist control instead of the API key middleware. The bundled UI supplies the key through a sidebar control backed by tab-scoped `sessionStorage`.

## Capability Gate Coverage

Capability gates still cover filesystem writes, shell execution, GitHub writes, database migration, unknown network calls, LLM calls, knowledge writes, scheduler loop and external notifications. Shadow write-like actions dry-run; staging/production deny unless explicitly enabled. Deny and dry-run decisions are persisted to `action_ledger` with redacted payloads.

Uncovered or deferred:

- No distributed scheduler lock for multi-replica deployment.
- No GitHub write adapter is enabled by default; any future write adapter must call the capability gate before executing.
- `rawDb` remains available internally and should be retired behind narrower storage methods later.

## Secrets, Env And Redaction

Secrets must come from env vars, explicit local key files or a future secret manager. Local temporary key files are under `$HOME/.config/alaya` with `0600` permissions when created by `npm run setup:secrets`; no values are stored in repo docs or tests.

Central redaction covers private key blocks, database URLs with credentials, emails, phone numbers, Authorization/Bearer/Cookie headers, AWS-style ids, OpenAI/GitHub/Slack-style tokens, and object keys containing token/secret/password/API key/private key/webhook/database URL.

GitHub token ledger verification:

- Dummy secret-like payload tests pass.
- `npm run secret:scan` passes after local secrets are present outside the repository.
- GitHub live E2E was not run because it creates/closes real remote issues; it remains opt-in.

## HTTP Controls

- CORS: `ALAYA_CORS_ORIGINS` in production-like modes; localhost dev origins only outside production-like modes.
- Headers: CSP without `unsafe-eval` in production-like modes, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, referrer/permissions/COOP and HSTS.
- Rate limits: `POST /api/cycles/:id/run-full` and `POST /api/scheduler/tick` use configurable per-client limits.
- Metrics: loopback-only by default with `ALAYA_METRICS_ALLOWED_CIDRS` for reviewed scrapers. `ALAYA_TRUST_PROXY=true` is required before trusting `X-Forwarded-For`.

## Input Validation

Covered endpoints:

- `POST /api/predictions`
- `PATCH /api/predictions/:id/observation`
- `PATCH /api/predictions/:id/error`
- `POST /api/knowledge`
- `PATCH /api/knowledge/:id`
- `POST /api/human-gates/:id/approve`
- `POST /api/human-gates/:id/reject`
- `POST /api/human-gates/:id/modify`
- `POST /api/scheduler/tick`
- Route params `:id` and `:sourceId`

Human gate decisions are derived from the route path, not trusted from body `decision`.

## Scheduler Concurrency

`schedulerTickProject()` now uses a per-project in-process guard. A concurrent tick returns a skipped result with `note: "tick_in_progress"`, records `scheduler_tick_skipped`, emits trace evidence and records a scheduler metric observation. After the first tick finishes, the next tick can run normally.

## Deployment Summary

Docker:

- Multi-stage `node:20-bookworm-slim` build/runtime.
- Non-root runtime user `alaya`.
- `.dockerignore` excludes `.env`, DB files, logs, backups, tmp/cache/coverage, `.git` and `node_modules`.
- Runtime command is `node dist/index.cjs`.

Compose shadow:

- `ALAYA_MODE=shadow`
- read-only root filesystem
- bounded state/log/cache volumes
- tmpfs for `/tmp`
- `security_opt: no-new-privileges:true`
- high-risk capabilities off or dry-run by default
- `ALAYA_API_KEY` injected from operator env, not baked into image

systemd:

- Uses `/etc/alaya/alaya.env` and low-privilege `alaya` user.
- Runtime state under `/var/lib/alaya`, logs under `/var/log/alaya`, cache under `/var/cache/alaya`.

## Health, Ready And Metrics

- `/healthz`: process liveness.
- `/readyz`: env/config validation, DB/schema readiness and writable path checks.
- `/metrics`: Prometheus text with uptime, mode, scheduler cycles/durations, actions, denials, capability denials, LLM requests/input/output tokens/cost, feedback items, knowledge injections, stalls, errors and last successful cycle timestamp.

Docker dynamic verification showed `/healthz` ok, `/readyz` ready, host `/metrics` 403 by default, and container loopback `/metrics` 200.

## Backup, Restore And Rollback

`npm run ops:backup` writes DB/WAL/SHM and a manifest under `tmp/alaya-backups/...` without secret values. `npm run ops:restore -- --backup <dir>` is dry-run unless `--confirm` is supplied. Long-run schema changes require an explicit migration window using `ALAYA_CAP_DATABASE_MIGRATION=true`; normal long-run startup validates schema readiness and does not silently run DDL.

Verified backup/restore dry-run path:

```bash
npm run ops:backup -- --out tmp/alaya-backups/verify-goal
npm run ops:restore -- --backup tmp/alaya-backups/verify-goal
```

## CI/CD And Validation

CI now includes tests, guard, secret scan, Docker/deploy-readiness coverage and app/core high-severity npm audit gates. Live LLM and GitHub E2E remain opt-in and do not run by default.

## Validation Results

| Command | Result |
|---|---|
| `npm install --package-lock=false` | PASS |
| `npm --prefix alaya-app install` | PASS |
| `npm --prefix alaya-core install` | PASS |
| `npm --prefix alaya-app run check` | PASS |
| Focused review-fix security/env/redaction test command | PASS, 16/16 |
| `npm --prefix alaya-app test` | PASS, 104/104 |
| `npm --prefix alaya-core test` | PASS, 50/50 |
| `npm run test:scripts` | PASS, 18/18 |
| `npm run test:all` | PASS |
| `npm run typecheck` | PASS |
| `npm run guard` | PASS, 17/17 |
| `npm run secret:scan` | PASS |
| `npm --prefix alaya-app audit --audit-level=high` | PASS, 0 vulnerabilities |
| `npm --prefix alaya-core audit --audit-level=high` | PASS, 0 vulnerabilities |
| `npm run build` | PASS, existing PostCSS `from` warning only |
| `npm --prefix alaya-app run build` | PASS, same PostCSS warning |
| `npm --prefix alaya-core run build` | N/A, no core build script |
| `npm run lint` | N/A, no root lint script |
| `npm run benchmark:smoke` | PASS, 7/7 |
| `npm run flywheel` | PASS |
| `npm run e2e:llm` with local key file and MiniMax-compatible config | PASS, schema valid, retry count 0, no key printed |
| `npm run audit:upgrade` with local key-file envs | PASS, 13/13 |
| `npm run setup:secrets:check` | PASS, local files exist with `0600` |
| `npm run ops:pre-upgrade` | PASS |
| `npm run ops:backup` / `npm run ops:restore` dry-run | PASS |
| `npm run ops:post-upgrade` | PASS; HTTP probes skipped because `ALAYA_BASE_URL` unset |
| `npm run shadow:report -- --out tmp/shadow-report-goal.md` | PASS |
| `docker build -t alaya:local .` | PASS |
| `docker image inspect alaya:local --format ...` | PASS, runtime user `alaya` |
| `docker compose -f deploy/docker-compose.shadow.yml config` | PASS |
| Docker migration + shadow up + health/ready/auth/metrics probes | PASS |

Failed or not run:

- Interim `npm --prefix alaya-app test`: failed once because `capabilityGate.test.ts` used shadow mode without a test API key; fixed by setting a test-only key and rerun passed 104/104.
- `npm --prefix alaya-core run build`: `N/A`, package has no `build` script; typecheck is the substitute.
- `npm run lint`: `N/A`, root has no `lint` script; tests/typecheck/guard are substitutes.
- GitHub live E2E: not run because scripts create/close real GitHub issues.
- 7-day shadow run: not run; this report recommends starting it.

## Remaining Risks

| Severity | Risk | Current handling |
|---|---|---|
| P0 | None known after local verification. | Keep CI and shadow run gates active. |
| P1 | GitHub live E2E not executed in this pass. | Run only in a controlled window with scoped token and hardened API auth. |
| P2 | `rawDb` internal export can bypass higher-level storage conventions. | Plan follow-up data-layer encapsulation. |
| P2 | Docker base not pinned by SHA digest. | Pin in release engineering after architecture/CI validation. |
| P2 | Scheduler lock is in-process only. | Add DB/distributed lock before multi-replica deployment. |
| P2 | FTS escaping/fuzzing and knowledge similarity scaling need deeper work. | Add fuzz tests and vector/index work later. |
| P2 | SQLite backup is safest when service is stopped or WAL checkpointed. | Use documented pre-upgrade procedure. |

## Shadow Run Recommendation

Recommendation: enter a 7-day shadow run.

Rationale: P0/P1 hardening gates are connected to runtime paths and verified locally: `/api/*` is authenticated in long-run modes, secrets are redacted and scanned, metrics are not public by default, costly endpoints are rate-limited, scheduler overlap is guarded, major write routes validate input, Docker shadow starts and probes successfully, backup/restore dry-run passes, and `npm run test:all` plus `npm run guard` pass.

Entry conditions:

- Set `ALAYA_API_KEY` from a local secret file or secret manager.
- Keep GitHub writes, shell execution and external notifications disabled.
- Keep `ALAYA_CAP_KNOWLEDGE_WRITE=dry_run` unless using a disposable shadow DB.
- If real LLM is enabled, set a daily cost budget and `ALAYA_CAP_LLM_CALL=true`.
- Scrape `/metrics` only from loopback/container-local or a reviewed `ALAYA_METRICS_ALLOWED_CIDRS` source.
- Follow [05-shadow-run-7d.md](/Users/peachy/Documents/alaya/docs/ops/05-shadow-run-7d.md).
