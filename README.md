# OpenFish AI Browser

Open-source, free-first browser automation starter. Version: **2.17.0**.

## What is included
- **MCP server** (`packages/mcp-server`): browser tools for ChatGPT-compatible MCP clients, including plan review and explicitly approved sequential execution.
- **Chrome extension** (`packages/chrome-extension`): side panel to inspect the current page, generate an AI plan, review it, and explicitly approve execution.
- **Browser runtime** (`packages/runtime`): Playwright browser session, local by default; can connect to a remote Chromium endpoint with `BROWSER_WS_ENDPOINT`.
- **Local AI planner**: optional Ollama integration (default model `qwen2.5:3b`) creates constrained JSON plans.
- **Safety defaults**: no credential collection; sensitive fields and potentially irreversible actions are blocked during plan execution.

## AI workbench (2.17.0 integration center)
- Integrates page and multi-tab context, model-provider settings, local Skills and Memory, writing, approved browser task plans, workspace snapshots, voice I/O, research search, and file input.
- Supports Ollama and OpenAI-compatible, Anthropic, and Gemini-style chat endpoints configured by the user. API keys and local Memory/Skills are stored in the browser's local profile; they are not synced between devices.
- Research uses authenticated Worker endpoints to query DuckDuckGo and Bing, then fetches public web pages for source cross-checking. Public-source fetching is restricted to HTTP(S) hostnames, rejects IP-literal/local targets, and revalidates redirects.
- PDF.js, Mammoth (DOCX), and SheetJS (XLS/XLSX) are loaded from public CDNs; image understanding is passed to compatible vision-capable models. Scanned PDFs need OCR, which is not yet included.
- Browser Agent plans are limited to approved navigation, tab switching, history, and scrolling actions. Each plan requires explicit user approval; failed steps are retried once and may produce a separate recovery plan for review.
- Cloud model use may incur provider charges. Local model use requires the browser device to reach the Ollama host; a phone's `127.0.0.1` refers to the phone itself. Direct provider calls can be limited by provider CORS policies.
- This is an integration release, not a claim that every capability is fully production-verified. Cross-device Memory sync, scanned-document OCR, broader file formats, and real-device end-to-end acceptance remain follow-up work. Agent plans are revalidated at generation, recovery, and execution time; editing the goal invalidates prior approval.

## Requirements
- Node.js 20+
- Chrome / Chromium
- Install dependencies with `npm install`
- Install Playwright browser: `npx playwright install chromium`

## Optional local AI planner
Install [Ollama](https://ollama.com), then run `ollama pull qwen2.5:3b`. Configure `OPENFISH_MODEL` and `OLLAMA_URL` in `.env` as needed. The MCP `plan_task` tool uses this local model; no hosted AI API key is required.

## Run locally
```bash
npm install
npm run start:bridge
```
Then load `packages/chrome-extension` in `chrome://extensions` → Developer mode → Load unpacked.
The extension connects to `http://127.0.0.1:8787`.

Run the MCP server separately:
```bash
npm run start:mcp
```
Configure your MCP host to launch `node packages/mcp-server/src/index.js` from this project directory using stdio.

## Visual admin dashboard\nOpen `http://127.0.0.1:8787/admin` after starting the bridge to open the local control panel. It displays bridge uptime, API request/error counts, browser connection mode, recent API activity, and a task planner with explicit approval before execution. Dashboard telemetry is held in process memory and resets when the bridge restarts. The panel is served only by the local bridge; it is not a public cloud admin site.\n\n## Unified local runtime (v1.3.3)\nThe bridge is the single owner of the Playwright browser. Both the Chrome side panel and the stdio MCP server call the same local bridge API; MCP no longer launches a second browser process. Start `npm run start:bridge` before launching either client. The MCP server exposes `open_page`, `read_page`, `plan_task`, `execute_plan`, `click_element`, `fill_element`, `take_screenshot`, `list_interactive_elements`, and `get_accessibility_snapshot`.\n\n## Review and execution flow
1. Ask the local AI planner to generate a plan for the current page.
2. Review the complete plan in the Chrome side panel or MCP response.
3. Explicitly approve the exact plan using the side-panel confirmation or the MCP `execute_plan` tool with `approved: true`.
4. The runtime executes steps in order and stops on the first failure or blocked action.

The side panel invalidates old plans when the task text changes, disables execution until a fresh plan is generated, and clears the plan after execution. The executor accepts at most 8 steps. It requires unique, visible, enabled targets; only button-like controls may be clicked, and only ordinary editable fields may be filled. Passwords, tokens, recovery codes, payment/identity fields, hidden fields, and potentially irreversible actions (such as payment, sending, deletion, publishing, and form submission) are blocked. Review each plan before approval. The executor does not bypass CAPTCHAs, access controls, paywalls, or site restrictions.

## Cloud browser
Set `BROWSER_WS_ENDPOINT` to a Chromium Playwright-compatible WebSocket endpoint and run the bridge/MCP server in a trusted server environment. A free local setup is included; a permanently available cloud browser needs compute hosting and may not remain free.

## Cloud login and encrypted secret vault (v2.17.0)

The Cloudflare mobile admin at `/admin` now uses a server-side owner account instead of asking the browser to retain a Relay Token.

### One-time Cloudflare setup

Run these commands from the repository root. Generate each value independently; do not reuse a password or commit either value to Git:

```bash
openssl rand -base64 48
npx wrangler secret put OPENFISH_BOOTSTRAP_SECRET --config cloudflare/wrangler.toml --config cloudflare/wrangler.toml
# Paste the first generated value when prompted.
openssl rand -base64 48
npx wrangler secret put OPENFISH_VAULT_KEY --config cloudflare/wrangler.toml --config cloudflare/wrangler.toml
# Paste the second generated value when prompted.
```

Keep `OPENFISH_VAULT_KEY` backed up in a secure password manager. It is the encryption root for the Durable Object secret vault; losing or replacing it without decrypting and re-encrypting the vault makes stored secrets unrecoverable. Never put it in `wrangler.toml`, source code, screenshots, issue comments, or chat.

For local Wrangler development, copy `cloudflare/.dev.vars.example` to `cloudflare/.dev.vars` and replace both placeholders with separate random values. The real `.dev.vars` file is ignored by Git.

Deploy the Worker using the normal reviewed release process (deployment is not triggered by this setup guide):

```bash
npx wrangler deploy --config cloudflare/wrangler.toml
```

Then open `https://YOUR_WORKER_HOST/admin`:

1. Under **首次初始化管理员账号**, enter the one-time bootstrap secret, choose a username and a unique password of at least 14 characters, then create the owner account.
2. After successful initialization, remove `OPENFISH_BOOTSTRAP_SECRET` from the Worker with `npx wrangler secret delete OPENFISH_BOOTSTRAP_SECRET --config cloudflare/wrangler.toml`, and remove the same GitHub Actions repository secret in Settings → Secrets and variables → Actions. Later deploys skip bootstrap-secret installation when it is absent. Do not remove `OPENFISH_VAULT_KEY`.
3. Log in with the owner account.
4. In **服务器密钥库**, enter the existing Relay Token used by the desktop Relay Agent. If using the self-hosted browser engine, also enter its HTTPS URL and Engine Token. Save the settings.
5. On the desktop Relay Agent, keep `OPENFISH_RELAY_TOKEN` set to the exact same Relay Token. The cloud Worker reads its encrypted copy from the vault; it never returns the raw value to browser JavaScript.

For the manual GitHub Actions production workflow, configure repository secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `OPENFISH_BOOTSTRAP_SECRET`, `OPENFISH_VAULT_KEY`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`, and `BROWSER_ENGINE_TOKEN`. The workflow installs only the bootstrap and vault-encryption secrets in the Worker; it does not duplicate the Relay or Engine bearer tokens as Worker secrets. `BROWSER_ENGINE_TOKEN` is required by the Cloud Run engine and must also be entered into the authenticated vault after first login. The Relay Token is entered in the vault and must match the desktop Agent's `.env` value.

### Security model

- Owner password hashes use PBKDF2-HMAC-SHA-256 with a per-account random salt and 310,000 iterations; login attempts are rate-limited.
- Admin sessions are random, 12-hour, `HttpOnly`, `Secure`, `SameSite=Strict` cookies. The UI uses same-origin requests and does not save bearer tokens in localStorage or sessionStorage.
- Relay and Engine tokens are encrypted at rest with AES-256-GCM using the separately configured `OPENFISH_VAULT_KEY`; only masked status is returned to the browser.
- Session records, encrypted vault data and bounded security audit events live in the existing Cloudflare Durable Object storage.
- The bootstrap route is one-time only. The Worker must be served over HTTPS. Do not expose the self-hosted engine directly to the public internet.
- The app vault intentionally does not accept broad Cloudflare account API tokens. Manage infrastructure credentials through Cloudflare's own secret manager and least-privilege access controls.
- Third-party model-provider API keys configured in the AI Workbench are still device-profile settings in this release; they are not part of the Relay/Engine vault and are not synchronized to the cloud login. Do not treat them as server-side encrypted by this feature.

This adds a single-owner cloud admin login and encrypted token vault; it is not yet a general multi-tenant user-management product. Keep PR #40 in draft until CI and real deployment acceptance are complete. Set `ALLOWED_EXTENSION_ORIGIN=chrome-extension://YOUR_EXTENSION_ID` in `.env` to pin the local bridge to your exact extension ID. Extension-origin requests are denied until this value is set; do not leave it blank for normal use.

## Safety
- Never paste passwords, recovery codes, payment details, or API keys into task prompts.
- Manually complete any blocked high-risk action only after independently reviewing the page and consequences.
- Stop if the page content or requested action differs from the plan you approved.

## Multi-platform AI integration (v1.3.3)
OpenFish provides a provider-neutral tool catalog and schema adapters so AI clients can integrate without changing the browser runtime:
- `GET /api/v1/tools` or `GET /.well-known/openfish-tools.json`: canonical tool catalog and discovery metadata.
- `GET /api/v1/adapters/openai`: OpenAI function-tool schema.
- `GET /api/v1/adapters/anthropic`: Anthropic tool-use schema.
- `GET /api/v1/adapters/gemini`: Gemini functionDeclarations schema.
- `GET /api/v1/openapi.json`: OpenAPI 3.1 document for REST clients, SDKs, LangChain/LlamaIndex wrappers, and custom agents.
- `POST /api/v1/tools/{tool_name}`: provider-neutral tool invocation endpoint. Send the tool's JSON arguments as the request body.
These are schema and REST compatibility interfaces, not direct hosted integrations with every vendor SDK. Clients must call the tool endpoint from their own agent runtime. The local bridge remains bound to loopback and is not safe to expose publicly without authentication, per-user isolation, rate limits, and network/SSRF hardening. Actions that change page state require `approved: true`; sensitive and irreversible targets remain blocked.


## Network destination protection (v1.3.3)
The runtime rejects loopback, private, link-local, metadata, and reserved IP literals plus common local-only hostnames. A Playwright context request guard applies the same checks to HTTP(S) subresources and redirect destinations, not only the first navigation URL. This is defense in depth, not a complete network sandbox: DNS rebinding and private-address resolution behind an otherwise public hostname require deployment-level egress filtering or a hardened outbound proxy. Keep the bridge bound to loopback and do not expose it directly to the internet.


## Admin console AI integration panel (v1.3.3)
The local dashboard now displays provider-specific integration endpoints for OpenAI-compatible function tools, Anthropic tool use, Gemini function declarations, and the OpenFish tool discovery manifest. Endpoint paths can be copied from the console, and the available tool catalog is loaded live from the bridge. These are local compatibility interfaces, not hosted vendor connections.


## Admin task templates (v1.3.3)
The dashboard supports creating, reading/loading, updating, and deleting reusable task templates. Templates are stored in the current browser's local storage only; they are not synced to the MCP process or other devices. The dashboard activity feed remains process-memory telemetry and is not a durable task-history database.

## Approval boundary (v1.3.3)
MCP `click_element` and `fill_element` now require an explicit `approved: true` argument for the exact action. The bridge independently checks this value before execution. Existing plan execution continues to require explicit approval. Sensitive fields and irreversible actions remain blocked by runtime policy.

## Current scope and deployment limitations
This release remains a local-first single-user runtime, not a hardened public multi-user SaaS. API keys and named browser sessions are now supported locally. Session state is in memory and is cleared when the bridge restarts; the HTTP MCP listener is loopback-bound by default and authenticated with scoped API keys. Provider adapters expose compatible tool schemas and REST endpoints; they do not establish vendor account connections or proxy vendor credentials. A public deployment still requires TLS termination, tenant-level isolation, durable storage, rate limiting, DNS-rebinding-resistant egress controls, and deployment-level network protections.


## Local MCP HTTP setup
1. Start the bridge: `npm run start:bridge`.
2. Start the HTTP MCP endpoint in another terminal: `npm run start:mcp:http`.
3. Create a key with read or read/write scope in `http://127.0.0.1:8787/admin`.
4. Configure your MCP client with endpoint `http://127.0.0.1:8788/mcp` and HTTP Bearer authentication. Add `X-OpenFish-Session` as a request header if using a named session.
5. Keep the endpoint local unless you put it behind a separately hardened TLS/authenticated gateway.

The HTTP endpoint uses the MCP Streamable HTTP transport. It is stateless at the protocol transport layer; browser state is selected separately by the session header. Stdio MCP remains available for local MCP hosts.


## AI client registry and rate limits (v1.6.0)
The local bridge records authenticated API/MCP client activity by API key identity, client ID, platform label, and browser session. The admin console shows recent clients and estimates online state from activity within the last 90 seconds. Client metadata is stored in `.openfish/clients.json` with restrictive local file permissions. Tool invocations are rate-limited per API key to 120 requests per minute by default; configure `OPENFISH_RATE_LIMIT_PER_MINUTE` to change the limit. Rate counters are process-memory state and reset on restart. This is operational visibility for a trusted local runtime, not tenant isolation or a public SaaS security boundary.


## Secure Cloudflare relay (v1.7.0)

The optional Cloudflare relay lets a local OpenFish runtime make an **outbound-only** WebSocket connection to a Cloudflare Worker. The browser and Playwright remain on the local computer; the Worker does not run Chromium and does not open inbound access to the local machine. A SQLite-backed Durable Object holds the relay WebSocket and forwards a small allowlist of authenticated HTTP/MCP requests to the connected local agent.

### Configure and deploy the relay

1. Install dependencies: `npm install`.
2. Create a long random relay secret (at least 32 characters) and store it securely.
3. Set the Worker secret: `npx wrangler secret put OPENFISH_RELAY_TOKEN --config cloudflare/wrangler.toml`.
4. Deploy: `npm run deploy:relay`. Wrangler provisions the SQLite-backed Durable Object namespace from the migration in `cloudflare/wrangler.toml`.
5. On the computer running OpenFish, create a local API key in the admin panel with **read and write** scopes. Keep it separate from the relay token.
6. Set these environment variables on that computer:
   - `OPENFISH_RELAY_URL=wss://YOUR-WORKER.workers.dev/agent/connect`
   - `OPENFISH_RELAY_TOKEN=the-same-long-random-relay-secret`
   - `OPENFISH_LOCAL_API_KEY=your-local-OpenFish-API-key`
   - optionally `OPENFISH_BRIDGE_URL=http://127.0.0.1:8787` and `OPENFISH_MCP_URL=http://127.0.0.1:8788/mcp`
7. Start the bridge, HTTP MCP server, and then `npm run start:relay-agent`.

Remote MCP endpoint: `https://YOUR-WORKER.workers.dev/mcp`. Remote clients use `Authorization: Bearer RELAY_TOKEN`; the local agent injects its separately stored local API key when forwarding to the local MCP server. The relay currently supports stateless JSON MCP requests and allowlisted REST discovery/tool routes; it buffers responses and caps request/response bodies at 512 KB with a 45-second relay timeout. It is not a general-purpose TCP tunnel or arbitrary URL proxy.

### Relay security and limitations

- Only the local agent initiates an outbound `wss://` connection; no inbound port forwarding is required.
- The Worker requires the relay Bearer secret for both agent connections and remote requests. Use a unique random secret and rotate it if exposed.
- The agent only forwards fixed local bridge/MCP paths and never accepts a destination URL from the remote caller.
- The relay currently represents one trusted local browser owner; anyone holding the relay token can use that owner's browser/API-key permissions. Do not share the relay token with untrusted users.
- This does not yet provide per-remote-user tenants, per-client delegated API keys, admin-console remote access, or a complete DNS/egress security boundary for arbitrary websites opened by the local browser.
- Cloudflare Durable Objects use SQLite-backed storage for this new namespace. Cloudflare account plan, usage limits, and billing eligibility depend on the account; check the Cloudflare dashboard before enabling production traffic.
- No Cloudflare deployment is claimed by this repository change. Deploy only after setting the Worker secret and verifying the relay health endpoint.

After deployment, check `GET https://YOUR-WORKER.workers.dev/health` with the relay Bearer token. It reports whether a local agent is connected.


## Browser navigation controls (v2.0.0)
The Chrome side panel and MCP interfaces expose `go_back`, `go_forward`, and `reload_page` for the current browser session. Named browser sessions are capped at 20 by default (excluding the default session); expired sessions are cleaned up before a new session is allocated. Configure `OPENFISH_MAX_SESSIONS` (2–50) and `OPENFISH_SESSION_TTL_MS` to adjust these limits.


## Screenshot preview (v2.1.0)
The Chrome side panel can capture and preview the active browser viewport as a compressed JPEG. The same screenshot tool is available through stdio MCP, Streamable HTTP MCP, and provider-neutral tool adapters. Screenshot bytes are returned inline rather than writing a temporary file to an unspecified working directory.

## Multi-tab browser management (v2.0.0)
The shared browser session supports listing tabs, opening a new tab, switching the active tab, and closing a tab through the Chrome side panel and MCP interfaces. Tab indices are current-list indices and can change after tabs are closed. Closing requires `approved: true` and the last remaining tab cannot be closed. Each isolated browser session retains its own tabs and cookies.


## Browser productivity library (v2.2.0)
OpenFish keeps a local browser library in `.openfish/browser-library.json`: bookmarks, top-level browsing history, a read-later list, and per-URL tab organization metadata (group label and pinned state). The Chrome side panel exposes these collections and tab organization. History is deduplicated for rapid reloads and capped at 3,000 entries. Remove and clear operations require explicit approval. The same capabilities are available through stdio MCP, Streamable HTTP MCP, REST, and provider-neutral AI tool adapters. Data stays on the machine running the bridge and is not synced to a cloud account.


## Diagnostics, reader mode, and tab recovery (v2.3.0)
The active page now records a bounded, in-memory diagnostic stream of console warnings/errors, uncaught page exceptions, failed requests, and HTTP responses with status 400 or higher. URLs in diagnostic records omit query strings and fragments to reduce accidental disclosure. The side panel exposes reader extraction, phrase search, navigation timing/resource summaries, tab search, duplicate-tab, and recently-closed-tab restore. Diagnostic data is page-local and resets when the runtime restarts; recently closed tabs are kept in the active session only. These tools are also available through MCP and the provider-neutral tool catalog.


## Workspaces, downloads, and privacy controls (v2.4.0)
OpenFish can save the current tab URLs as named local workspaces and restore them into new tabs without closing the current session. The download manager can save a file only from one unique visible link after explicit approval, stores files in `.openfish/downloads`, enforces a 25 MB per-file and 500 MB total managed-storage limit by default, and supports explicit file deletion. A session privacy action clears cookies and site storage for the active isolated browser context; it does not erase bookmarks, history, reading-list items, or managed downloads. These capabilities are exposed through MCP and provider-neutral AI tool adapters.


## Command center and portable browser backups (v2.5.0)
The Chrome side panel now has a searchable command center (Ctrl/⌘+K), keyboard shortcuts, and in-page text search. Browser-library backups can be exported as JSON and merged back after confirmation. Backups include bookmarks, history, reading-list items, tab organization, and workspace snapshots; they exclude cookies, session credentials, and downloaded files. Imports are limited to 1 MB and validate public HTTP(S) URLs before merging.


## Mobile remote admin (v2.6.0)
Open the Cloudflare Worker URL at `/admin` from iPhone Safari. The mobile dashboard uses the existing relay token as a bearer credential and exposes only bridge status, recent events, isolated browser-session management, and reviewed task planning/execution. The token is stored in `sessionStorage` for the current browser tab session and is cleared when the user disconnects. The Worker serves the static dashboard; all management API requests are authenticated by the relay token and forwarded through the already-connected local relay agent. The local computer must keep the bridge, HTTP MCP server, and relay agent running. This is a single-owner private control panel, not a multi-user SaaS. Do not share the relay token. High-risk browser actions remain blocked by runtime safety rules, and task execution requires explicit confirmation.


## First-party plugin browser API (v2.10.1)

The cloud browser can now be called directly by first-party plugins without routing through the mobile UI. The Worker exposes a versioned REST API and an OpenAPI 3.1 discovery document:

- `GET /api/v1/openapi.json` — API schema (public read-only discovery).
- `GET /api/v1/browser/status` — session status.
- `GET /api/v1/browser/view` — current URL, page title, visible text, links, and screenshot.
- `POST /api/v1/browser/navigate` — navigate to a public HTTP(S) URL; JSON body: `{"url":"https://example.com"}`.
- `POST /api/v1/browser/action` — back/forward/reload/click/type/press/scroll/clickLink actions.
- `POST /api/v1/browser/close` — close the current cloud browser session.

Send `Authorization: Bearer YOUR_OPENFISH_RELAY_TOKEN` with every browser API request. The token is a private single-owner credential; do not embed it in public client-side code or distribute it to third parties. The `X-OpenFish-Session` value is a client-generated isolation key, not a user identity or authorization credential: anyone who possesses the shared relay token can select another session ID. Do not expose this deployment as a public multi-tenant service; use a separate authenticated gateway and per-user authorization before inviting multiple users. Browser API CORS is enabled for first-party browser extensions, but CORS is not an authentication boundary. The API is intended for your own trusted plugins. Navigation blocks localhost, private IP literals, and common metadata/local hostnames. Cloudflare Browser Run free usage is limited and may be exhausted; the API does not create unlimited free compute.


## Browser engine: Cloudflare Playwright + Chromium (v2.10.1)

OpenFish uses the open-source Playwright API through Cloudflare's Workers-compatible `@cloudflare/playwright` package, connected to the Cloudflare Browser Run Chromium binding. This replaces the Puppeteer-specific browser control adapter with Playwright's browser contexts, pages, locators, and interaction API while keeping the existing REST and MCP interfaces stable. It does not introduce Browser Use Cloud, Browserless Cloud, paid proxy services, or other metered third-party browser providers.

The upstream Playwright project is Apache-2.0 licensed; Cloudflare publishes its Workers-compatible fork. Browser Use is MIT-licensed and is a useful optional AI-agent layer, but its main library is Python and runs against a separately provisioned local/remote browser. It is not copied into the Worker runtime because that Python runtime cannot execute inside this Worker deployment. Browserless is excluded from the core stack because its current server license is SSPL-1.0 or commercial. Lightpanda is excluded from the core stack because it is AGPL-3.0 and still documents partial Web API coverage / work-in-progress status.

References:
- https://github.com/microsoft/playwright
- https://developers.cloudflare.com/browser-run/playwright/
- https://github.com/browser-use/browser-use
- https://github.com/browserless/browserless
- https://github.com/lightpanda-io/browser

## Browser network egress hardening (v2.13.4)

The self-hosted Playwright engine now validates browser-context HTTP(S) requests, not only the initial navigation URL. Subresources and redirect hops are checked; service workers are disabled; page WebSocket connections are blocked. IPv4 and IPv6 private, loopback, link-local, metadata, multicast, documentation, benchmarking, and other special-purpose ranges are rejected. The Cloudflare Browser Run fallback applies the same URL checks to browser-context requests when the platform exposes the routing APIs, and viewing a page disconnects the Worker from the session without closing the session itself.

**Important limitation:** hostname validation and the browser's later DNS resolution are separate operations. DNS rebinding cannot be fully prevented by application checks alone. A public deployment must also enforce outbound network rules that block private, loopback, link-local, metadata, and reserved destinations. This release does not claim a complete SSRF-proof network sandbox.



## Self-hosted cloud browser engine (v2.13.4)

The mobile cloud browser uses the free/open-source Playwright + Chromium engine on Cloud Run. The release deployment workflow deploys the engine first, checks its authenticated `/health` response and expected engine version, then deploys the Cloudflare Worker and writes the discovered Cloud Run URL and shared engine token as Worker secrets.

Configure these GitHub repository secrets:
- `GCP_WORKLOAD_IDENTITY_PROVIDER`: full Google Workload Identity Federation provider resource name.
- `GCP_SERVICE_ACCOUNT`: Google service account email that GitHub Actions may impersonate.
- `BROWSER_ENGINE_TOKEN`: random secret of at least 32 characters; it is injected as Cloud Run's `OPENFISH_ENGINE_TOKEN` and stored as the Worker secret. Never commit or paste it into source code.
- Existing `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `OPENFISH_RELAY_TOKEN`.

The Cloud Run URL is discovered by the deployment workflow; `BROWSER_ENGINE_URL` is no longer a GitHub secret that must be copied manually. The workflow deploys service `openfish-browser-engine` in `asia-northeast3`, with scale-to-zero and a one-instance maximum, then verifies the authenticated health response before continuing to Cloudflare.

The Playwright/Chromium engine is open-source and has no software license fee, but **Cloud Run hosting is not guaranteed to be free**. Request-based billing and scale-to-zero reduce idle charges, but usage beyond applicable free-tier allowances is billed. The Cloud Run free tier is calculated using `us-central1` rates; `asia-northeast3` (Seoul) is a Tier 2 region, and Cloud Build/Artifact Registry may have separate charges. Check the active billing account and set budget alerts before running a production deployment.

Google Cloud setup is still required once: enable Cloud Run, Cloud Build, Artifact Registry, and IAM Credentials APIs; configure a Workload Identity Pool/provider restricted to this GitHub repository and the `main` branch; grant that provider's repository principal `roles/iam.workloadIdentityUser` on the deployment service account. The service account needs the permissions required to build and deploy the service (Cloud Run Admin, Service Account User on the runtime identity, Cloud Build build permissions, and Artifact Registry write access). Do not create or commit a long-lived service-account key.

The engine requires the matching Bearer token and a client-specific `X-OpenFish-Session` header. It isolates browser contexts per session and provides bounded cloud download delivery (15 MB per file, 50 MB in-memory per session). Browser Run fallback remains for compatibility, but its download endpoint returns HTTP 501 because no verified file-transfer implementation exists there.

CI builds the Docker image and validates the Worker bundle without deploying. The production deployment workflow is manual-only (`workflow_dispatch`) so merging prerequisite pull requests cannot unexpectedly deploy an incomplete release. It requires the configured GitHub and Google Cloud credentials. An authenticated health check is not a substitute for testing a real iPhone session and file handoff.

## Browser workspace refresh (v2.13.4)

The mobile browser workspace now has selectable Google, Bing and DuckDuckGo search, local browsing history, searchable bookmarks, page-text copy and a simplified reading view. Local history and bookmarks stay in the current device's browser storage; they are not synced to the cloud browser session. The cloud browser service now supports multiple tabs in its active browser context; tab indexes are session-scoped and are not durable identities. This release does not add paid browser providers.

## Browser ecosystem review and integrated module map (v2.13.4)

The public-source review used these projects as architecture references, not as wholesale code imports:

- [Playwright](https://github.com/microsoft/playwright) — cross-browser automation, browser contexts, navigation, downloads and test primitives; already the core automation layer in OpenFish.
- [Browser Use](https://github.com/browser-use/browser-use) — MIT-licensed agent patterns for accessibility-first actions, persistent browser work and local-model integration. OpenFish keeps its own approval gate and does not depend on the paid Browser Use Cloud.
- [Steel Browser](https://github.com/steel-dev/steel-browser) — Apache-2.0 reference for session lifecycle, browser APIs, observability and cleanup. Its standalone server is not bundled as a second competing engine.
- [Blanc](https://github.com/bnfy/blanc) — MIT-licensed desktop-browser reference for tab organization, favorites/history/downloads, permissions, privacy and compact browser chrome. Its Electron desktop implementation is not copied into this mobile/cloud product.
- Browserless was reviewed but not selected as a required dependency: its published open-source licensing is SSPL-1.0 OR a commercial license, which is not a safe default for a free-first deployment.

OpenFish's existing runtime module set includes Chromium/Playwright navigation, isolated sessions, local tab management, bookmarks, browsing history, reading list, downloads, tab organization, page diagnostics, accessibility snapshots, reader-content extraction, screenshots, AI task planning, explicit action approval, MCP/REST tool discovery and provider adapters. The v2.13.4 mobile workspace adds searchable local history and favorites, selectable search engines, page-text copy and a simplified reading view while preserving the existing legacy bookmark storage key.

**Not represented as completed in this release:** durable per-tab profiles, private-profile isolation in the mobile cloud UI, built-in network ad blocking, extension installation management, browser sync, and a full native desktop browser shell. These require separate backend, permission and security work; the UI does not expose fake controls for them.

## Durable task history (v2.15.0)
Local task records are stored in `.openfish/tasks.json` with atomic file replacement and restrictive permissions. The store retains at most 500 records by default (`OPENFISH_MAX_TASKS` can be set between 50 and 2,000), redacts common credentials, and supports search, detail, and restore. Restored plans return to the review state and always require a new explicit approval. For Cloud Run or other ephemeral container hosting, mount a persistent volume or use a durable database; the container writable layer alone is not a cross-restart or multi-instance store.


## AI client integration center (v2.17.0)

The local admin dashboard at `http://127.0.0.1:8787/admin` includes an integration configuration generator. Create a separate API key for each client under **API Keys**, choose `browser:read` for read-only access or both `browser:read` and `browser:write` for approved browser actions, then paste the key into **AI Integration** to generate a Streamable HTTP MCP client configuration. The MCP endpoint is `http://127.0.0.1:8788/mcp`; REST tools are available at `http://127.0.0.1:8787/api/v1/tools/<tool_name>`.

The generated configuration keeps the API key in the client configuration as a Bearer header. For Cursor / Cherry Studio, use the `mcpServers` format:
```json
{
  "mcpServers": {
    "openfish-browser": {
      "url": "http://127.0.0.1:8788/mcp",
      "headers": { "Authorization": "Bearer YOUR_OPENFISH_API_KEY" }
    }
  }
}
```
For Visual Studio Code, use its native `servers` format:
```json
{
  "servers": {
    "openfish-browser": {
      "type": "http",
      "url": "http://127.0.0.1:8788/mcp",
      "headers": { "Authorization": "Bearer YOUR_OPENFISH_API_KEY" }
    }
  }
}
```
For REST, send `POST http://127.0.0.1:8787/api/v1/tools/read_page` with `Authorization: Bearer YOUR_OPENFISH_API_KEY` and `Content-Type: application/json`; the JSON body can be `{}` for the current page. Choose the read-only scope for read tools; browser actions require the write scope. The server stores only a SHA-256 digest and shows the raw key only once. Revoke a client key from the local admin panel to disable that client. Use a unique key per application and least-privilege scopes. The local MCP listener binds to `127.0.0.1` by default. Prefer SSH local port forwarding (for example, `ssh -L 8787:127.0.0.1:8787 -L 8788:127.0.0.1:8788 user@host`) so the client continues to connect to its own `127.0.0.1`. Do not expose the local ports directly to the public internet. The Cloudflare Relay Token is a separate credential and is not interchangeable with an `ofb_live_` API key.
