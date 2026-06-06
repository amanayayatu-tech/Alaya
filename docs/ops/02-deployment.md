# Deployment

This hardening pass adds two long-run deployment paths: Docker shadow compose and a systemd unit for a prebuilt app.

## Docker Shadow Run

Build:

```bash
docker build -t alaya:local .
```

Validate compose:

```bash
docker compose -f deploy/docker-compose.shadow.yml config
```

Initialize or upgrade the shadow database schema during a reviewed migration window:

```bash
docker tag alaya:local alaya:shadow
ALAYA_SHADOW_PORT=5055 docker compose -f deploy/docker-compose.shadow.yml run --rm \
  -e ALAYA_CAP_DATABASE_MIGRATION=true \
  alaya node dist/migrate.cjs
```

The normal service keeps `ALAYA_CAP_DATABASE_MIGRATION=false`; steady-state restarts validate that the schema is already present instead of running DDL.

Start shadow after migration:

```bash
docker compose -f deploy/docker-compose.shadow.yml up -d
curl -fsS http://localhost:5000/healthz
curl -fsS http://localhost:5000/readyz
curl -fsS http://localhost:5000/metrics
```

Stop:

```bash
docker compose -f deploy/docker-compose.shadow.yml down
```

If local port `5000` is already in use:

```bash
ALAYA_SHADOW_PORT=5055 docker compose -f deploy/docker-compose.shadow.yml up -d
curl -fsS http://localhost:5055/readyz
ALAYA_SHADOW_PORT=5055 docker compose -f deploy/docker-compose.shadow.yml down
```

## Container Safety Properties

- Base image pins Node major version: `node:20-bookworm-slim`.
- Build and runtime stages are separated.
- Runtime uses non-root user `alaya`.
- `.env`, database files, logs, backups and node_modules are excluded by `.dockerignore`.
- `deploy/docker-compose.shadow.yml` sets `read_only: true`.
- Writable state is limited to named volumes:
  - `/var/lib/alaya`
  - `/var/log/alaya`
  - `/var/cache/alaya`
- Compose sets restart policy, memory/CPU limits, `nofile` ulimit and log rotation.

## systemd Deployment

Install layout:

```text
/opt/alaya/alaya-app/dist
/opt/alaya/alaya-app/node_modules
/etc/alaya/alaya.env
/var/lib/alaya
/var/log/alaya
/var/cache/alaya
```

Create a low-privilege user:

```bash
sudo useradd --system --home /opt/alaya --shell /usr/sbin/nologin alaya
```

Install the unit:

```bash
sudo cp deploy/systemd/alaya.service /etc/systemd/system/alaya.service
sudo systemctl daemon-reload
sudo systemctl enable --now alaya
```

Inspect:

```bash
systemctl status alaya
journalctl -u alaya -n 200
curl -fsS http://127.0.0.1:5000/readyz
```

Stop:

```bash
sudo systemctl stop alaya
```

## Upgrade And Rollback

1. Stop scheduler or keep `ALAYA_CAP_SCHEDULER_LOOP=false`.
2. Run `npm run ops:pre-upgrade`.
3. Run `npm run ops:backup`.
4. Run the explicit schema migration command with `ALAYA_CAP_DATABASE_MIGRATION=true`.
5. Disable `ALAYA_CAP_DATABASE_MIGRATION` for steady-state service startup.
6. Deploy the new build.
7. Run `npm run ops:post-upgrade` or probe `/healthz`, `/readyz`, `/metrics`.

Rollback code by redeploying the previous image/tag or previous `/opt/alaya` release directory, then restore state only if the migration or runtime writes damaged the state.
