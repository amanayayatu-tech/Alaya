# Alaya Baseline Audit

Date: 2026-06-06

This baseline was rechecked against the current local repository before applying this hardening pass. The two upstream audit inputs disagreed on commit and severity, so the status below is based on the current working tree and command evidence in [98-verification-ledger.md](/Users/peachy/Documents/alaya/docs/ops/98-verification-ledger.md).

## Environment

- Repository root: `/Users/peachy/Documents/alaya`
- Branch: `main`
- Current HEAD: `d9ec48069529ac491b143aa57777fa4c085c6cc1`
- Git status: intentionally dirty with this uncommitted hardening pass.
- Node: `v22.22.1`
- npm: `10.9.4`
- OS: `Darwin peachydeMac-mini.local 25.5.0 arm64`
- Package roots: `package.json`, `alaya-core/package.json`, `alaya-app/package.json`

## Project Structure

```text
.
├── alaya-core/      # Pure TypeScript core, LLM provider abstraction, numeric tests
├── alaya-app/       # Express + React + SQLite app, scheduler, LLM adapter, trace, ledger
├── scripts/         # validation, E2E, benchmark, readiness and ops scripts
├── benchmarks/      # deterministic smoke cases
├── docs/ops/        # deployment, validation, shadow-run and readiness docs
├── deploy/          # shadow compose, env examples and systemd unit
├── examples/        # rollback-ready package examples
├── Dockerfile       # multi-stage app image
└── .github/         # CI, deploy-readiness and principles guard workflows
```

## Runtime Entry Points

- Development app: `npm run dev` -> `npm --prefix alaya-app run dev`.
- Production app: `npm run start` -> `npm --prefix alaya-app run start`.
- Build: `npm run build` -> `npm --prefix alaya-app run build`.
- Server entry: `alaya-app/server/index.ts`.
- API routes: `alaya-app/server/routes.ts`.
- API auth and metrics access control: `alaya-app/server/security/auth.ts`.
- CORS, security headers and cost endpoint rate limits: `alaya-app/server/security/http.ts`.
- Scheduler: `alaya-app/server/scheduler.ts`.
- Flywheel engine: `alaya-app/server/flywheel.ts`.
- Storage, schema readiness and migration: `alaya-app/server/storage.ts`, `alaya-app/server/migrate.ts`.

## Key Module Responsibilities

- `alaya-app/server/config/env.ts`: run mode, fail-fast env validation and production-like safety posture.
- `alaya-app/server/actionLedger.ts`: high-risk action proposal ledger and approval gate integration.
- `alaya-app/server/trace.ts`: OTel-like trace event persistence.
- `alaya-app/server/llm.ts`: app-side mock/OpenAI-compatible LLM boundary, retry/backoff, call logging and redaction.
- `alaya-core/src/llm/provider.ts`: core OpenAI-compatible LLM provider boundary.
- `alaya-app/server/externalFeedback.ts`: GitHub issue/form feedback ingestion with redaction.
- `alaya-app/server/knowledgeInjection.ts`: FTS5 active/strong knowledge injection before LLM calls.
- `alaya-app/server/security/capabilities.ts`: mode-aware capability decisions and audit trail.
- `alaya-app/server/security/redact.ts`: centralized recursive data/text redaction.
- `alaya-app/server/observability/health.ts`: liveness/readiness checks and Prometheus metrics source data.
- `alaya-core/src/core/*` and `alaya-app/shared/core/*`: pure functions protected by `PRINCIPLES.md`.

## Existing Validation Assets

- Root: `npm run test:all`, `npm run typecheck`, `npm run build`, `npm run guard`, `npm run secret:scan`.
- App: `npm --prefix alaya-app test`, `npm --prefix alaya-app run check`, `npm --prefix alaya-app run build`.
- Core: `npm --prefix alaya-core test`, `npm --prefix alaya-core run typecheck`, `npm --prefix alaya-core run flywheel`.
- Long-run and smoke: `npm run e2e:long-evolution`, `npm run benchmark:smoke`, `scripts/12h_validation.sh`, `scripts/24h_validation.sh`.
- Ops: `npm run ops:pre-upgrade`, `npm run ops:backup`, `npm run ops:restore`, `npm run ops:post-upgrade`, `npm run shadow:report`.
- CI: `.github/workflows/ci.yml`, `.github/workflows/deploy-readiness.yml`, `.github/workflows/principles-guard.yml`.

## Audit Finding Status

| ID | Finding | Current Status | Evidence |
|---|---|---|---|
| SEC-A01 / SEC-B01 | `/api/*` had no identity authentication. | FIXED | `apiAuthMiddleware` is mounted on `/api`; long-run modes require `ALAYA_API_KEY`; tests cover no key, wrong key and valid Bearer key. |
| SEC-A02 | Hardcoded `/private/tmp/alaya-minimax-key` fallback. | FIXED | App/core LLM providers and scripts now use only env or explicit key-file env; repo grep excludes historical validation logs and finds no active hardcoded fallback. |
| SEC-A03 | No CORS policy. | FIXED | `corsMiddleware` enforces `ALAYA_CORS_ORIGINS` in production-like modes and allows local dev origins only outside production-like modes. |
| SEC-A04 | Costly endpoints had no rate limit. | FIXED | `POST /api/cycles/:id/run-full` and `POST /api/scheduler/tick` use `costEndpointRateLimit`; tests cover 429 behavior. |
| SEC-A05 | Missing security response headers. | FIXED | `securityHeadersMiddleware` sets CSP, `X-Content-Type-Options`, `X-Frame-Options`, Referrer Policy, Permissions Policy, COOP and HSTS in production-like modes. |
| SEC-A06 | FTS5 query construction needed verification. | PARTIAL | Existing query path is parameterized; full FTS escaping/fuzzing remains a P2 follow-up. |
| SEC-A07 | Dynamic `PRAGMA table_info(${table})`. | FIXED | `storage.ts` now validates table names against `REQUIRED_TABLE_SET` before PRAGMA calls. |
| SEC-A08 | Unused auth/session/Supabase dependencies. | FIXED | Removed unused `passport`, `passport-local`, `express-session`, `memorystore`, `@supabase/supabase-js` and related types; app build allowlist updated. |
| SEC-A09 | Secret scan coverage gaps. | FIXED | Scanner now covers MiniMax/OpenAI-like keys, GitHub tokens, bearer tokens, database URLs, cookies and private keys; `npm run secret:scan` passes. |
| SEC-A10 | Docker base not pinned by digest. | DEFERRED | Docker uses pinned Node major `node:20-bookworm-slim`; digest pinning is retained as P2 supply-chain follow-up because it needs release/architecture review. |
| SEC-B02 | GitHub token could enter action ledger. | FIXED | Central redaction applies before ledger/trace/event persistence; tests cover secret-like payloads and dummy tokens. |
| SEC-B03 | `/metrics` had no access control. | FIXED | Metrics defaults to loopback only, supports explicit CIDR allowlist, and only trusts `X-Forwarded-For` when `ALAYA_TRUST_PROXY=true`; Docker host negative probe returned 403. |
| SEC-B04 | Main write routes lacked schema validation. | FIXED | Added Zod validation for predictions, knowledge, human gates and scheduler tick; invalid payloads return 400. |
| SEC-B05 | `ALAYA_ALLOWED_NETWORK_HOSTS` runtime injection risk. | FIXED | Allowed hosts are parsed and validated once at startup into a non-exported frozen set. |
| SEC-B06 | Dockerfile runtime ENV visibility. | PARTIAL | Runtime env remains low-sensitivity defaults only; docs call out that real secrets and API keys must come from compose/env files, not image layers. |
| SEC-B07 | `req.params.id` had no format/length filter. | FIXED | Route params `id` and `sourceId` are constrained with `/^[A-Za-z0-9_-]{1,160}$/`. |
| SEC-B08 | Compose lacked `no-new-privileges`. | FIXED | Shadow compose sets read-only rootfs, tmpfs, bounded writable volumes and `security_opt: no-new-privileges:true`. |
| SEC-B09 | CI lacked npm audit gate. | FIXED | CI and deploy-readiness run app/core `npm audit --audit-level=high`. |
| ARCH-01 | `storage.ts` exports `rawDb`. | DEFERRED | Still present for current internals/tests; documented as P2 because removing it safely is a broader data-layer migration. |
| ARCH-02 | No API versioning. | DEFERRED | Documented as future compatibility work. |
| ARCH-03 | Express/Drizzle version risk. | REVIEWED | Existing test/build coverage passes; monitor upgrades through CI. |
| ARCH-04 | `alaya-core` and app shared core duplication. | DEFERRED | Protected by guard/tests; workspace boundary cleanup remains future work. |
| ARCH-05 | SQLite SPOF. | ACCEPTED | Backup/restore and shadow docs cover current single-node design; horizontal scale needs future storage architecture. |
| ARCH-06 | Scheduler has no distributed lock. | PARTIAL | Added in-process per-project concurrency guard; multi-replica/distributed lock remains P2. |
| ARCH-07 | Large modules. | DEFERRED | No broad refactor in this pass; tests added around risky surfaces. |
| ARCH-08 | `@shared` boundary ambiguity. | DEFERRED | No change in this pass. |
| ARCH-09 | Possible in-memory/SQLite consistency drift. | REVIEWED | No new broad data model changes; event/ledger paths remain SQLite-backed. |
| QUAL-01 | `rowToKnowledge(any)`. | FIXED | Mapping now accepts `unknown` and asserts object shape. |
| QUAL-02 | Route error handling inconsistencies. | PARTIAL | New validation paths return structured 400; full async wrapper standardization remains future work. |
| QUAL-03 | Duplicate redaction in `llm.ts`. | FIXED | `llm.ts` imports centralized redaction. |
| QUAL-04 | JSON text parsing drift. | PARTIAL | `parseJsonFields` now logs warning on parse failure; full schema normalization remains P2. |
| QUAL-05 | Mixed timestamp formats. | DEFERRED | No broad migration in this pass. |
| QUAL-06 | Silent `parseJsonFields` catch. | FIXED | Warns with field context now. |
| QUAL-07 | Human gate decision trusted body. | FIXED | Decision is derived from route path; body decision is ignored. |
| QUAL-08 | LLM retry/backoff missing. | FIXED | OpenAI-compatible app LLM calls retry 429/5xx with bounded exponential backoff. |
| QUAL-09 | Knowledge similarity O(n). | DEFERRED | Long-term vector/index optimization. |
| TEST-01 | Core routes lacked HTTP integration tests. | FIXED | Added security, validation, env, redaction and scheduler concurrency tests; app suite now covers 104 tests. |
| TEST-02 | Live readiness can skip network. | ACCEPTED | Live tests remain opt-in; mock/default CI path is deterministic. |
| TEST-03 | No mutation/coverage gate. | DEFERRED | P2 follow-up. |
| TEST-04 | Missing auth/rate/scheduler/security tests. | FIXED | Added focused HTTP security, route validation and scheduler concurrency suites. |

## Modification Boundary

Files changed in this pass are limited to API/security middleware, env/deployment examples, LLM/secrets paths, scheduler concurrency, storage safety, dependency metadata, CI/audit gates, ops scripts, tests and ops docs. Core pure algorithms were not reworked.

## Strategy

The pass used minimal connected fixes over large refactors: add authentication before capability checks, keep capability gates intact, redact at persistence boundaries, make long-run modes fail safe, rate-limit costly actions, protect metrics, add negative tests, and document remaining architectural risks instead of hiding them.
