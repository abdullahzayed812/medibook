# syntax=docker/dockerfile:1

# Development image for the backend API and worker.
# Source code is bind-mounted by docker-compose.yml for hot reload; dependencies are
# installed in the image so host and container node_modules never mix.

FROM node:20.19-bookworm-slim AS dev
ENV NODE_ENV=development \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
WORKDIR /app

# Copy manifests first for better layer caching (all workspaces are needed by `npm ci`).
COPY package.json package-lock.json .npmrc ./
COPY packages/ ./packages/
COPY apps/ ./apps/
RUN npm ci --workspace @medibook/backend --include-workspace-root \
 && chown -R node:node /app

USER node
WORKDIR /app/apps/backend
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["/app/node_modules/.bin/tsx", "watch", "--clear-screen=false", "src/server.ts"]
