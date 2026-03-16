# GCP Deployment & CI/CD Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the shopping-assistant backend to GCP Cloud Run with Secret Manager for credentials, fix the Dockerfile for production, add the Gemini Live model config, and set up a GitHub Actions CI/CD pipeline that automatically builds and deploys on push to `main`.

**Architecture:** Single Cloud Run service running the existing Hono backend (REST + WebSocket). Docker image built from monorepo root, pushed to Artifact Registry. Secrets injected from Secret Manager as env vars at deploy time. GitHub Actions uses Workload Identity Federation (no long-lived keys) to authenticate and deploy. WebSocket `/live` endpoint works on Cloud Run with extended timeout + session affinity.

**Tech Stack:** GCP Cloud Run, Artifact Registry, Secret Manager, Workload Identity Federation, GitHub Actions, Docker, gcloud CLI.

> **Important: Monorepo context.** The GitHub repo is `wuTims/web-dev-playground` and `shopping-assistant/` is a **subdirectory**, not the repo root. All GitHub Actions paths, Docker build contexts, and workflow commands must account for this. The workflow uses `defaults.run.working-directory: shopping-assistant` and path filters are prefixed with `shopping-assistant/`.

> **WebSocket timeout limitation.** Cloud Run's `--timeout=3600` is the maximum **request** timeout (1 hour). WebSocket connections are forcibly terminated after this period regardless of activity. The `/live` client must implement reconnection logic to handle this hard cap.

---

## Environment Variable Analysis

### Current `.env` assessment

| Variable | Status | Notes |
|----------|--------|-------|
| `GEMINI_API_KEY` | Existing dev key | Used by backend code (`ai-client.ts`) |
| `GCP_GEMINI_API_KEY` | New, scoped to "Generative Language APIs" | **Correct for production.** Covers `generateContent`, grounded search (`googleSearch` tool), and Live API (`BidiGenerateContent`) — all methods on `generativelanguage.googleapis.com`. |
| `GCP_CLOUD_API_KEY` | New, scoped to "Google Cloud APIs" | **Not needed.** Broader scope than required. All Gemini features work under "Generative Language APIs" scope. Keep it if you plan to use other GCP services later, but it's not required for this deployment. |
| `BRAVE_API_KEY` | Existing | Separate from Google, uses its own auth header. No change needed. |
| `GEMINI_LIVE_MODEL` | **Missing from `.env`** | Needs to be added. Correct value: `gemini-2.5-flash-native-audio-preview-12-2025` |
| `GEMINI_MODEL` | **Not set** (defaults to `gemini-2.5-flash` in code) | Current default is fine. |

### Key decision for deployment

The backend code reads `process.env.GEMINI_API_KEY`. For Cloud Run, we inject `GCP_GEMINI_API_KEY`'s value into Secret Manager under the name `GEMINI_API_KEY`. This means **zero code changes** — the same env var name works in both dev (`.env` file) and prod (Secret Manager injection).

### Secrets to store in Secret Manager

| Secret Name | Source | Used For |
|-------------|--------|----------|
| `GEMINI_API_KEY` | Value of `GCP_GEMINI_API_KEY` | All Gemini API calls (text, grounding, Live) |
| `BRAVE_API_KEY` | Current value | Brave Search API |
| `ALIEXPRESS_APP_KEY` | Current value | AliExpress API |
| `ALIEXPRESS_API_KEY` | Current value | AliExpress API |
| `ALIEXPRESS_ACCESS_TOKEN` | Current value | AliExpress API (auto-refreshed + written back by Task 10) |
| `ALIEXPRESS_REFRESH_TOKEN` | Current value | AliExpress token refresh |
| `ALIEXPRESS_TOKEN_EXPIRY` | Current value (ms timestamp) | AliExpress token expiry (written back by auto-refresh) |
| `ALIEXPRESS_REFRESH_TOKEN_EXPIRY` | Current value (ms timestamp) | AliExpress refresh token expiry (written back by auto-refresh) |

> **AliExpress token management (CRITICAL — addressed in Task 10).** The access token has 24hr expiry and is auto-refreshed in-memory by `initAliExpressAutoRefresh()`. The current code persists refreshed tokens to `.env` via `persistAllTokensToEnv()` — this uses `readFileSync`/`writeFileSync` which will fail on Cloud Run's ephemeral filesystem. When Cloud Run scales down and a new instance starts, it gets the original (possibly expired) token from Secret Manager. **Task 10 adds Secret Manager write-back** so refreshed tokens survive instance restarts. The Cloud Run service account needs `roles/secretmanager.secretVersionAdder` in addition to `roles/secretmanager.secretAccessor`.

### Non-secret env vars (set directly on Cloud Run)

| Env Var | Value |
|---------|-------|
| `PORT` | `8080` (already default) |
| `GCP_PROJECT_ID` | Your GCP project ID (needed by Secret Manager write-back for AliExpress tokens) |
| `GEMINI_MODEL` | `gemini-2.5-flash` (or omit to use code default) |
| `GEMINI_LIVE_MODEL` | `gemini-2.5-flash-native-audio-preview-12-2025` |
| `ALIEXPRESS_CALLBACK_URL` | Production callback URL |

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Modify | `packages/backend/.env` | Add `GEMINI_LIVE_MODEL` |
| Modify | `packages/backend/.env.example` | Update live model name, add GCP key docs |
| Modify | `packages/backend/src/services/ai-client.ts` | Export `liveModel` constant |
| Modify | `packages/backend/src/index.ts` | Add `GEMINI_LIVE_MODEL` to optional env var logging |
| Modify | `packages/backend/Dockerfile` | Fix multi-stage build to include runtime deps + non-root user |
| Create | `.dockerignore` | Exclude dev files from Docker build context |
| Modify | `package.json` (root) | Pin pnpm version via `packageManager` field |
| Create | `.github/workflows/deploy-backend.yml` | CI/CD pipeline with concurrency control + auto-rollback |
| Create | `docs/gcp-setup.md` | One-time GCP setup commands (not automated) |
| Modify | `packages/extension/src/manifest.json` | Add Cloud Run URL to `host_permissions` |
| Create | `packages/backend/src/services/secret-store.ts` | Secret Manager write-back for AliExpress token persistence |
| Modify | `packages/backend/src/routes/aliexpress-auth.ts` | Use secret store strategy instead of .env file writes |
| Modify | `packages/backend/package.json` | Add `@google-cloud/secret-manager` dependency |

---

## Chunk 1: Backend Config & Dockerfile Fix

### Task 1: Add GEMINI_LIVE_MODEL to env and ai-client

**Files:**
- Modify: `packages/backend/.env`
- Modify: `packages/backend/.env.example`
- Modify: `packages/backend/src/services/ai-client.ts`

- [ ] **Step 1: Add GEMINI_LIVE_MODEL to `.env`**

In `packages/backend/.env`, add after the `GCP_CLOUD_API_KEY` line:

```
GEMINI_LIVE_MODEL=gemini-2.5-flash-native-audio-preview-12-2025
```

- [ ] **Step 2: Update `.env.example` with correct model name and GCP key documentation**

Replace the full content of `packages/backend/.env.example` with:

```bash
# Required
GEMINI_API_KEY=
BRAVE_API_KEY=

# Optional: override default models (defaults are set in code)
# GEMINI_MODEL=gemini-2.5-flash
# GEMINI_LIVE_MODEL=gemini-2.5-flash-native-audio-preview-12-2025

# GCP deployment keys (create in Google Cloud Console)
# GCP_GEMINI_API_KEY — scoped to "Generative Language APIs" (covers all Gemini: text, grounding, Live)
# GCP_CLOUD_API_KEY — scoped to "Google Cloud APIs" (broader, not needed unless using other GCP services)
# For production: inject GCP_GEMINI_API_KEY as GEMINI_API_KEY via Secret Manager

# AliExpress Open Platform (optional — enables AliExpress as a search source)
# ALIEXPRESS_APP_KEY=
# ALIEXPRESS_API_KEY=
# ALIEXPRESS_CALLBACK_URL=
# These are managed automatically by the /auth/aliexpress endpoints:
# ALIEXPRESS_ACCESS_TOKEN=
# ALIEXPRESS_TOKEN_EXPIRY=
# ALIEXPRESS_REFRESH_TOKEN=
# ALIEXPRESS_REFRESH_TOKEN_EXPIRY=
```

- [ ] **Step 3: Export `liveModel` from ai-client.ts**

In `packages/backend/src/services/ai-client.ts`, add the live model export. The full file should become:

```typescript
import { GoogleGenAI } from "@google/genai";

export const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
export const geminiModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
export const liveModel = process.env.GEMINI_LIVE_MODEL || "gemini-2.5-flash-native-audio-preview-12-2025";
export const embeddingModel = "gemini-embedding-2-preview";
```

- [ ] **Step 4: Commit**

```bash
git add packages/backend/.env.example packages/backend/src/services/ai-client.ts
git commit -m "feat: add GEMINI_LIVE_MODEL config and update env documentation"
```

> **Note:** Do NOT commit `.env` — it contains secrets. Only commit `.env.example` and code changes.

---

### Task 2: Fix Dockerfile for Production

**Files:**
- Modify: `packages/backend/Dockerfile`
- Create: `.dockerignore` (repo root)
- Modify: `package.json` (root — pin pnpm version)

The current Dockerfile has a critical bug: the final stage copies only `dist/` and `package.json` but never installs runtime dependencies. Since `tsup` (the bundler) defaults to treating `node_modules` as external, native modules like `sharp` and `@google/genai` won't be in the bundle. The container will crash with `MODULE_NOT_FOUND` at runtime.

- [ ] **Step 1: Pin pnpm version in root package.json**

Add the `packageManager` field to the root `package.json`:

```json
"packageManager": "pnpm@10.20.0"
```

This ensures consistent pnpm version across Docker builds, CI, and local development. `corepack enable` will use this pinned version.

- [ ] **Step 2: Create root `.dockerignore`**

Create `.dockerignore` at the repo root (`/workspaces/web-dev-playground/shopping-assistant/.dockerignore`):

```
**/node_modules
**/dist
**/.env
**/.env.*
!**/.env.example
packages/extension
docs
.git
.github
*.md
```

This keeps the build context lean. The extension package, docs, and GitHub workflows are excluded since they're not needed for the backend image. Only the root `.dockerignore` matters since the build context is the repo root.

- [ ] **Step 3: Fix the Dockerfile**

Replace `packages/backend/Dockerfile` with:

```dockerfile
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
```

Key changes:
- Final stage now installs production-only dependencies via `pnpm install --prod`
- `corepack enable` added to final stage (pnpm needs it)
- Copies built `shared/dist` so the workspace dependency resolves
- Sets `WORKDIR` to backend package for correct module resolution
- **Runs as non-root `node` user** for container security

- [ ] **Step 4: Test the Docker build locally**

Run from the repo root:

```bash
docker build -t shopping-assistant-backend:test -f packages/backend/Dockerfile .
```

Expected: Build succeeds without errors.

- [ ] **Step 5: Test the container runs**

```bash
docker run --rm -e GEMINI_API_KEY=test -e BRAVE_API_KEY=test -p 8080:8080 shopping-assistant-backend:test
```

Expected: Container starts and prints `Backend running on http://localhost:8080`. It will crash on actual API calls since keys are fake, but the process should boot and bind the port.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/Dockerfile .dockerignore package.json
git commit -m "fix: Dockerfile multi-stage build installs runtime deps in production stage"
```

---

## Chunk 2: GCP Infrastructure Setup (Manual One-Time)

This chunk documents the one-time GCP setup commands. These are run manually by the developer, not automated. Save them as a reference doc.

### Task 3: Write GCP Setup Guide

**Files:**
- Create: `docs/gcp-setup.md`

- [ ] **Step 1: Create the setup guide**

Create `docs/gcp-setup.md`:

````markdown
# GCP Setup Guide (One-Time)

Run these commands once to set up the GCP infrastructure for the shopping-assistant backend.

## Prerequisites

- [gcloud CLI](https://cloud.google.com/sdk/docs/install) installed and authenticated
- A GCP project created (note your `PROJECT_ID`)
- Billing enabled on the project

## 1. Set Project Variables

```bash
export PROJECT_ID="your-project-id"
export REGION="us-central1"
export SERVICE_NAME="shopping-assistant-backend"
export REPO_NAME="shopping-assistant"
export SA_NAME="github-actions-deployer"
export GITHUB_ORG="wuTims"
export GITHUB_REPO="web-dev-playground"
```

## 2. Enable Required APIs

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  --project=$PROJECT_ID
```

## 3. Create Artifact Registry Repository

```bash
gcloud artifacts repositories create $REPO_NAME \
  --repository-format=docker \
  --location=$REGION \
  --description="Shopping Assistant Docker images" \
  --project=$PROJECT_ID
```

## 4. Create Secrets in Secret Manager

```bash
# Gemini API key (use GCP_GEMINI_API_KEY value — scoped to Generative Language APIs)
echo -n "YOUR_GCP_GEMINI_API_KEY_VALUE" | \
  gcloud secrets create GEMINI_API_KEY --data-file=- --project=$PROJECT_ID

# Brave Search API key
echo -n "YOUR_BRAVE_API_KEY_VALUE" | \
  gcloud secrets create BRAVE_API_KEY --data-file=- --project=$PROJECT_ID

# AliExpress keys (if using AliExpress integration)
echo -n "YOUR_ALIEXPRESS_APP_KEY" | \
  gcloud secrets create ALIEXPRESS_APP_KEY --data-file=- --project=$PROJECT_ID

echo -n "YOUR_ALIEXPRESS_API_KEY" | \
  gcloud secrets create ALIEXPRESS_API_KEY --data-file=- --project=$PROJECT_ID

echo -n "YOUR_ALIEXPRESS_ACCESS_TOKEN" | \
  gcloud secrets create ALIEXPRESS_ACCESS_TOKEN --data-file=- --project=$PROJECT_ID

echo -n "YOUR_ALIEXPRESS_REFRESH_TOKEN" | \
  gcloud secrets create ALIEXPRESS_REFRESH_TOKEN --data-file=- --project=$PROJECT_ID

# AliExpress token expiry timestamps (managed by auto-refresh write-back)
echo -n "0" | \
  gcloud secrets create ALIEXPRESS_TOKEN_EXPIRY --data-file=- --project=$PROJECT_ID

echo -n "0" | \
  gcloud secrets create ALIEXPRESS_REFRESH_TOKEN_EXPIRY --data-file=- --project=$PROJECT_ID
```

## 5. Grant Cloud Run Access to Secrets

```bash
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
SA_EMAIL="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

# Grant read access (secretAccessor) to all secrets
for SECRET in GEMINI_API_KEY BRAVE_API_KEY ALIEXPRESS_APP_KEY ALIEXPRESS_API_KEY ALIEXPRESS_ACCESS_TOKEN ALIEXPRESS_REFRESH_TOKEN ALIEXPRESS_TOKEN_EXPIRY ALIEXPRESS_REFRESH_TOKEN_EXPIRY; do
  gcloud secrets add-iam-policy-binding $SECRET \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" \
    --project=$PROJECT_ID
done

# Grant write access (secretVersionAdder) for AliExpress token write-back
# The backend auto-refreshes AliExpress tokens and writes updated values back to Secret Manager
# so new instances get fresh tokens instead of the original (possibly expired) ones
for SECRET in ALIEXPRESS_ACCESS_TOKEN ALIEXPRESS_REFRESH_TOKEN ALIEXPRESS_TOKEN_EXPIRY ALIEXPRESS_REFRESH_TOKEN_EXPIRY; do
  gcloud secrets add-iam-policy-binding $SECRET \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/secretmanager.secretVersionAdder" \
    --project=$PROJECT_ID
done
```

## 6. Initial Manual Deploy (Test)

Build and push the image, then deploy:

```bash
IMAGE_TAG="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/backend:initial"

# Authenticate Docker to Artifact Registry
gcloud auth configure-docker ${REGION}-docker.pkg.dev --quiet

# Build from repo root (shopping-assistant/)
docker build -t $IMAGE_TAG -f packages/backend/Dockerfile .

# Push to Artifact Registry
docker push $IMAGE_TAG

# Deploy to Cloud Run
gcloud run deploy $SERVICE_NAME \
  --image=$IMAGE_TAG \
  --region=$REGION \
  --port=8080 \
  --timeout=3600 \
  --session-affinity \
  --concurrency=20 \
  --min-instances=0 \
  --max-instances=5 \
  --memory=512Mi \
  --cpu=1 \
  --allow-unauthenticated \
  --update-secrets=GEMINI_API_KEY=GEMINI_API_KEY:latest,BRAVE_API_KEY=BRAVE_API_KEY:latest,ALIEXPRESS_APP_KEY=ALIEXPRESS_APP_KEY:latest,ALIEXPRESS_API_KEY=ALIEXPRESS_API_KEY:latest,ALIEXPRESS_ACCESS_TOKEN=ALIEXPRESS_ACCESS_TOKEN:latest,ALIEXPRESS_REFRESH_TOKEN=ALIEXPRESS_REFRESH_TOKEN:latest,ALIEXPRESS_TOKEN_EXPIRY=ALIEXPRESS_TOKEN_EXPIRY:latest,ALIEXPRESS_REFRESH_TOKEN_EXPIRY=ALIEXPRESS_REFRESH_TOKEN_EXPIRY:latest \
  --set-env-vars=GCP_PROJECT_ID=${PROJECT_ID},GEMINI_LIVE_MODEL=gemini-2.5-flash-native-audio-preview-12-2025,ALIEXPRESS_CALLBACK_URL=https://YOUR_CLOUD_RUN_URL/auth/aliexpress/callback \
  --project=$PROJECT_ID
```

## 7. Verify Deployment

```bash
# Get the service URL
SERVICE_URL=$(gcloud run services describe $SERVICE_NAME --region=$REGION --format='value(status.url)' --project=$PROJECT_ID)

# Health check
curl "${SERVICE_URL}/health"
# Expected: {"status":"ok"}
```

## 8. Set Up Workload Identity Federation (for GitHub Actions)

```bash
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')

# Create service account for GitHub Actions
gcloud iam service-accounts create $SA_NAME \
  --display-name="GitHub Actions deployer" \
  --project=$PROJECT_ID

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# Grant roles to service account
# roles/run.developer — deploy new revisions and manage traffic (more scoped than run.admin)
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/run.developer"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/iam.serviceAccountUser"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/artifactregistry.writer"

# NOTE: The deployer SA does NOT need roles/secretmanager.secretAccessor.
# deploy-cloudrun@v2 only sets secret *references* on the service — it does not
# read secret values. The Cloud Run runtime SA (default compute) reads secrets
# at container start, and that binding is set per-secret in Section 5.

# Create Workload Identity Pool
gcloud iam workload-identity-pools create github-actions-pool \
  --location="global" \
  --display-name="GitHub Actions Pool" \
  --project=$PROJECT_ID

# Create OIDC Provider for GitHub
gcloud iam workload-identity-pools providers create-oidc github-actions-provider \
  --location="global" \
  --workload-identity-pool=github-actions-pool \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.actor=assertion.actor" \
  --attribute-condition="assertion.repository=='${GITHUB_ORG}/${GITHUB_REPO}'" \
  --project=$PROJECT_ID

# Allow GitHub Actions to impersonate the service account
gcloud iam service-accounts add-iam-policy-binding $SA_EMAIL \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-actions-pool/attribute.repository/${GITHUB_ORG}/${GITHUB_REPO}" \
  --project=$PROJECT_ID

echo ""
echo "=== Values for GitHub Actions workflow ==="
echo "WORKLOAD_IDENTITY_PROVIDER: projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-actions-pool/providers/github-actions-provider"
echo "SERVICE_ACCOUNT: ${SA_EMAIL}"
```

## 9. Set Min Instances for Demos

```bash
# Keep 1 warm instance (avoids cold starts, costs more)
gcloud run services update $SERVICE_NAME \
  --min-instances=1 \
  --region=$REGION \
  --project=$PROJECT_ID

# Reset to scale-to-zero after demo
gcloud run services update $SERVICE_NAME \
  --min-instances=default \
  --region=$REGION \
  --project=$PROJECT_ID
```

## Cloud Run Configuration Reference

| Setting | Value | Reason |
|---------|-------|--------|
| `--timeout=3600` | 60 min | WebSocket `/live` sessions need long timeouts. **This is a hard cap** — WS connections are forcibly terminated after 1 hour. Client must implement reconnection. |
| `--session-affinity` | enabled | Reconnecting WS clients route to same instance |
| `--min-instances=0` | default | Scale to zero when idle (set to 1 for demos) |
| `--concurrency=20` | 20 req/instance | Prevents overloading instances with long-lived WS sessions + REST (default 80 is too high) |
| `--max-instances=5` | conservative | Start low, increase after load testing |
| `--memory=512Mi` | 512 MB | Sufficient for Hono + sharp image processing |
| `--cpu=1` | 1 vCPU | Sufficient for current load |
| `--allow-unauthenticated` | public | Extension needs public access (rate limit at app layer) |
| **No** `--use-http2` | deliberate | WebSockets use HTTP/1.1 upgrade; HTTP/2 breaks them |
````

- [ ] **Step 2: Commit**

```bash
git add docs/gcp-setup.md
git commit -m "docs: add GCP one-time setup guide for Cloud Run deployment"
```

---

## Chunk 3: GitHub Actions CI/CD Pipeline

### Task 4: Create GitHub Actions Workflow

**Files:**
- Create: `.github/workflows/deploy-backend.yml`

This workflow triggers on pushes to `main` that touch backend or shared code, builds the Docker image, pushes to Artifact Registry, and deploys to Cloud Run.

- [ ] **Step 1: Create the workflow directory**

```bash
mkdir -p .github/workflows
```

- [ ] **Step 2: Create the workflow file**

Create `.github/workflows/deploy-backend.yml`:

```yaml
name: Deploy Backend to Cloud Run

on:
  push:
    branches: [main]
    paths:
      # All paths prefixed with shopping-assistant/ — this is a subdirectory of the repo
      - 'shopping-assistant/packages/backend/**'
      - 'shopping-assistant/packages/shared/**'
      - 'shopping-assistant/pnpm-lock.yaml'
      - 'shopping-assistant/tsconfig.base.json'
      - 'shopping-assistant/.dockerignore'
      - 'shopping-assistant/package.json'
  workflow_dispatch: # Allow manual trigger

# Prevent concurrent deploys — newer push cancels in-progress deploy
concurrency:
  group: deploy-backend
  cancel-in-progress: true

env:
  PROJECT_ID: ${{ vars.GCP_PROJECT_ID }}
  REGION: us-central1
  SERVICE_NAME: shopping-assistant-backend
  REPOSITORY: shopping-assistant
  IMAGE_NAME: backend

# All run commands execute from the shopping-assistant subdirectory
defaults:
  run:
    working-directory: shopping-assistant

jobs:
  # Job 1: Typecheck and test before deploying
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
          cache-dependency-path: shopping-assistant/pnpm-lock.yaml

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build shared package
        run: pnpm build:shared

      - name: Typecheck backend
        run: pnpm --filter @shopping-assistant/backend typecheck

      - name: Test backend
        run: pnpm --filter @shopping-assistant/backend test

  # Job 2: Build image, push, deploy
  deploy:
    needs: check
    runs-on: ubuntu-latest

    permissions:
      contents: read
      id-token: write # Required for Workload Identity Federation

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Authenticate to Google Cloud
        id: auth
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: ${{ vars.GCP_SERVICE_ACCOUNT }}

      - name: Set up Cloud SDK
        uses: google-github-actions/setup-gcloud@v2

      - name: Authenticate Docker to Artifact Registry
        run: gcloud auth configure-docker ${{ env.REGION }}-docker.pkg.dev --quiet

      - name: Build Docker image
        run: |
          docker build \
            -t ${{ env.REGION }}-docker.pkg.dev/${{ env.PROJECT_ID }}/${{ env.REPOSITORY }}/${{ env.IMAGE_NAME }}:${{ github.sha }} \
            -f packages/backend/Dockerfile \
            .

      - name: Push Docker image
        run: |
          docker push ${{ env.REGION }}-docker.pkg.dev/${{ env.PROJECT_ID }}/${{ env.REPOSITORY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}

      - name: Deploy to Cloud Run (no traffic)
        id: deploy
        uses: google-github-actions/deploy-cloudrun@v2
        with:
          service: ${{ env.SERVICE_NAME }}
          region: ${{ env.REGION }}
          image: ${{ env.REGION }}-docker.pkg.dev/${{ env.PROJECT_ID }}/${{ env.REPOSITORY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}
          # These flags are authoritative — manual Cloud Run config changes will be
          # overwritten on the next deploy. Modify this workflow to change service config.
          flags: |
            --port=8080
            --timeout=3600
            --session-affinity
            --concurrency=20
            --min-instances=0
            --max-instances=5
            --memory=512Mi
            --cpu=1
            --allow-unauthenticated
            --no-traffic
          secrets: |
            GEMINI_API_KEY=GEMINI_API_KEY:latest
            BRAVE_API_KEY=BRAVE_API_KEY:latest
            ALIEXPRESS_APP_KEY=ALIEXPRESS_APP_KEY:latest
            ALIEXPRESS_API_KEY=ALIEXPRESS_API_KEY:latest
            ALIEXPRESS_ACCESS_TOKEN=ALIEXPRESS_ACCESS_TOKEN:latest
            ALIEXPRESS_REFRESH_TOKEN=ALIEXPRESS_REFRESH_TOKEN:latest
            ALIEXPRESS_TOKEN_EXPIRY=ALIEXPRESS_TOKEN_EXPIRY:latest
            ALIEXPRESS_REFRESH_TOKEN_EXPIRY=ALIEXPRESS_REFRESH_TOKEN_EXPIRY:latest
          env_vars: |
            GCP_PROJECT_ID=${{ env.PROJECT_ID }}
            GEMINI_LIVE_MODEL=gemini-2.5-flash-native-audio-preview-12-2025

      - name: Verify new revision before routing traffic
        run: |
          # Get the revision URL (not the service URL — the revision is not serving yet)
          REVISION_URL=$(gcloud run revisions list \
            --service=${{ env.SERVICE_NAME }} \
            --region=${{ env.REGION }} \
            --sort-by=~CREATED \
            --format='value(status.url)' \
            --limit=1)
          echo "Revision URL: ${REVISION_URL}"

          # If revision URL isn't available, fall back to service URL with tag
          if [ -z "$REVISION_URL" ]; then
            REVISION_URL="${{ steps.deploy.outputs.url }}"
          fi

          # Health check with retry (new revision may take a moment to start)
          for i in 1 2 3 4 5; do
            HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "${REVISION_URL}/health" 2>/dev/null || echo "000")
            if [ "$HTTP_CODE" = "200" ]; then
              echo "Health check passed!"
              curl -s "${REVISION_URL}/health" | jq .
              exit 0
            fi
            echo "Attempt $i: got HTTP $HTTP_CODE, retrying in 5s..."
            sleep 5
          done
          echo "Health check failed after 5 attempts"
          exit 1

      - name: Route traffic to new revision
        run: |
          gcloud run services update-traffic ${{ env.SERVICE_NAME }} \
            --to-latest \
            --region=${{ env.REGION }}
          echo "Traffic routed to latest revision."
          SERVICE_URL=$(gcloud run services describe ${{ env.SERVICE_NAME }} \
            --region=${{ env.REGION }} \
            --format='value(status.url)')
          echo "Service URL: ${SERVICE_URL}"

      - name: Rollback on failure
        if: failure() && steps.deploy.outcome == 'success'
        run: |
          echo "Deployment verification failed — rolling back to previous revision."
          # Get the second-most-recent revision (the one before this deploy)
          PREV_REVISION=$(gcloud run revisions list \
            --service=${{ env.SERVICE_NAME }} \
            --region=${{ env.REGION }} \
            --sort-by=~CREATED \
            --format='value(REVISION)' \
            --limit=2 | tail -1)
          if [ -n "$PREV_REVISION" ]; then
            gcloud run services update-traffic ${{ env.SERVICE_NAME }} \
              --to-revisions=${PREV_REVISION}=100 \
              --region=${{ env.REGION }}
            echo "Rolled back to revision: ${PREV_REVISION}"
          else
            echo "No previous revision found — this may be the first deploy."
          fi
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy-backend.yml
git commit -m "ci: add GitHub Actions workflow for Cloud Run deployment"
```

---

### Task 5: Configure GitHub Repository Variables

**Files:** None (GitHub UI / CLI only)

These values must be set as **GitHub repository variables** (not secrets — they're not sensitive) via the GitHub UI or `gh` CLI. They are referenced as `${{ vars.* }}` in the workflow.

- [ ] **Step 1: Set repository variables**

After running the GCP setup (Task 3, step 8), you'll have the Workload Identity Provider path and service account email. Set them:

```bash
# From the repo root
gh variable set GCP_PROJECT_ID --body "your-project-id"
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --body "projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions-pool/providers/github-actions-provider"
gh variable set GCP_SERVICE_ACCOUNT --body "github-actions-deployer@your-project-id.iam.gserviceaccount.com"
```

Replace the placeholder values with your actual GCP project details from the setup guide output.

---

## Chunk 4: Backend Hardening for Production

### Task 6: Tighten CORS for Production

**Files:**
- Modify: `packages/backend/src/index.ts`

The current CORS is `origin: "*"` with a TODO comment. For production, restrict it to the Chrome extension origin.

- [ ] **Step 1: Update CORS configuration**

In `packages/backend/src/index.ts`, replace the CORS middleware block:

```typescript
// Old:
const corsMiddleware = cors({
  origin: "*", // TODO: Restrict to extension origin in production
  allowMethods: ["GET", "POST"],
  allowHeaders: ["Content-Type"],
});
```

With:

```typescript
const ALLOWED_ORIGINS = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(",")
  : ["*"];

const corsMiddleware = cors({
  origin: ALLOWED_ORIGINS,
  allowMethods: ["GET", "POST"],
  allowHeaders: ["Content-Type"],
});
```

This keeps `*` as the default for local dev (no env var set) but allows production to restrict origins via `CORS_ALLOWED_ORIGINS=chrome-extension://YOUR_EXTENSION_ID`.

- [ ] **Step 2: Add CORS env var to workflow**

In `.github/workflows/deploy-backend.yml`, add `CORS_ALLOWED_ORIGINS` to the `env_vars` section of the deploy step (alongside the existing `GCP_PROJECT_ID` and `GEMINI_LIVE_MODEL`):

```yaml
          env_vars: |
            GCP_PROJECT_ID=${{ env.PROJECT_ID }}
            GEMINI_LIVE_MODEL=gemini-2.5-flash-native-audio-preview-12-2025
            CORS_ALLOWED_ORIGINS=chrome-extension://YOUR_EXTENSION_ID
```

> Replace `YOUR_EXTENSION_ID` with the actual extension ID after publishing. You can also set this as a GitHub variable to avoid hardcoding.

- [ ] **Step 3: Commit**

```bash
git add packages/backend/src/index.ts .github/workflows/deploy-backend.yml
git commit -m "feat: configurable CORS origins for production deployment"
```

---

### Task 7: Add Health Check Logging and Startup Banner

**Files:**
- Modify: `packages/backend/src/index.ts`

- [ ] **Step 1: Add environment summary on startup**

In `packages/backend/src/index.ts`, after the `injectWebSocket(server);` line, add:

```typescript
console.log("[config] GEMINI_MODEL:", process.env.GEMINI_MODEL || "gemini-2.5-flash (default)");
console.log("[config] GEMINI_LIVE_MODEL:", process.env.GEMINI_LIVE_MODEL || "not set");
console.log("[config] CORS origins:", process.env.CORS_ALLOWED_ORIGINS || "* (open)");
```

This makes it easy to verify the correct config is active in Cloud Logging.

- [ ] **Step 2: Commit**

```bash
git add packages/backend/src/index.ts
git commit -m "feat: log config summary on backend startup"
```

---

## Chunk 5: Extension Production Config

### Task 8: Add Production Backend URL Config to Extension

**Files:**
- Modify: `packages/extension/src/background/index.ts` (or wherever `BACKEND_URL` is defined)
- Modify: `packages/extension/src/manifest.json`

- [ ] **Step 1: Locate the backend URL configuration**

Search for where the backend URL is defined in the extension code:

```bash
grep -r "localhost:8080\|BACKEND_URL\|backendUrl\|apiUrl\|API_URL" packages/extension/src/
```

- [ ] **Step 2: Make backend URL configurable**

The extension needs to point at the Cloud Run URL in production. The typical pattern is a build-time env var. Wherever the backend URL is defined, ensure it reads from an environment variable with a localhost fallback:

```typescript
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:8080";
const WS_BACKEND_URL = import.meta.env.VITE_WS_BACKEND_URL || "ws://localhost:8080";
```

The actual Cloud Run URLs will be:
- REST: `https://shopping-assistant-backend-HASH-uc.a.run.app`
- WebSocket: `wss://shopping-assistant-backend-HASH-uc.a.run.app`

- [ ] **Step 3: Update manifest.json host_permissions**

The current `manifest.json` has `"host_permissions": ["http://localhost:8080/*"]`. Chrome will block fetch requests to the Cloud Run URL without adding it to host_permissions.

In `packages/extension/src/manifest.json`, update:

```json
"host_permissions": ["http://localhost:8080/*", "https://*.run.app/*"],
```

The `https://*.run.app/*` pattern covers any Cloud Run service URL. If you later set up a custom domain, add that too.

- [ ] **Step 4: Commit**

```bash
git add packages/extension/
git commit -m "feat: configurable backend URL and Cloud Run host_permissions for production"
```

---

## Chunk 6: Rate Limiting (Production Safety)

### Task 9: Add Basic Rate Limiting Middleware

**Files:**
- Create: `packages/backend/src/middleware/rate-limit.ts`
- Modify: `packages/backend/src/index.ts`

The design doc requires rate limiting before public deployment. This implements a simple in-memory sliding window rate limiter. For a single Cloud Run instance, in-memory is sufficient. For multi-instance scaling, consider upgrading to Redis-based limiting later.

- [ ] **Step 1: Create rate limiter middleware**

Create `packages/backend/src/middleware/rate-limit.ts`:

```typescript
import type { Context, Next } from "hono";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Clean expired entries every 60s to prevent memory leaks
// .unref() allows the process to exit cleanly on SIGTERM (Cloud Run graceful shutdown)
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }
}, 60_000);
cleanupTimer.unref();

export function rateLimit(opts: { windowMs: number; max: number }) {
  return async (c: Context, next: Next) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      ?? c.req.header("x-real-ip")
      ?? "unknown";

    const now = Date.now();
    const entry = store.get(ip);

    if (!entry || entry.resetAt <= now) {
      store.set(ip, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }

    if (entry.count >= opts.max) {
      c.header("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return c.json({ error: "rate_limited", message: "Too many requests" }, 429);
    }

    entry.count++;
    return next();
  };
}
```

- [ ] **Step 2: Apply rate limiter to API routes**

In `packages/backend/src/index.ts`, import and apply the middleware after CORS but before routes:

```typescript
import { rateLimit } from "./middleware/rate-limit.js";

// After CORS middleware, before routes:
// Rate limit: 60 requests per minute per IP for API endpoints
const apiRateLimit = rateLimit({ windowMs: 60_000, max: 60 });
app.use("/search/*", apiRateLimit);
app.use("/identify/*", apiRateLimit);
app.use("/chat/*", apiRateLimit);
```

> **Note:** Don't rate-limit `/health` (monitoring) or `/live` (WebSocket upgrade — it's one connection, not repeated requests).

- [ ] **Step 3: Commit**

```bash
git add packages/backend/src/middleware/rate-limit.ts packages/backend/src/index.ts
git commit -m "feat: add in-memory rate limiting for API endpoints (60 req/min per IP)"
```

---

## Chunk 7: AliExpress Token Persistence for Cloud Run (CRITICAL)

### Task 10: Secret Manager Write-Back for AliExpress Token Refresh

**Files:**
- Create: `packages/backend/src/services/secret-store.ts`
- Modify: `packages/backend/src/routes/aliexpress-auth.ts`
- Modify: `packages/backend/package.json`

**Problem:** The current token refresh flow writes updated tokens to the local `.env` file via `persistAllTokensToEnv()` (lines 373-391 of `aliexpress-auth.ts`). On Cloud Run:
1. The filesystem is ephemeral — writes are lost on instance restart
2. `writeFileSync` may fail with `EROFS` on read-only layers
3. With `--min-instances=0`, instances are frequently killed and restarted
4. After 24 hours, every new instance gets stale tokens from Secret Manager and AliExpress silently stops working

**Solution:** Create a `SecretStore` abstraction that writes to Secret Manager in production (when `GCP_PROJECT_ID` is set) and falls back to `.env` file writes locally.

- [ ] **Step 1: Add `@google-cloud/secret-manager` dependency**

```bash
cd packages/backend
pnpm add @google-cloud/secret-manager
```

> **Note:** On Cloud Run, the `@google-cloud/secret-manager` client authenticates automatically using the default service account's Application Default Credentials (ADC). No API key or credentials file needed. The Cloud Run SA was granted `roles/secretmanager.secretVersionAdder` in the GCP setup (Task 3, Section 5).

- [ ] **Step 2: Create the secret store service**

Create `packages/backend/src/services/secret-store.ts`:

```typescript
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

interface TokenStore {
  persistTokens(tokens: Record<string, string>): Promise<void>;
}

/**
 * Writes token values as new secret versions in GCP Secret Manager.
 * Used on Cloud Run so refreshed AliExpress tokens survive instance restarts.
 */
class SecretManagerStore implements TokenStore {
  private client = new SecretManagerServiceClient();
  private projectId: string;

  constructor(projectId: string) {
    this.projectId = projectId;
  }

  async persistTokens(tokens: Record<string, string>): Promise<void> {
    const results = await Promise.allSettled(
      Object.entries(tokens).map(([secretName, value]) =>
        this.client.addSecretVersion({
          parent: `projects/${this.projectId}/secrets/${secretName}`,
          payload: { data: Buffer.from(value, "utf8") },
        })
      )
    );

    for (const [i, result] of results.entries()) {
      const secretName = Object.keys(tokens)[i];
      if (result.status === "rejected") {
        console.error(`[secret-store] Failed to update ${secretName}:`, result.reason);
      } else {
        console.log(`[secret-store] Updated ${secretName} in Secret Manager`);
      }
    }

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      throw new Error(`Failed to persist ${failures.length}/${results.length} tokens to Secret Manager`);
    }
  }
}

/**
 * Falls back to writing tokens to the .env file (local development).
 */
class EnvFileStore implements TokenStore {
  private envPath: string;

  constructor(envPath: string) {
    this.envPath = envPath;
  }

  async persistTokens(tokens: Record<string, string>): Promise<void> {
    const { readFileSync, writeFileSync } = await import("node:fs");
    let content = "";
    try {
      content = readFileSync(this.envPath, "utf-8");
    } catch {
      // .env may not exist yet
    }

    for (const [key, value] of Object.entries(tokens)) {
      const regex = new RegExp(`^${key}=.*$`, "m");
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
      } else {
        content += `\n${key}=${value}\n`;
      }
    }

    writeFileSync(this.envPath, content);
    console.log(`[secret-store] Persisted ${Object.keys(tokens).length} tokens to ${this.envPath}`);
  }
}

let _store: TokenStore | null = null;

/**
 * Returns the appropriate token store:
 * - Secret Manager when GCP_PROJECT_ID is set (production / Cloud Run)
 * - .env file fallback for local development
 */
export function getTokenStore(): TokenStore {
  if (!_store) {
    const projectId = process.env.GCP_PROJECT_ID;
    if (projectId) {
      console.log("[secret-store] Using Secret Manager for token persistence");
      _store = new SecretManagerStore(projectId);
    } else {
      const path = new URL("../../.env", import.meta.url).pathname;
      console.log("[secret-store] Using .env file for token persistence");
      _store = new EnvFileStore(path);
    }
  }
  return _store;
}
```

- [ ] **Step 3: Refactor `persistAllTokensToEnv()` to use the secret store**

In `packages/backend/src/routes/aliexpress-auth.ts`, replace the `persistAllTokensToEnv()` and `persistTokenToEnv()` functions and their helpers (`getEnvPath`, `upsertEnvVar`):

**Replace imports/add import:**
```typescript
import { getTokenStore } from "../services/secret-store.js";
```

**Replace `persistAllTokensToEnv()` (lines 373-391):**

```typescript
async function persistAllTokens(): Promise<void> {
  const tokens: Record<string, string> = {
    ALIEXPRESS_ACCESS_TOKEN: getAccessToken(),
    ALIEXPRESS_TOKEN_EXPIRY: String(getTokenExpiry()),
  };

  if (refreshToken) {
    tokens.ALIEXPRESS_REFRESH_TOKEN = refreshToken;
  }
  if (refreshTokenExpiry) {
    tokens.ALIEXPRESS_REFRESH_TOKEN_EXPIRY = String(refreshTokenExpiry);
  }

  try {
    await getTokenStore().persistTokens(tokens);
  } catch (err) {
    console.warn("[aliexpress] Failed to persist tokens:", err);
  }
}
```

**Replace `persistTokenToEnv()` (lines 363-371):**

```typescript
async function persistToken(token: string): Promise<void> {
  try {
    await getTokenStore().persistTokens({ ALIEXPRESS_ACCESS_TOKEN: token });
  } catch (err) {
    console.warn("[aliexpress] Failed to persist access token:", err);
  }
}
```

**Update all call sites:**
- Line 192 (`exchangeCodeForToken`): `persistAllTokensToEnv()` → `await persistAllTokens()`
- Line 263 (`refreshAccessToken`): `persistAllTokensToEnv()` → `await persistAllTokens()`
- Line 112 (`/auth/aliexpress/persist` handler): `persistTokenToEnv(token)` → `await persistToken(token)`

**Remove dead code:**
- Delete `getEnvPath()` (lines 349-353)
- Delete `upsertEnvVar()` (lines 355-361)
- Delete the old `persistAllTokensToEnv()` and `persistTokenToEnv()` functions
- Remove `import { readFileSync, writeFileSync } from "node:fs"` if no longer used elsewhere
- Remove `import { resolve, dirname } from "node:path"` if no longer used elsewhere
- Remove `import { fileURLToPath } from "node:url"` if no longer used elsewhere

- [ ] **Step 4: Update `initAliExpressAutoRefresh()` startup to read from Secret Manager on Cloud Run**

The current `initAliExpressAutoRefresh()` reads from `process.env.*` which works for both `.env` (local) and Secret Manager env injection (Cloud Run) **on first start**. However, when a new Cloud Run instance starts after tokens have been refreshed by a previous instance, the injected env vars contain the original secret version, not the refreshed one.

Add a startup check that reads the latest token values from Secret Manager if available:

```typescript
export async function initAliExpressAutoRefresh(): Promise<void> {
  // On Cloud Run, check Secret Manager for newer token values than what was
  // injected at deploy time. A previous instance may have refreshed them.
  if (process.env.GCP_PROJECT_ID) {
    try {
      const { SecretManagerServiceClient } = await import("@google-cloud/secret-manager");
      const client = new SecretManagerServiceClient();
      const projectId = process.env.GCP_PROJECT_ID;

      const secretNames = [
        "ALIEXPRESS_ACCESS_TOKEN",
        "ALIEXPRESS_TOKEN_EXPIRY",
        "ALIEXPRESS_REFRESH_TOKEN",
        "ALIEXPRESS_REFRESH_TOKEN_EXPIRY",
      ];

      for (const name of secretNames) {
        try {
          const [version] = await client.accessSecretVersion({
            name: `projects/${projectId}/secrets/${name}/versions/latest`,
          });
          const value = version.payload?.data?.toString();
          if (value) {
            process.env[name] = value;
          }
        } catch {
          // Secret may not exist (e.g., refresh token expiry). Skip.
        }
      }
      console.log("[aliexpress] Loaded latest token values from Secret Manager");
    } catch (err) {
      console.warn("[aliexpress] Failed to read tokens from Secret Manager, using env vars:", err);
    }
  }

  // Rest of existing initAliExpressAutoRefresh() logic...
  // Re-read the potentially-updated env vars:
  const tokenExpiry = Number(process.env.ALIEXPRESS_TOKEN_EXPIRY) || 0;
  const hasToken = !!process.env.ALIEXPRESS_ACCESS_TOKEN;
  // ... (existing scheduling logic)
}
```

> **Note:** The module-level `refreshToken` and `refreshTokenExpiry` variables in `aliexpress-auth.ts` are set at import time from `process.env`. Since `initAliExpressAutoRefresh()` runs after module initialization, update those variables inside the function after reading from Secret Manager:
> ```typescript
> refreshToken = process.env.ALIEXPRESS_REFRESH_TOKEN ?? "";
> refreshTokenExpiry = Number(process.env.ALIEXPRESS_REFRESH_TOKEN_EXPIRY) || 0;
> ```
> Similarly, call `setAccessToken()` from `aliexpress.ts` to update the service module's in-memory state.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/services/secret-store.ts packages/backend/src/routes/aliexpress-auth.ts packages/backend/package.json pnpm-lock.yaml
git commit -m "feat: AliExpress token persistence via Secret Manager on Cloud Run

Tokens are written back to Secret Manager after each refresh so new
Cloud Run instances get fresh tokens instead of the original (possibly
expired) ones injected at deploy time. Falls back to .env file writes
for local development."
```

---

## Execution Order

| Order | Task | Depends On | Duration |
|-------|------|------------|----------|
| 1 | Task 1: Env + ai-client config | — | 3 min |
| 2 | Task 2: Dockerfile fix + pnpm pin + non-root user | — | 10 min |
| 3 | Task 3: GCP setup guide (incl. Secret Manager write roles) | — | 5 min |
| 4 | Task 4: GitHub Actions workflow (concurrency + rollback) | — | 5 min |
| 5 | Task 5: GitHub repo variables | Task 3 (needs GCP outputs) | 2 min |
| 6 | Task 6: CORS hardening | — | 3 min |
| 7 | Task 7: Startup logging | Task 6 | 2 min |
| 8 | Task 8: Extension prod config | — | 5 min |
| 9 | Task 9: Rate limiting (with `.unref()` for graceful shutdown) | Task 6 (both modify index.ts) | 5 min |
| 10 | Task 10: AliExpress Secret Manager write-back | Task 3 (needs SA roles) | 15 min |

Tasks 1–4 are fully independent and can be parallelized. Task 5 requires Task 3's GCP setup to have been run to get the actual values. Tasks 6, 7, 9 are sequential (all modify `index.ts`). Task 8 is independent. **Task 10 is critical** — without it, AliExpress integration silently breaks after 24 hours on Cloud Run.

---

## Rollback

If a deployment goes wrong, roll back to the previous revision:

```bash
# List revisions
gcloud run revisions list --service=shopping-assistant-backend --region=us-central1

# Route 100% traffic to previous revision
gcloud run services update-traffic shopping-assistant-backend \
  --to-revisions=PREVIOUS_REVISION_NAME=100 \
  --region=us-central1
```

---

## Post-Deployment Verification Checklist

After GCP setup is complete and the first deploy lands:

- [ ] `curl https://SERVICE_URL/health` returns `{"status":"ok"}`
- [ ] `curl -X POST https://SERVICE_URL/search -H 'Content-Type: application/json' -d '...'` returns search results
- [ ] `curl -X POST https://SERVICE_URL/chat -H 'Content-Type: application/json' -d '...'` returns chat response
- [ ] WebSocket connects to `wss://SERVICE_URL/live` (even if Live proxy isn't implemented yet, the connection should upgrade)
- [ ] Cloud Logging shows the startup config banner
- [ ] Cloud Logging shows `[secret-store] Using Secret Manager for token persistence`
- [ ] Cloud Logging shows `[aliexpress] Loaded latest token values from Secret Manager`
- [ ] After 24+ hours, verify a new Cloud Run instance still has valid AliExpress tokens (check logs for successful token refresh + Secret Manager write-back)
- [ ] GitHub Actions workflow succeeds on next push to `main` that touches `shopping-assistant/packages/backend/`
- [ ] Manual `workflow_dispatch` trigger works from GitHub Actions UI
- [ ] Failed health check triggers automatic rollback (test by deploying a broken image)
