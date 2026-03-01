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

# Run
FROM node:20-slim
WORKDIR /app
COPY --from=base /app/packages/backend/dist ./dist
COPY --from=base /app/packages/backend/package.json ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/index.js"]
