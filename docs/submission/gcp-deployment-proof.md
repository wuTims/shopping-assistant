# Proof of Google Cloud Deployment

Evidence that the Shopping Source Discovery Agent backend runs on Google Cloud Platform.

---

## Live Service

The production backend runs on Cloud Run at:

```
https://shopping-assistant-backend-636264173894.us-central1.run.app
```

This URL is configured in the extension's production build:
- **File:** [`packages/extension/.env.production`](../../packages/extension/.env.production)

The extension manifest grants access to Cloud Run via host permissions:
- **File:** [`packages/extension/src/manifest.json`](../../packages/extension/src/manifest.json) (line 7)
```json
"host_permissions": ["http://localhost:8080/*", "https://*.run.app/*"]
```

---

## GCP Services Used

| Service | Purpose | Evidence |
|---------|---------|----------|
| **Cloud Run** | Hosts the backend container (Hono + Node.js) | [`.github/workflows/deploy-backend.yml`](../../.github/workflows/deploy-backend.yml) lines 91-125 |
| **Artifact Registry** | Stores Docker images tagged by git SHA | Workflow lines 80-89 |
| **Secret Manager** | Stores API keys; runtime write-back for AliExpress token refresh | [`packages/backend/src/services/secret-store.ts`](../../packages/backend/src/services/secret-store.ts) |
| **Workload Identity Federation** | Keyless GitHub Actions auth via OIDC | Workflow lines 67-72 |
| **IAM** | Service account roles for deployer and compute SA | [`docs/gcp-setup.md`](../gcp-setup.md) sections 5, 8 |

---

## CI/CD Pipeline

**File:** [`.github/workflows/deploy-backend.yml`](../../.github/workflows/deploy-backend.yml)

The pipeline runs on every push to `main` that touches backend or shared code. It:

1. **Typechecks** the backend (fails deployment on type errors)
2. **Builds** a multi-stage Docker image from [`packages/backend/Dockerfile`](../../packages/backend/Dockerfile)
3. **Pushes** the image to Artifact Registry (`us-central1-docker.pkg.dev/{PROJECT}/shopping-assistant/backend:{SHA}`)
4. **Deploys** to Cloud Run with a `canary` tag and zero traffic
5. **Verifies** the new revision via `/health` endpoint (5 retries, 5s backoff)
6. **Routes traffic** to the new revision on success
7. **Rolls back** to the previous revision on health check failure

---

## Successful Deployment History

Three consecutive successful deployments on 2026-03-16 (via `gh run list`):

| Run ID | Trigger | Duration | Result |
|--------|---------|----------|--------|
| 23164925789 | push (fix: cluster price extraction) | 2m 9s | success |
| 23163928382 | push (configurable backend URL) | 1m 53s | success |
| 23163700005 | workflow_dispatch (manual) | 1m 51s | success |

---

## Runtime GCP SDK Usage

The backend uses the `@google-cloud/secret-manager` SDK (v6.1.1) at runtime to persist refreshed AliExpress OAuth tokens back to Secret Manager:

**File:** [`packages/backend/src/services/secret-store.ts`](../../packages/backend/src/services/secret-store.ts)

This code detects whether it's running on GCP (via `GCP_PROJECT_ID` env var) and uses the Secret Manager API to add new secret versions when tokens are refreshed. Locally, it falls back to `.env` file storage.

**Dependency:** `packages/backend/package.json` includes `"@google-cloud/secret-manager": "^6.1.1"`.

---

## Cloud Run Configuration

From the deployment workflow (lines 100-112):

```yaml
flags: |
  --port=8080
  --timeout=3600          # 1hr max for WebSocket sessions
  --session-affinity      # Reconnecting clients route to same instance
  --cpu-boost             # Extra CPU during cold starts
  --concurrency=20
  --min-instances=1       # Warm instance for demos
  --max-instances=5
  --memory=512Mi
  --cpu=1
  --allow-unauthenticated
```

Secrets injected from Secret Manager (lines 113-121):
- `GEMINI_API_KEY`, `BRAVE_API_KEY`
- `ALIEXPRESS_APP_KEY`, `ALIEXPRESS_API_KEY`
- `ALIEXPRESS_ACCESS_TOKEN`, `ALIEXPRESS_REFRESH_TOKEN`
- `ALIEXPRESS_TOKEN_EXPIRY`, `ALIEXPRESS_REFRESH_TOKEN_EXPIRY`
