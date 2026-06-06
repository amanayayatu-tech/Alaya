# Validation Matrix

| Validation item | development | test | shadow | staging | production | Automation | Failure handling |
|---|---|---|---|---|---|---|---|
| install | `npm run install:all` | CI `npm ci` | Docker build | CI | release build | automated | fail build |
| typecheck | `npm run typecheck` | CI | CI | CI | CI | automated | fail build |
| unit tests | app/core tests | required | focused safety tests | required | required | automated | fail build |
| API auth | optional unless key configured | focused tests | required | required | required | automated + curl | fail deploy |
| input validation | required for changed routes | focused tests | required | required | required | automated | fail build |
| secret scan | optional local | required | required | required | required | automated | rotate/remove if real |
| env validation | local warnings | required | required | required | required | automated | fail fast |
| redaction tests | required before release | required | required | required | required | automated | fail build |
| capability gate tests | required | required | required | required | required | automated | fail build |
| shadow dry-run | manual/API | test fixture | required | optional | blocked | automated + manual | stop run if write executes |
| metrics access control | local loopback | focused tests | required | required | required | automated + probe | deny until allowlist is reviewed |
| rate limits | local focused | required | required | required | required | automated | fail build |
| scheduler concurrency | local focused | required | required | required | required | automated | disable scheduler until fixed |
| Docker build | optional | CI | required | required | required | automated | fail build |
| compose config | optional | CI | required | optional | optional | automated | fix deployment asset |
| npm audit high | optional local | required | required | required | required | automated | patch, remove dependency or document allowlist |
| explicit schema migration | local | fixture | required before first shadow start | required before deploy | required before deploy | scripted/manual | stop rollout and restore backup |
| healthz/readyz | local curl | tests | required | required | required | automated + probe | page operator |
| metrics | local/container loopback curl | tests | required | required | required | automated + probe | page operator |
| principles guard | local | CI | CI | CI | CI | automated | fail build |
| benchmark smoke | local | CI | baseline | baseline | baseline | automated | investigate regression |
| live LLM | opt-in | skipped | explicit `ALAYA_CAP_LLM_CALL=true` | explicit | explicit | opt-in | skip without secret, fail on invalid secret |
| GitHub sensor | opt-in | mocked | read-only token | read-only token | read-only token | opt-in | disable source/gate error |

Core command set:

```bash
npm run secret:scan
npm run guard
npm run test:all
npm run typecheck
npm run build
npm run ops:migrate
npm run benchmark:smoke
npm --prefix alaya-app audit --audit-level=high
npm --prefix alaya-core audit --audit-level=high
docker build -t alaya:local .
docker compose -f deploy/docker-compose.shadow.yml config
```

Latest local results are recorded in [98-verification-ledger.md](/Users/peachy/Documents/alaya/docs/ops/98-verification-ledger.md). Nonexistent scripts are recorded as `N/A`, not treated as passing.
