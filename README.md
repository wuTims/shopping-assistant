# Shopping Source Discovery Agent

Chrome extension (MV3) that finds cheaper product alternatives across marketplaces, powered by Gemini and Brave Search.

## Prerequisites

- **Node.js >= 20** — check with `node -v`
  - Install via [nvm](https://github.com/nvm-sh/nvm): `nvm install 20 && nvm use 20`
  - Or download from [nodejs.org](https://nodejs.org/)
- **pnpm** — check with `pnpm -v`
  - Install via corepack (ships with Node 20+): `corepack enable && corepack prepare pnpm@latest --activate`
  - Or standalone: `npm install -g pnpm`
- **Google Chrome** (or any Chromium-based browser)

## API Keys

The backend requires two API keys. Copy the example env file and fill in your keys:

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
2. The content script will detect product images and show an overlay
3. Click the overlay to search for cheaper alternatives
4. Results appear in the side panel

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
