# GCP Deployment & Gemini Live Integration Design

**Date:** 2026-03-15
**Goal:** Deploy the current shopping-assistant repo to GCP in a way that supports the existing REST API, keeps secrets server-side, and cleanly hooks up the Gemini Live voice agent for the extension sidepanel.
**Approach:** Keep the current monorepo shape, deploy `packages/backend` as a single Cloud Run service, and use that backend as both the normal API surface and the Gemini Live WebSocket proxy.

---

## Summary

This repo already has the right high-level boundaries for a simple GCP deployment. The Chrome extension remains the only client, while the backend becomes one containerized Cloud Run service that handles `/identify`, `/search`, `/chat`, and `/live`.

That structure keeps Gemini and Brave credentials off the client, avoids introducing extra infrastructure too early, and matches the current codebase and architecture docs closely. The voice path should run directly from the sidepanel to the backend over WebSocket, with Cloud Run maintaining the upstream Gemini Live session.

**Decisions made:**
- Keep the deployment scoped to the current monorepo only
- Deploy a single backend service to Cloud Run first
- Keep the extension out of GCP and point it at the deployed backend URL
- Use Cloud Run as the Gemini Live proxy endpoint
- Store API secrets in GCP Secret Manager
- Treat voice sessions as connection-scoped, not globally persistent

## Alternatives Considered

### 1. Single Cloud Run service for API + Live proxy

Deploy one backend service that serves normal REST routes and the `/live` WebSocket endpoint.

**Why chosen:** Best fit for the current repo. Lowest ops overhead, minimal code restructuring, and already aligned with the architecture in [architecture-spec.md](docs/architecture-spec.md).

### 2. Split Cloud Run services

Deploy one service for `/identify`, `/search`, `/chat` and a second dedicated service for `/live`.

**Why not chosen initially:** Cleaner long-term scaling, but unnecessary complexity for the current repo stage. It adds deployment, config, and monitoring overhead without solving an immediate problem.

### 3. Add a separate realtime transport layer

Use a dedicated realtime platform or a more complex media architecture for voice instead of a direct backend WebSocket proxy.

**Why not chosen:** Too large a change from the current code structure and product scope. The repo already assumes a backend-managed Live API bridge.

## Section 1: Deployment Architecture

The deployment structure for this repo should stay simple:

```text
Chrome Extension
  content script / background / sidepanel
    -> Cloud Run backend
      -> Gemini API / Gemini Live API
      -> Brave Search API
```

### Backend service

`packages/backend` is the only server deployable in the repo today. It already has:

- REST routes in [index.ts](packages/backend/src/index.ts)
- WebSocket entry point at `/live`
- Gemini client wiring in [ai-client.ts](packages/backend/src/services/ai-client.ts)
- a production container build in [Dockerfile](packages/backend/Dockerfile)

That means the natural deployment unit is a single container image built from the existing backend package and pushed to Artifact Registry, then deployed to Cloud Run.

### Extension role

The extension is not deployed into GCP. It is built locally or in CI and configured with:

- a production HTTPS base URL for `/identify`, `/search`, `/chat`
- a production WSS URL for `/live`

The extension sidepanel should be treated as the realtime voice client. The background worker can continue orchestrating normal search flows, but voice should connect from the sidepanel directly to the backend because it is the persistent UI surface.

## Section 2: GCP Services

The initial GCP footprint can stay very small.

### Required services

- **Cloud Run** for the backend runtime
- **Artifact Registry** for the backend container image
- **Secret Manager** for API credentials
- **Cloud Logging** for backend logs and Live session debugging

### Useful but optional early additions

- **Cloud Build** or **GitHub Actions** for CI/CD
- **Cloud Monitoring / alerting** for uptime and error-rate visibility
- **Custom domain** for a stable production API hostname

### Environment and secret model

At minimum, the backend deployment should receive:

- `GEMINI_API_KEY`
- `BRAVE_API_KEY`
- `GEMINI_MODEL`
- `GEMINI_LIVE_MODEL`

The current code already reads `GEMINI_API_KEY` and `GEMINI_MODEL`. Live model selection should be added alongside that existing pattern rather than introducing a separate config system.

## Section 3: Gemini Live Integration Shape

The current repo should use this voice flow:

```text
Sidepanel mic capture
  -> WebSocket to Cloud Run /live
    -> backend opens upstream Gemini Live session
      -> backend forwards audio, text, transcripts, and audio responses
```

### Why the sidepanel should own the voice session

The sidepanel is the UI that stays open during the shopping workflow, while the MV3 service worker is not a good place to anchor long-lived realtime voice state. That makes the sidepanel the correct place for:

- microphone capture
- playback of assistant audio
- transcript rendering
- reconnect and retry behavior

The backend then acts as a secure broker that:

- holds Gemini credentials
- creates the Live API session
- translates between extension message types and Gemini Live events
- keeps provider-specific protocol details out of the extension

### API split

The clean split for this repo is:

- `POST /identify`, `POST /search`, `POST /chat` for non-streaming request/response flows
- `GET /live` upgraded to WebSocket for streaming voice interactions

This matches the current code organization and lets text chat and voice share the same product/result context while using different transports.

## Section 4: Runtime Behavior

### Cloud Run request model

Cloud Run is a good fit here because it supports HTTP and WebSocket traffic in a managed runtime, but the design should assume that Live sessions are tied to individual client connections.

The safe mental model is:

- one open sidepanel voice interaction maps to one backend WebSocket connection
- that backend connection owns one upstream Gemini Live session
- if the socket drops, the sidepanel reconnects and re-sends current context

This keeps the backend effectively stateless outside the lifetime of each active connection.

### Cold starts and demos

For search-only traffic, scale-to-zero is fine. For voice demos, cold starts can make the first interaction feel rough. A practical first deployment should likely keep one warm instance during demos or testing windows.

### Concurrency

Because the same service may handle both short REST requests and longer-lived voice sockets, concurrency should start conservative and be raised only after observing behavior under load.

### Timeouts

The Cloud Run request timeout should be configured with WebSocket session duration in mind rather than just REST latency. Voice sessions should still have explicit app-level idle handling so stale sockets close cleanly.

## Section 5: Security & Production Guardrails

This repo does not need heavy infrastructure, but it does need a few backend guardrails before public deployment.

### Minimum protections

- keep Gemini and Brave credentials only in Secret Manager / Cloud Run env injection
- replace the current wildcard CORS setup with an allowlist for expected extension origins
- validate and rate-limit incoming API usage at the backend or edge
- use HTTPS/WSS only

### Extension trust model

The extension is not a trusted secret holder, so all provider access should remain server-side. The browser can hold user session context and cached results, but it should never talk directly to Gemini or Brave with privileged credentials.

## Section 6: Deployment Workflow

The deployment path for the current repo should be:

1. Build backend container from `packages/backend`
2. Push image to Artifact Registry
3. Deploy image to Cloud Run with required env vars and secrets
4. Verify `/health`, then verify `/search` and `/chat`
5. Implement and verify `/live` against Gemini Live
6. Point the extension config at the deployed Cloud Run URLs

### Repo impact

This design mostly affects:

- [index.ts](packages/backend/src/index.ts)
- [live.ts](packages/backend/src/ws/live.ts)
- [ai-client.ts](packages/backend/src/services/ai-client.ts)
- extension config files that store backend URLs

The main missing piece today is the actual Gemini Live upstream session handling in [live.ts](packages/backend/src/ws/live.ts), which is still a stub.

## Recommended Next Steps

1. Add explicit backend config for production base URLs and `GEMINI_LIVE_MODEL`
2. Implement the real upstream Gemini Live proxy in the backend WebSocket handler
3. Add extension-side production config for HTTPS/WSS backend endpoints
4. Tighten CORS and add lightweight rate limiting before public demos
5. Deploy the backend to Cloud Run and test text flows first, then voice

## Scope Boundaries

**In scope:**

- current repo only
- single-service Cloud Run deployment shape
- Gemini Live connection model for the extension sidepanel
- secrets, runtime, and safety basics

**Out of scope:**

- mobile or non-extension clients
- multi-service microservice decomposition
- heavy production infra such as queues, databases, or auth systems
- detailed Terraform or step-by-step GCP command instructions

## Reference Notes

This design aligns with the current repo structure and with Google’s current Cloud Run and Vertex AI Live API documentation for WebSocket-based realtime sessions.
