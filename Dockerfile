# syntax=docker/dockerfile:1.7
# Multi-stage build: one Node process serving /api and the SPA.
#   docker build -t ptd . && docker run -p 3000:3000 -v ptd-data:/data \
#     -e DASHBOARD_TOKEN=... -e SESSION_SECRET=... ptd

FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
# self-contained production node_modules for the server (native better-sqlite3 included)
RUN pnpm --filter @ptd/server deploy --prod --legacy /out/server \
 && cp -r apps/server/dist /out/server/dist \
 && cp -r apps/web/dist /out/web

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    WEB_DIST=/app/web
WORKDIR /app/server
COPY --from=build --chown=node:node /out/server /app/server
COPY --from=build --chown=node:node /out/web /app/web
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
