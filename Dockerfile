# syntax=docker/dockerfile:1
# workspaces 仓库：根目录单次 npm ci；alaya-app 依赖 file:../alaya-core，
# 必须在根上下文安装与构建（子包单独 npm ci 会产生悬空的 workspace 符号链接）。

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY alaya-core/package.json ./alaya-core/
COPY alaya-app/package.json ./alaya-app/
RUN npm ci
COPY alaya-core ./alaya-core
COPY alaya-app ./alaya-app
WORKDIR /app/alaya-app
RUN npm run build
WORKDIR /app
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
COPY --from=build --chown=alaya:alaya /app/package*.json ./
COPY --from=build --chown=alaya:alaya /app/node_modules ./node_modules
COPY --from=build --chown=alaya:alaya /app/alaya-core ./alaya-core
COPY --from=build --chown=alaya:alaya /app/alaya-app/package*.json ./alaya-app/
COPY --from=build --chown=alaya:alaya /app/alaya-app/dist ./alaya-app/dist
RUN mkdir -p /var/lib/alaya/state /var/log/alaya /var/cache/alaya \
  && chown -R alaya:alaya /var/lib/alaya /var/log/alaya /var/cache/alaya

USER alaya
WORKDIR /app/alaya-app
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.cjs"]
