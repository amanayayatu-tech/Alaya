# 7 Day Shadow Run

Goal: observe Alaya for seven days without executing real external writes.

## Start Checklist

- `npm run secret:scan` passes.
- `npm run test:all` passes.
- `npm run build` passes.
- `docker build -t alaya:local .` passes.
- `docker compose -f deploy/docker-compose.shadow.yml config` passes.
- Shadow DB schema has been initialized with the explicit migration command.
- `ALAYA_API_KEY` is set from a local secret file or secret manager and is not committed.
- `ALAYA_CAP_GITHUB_WRITE=false`.
- `ALAYA_CAP_SHELL_EXECUTION=false`.
- `ALAYA_CAP_EXTERNAL_NOTIFICATION=false`.
- `ALAYA_CAP_KNOWLEDGE_WRITE=dry_run` unless using a disposable shadow DB.
- If real LLM is enabled, `ALAYA_CAP_LLM_CALL=true` and a daily cost budget are documented.
- `ALAYA_CORS_ORIGINS` and `ALAYA_METRICS_ALLOWED_CIDRS` are reviewed when exposing beyond localhost.

## Start

```bash
export ALAYA_API_KEY=<local-shadow-api-key>
docker tag alaya:local alaya:shadow
ALAYA_SHADOW_PORT=5055 docker compose -f deploy/docker-compose.shadow.yml run --rm \
  -e ALAYA_CAP_DATABASE_MIGRATION=true \
  alaya node dist/migrate.cjs
docker compose -f deploy/docker-compose.shadow.yml up -d
curl -fsS http://localhost:5000/readyz
curl -fsS -H "Authorization: Bearer $ALAYA_API_KEY" http://localhost:5000/api/projects
```

Use `ALAYA_SHADOW_PORT=5055` or another reviewed port when `5000` is occupied.

Metrics are loopback-restricted by default. For a one-shot local scrape:

```bash
docker compose -f deploy/docker-compose.shadow.yml exec alaya \
  node -e "fetch('http://127.0.0.1:5000/metrics').then(async r => { console.log(r.status); console.log((await r.text()).slice(0, 200)); })"
```

## Proof That Writes Are Disabled

- Mutating API calls in `ALAYA_MODE=shadow` return `202` with `status=dry_run`.
- Capability decisions are written to `action_ledger` with `status=dry_run` or `blocked`.
- Shadow compose disables GitHub writes, shell execution and notifications.
- Shadow compose keeps `ALAYA_CAP_DATABASE_MIGRATION=false` for steady-state service starts; schema changes require the explicit one-shot migration command.
- Root filesystem is read-only; writable volumes are isolated from production.

## Daily Checks

```bash
curl -fsS http://localhost:5000/healthz
curl -fsS http://localhost:5000/readyz
curl -fsS -H "Authorization: Bearer $ALAYA_API_KEY" http://localhost:5000/api/projects
npm run shadow:report -- --out tmp/shadow-report-day-N.md
```

Review:

- action denial and dry-run counts.
- LLM call count, tokens and estimated cost.
- scheduler error events.
- cost endpoint rate-limit responses.
- trace/action ledger growth.
- knowledge injection volume.
- repeated target/action patterns.

## Stop Conditions

- Any non-dry-run external write occurs.
- `/readyz` fails for more than five minutes.
- LLM cost exceeds the approved daily budget.
- scheduler failures are consecutive and unresolved.
- action denials spike without an expected config change.
- trace or action ledger writes fail.
- the same target is repeatedly modified/planned beyond the agreed threshold.

## Success Criteria

- Seven days with no unauthorized real writes.
- Cost stays under budget.
- `/healthz`, `/readyz`, and `/metrics` remain available.
- scheduler has no unrecoverable stall.
- action ledger and trace are complete enough for audit.
- high-risk denied/dry-run logic is visible and effective.
- benchmark/core quality indicators do not regress.

## Final Report

At the end:

```bash
npm run shadow:report -- --out tmp/shadow-run-final.md
docker compose -f deploy/docker-compose.shadow.yml logs --tail=500 > tmp/shadow-run-final.log
docker compose -f deploy/docker-compose.shadow.yml down
```
