# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS deps
WORKDIR /app/alaya-app
COPY alaya-app/package*.json ./
RUN npm ci

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/alaya-app/node_modules ./alaya-app/node_modules
COPY alaya-app ./alaya-app
WORKDIR /app/alaya-app
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5000 \
    ALAYA_MODE=shadow \
    ALAYA_DB_PATH=/var/lib/alaya/alaya.db \
    ALAYA_DATA_DIR=/var/lib/alaya \
    ALAYA_LOG_DIR=/var/log/alaya \
    ALAYA_STATE_DIR=/var/lib/alaya/state \
    ALAYA_CACHE_DIR=/var/cache/alaya \
    ALAYA_AUTO_SEED_DEMO=false \
    ALAYA_LLM_PROVIDER=mock

RUN groupadd --system alaya && useradd --system --gid alaya --home /app --shell /usr/sbin/nologin alaya
WORKDIR /app
COPY --from=build --chown=alaya:alaya /app/alaya-app/package*.json ./alaya-app/
COPY --from=build --chown=alaya:alaya /app/alaya-app/dist ./alaya-app/dist
COPY --from=build --chown=alaya:alaya /app/alaya-app/node_modules ./alaya-app/node_modules
RUN mkdir -p /var/lib/alaya/state /var/log/alaya /var/cache/alaya \
  && chown -R alaya:alaya /var/lib/alaya /var/log/alaya /var/cache/alaya

USER alaya
WORKDIR /app/alaya-app
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.cjs"]
