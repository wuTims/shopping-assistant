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
export GITHUB_REPO="shopping-assistant"
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

# Get the service URL after first deploy (needed for AliExpress callback)
# SERVICE_URL=$(gcloud run services describe $SERVICE_NAME --region=$REGION --format='value(status.url)' --project=$PROJECT_ID)

# Deploy to Cloud Run
gcloud run deploy $SERVICE_NAME \
  --image=$IMAGE_TAG \
  --region=$REGION \
  --port=8080 \
  --timeout=3600 \
  --session-affinity \
  --cpu-boost \
  --concurrency=20 \
  --min-instances=1 \
  --max-instances=5 \
  --memory=512Mi \
  --cpu=1 \
  --allow-unauthenticated \
  --update-secrets=GEMINI_API_KEY=GEMINI_API_KEY:latest,BRAVE_API_KEY=BRAVE_API_KEY:latest,ALIEXPRESS_APP_KEY=ALIEXPRESS_APP_KEY:latest,ALIEXPRESS_API_KEY=ALIEXPRESS_API_KEY:latest,ALIEXPRESS_ACCESS_TOKEN=ALIEXPRESS_ACCESS_TOKEN:latest,ALIEXPRESS_REFRESH_TOKEN=ALIEXPRESS_REFRESH_TOKEN:latest,ALIEXPRESS_TOKEN_EXPIRY=ALIEXPRESS_TOKEN_EXPIRY:latest,ALIEXPRESS_REFRESH_TOKEN_EXPIRY=ALIEXPRESS_REFRESH_TOKEN_EXPIRY:latest \
  --set-env-vars=GCP_PROJECT_ID=${PROJECT_ID},GEMINI_LIVE_MODEL=gemini-2.5-flash-native-audio-preview-12-2025 \
  --project=$PROJECT_ID
```

Note: `--min-instances=1` keeps one warm instance for hackathon demos (~$0.05/hr). `--cpu-boost` gives extra CPU during cold starts. After the hackathon, set `--min-instances=0` to scale to zero.

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
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/run.developer"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/iam.serviceAccountUser"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/artifactregistry.writer"

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

## 9. Set GitHub Repository Variables

After running Section 8, set these as GitHub repository variables:

```bash
gh variable set GCP_PROJECT_ID --body "your-project-id"
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --body "projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions-pool/providers/github-actions-provider"
gh variable set GCP_SERVICE_ACCOUNT --body "github-actions-deployer@your-project-id.iam.gserviceaccount.com"

# CORS: set to extension origin once known (e.g. chrome-extension://YOUR_ID)
# Leave unset to default to * (open) during development
gh variable set CORS_ALLOWED_ORIGINS --body "chrome-extension://YOUR_EXTENSION_ID"
```

## 10. Manage Min Instances for Demos

```bash
# Keep 1 warm instance (avoids cold starts, costs ~$0.05/hr)
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
| `--timeout=3600` | 60 min | WebSocket `/live` sessions need long timeouts. Hard cap per connection. |
| `--session-affinity` | enabled | Reconnecting WS clients route to same instance |
| `--cpu-boost` | enabled | Extra CPU during cold starts (free) |
| `--min-instances=1` | hackathon | Keep warm for demos (~$0.05/hr). Set to 0 after. |
| `--concurrency=20` | 20 req/instance | Prevents overloading with long-lived WS + REST |
| `--max-instances=5` | conservative | Start low, increase after load testing |
| `--memory=512Mi` | 512 MB | Sufficient for Hono + sharp image processing |
| `--cpu=1` | 1 vCPU | Sufficient for current load |
| `--allow-unauthenticated` | public | Extension needs public access |
| **No** `--use-http2` | deliberate | WebSockets use HTTP/1.1 upgrade; HTTP/2 breaks them |
