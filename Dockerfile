# syntax=docker/dockerfile:1

ARG BUN_VERSION=1.2
ARG NODE_VERSION=22-bookworm-slim
ARG PNPM_VERSION=10.28.1

# ---- Builder: pnpm install with frozen lockfile (matches CI) ----
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ---- Runtime: bun executes TS directly per package.json `start` script ----
FROM oven/bun:${BUN_VERSION}-debian AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    MCP_PROJECT_ROOT=/app \
    MMC_UI_DIST=/app/ui-dist

# Install Node 22 alongside bun so child MCP servers (mcp-server-sqlite)
# whose native bindings target Node's V8 ABI run cleanly. The main server
# stays on bun; only externalServers entries with command="node" pay this cost.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY sdk ./sdk
COPY connectors ./connectors
COPY config ./config

# Co-hosted dashboard SPA. mmc-workflow is a separate repo, so CI stages its
# built `dist/` into ./ui-dist before `docker build` (decoupled — the image
# never builds the SPA). Locally ./ui-dist is an empty placeholder, so the
# server runs engine-only: staticUi.ts no-ops when index.html is absent, even
# though MMC_UI_DIST is set. See architecture/managed-deployment.md.
COPY ui-dist ./ui-dist

# Dirs the server reads/writes at runtime. /app/data is overlaid by a Fly volume;
# /app/skills is repopulated on boot from GitHub via skillSyncStartup.
RUN mkdir -p data skills logs

EXPOSE 8080
CMD ["bun", "src/server/index.ts"]
