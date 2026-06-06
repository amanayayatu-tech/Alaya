# Secrets And Environment

Alaya must receive real secrets only through environment variables, local secret files, or a future secret manager. Do not commit `.env`, key files, shell history snippets, or test snapshots containing real values.

## Run Modes

`ALAYA_MODE` accepts:

- `development`: local debug, mock provider by default.
- `test`: deterministic tests, no real external services required.
- `shadow`: reads approved inputs but mutating API calls dry-run by default.
- `staging`: controlled writes only through explicit capability flags.
- `production`: fail-fast env validation, no demo seed, high-risk capabilities off unless explicitly enabled.

If `ALAYA_MODE` is unset, `NODE_ENV=test` maps to `test`, `NODE_ENV=production` maps to `production`, otherwise Alaya uses `development`.

## Required Variables

| Variable | Modes | Purpose | Permission Scope | Safe Example |
|---|---|---|---|---|
| `ALAYA_MODE` | all | Runtime mode | Defines safety posture | `shadow` |
| `NODE_ENV` | container/prod | Node runtime mode | Build/runtime behavior | `production` |
| `ALAYA_DB_PATH` | staging/production/shadow | SQLite state path | Local state write only | `/var/lib/alaya/alaya.db` |
| `ALAYA_AUTO_SEED_DEMO` | production | Must be disabled in production | Prevents demo data writes | `false` |

## Optional Variables

| Variable | Purpose | Notes |
|---|---|---|
| `PORT`, `HOST` | HTTP bind address | Default `5000`, `0.0.0.0` |
| `ALAYA_SCHEDULER` | Enable background scheduler | Set `false` unless reviewed |
| `ALAYA_SCHEDULER_INTERVAL_MS` | Scheduler interval | Default `60000` |
| `ALAYA_ALLOWED_NETWORK_HOSTS` | Additional allowed external hosts | Comma-separated hostnames |
| `ALAYA_DATA_DIR`, `ALAYA_LOG_DIR`, `ALAYA_STATE_DIR`, `ALAYA_CACHE_DIR` | Writable paths | Used by container/systemd readiness |

## LLM Variables

| Variable | Purpose | Permission Scope |
|---|---|---|
| `ALAYA_LLM_PROVIDER` | `mock` or `openai` | Real LLM calls only when `openai` |
| `OPENAI_API_KEY` | OpenAI-compatible API key | LLM calls only, no repository write |
| `OPENAI_API_KEY_FILE` | Local key file path | Preferred for local runs |
| `OPENAI_BASE_URL` | OpenAI-compatible base URL | Must be in allowed network hosts in long-run modes |
| `OPENAI_MODEL` | Model name | Cost and latency impact |

## GitHub Variables

| Variable | Purpose | Permission Scope |
|---|---|---|
| `ALAYA_GITHUB_TOKEN` | GitHub sensor token | Read issues by default; avoid write scopes |
| `ALAYA_GITHUB_TOKEN_FILE` | Local token file | Preferred for local runs |
| `GITHUB_TOKEN_FILE` | Compatibility token file | Read by E2E scripts |

Use a GitHub token with the narrowest possible repository scope. The current app reads GitHub Issues; production write operations are not enabled by default.

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

## Production Fail-Fast Rules

Production mode fails when:

- `ALAYA_DB_PATH` is missing.
- `ALAYA_AUTO_SEED_DEMO` is not `false`.
- real LLM provider is configured without `ALAYA_CAP_LLM_CALL=true`.
- obvious placeholder/test secret values such as `changeme`, `test-secret`, `demo-key`, `fake`, or empty strings appear in secret-like env vars.

Run:

```bash
npm run secret:scan
npm --prefix alaya-app run test -- tests/env.validation.test.ts tests/secret.redaction.test.ts
```
