# One image for every Node process in this repository: portal-api, which also serves the
# built portal-web, and the Sentinel, which compose starts from the same image with a
# different command. Build from the repository root:
#   docker build -t incident-resolver .
#
# It runs TypeScript through tsx rather than a build step, so the workspace ships as source
# with its devDependencies — tsx is one of them. And a Workspace is a real clone: portal-api
# runs `git clone` and then `pnpm install` inside it (packages/agents/src/workspace.ts), so
# git and pnpm are runtime dependencies here, not just build-time ones.

FROM node:22-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# Manifests alone first, so editing a source file does not re-resolve the dependency tree.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/portal-api/package.json apps/portal-api/
COPY apps/portal-web/package.json apps/portal-web/
COPY apps/sentinel/package.json apps/sentinel/
COPY packages/agents/package.json packages/agents/
COPY packages/mcp-database/package.json packages/mcp-database/
COPY packages/mcp-incidents/package.json packages/mcp-incidents/
COPY packages/mcp-observability/package.json packages/mcp-observability/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm --filter @incident-resolver/portal-web build

FROM node:22-alpine AS runtime
# pnpm is installed outright rather than through corepack: corepack downloads on first use,
# and here the first use is a Ticket's Workspace install, running as `node` with no cache.
RUN apk add --no-cache git && npm install -g pnpm@10.34.5
# NODE_ENV is deliberately not "production": a Workspace's `pnpm install` would then skip
# ShopLite's devDependencies, and its tests — which Code RCA runs — need them.
# Where the built portal is; setting it is what makes portal-api serve the pages and mount
# the API under /api. Absolute WORKSPACES_DIR, because the default is read relative to
# the repository root.
ENV PORTAL_WEB_DIST_DIR=/app/apps/portal-web/dist
ENV WORKSPACES_DIR=/workspaces
# The default binds to loopback, which in a container is unreachable from anywhere else.
ENV PORTAL_API_HOST=0.0.0.0
ENV PORTAL_API_PORT=5000

COPY --from=build --chown=node:node /app /app
COPY --chown=node:node docker-entrypoint.sh /app/
RUN mkdir -p /workspaces && chown node:node /workspaces

USER node
WORKDIR /app/apps/portal-api
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORTAL_API_PORT||5000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["/app/docker-entrypoint.sh"]
