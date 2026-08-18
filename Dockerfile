# AgentMesh - single image serving the API, the realtime gateway and the web UI.
#
# Build:  docker build -t agentmesh .
# Run:    docker run -p 4000:4000 -e DATABASE_URL=... -e JWT_SECRET=... agentmesh

FROM node:22-alpine AS build
WORKDIR /app

# Install dependencies first so the layer is cached across source changes.
COPY package.json package-lock.json* ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/sdk/package.json packages/sdk/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build

# Drop dev dependencies from the artefact we ship.
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S agentmesh && adduser -S agentmesh -G agentmesh

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/sdk/package.json ./packages/sdk/
COPY --from=build /app/packages/sdk/dist ./packages/sdk/dist
COPY --from=build /app/packages/cli/package.json ./packages/cli/
COPY --from=build /app/packages/cli/dist ./packages/cli/dist
COPY --from=build /app/packages/server/package.json ./packages/server/
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/src/db/migrations ./packages/server/dist/db/migrations
COPY --from=build /app/packages/web/dist ./packages/web/dist

USER agentmesh
EXPOSE 4000
ENV HOST=0.0.0.0 PORT=4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations are applied on boot, so a fresh volume needs no extra step.
CMD ["node", "packages/server/dist/index.js"]
