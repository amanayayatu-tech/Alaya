# Secrets And Environment

Alaya must receive real secrets only through environment variables, local secret files, or a future secret manager. Do not commit `.env`, key files, shell history snippets, or test snapshots containing real values.

## Run Modes

`ALAYA_MODE` accepts:

- `development`: local debug, mock provider by default.
- `test`: deterministic tests, no real external services required.
- `shadow`: reads approved inputs but mutating API calls dry-run by default; demo seed must be disabled.
- `staging`: controlled writes only through explicit capability flags; demo seed must be disabled.
- `production`: fail-fast env validation, no demo seed, high-risk capabilities off unless explicitly enabled.

If `ALAYA_MODE` is unset, `NODE_ENV=test` maps to `test`, `NODE_ENV=production` maps to `production`, otherwise Alaya uses `development`.

## Required Variables

| Variable | Modes | Purpose | Permission Scope | Safe Example |
|---|---|---|---|---|
| `ALAYA_MODE` | all | Runtime mode | Defines safety posture | `shadow` |
| `NODE_ENV` | container/prod | Node runtime mode | Build/runtime behavior | `production` |
| `ALAYA_DB_PATH` | staging/production/shadow | SQLite state path | Local state write only | `/var/lib/alaya/alaya.db` |
| `ALAYA_API_KEY` | shadow/staging/production | API Bearer key for `/api/*` | Authenticate HTTP API clients | `read-from-secret-manager` |
| `ALAYA_AUTO_SEED_DEMO` | shadow/staging/production | Must be disabled in long-run modes | Prevents demo data writes | `false` |

## Optional Variables

| Variable | Purpose | Notes |
|---|---|---|
| `PORT`, `HOST` | HTTP bind address | Default `5000`, `0.0.0.0` |
| `ALAYA_SCHEDULER` | Enable background scheduler | Set `false` unless reviewed |
| `ALAYA_SCHEDULER_INTERVAL_MS` | Scheduler interval | Default `60000` |
| `ALAYA_ALLOWED_NETWORK_HOSTS` | Additional allowed external hosts | Comma-separated hostnames |
| `ALAYA_CORS_ORIGINS` | Allowed browser origins | Required for production browser clients |
| `ALAYA_METRICS_ALLOWED_CIDRS` | Extra `/metrics` source allowlist | Loopback is always allowed; only trust proxy headers when `ALAYA_TRUST_PROXY=true` |
| `ALAYA_TRUST_PROXY` | Trust `X-Forwarded-For` for metrics allowlist | Default false |
| `ALAYA_COST_RATE_LIMIT_WINDOW_MS` | Rate-limit window for costly endpoints | Default `60000` |
| `ALAYA_COST_RATE_LIMIT_MAX` | Costly endpoint request limit per window | Default `10` |
| `ALAYA_DATA_DIR`, `ALAYA_LOG_DIR`, `ALAYA_STATE_DIR`, `ALAYA_CACHE_DIR` | Writable paths | Used by container/systemd readiness |

## LLM Variables

| Variable | Purpose | Permission Scope |
|---|---|---|
| `ALAYA_LLM_PROVIDER` | `mock` or `openai` | Real LLM calls only when `openai` |
| `OPENAI_API_KEY` | OpenAI-compatible API key | LLM calls only, no repository write |
| `OPENAI_API_KEY_FILE` | Local key file path | Preferred for local runs |
| `OPENAI_BASE_URL` | OpenAI-compatible base URL | Must be in allowed network hosts in long-run modes |
| `OPENAI_MODEL` | Model name | Cost and latency impact |
| `OPENAI_MAX_RETRIES` | Retry budget for 429/5xx | Default `3`, bounded |
| `OPENAI_RETRY_BASE_MS` | Initial retry backoff | Default `2000` |

## GitHub Variables

| Variable | Purpose | Permission Scope |
|---|---|---|
| `ALAYA_GITHUB_TOKEN` | GitHub sensor token | Read issues by default; avoid write scopes |
| `ALAYA_GITHUB_TOKEN_FILE` | Local token file | Preferred for local runs |
| `GITHUB_TOKEN_FILE` | Compatibility token file | Read by E2E scripts |

Use a GitHub token with the narrowest possible repository scope. The current app reads GitHub Issues; production write operations are not enabled by default.

For local temporary use, prefer:

```bash
npm run setup:secrets
npm run setup:secrets:check
```

The helper writes `0600` files under `$HOME/.config/alaya` by default and does not write values into the repository. Override with `ALAYA_SECRETS_DIR`, `OPENAI_API_KEY_FILE`, `ALAYA_GITHUB_TOKEN_FILE`, or `GITHUB_TOKEN_FILE` when needed.

## API Auth

All `/api/*` routes require `Authorization: Bearer <ALAYA_API_KEY>` or `X-Alaya-API-Key: <ALAYA_API_KEY>` in `shadow`, `staging`, and `production`. `development` and `test` can run without auth only when no API key is configured and `ALAYA_REQUIRE_API_AUTH` is not set.

The bundled React UI has an `API Key` control in the sidebar. It stores the key in browser `sessionStorage` for the current tab and injects `Authorization: Bearer ...` into all app API calls. Do not bake `ALAYA_API_KEY` into the frontend bundle.

`/healthz` and `/readyz` are public liveness/readiness endpoints. `/metrics` is not public; it is controlled by source IP/CIDR instead of the API key middleware.

## Metrics Access

`/metrics` defaults to loopback only: `127.0.0.1` and `::1`. Add explicit sources through:

```bash
ALAYA_METRICS_ALLOWED_CIDRS=10.0.0.0/8,192.168.1.10
```

Do not enable `ALAYA_TRUST_PROXY=true` unless Alaya is behind a trusted reverse proxy that overwrites `X-Forwarded-For`. Without that flag, spoofed forwarded headers are ignored.

## Capability Flags

Every high-risk capability is default-deny in `staging` and `production`. In `shadow`, write-like capabilities default to dry-run.

| Capability Env | Covers | Default Long-Run Behavior |
|---|---|---|
| `ALAYA_CAP_FILESYSTEM_WRITE` | local file writes | deny |
| `ALAYA_CAP_SHELL_EXECUTION` | shell commands | deny |
| `ALAYA_CAP_GITHUB_WRITE` | issue/PR/comment/merge writes | deny |
| `ALAYA_CAP_DATABASE_MIGRATION` | explicit schema migration window | deny unless explicitly true |
| `ALAYA_CAP_NETWORK_UNKNOWN` | unknown external host requests | deny |
| `ALAYA_CAP_LLM_CALL` | real LLM provider calls | deny |
| `ALAYA_CAP_KNOWLEDGE_WRITE` | memory/knowledge writes | shadow dry-run |
| `ALAYA_CAP_SCHEDULER_LOOP` | background scheduler | deny |
| `ALAYA_CAP_EXTERNAL_NOTIFICATION` | outbound notifications | deny |

Accepted values are `true`, `false`, and `dry_run`.

## Redaction

Runtime logs, error handler output, trace attributes, event-log before/after snapshots and action ledger payloads use centralized redaction for:

- `Authorization` bearer tokens.
- `Cookie` and `Set-Cookie`.
- GitHub, Slack and OpenAI-style tokens.
- AWS access key IDs.
- database URLs containing username/password.
- private key blocks.
- object keys containing token, secret, password, API key, private key, webhook secret or database URL.

## Long-Run Fail-Fast Rules

Long-run modes fail when:

- `ALAYA_DB_PATH` is missing in staging or production.
- `ALAYA_API_KEY` is missing in `shadow`, `staging`, or `production`.
- `ALAYA_AUTO_SEED_DEMO` is not `false` in `shadow`, `staging`, or `production`.
- real LLM provider is configured in production without `ALAYA_CAP_LLM_CALL=true`.
- obvious placeholder/test secret values such as `changeme`, `test-secret`, `demo-key`, `fake`, or empty strings appear in secret-like env vars.

Run:

```bash
npm run secret:scan
npm --prefix alaya-app run test -- tests/env.validation.test.ts tests/secret.redaction.test.ts
```
