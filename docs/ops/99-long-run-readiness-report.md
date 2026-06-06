# Alaya Long-Run Readiness Report

Date: 2026-06-06

## Summary

This hardening pass added run-mode env validation, centralized secret redaction, capability gates with action ledger audit, shadow-mode dry-run protection, health/readiness/metrics endpoints, backup/restore scripts, Docker/systemd deployment assets, deploy-readiness CI, and operational documentation.

Cross-verification evidence is maintained in `docs/ops/98-verification-ledger.md`.

## Modified Files

- `Dockerfile`
- `README.md`
- `.dockerignore`
- `.github/workflows/ci.yml`
- `.github/workflows/deploy-readiness.yml`
- `deploy/docker-compose.shadow.yml`
- `deploy/env/alaya.env.example`
- `deploy/systemd/alaya.service`
- `alaya-app/server/config/env.ts`
- `alaya-app/server/security/redact.ts`
- `alaya-app/server/security/capabilities.ts`
- `alaya-app/server/observability/health.ts`
- `alaya-app/server/observability/metrics.ts`
- `alaya-app/server/index.ts`
- `alaya-app/server/routes.ts`
- `alaya-app/server/llm.ts`
- `alaya-app/server/externalFeedback.ts`
- `alaya-app/server/scheduler.ts`
- `alaya-app/server/storage.ts`
- `alaya-app/server/migrate.ts`
- `alaya-app/server/actionLedger.ts`
- `alaya-app/server/trace.ts`
- `alaya-app/shared/schema.ts`
- `alaya-app/client/src/lib/alaya.ts`
- `alaya-app/client/src/pages/Ledger.tsx`
- `alaya-app/script/build.ts`
- `alaya-app/package.json`
- `alaya-app/tests/env.validation.test.ts`
- `alaya-app/tests/evidence_trace.test.ts`
- `alaya-app/tests/secret.redaction.test.ts`
- `alaya-app/tests/capabilityGate.test.ts`
- `alaya-app/tests/shadowMode.test.ts`
- `alaya-app/tests/healthMetrics.test.ts`
- `scripts/secret-scan.mjs`
- `scripts/backup-state.mjs`
- `scripts/restore-state.mjs`
- `scripts/pre-upgrade-check.mjs`
- `scripts/post-upgrade-verify.mjs`
- `scripts/shadow-run-report.mjs`
- `package.json`
- `docs/ops/*.md`

## Audited But Not Reworked

- `PRINCIPLES.md`
- `VALIDATION_REPORT.md`
- `Alaya_PRD.md`
- `Alaya_实现方案与架构评审.md`
- `alaya-app/server/flywheel.ts`
- `alaya-app/server/knowledgeInjection.ts`
- `alaya-core/src/core/*`

## Run Modes

`development`, `test`, `shadow`, `staging`, and `production` are now explicit. Long-run modes default-deny high-risk capabilities. Shadow mutating API requests dry-run before handler execution; staging and production mutating API requests are rejected unless their capability is explicitly enabled.

## Secrets And Permissions

Secrets are validated in production, redacted from logs, traces, event logs and ledger payloads, and scanned by `npm run secret:scan`. Capability flags cover filesystem writes, shell, GitHub writes, DB migration, unknown network, LLM calls, knowledge writes, scheduler loop and external notifications.

## Deployment

Docker shadow compose and systemd assets are available. Docker runs as non-root, uses Node 20, excludes `.env`, and uses isolated writable volumes.

## Health And Metrics

- `/healthz`: liveness.
- `/readyz`: config, DB and writable directory readiness.
- `/metrics`: Prometheus-style metrics with scheduler, action, denial, LLM, cost, feedback, knowledge injection, stall, error and last-success fields.

## Backup And Rollback

`npm run ops:backup` creates a DB/state backup without secret values. `npm run ops:restore -- --backup <dir>` is dry-run by default and requires `--confirm` to write. Long-run schema migration is explicit through `npm run ops:migrate` or container `node dist/migrate.cjs` with `ALAYA_CAP_DATABASE_MIGRATION=true`; steady-state startup validates schema readiness and keeps migration disabled.

## Validation Results

Passed:

| Command | Result |
|---|---|
| `npm run secret:scan` | PASS, no high-confidence secrets found |
| `npm --prefix alaya-core test` | PASS, 50/50 |
| `npm --prefix alaya-app test` | PASS, 92/92 |
| `npm run test:scripts` | PASS, 18/18 |
| `npm run test:all` | PASS, core + app + scripts |
| `npm run typecheck` | PASS |
| `npm --prefix alaya-app run check` | PASS |
| `npm --prefix alaya-core run typecheck` | PASS |
| `npm run guard` | PASS, 17/17 principles checks |
| `npm run build` | PASS, with existing PostCSS `from` warning |
| `npm run benchmark:smoke` | PASS, 7/7 benchmark cases |
| `npm run flywheel` | PASS, 4-cycle mock flywheel accepted |
| `npm run e2e:long-evolution` | PASS, 20 cycles |
| `npm run ops:pre-upgrade` | PASS |
| `npm run ops:backup -- --out tmp/alaya-backups/verify-backup` | PASS, copied DB/WAL/SHM |
| `npm run ops:restore -- --backup tmp/alaya-backups/verify-backup` | PASS dry-run, no restore performed |
| `npm run ops:post-upgrade` | PASS; guard/core tests passed, HTTP probes skipped because `ALAYA_BASE_URL` was unset |
| `npm run shadow:report -- --out tmp/shadow-report-cross.md` | PASS; output file was written, then removed after verification |
| `docker compose -f deploy/docker-compose.shadow.yml config` | PASS |
| `docker build -t alaya:local .` | PASS |
| `docker image inspect alaya:local --format ...` | PASS; runtime user is `alaya` |
| `ALAYA_SHADOW_PORT=5055 docker compose -f deploy/docker-compose.shadow.yml up -d --no-build` + `curl /healthz /readyz /metrics` | PASS; health ok, ready ok, metrics emitted |
| Shadow container `POST /api/knowledge` + `/api/action-ledger?limit=5` | PASS; write returned `202 dry_run`, ledger recorded `capability.knowledge_write` |

Docker shadow runtime result:

- `/healthz`: `status=ok`, `mode=shadow`.
- `/readyz`: `status=ready`, config/database/writable volume checks ok.
- `/metrics`: emitted scheduler, action, denial, LLM input/output token, cost, feedback, knowledge injection, stall, error and last-success metrics.
- Compose service was shut down after verification.

Not run:

- Real LLM / GitHub live E2E. These require explicit real secrets and are intentionally opt-in.

## Remaining Risks

- SQLite backup consistency is strongest when the service is stopped or WAL is checkpointed.
- The current GitHub path is read-oriented; any future GitHub write adapter must call the capability gate before execution.

## Recommendation

Recommendation: enter a 7-day shadow run.

Rationale: the required hardening checks passed locally, Docker shadow compose starts successfully on an alternate host port, shadow mode dry-run behavior is tested, production-like env validation fails fast, health/readiness/metrics are available, and high-risk capabilities default to deny or dry-run in long-run modes.
