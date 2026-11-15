# OpenFish Cloudflare Browser Run (preview)

This is a separate Cloudflare Worker deployment target. It does not replace the local Node.js bridge or the Chrome extension. The local mode remains available.

## Architecture

- Cloudflare Worker serves the mobile-friendly dashboard and authenticated REST API.
- `@cloudflare/playwright` drives a Browser Run Chromium instance through the `BROWSER` binding.
- `agents/mcp/server` exposes the same browser tools over remote MCP Streamable HTTP at `/mcp`.
- `SESSIONS` is an optional KV binding for short-lived browser storage state (24 hours). Without it, each request starts with a fresh browser context and session cookies are not retained.

## Install and validate

Node.js 20+:

```bash
cd cloudflare
npm install
npm run check
npm test
npx wrangler dev
```

The local Worker dashboard is shown at the URL printed by Wrangler. The Browser Run binding requires Cloudflare remote development/deployment; use the account's Browser Run entitlement.

## Cloudflare setup

1. In Cloudflare, create a Worker named `openfish-browser-preview` or let Wrangler create it.
2. Create a Worker secret named `OPENFISH_API_TOKEN` with a randomly generated value of at least 24 characters. Never commit this token.
3. Optional: create a KV namespace named `OPENFISH_SESSIONS`, bind it to this Worker as `SESSIONS`, and configure the same binding for preview and production. This stores browser cookies/localStorage for up to 24 hours. Use a separate namespace per environment.
4. Set `ALLOWED_EXTENSION_ORIGIN` to the exact Chrome extension origin when the extension is connected. Leave empty for same-origin dashboard requests.
5. For automatic preview deployment, add these three repository Actions secrets under GitHub → Settings → Secrets and variables → Actions:
   - `CLOUDFLARE_API_TOKEN`: Cloudflare API token with Workers Scripts Edit and Browser Rendering Edit permissions.
   - `CLOUDFLARE_ACCOUNT_ID`: your Cloudflare account ID.
   - `OPENFISH_API_TOKEN`: a new random secret with at least 24 characters. Do not paste it into chat or commit it.
   Then push a commit to `feature/cloudflare-browser-run-v1`; the gated workflow will deploy the preview Worker and set its API token. If the secrets are absent, the workflow skips deployment without exposing credentials.
6. Or deploy manually from this directory:

```bash
npx wrangler deploy
```

The Worker uses Cloudflare's Browser Run binding. No Cloudflare account ID or Browser Run API token is embedded in source. The first preview deployment still requires a Cloudflare account with Browser Run enabled and a Worker secret configured.

## Endpoints

- `GET /health` — unauthenticated health/version check.
- `GET /api/v1/tools` — authenticated tool catalog.
- `POST /api/v1/execute` — authenticated, bounded browser action sequence.
- `/mcp` — authenticated MCP Streamable HTTP endpoint.

All API/MCP routes require `Authorization: Bearer <OPENFISH_API_TOKEN>`.

## Safety model

- Only HTTP(S) URLs are accepted; embedded credentials, localhost, common private/reserved IPv4 ranges, link-local, and local-only hostnames are blocked.
- This application-level URL check is defense in depth, not a complete DNS-rebinding or network-egress sandbox. Before enabling untrusted users, add Cloudflare Browser Run guardrails/outbound filtering and per-user authorization.
- Plans are limited to eight steps. Click/fill require `approved: true`; password, credential, payment, and other sensitive fields are blocked. Submit/purchase/send/delete/publish/transfer-like actions are blocked.
- The dashboard stores the API token only in the current tab's `sessionStorage`.
- Do not expose a shared operator token to multiple unrelated users. Add OAuth and per-user session IDs before public multi-user operation.

## Important preview limitations

The cloud planner currently creates a deterministic draft, not an LLM-generated plan. The existing local planner continues to use Ollama. The cloud worker runs one browser context per tool call; with KV enabled, cookies and local storage are restored, but open tabs and live in-memory page state are not preserved between calls. This preview is designed to validate remote execution and MCP connectivity before a durable per-user browser-session layer is added.

## Relationship to local mode

The existing `npm run start:bridge`, `npm run start:mcp`, and Chrome extension local flow are unchanged. This worker is an additional remote mode.


## Preview deployment trigger

- Trigger commit: request preview deployment after repository Actions secrets are configured.
