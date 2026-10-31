# BotLab server + web UI (spec §15). Multi-arch: docker buildx build --platform linux/amd64,linux/arm64 .
# Runs as the unprivileged `node` user; data in /data, human-owned config in /config.

# ── Build: install everything, compile server + core, build the web UI ──
FROM node:22-slim AS build
WORKDIR /app
# better-sqlite3 downloads a prebuilt binary for linux x64/arm64 (glibc), so no compiler toolchain
COPY package.json package-lock.json ./
COPY scripts/check-node.mjs ./scripts/
RUN npm ci
COPY tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY templates ./templates
RUN npm run build && npm prune --omit=dev

# ── Runtime ──
FROM node:22-slim
ENV NODE_ENV=production \
    BOTLAB_DATA_DIR=/data \
    BOTLAB_CONFIG_DIR=/config \
    BOTLAB_HOST=0.0.0.0 \
    BOTLAB_PORT=3780 \
    TZ=Europe/Dublin
WORKDIR /app
# TZ works without tzdata: Node's bundled ICU has the time zone database
RUN mkdir -p /data /config && chown node:node /data /config
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/templates ./templates
USER node
VOLUME ["/data", "/config"]
EXPOSE 3780
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3780/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# node handles SIGTERM itself (graceful shutdown → clean-shutdown marker); compose adds `init: true`
# and stop_grace_period so it has time
CMD ["node", "dist/apps/server/src/main.js"]
