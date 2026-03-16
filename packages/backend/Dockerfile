FROM node:20-slim AS base
RUN corepack enable

WORKDIR /app

# Copy workspace files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/

# Install dependencies
RUN pnpm install --frozen-lockfile --filter @shopping-assistant/backend --filter @shopping-assistant/shared

# Copy source
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/backend/ packages/backend/

# Build
RUN pnpm build:shared && pnpm --filter @shopping-assistant/backend build

# Production stage
FROM node:20-slim
RUN corepack enable

WORKDIR /app

# Copy workspace structure for pnpm to resolve workspace deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod --filter @shopping-assistant/backend --filter @shopping-assistant/shared

# Copy built artifacts
COPY --from=base /app/packages/shared/dist packages/shared/dist
COPY --from=base /app/packages/backend/dist packages/backend/dist

# Run as non-root user (node:20-slim includes a 'node' user at uid 1000)
RUN chown -R node:node /app
USER node

ENV PORT=8080
EXPOSE 8080

WORKDIR /app/packages/backend
CMD ["node", "dist/index.js"]
