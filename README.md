# Shopping Source Discovery Agent

Chrome extension (MV3) that finds cheaper product alternatives across marketplaces, powered by Gemini and Brave Search. Backend deployed on GCP Cloud Run with automated CI/CD.

**[Architecture Overview](docs/submission/architecture-overview.md)** | **[GCP Deployment Proof](docs/submission/gcp-deployment-proof.md)** | **[Project Summary](docs/submission/project-summary.md)**

## Prerequisites

- **Node.js >= 20** — check with `node -v`
  - Install via [nvm](https://github.com/nvm-sh/nvm): `nvm install 20 && nvm use 20`
  - Or download from [nodejs.org](https://nodejs.org/)
- **pnpm** — check with `pnpm -v`
  - Install via corepack (ships with Node 20+): `corepack enable && corepack prepare pnpm@latest --activate`
  - Or standalone: `npm install -g pnpm`
- **Google Chrome** (or any Chromium-based browser)

## API Keys

The backend requires two API keys (AliExpress is optional). Copy the example env file and fill in your keys:

```bash
cp packages/backend/.env.example packages/backend/.env
```

Edit `packages/backend/.env`:

```
GEMINI_API_KEY=<your-gemini-api-key>
BRAVE_API_KEY=<your-brave-search-api-key>
PORT=8080
```

- Get a Gemini API key at [Google AI Studio](https://aistudio.google.com/apikey)
- Get a Brave Search API key at [Brave Search API](https://brave.com/search/api/)

In production, secrets are managed via GCP Secret Manager. See [GCP Setup Guide](docs/submission/gcp-setup.md) for deployment configuration.

## Build

```bash
# 1. Install all workspace dependencies
pnpm install

# 2. Build all packages (shared types → extension → backend)
pnpm build
```

The extension build output will be at `packages/extension/dist/`.

## Load the Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `packages/extension/dist` folder
5. The "Shopping Source Discovery" extension should now appear in your extensions list

## Start the Backend

In a separate terminal, start the backend dev server:

```bash
pnpm dev:backend
```

The backend runs on `http://localhost:8080` by default.

## Usage

1. Navigate to any product page (e.g. Amazon, eBay, or any online store)
2. The content script will detect product images and show an overlay icon
3. Click the overlay to search for cheaper alternatives across Brave Search and AliExpress
4. Results appear in the side panel, ranked by visual similarity and price
5. Ask follow-up questions via text chat or voice (Gemini Live API)

## Deployment

The backend deploys to GCP Cloud Run automatically on push to `main` via GitHub Actions. The pipeline typechecks, builds a Docker image, deploys a canary revision, health-checks it, and routes traffic (or rolls back).

- **Workflow:** [`.github/workflows/deploy-backend.yml`](.github/workflows/deploy-backend.yml)
- **Setup:** [GCP Setup Guide](docs/submission/gcp-setup.md) (one-time infrastructure provisioning)
- **Proof:** [GCP Deployment Proof](docs/submission/gcp-deployment-proof.md)

## Development

For active development with hot-reload:

```bash
# Terminal 1 — extension dev server (HMR)
pnpm dev:ext

# Terminal 2 — backend dev server (watch mode)
pnpm dev:backend
```

When using `pnpm dev:ext`, reload the extension in `chrome://extensions` after the initial load to pick up the dev server.

## Troubleshooting

- **Extension not detecting products:** Make sure the backend is running and accessible at `http://localhost:8080`
- **API errors in backend logs:** Verify your `.env` keys are valid and have sufficient quota
- **Build errors after pulling changes:** Run `pnpm build:shared` first — the extension and backend depend on the shared types package

## Architecture

See [Architecture Overview](docs/submission/architecture-overview.md) for the full system design and [Architecture Diagram](docs/submission/architecture-diagram.mermaid) for a visual representation.

```
packages/
├── shared/      TypeScript types + constants (the contract)
├── extension/   Chrome Extension (Vite + CRXJS + React 19)
└── backend/     Cloud Run API (Hono + Node.js)
```

Key technologies: Gemini 2.5 Flash, Gemini Embedding, Gemini Live API (voice), Brave Search, AliExpress TOP API, GCP Cloud Run, Secret Manager, Workload Identity Federation.
