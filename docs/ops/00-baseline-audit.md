# Alaya Baseline Audit

Date: 2026-06-06

## Environment

- Branch: `main`
- Commit: `c12c4c15e242b7171e0cefbad286380f6f95d8fd`
- Node: `v22.22.1`
- npm: `10.9.4`
- OS: `Darwin peachydeMac-mini.local 25.5.0 arm64`

## Project Structure

```text
.
├── alaya-core/      # Pure TypeScript core, LLM provider abstraction, numeric tests
├── alaya-app/       # Express + React + SQLite app, scheduler, LLM adapter, trace, ledger
├── scripts/         # validation, E2E, benchmark, readiness and ops scripts
├── benchmarks/      # deterministic smoke cases
├── docs/            # validation and ops docs
├── examples/        # rollback-ready package examples
└── .github/         # CI and principles guard workflows
```

## Runtime Entry Points

- Development app: `npm run dev` -> `npm --prefix alaya-app run dev`.
- Production app: `npm run start` -> `npm --prefix alaya-app run start`.
- Server entry: `alaya-app/server/index.ts`.
- API routes: `alaya-app/server/routes.ts`.
- Scheduler: `alaya-app/server/scheduler.ts`.
- Flywheel engine: `alaya-app/server/flywheel.ts`.
- Storage, explicit schema migration and readiness checks: `alaya-app/server/storage.ts`, `alaya-app/server/migrate.ts`.

## Key Module Responsibilities

- `alaya-app/server/actionLedger.ts`: high-risk action proposal ledger and approval gate integration.
- `alaya-app/server/trace.ts`: OTel-like trace event persistence.
- `alaya-app/server/llm.ts`: app-side mock/OpenAI-compatible LLM boundary and call logging.
- `alaya-app/server/externalFeedback.ts`: GitHub issue/form feedback ingestion with redaction.
- `alaya-app/server/knowledgeInjection.ts`: FTS5 active/strong knowledge injection before LLM calls.
- `alaya-app/server/flywheelHealth.ts`: flywheel health aggregation.
- `alaya-core/src/core/*` and `alaya-app/shared/core/*`: pure functions protected by `PRINCIPLES.md`.

## Existing Validation Assets

- Root: `npm run test:all`, `npm run typecheck`, `npm run build`, `npm run guard`.
- App: `npm --prefix alaya-app test`, `npm --prefix alaya-app run check`.
- Core: `npm --prefix alaya-core test`, `npm --prefix alaya-core run typecheck`, `npm --prefix alaya-core run flywheel`.
- Long-run and smoke: `npm run e2e:long-evolution`, `npm run benchmark:smoke`, `scripts/12h_validation.sh`, `scripts/24h_validation.sh`.
- CI: `.github/workflows/ci.yml`, `.github/workflows/principles-guard.yml`.

## Long-Run Deployment Gaps Found

- No root `Dockerfile`, shadow compose, or systemd unit existed.
- No explicit `development/test/shadow/staging/production` mode contract existed.
- Production env validation did not fail fast on missing DB path or placeholder secrets.
- API logging summarized JSON responses without centralized secret redaction.
- Capability controls were implicit in human gates and action risk, not mode-aware.
- `/healthz`, `/readyz`, and `/metrics` endpoints were missing.
- Backup/restore and upgrade verification scripts were missing.
- CI lacked secret scan, Docker build, deploy-readiness and shadow-mode checks.

## Planned Modification Boundary

Code and config files planned for modification/addition:

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
- `alaya-app/tests/*hardening*.test.ts` and focused ops tests
- `Dockerfile`, `.dockerignore`, `deploy/*`
- `scripts/*state*.mjs`, `scripts/*upgrade*.mjs`, `scripts/secret-scan.mjs`, `scripts/shadow-run-report.mjs`
- `.github/workflows/ci.yml`, `.github/workflows/deploy-readiness.yml`
- `docs/ops/*.md`

Core pure functions are intentionally out of scope for this hardening pass.
