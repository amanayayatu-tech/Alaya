# Alaya Phase 1 MVP — Build Report

> Historical snapshot from 2026-06-03. This file is archived for provenance and
> is not the current setup or runtime source of truth. Current commands live in
> the root README, CONTRIBUTING and docs/configuration.md.

## Status

Complete for local Phase 1 validation.

The app is an Express + React MVP backed by local SQLite and deterministic mock
LLM/Agent logic. At the time of this snapshot it did not call an external LLM
API. The current app supports explicit OpenAI-compatible providers behind
runtime capability flags.

## Local Deployment

```bash
npm ci
npm run dev
```

The server reads:

- `PORT` (default `5000`)
- `HOST` (default `0.0.0.0`)
- `REUSE_PORT=true` to opt into Node's `reusePort` listen option

On macOS, some Node versions return `ENOTSUP` when `reusePort` is enabled, so it
is disabled by default.

## Production Build

```bash
cd alaya-app
npm run build
npm run start
```

The build emits:

- `dist/public/` for the client
- `dist/index.cjs` for the Express server

## Verified Pages

- Dashboard
- Human Gates
- Prediction Ledger
- Knowledge Base
- Cycle Review

The seeded demo creates one project with three closed flywheel cycles, four
knowledge items, one pending human gate, and deterministic mock LLM call logs.

## Key API Routes

- `GET /api/projects`
- `GET /api/projects/:id/dashboard`
- `GET /api/projects/:id/cycles`
- `POST /api/cycles/:id/run-full`
- `GET /api/human-gates`
- `POST /api/human-gates/:id/approve`
- `POST /api/human-gates/:id/modify`
- `POST /api/human-gates/:id/reject`
- `GET /api/knowledge?projectId=...`
- `POST /api/knowledge/search`
- `GET /api/cycles/:id/review`
- `GET /api/llm-calls/summary?projectId=...`

## Current Validation Snapshot

Validated locally on 2026-06-03:

- `alaya-core`: `npm test` passed, 34/34 tests.
- `alaya-core`: `npm run typecheck` passed.
- `alaya-core`: `npm run flywheel` passed all PRD 17.3 flywheel acceptance checks.
- `alaya-app`: `npm run check` passed.
- `alaya-app`: `npm run build` passed.
- `alaya-app`: FTS5 search for `预览` returned the expected `kb_004` knowledge item.

Build warnings currently remaining:

- A PostCSS plugin warns that it did not pass the `from` option to
  `postcss.parse`.
