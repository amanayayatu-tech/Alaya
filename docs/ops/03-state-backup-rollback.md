# State, Backup And Rollback

## State Inventory

| State | Default Location | Notes |
|---|---|---|
| SQLite DB | `ALAYA_DB_PATH` or `alaya-app/data.db` | Projects, cycles, gates, knowledge, LLM calls, traces, action ledger |
| SQLite WAL/SHM | DB path plus `-wal`, `-shm` | Must be backed up with DB when service is stopped or checkpointed |
| Logs | `ALAYA_LOG_DIR` or process stdout | JSON structured runtime logs |
| Validation logs | `validation-logs/` | Not required for restore, useful for audit |
| Config | env vars / `/etc/alaya/alaya.env` | Secrets are not backed up by scripts |
| Generated build | `alaya-app/dist` | Reproducible from source |

## Backup

Run:

```bash
npm run ops:backup
```

The script copies the configured SQLite DB and WAL/SHM sidecars into `tmp/alaya-backups/...` and writes `manifest.json`. It records env variable names that were present, but never env values. `.env` files and secret files are excluded.

## Restore

Dry run:

```bash
npm run ops:restore -- --backup tmp/alaya-backups/<backup-dir>
```

Restore after stopping Alaya:

```bash
npm run ops:restore -- --backup tmp/alaya-backups/<backup-dir> --confirm
```

The restore script requires `--confirm` to copy files.

## Migration Policy

In `development` and `test`, the local SQLite schema can migrate at startup for developer ergonomics. In `shadow`, `staging`, and `production`, normal startup does not run schema DDL unless a reviewed migration window explicitly enables:

```bash
ALAYA_CAP_DATABASE_MIGRATION=true
```

Use that flag only with the explicit migration command after backup:

```bash
npm run ops:pre-upgrade
npm run ops:backup
ALAYA_CAP_DATABASE_MIGRATION=true npm run ops:migrate
```

For Docker shadow:

```bash
ALAYA_SHADOW_PORT=5055 docker compose -f deploy/docker-compose.shadow.yml run --rm \
  -e ALAYA_CAP_DATABASE_MIGRATION=true \
  alaya node dist/migrate.cjs
```

After migration, keep `ALAYA_CAP_DATABASE_MIGRATION=false`. If a long-run database is missing required tables or columns, startup fails with a schema readiness error instead of silently running DDL.

## Rollback Targets

- Code: previous commit, previous Docker image tag, or previous `/opt/alaya` release directory.
- Config: previous `/etc/alaya/alaya.env` from operator-managed backup.
- Data: restore the previous SQLite DB backup.
- Agent actions: use `action_ledger`, `trace_events`, and `event_log` to locate generated patches, gates, knowledge writes and dry-run actions.

## Irreversible Risk

SQLite restore can recover database state, but external actions already performed outside Alaya cannot be automatically undone. Production defaults therefore keep GitHub writes, shell execution and external notifications disabled.
