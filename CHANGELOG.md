## Browser engine 1.3.4 - 2026-11-19
- Reap idle Playwright browser sessions on a periodic unref'ed timer, not only when another request arrives.
- Prevent /close from terminating a browser context while an operation is in progress.
- Synchronize engine package, health endpoint, deployment preflight, documentation, and regression assertions to 1.3.4.

## 2.10.0
- Added an optional self-hosted Playwright + Chromium engine to remove dependence on Cloudflare Browser Run daily browser-minute quotas when deployed on user-controlled compute.
- Added authenticated Worker routing to the self-hosted engine; Cloudflare Browser Run remains the fallback when engine secrets are not configured.
- Added Docker deployment files, API documentation, and server-side DNS/IP checks for private-network destinations.

## 2.9.0 - 2026-11-18
- Adopted Cloudflare's Workers-compatible open-source Playwright package as the browser-control adapter for the existing Chromium Browser Run binding.
- Replaced Puppeteer-specific page/session operations with Playwright browser contexts, pages, and viewport APIs while preserving the existing REST/MCP surface.
- Enabled nodejs_compat as required by the Cloudflare Playwright runtime.
- Documented third-party project/license review and excluded incompatible/paid-service dependencies.
- Synchronized package version and regression tests to 2.9.0.

## 2.8.0 - 2026-11-18
- Added a versioned REST API for first-party plugins to control the Cloudflare cloud browser independently of the mobile UI.
- Added an OpenAPI 3.1 discovery document and CORS preflight support for browser-extension/plugin callers.
- Kept all browser operations behind the private relay Bearer token and retained public-network URL validation.
- Fixed mobile screenshot coordinate mapping for page clicks.
- Synchronized package, Worker, mobile frontend, README, changelog, and regression tests to 2.8.0.

## 2.6.0 - 2026-11-17
- Added an iPhone-friendly remote admin dashboard at the Cloudflare Worker `/admin` route.
- Added relay-token-authenticated status, event, session, and reviewed task-control routes; only an explicit allowlist is forwarded to the local agent.
- Dashboard token is kept in sessionStorage for the current tab session; no admin credential is embedded in the static page.
- Synchronized active release markers to 2.6.0.

# Changelog

## 2.13.3 - 2026-11-19
- Automate Cloud Run engine deployment with Google Workload Identity Federation, authenticated health/version verification, then Cloudflare Worker deployment and secret synchronization.
- Derive the Cloud Run service URL during deployment rather than requiring a manually copied GitHub secret.
- Synchronize OpenFish suite version to 2.13.3 and self-hosted browser engine version to 1.3.3.


## 2.13.1 - 2026-11-19
- Make cloud downloads resumable within the active browser session.
- Replace automatic post-fetch download triggering with an explicit user-tapped save link for improved iPhone Safari compatibility.
- Retain prepared object URLs until page exit or explicit removal, with retry and expiry messaging.
- Synchronize OpenFish release metadata to 2.13.1 and self-hosted engine metadata to 1.3.1.


## 1.0.0 - 2026-11-13
- Initial OpenFish AI Browser project scaffold.
- Added Playwright local/remote browser runtime.
- Added MCP tools for navigation, reading, clicking, filling and screenshots.
- Added Chrome Manifest V3 side panel and local HTTP bridge.
- Added safety boundaries and setup documentation.

## 1.0.0 maintenance update - 2026-11-13
- Added interactive element discovery and semantic page outline MCP tools.
- Added smoke test and declared the zod dependency used by the MCP server.

## 1.0.1 - 2026-11-13
- Added optional local Ollama task planning with strict action allowlists.
- Added structured page context and synchronized runtime/package version.
- Added dependency-free smoke tests for release metadata and safety policy.

## 1.0.2 - 2026-11-13
- Synchronized package, MCP, bridge, Chrome extension, and README version metadata.
- Centralized HTTP(S) URL validation and blocked URLs containing embedded credentials.
- Strengthened local bridge Host/Origin checks and request-body size/error handling.
- Added shared checks for sensitive form fields and irreversible actions, including payment and identity fields.
- Added a bounded timeout and clearer connection errors for local Ollama planning.
- Expanded task context capture and input-length validation.
- Fixed the Chrome side-panel version label and added a synchronization test.

## 1.0.3 - 2026-11-13
- Fixed the AI planning endpoint so supplied URLs use the same strict HTTP(S) validator as navigation and reject embedded credentials.
- Return HTTP 400 for malformed, unsupported-protocol, or credential-bearing URLs.
- Make local bridge Host validation follow the configured PORT instead of hard-coding 8787.
- Corrected documentation to distinguish page inspection and plan generation from autonomous multi-step execution.
- Synchronized all release version labels and expanded regression coverage.

## 1.0.4 - 2026-11-13
- Added a sequential browser plan executor with explicit user approval required.
- Added MCP `execute_plan` and local bridge `/api/execute` entry points.
- Added Chrome side-panel review-and-execute button with an approval confirmation.
- Require unique, visible, enabled targets; restrict clicks to button-like controls and fills to ordinary editable fields.
- Stop immediately on the first failed or blocked step; continue blocking sensitive and potentially irreversible actions.
- Synchronized release version metadata and expanded syntax/test coverage.


## 1.0.5 - 2026-11-13
- Invalidate a pending plan whenever the task text changes or a new plan request starts, preventing accidental execution of stale plans.
- Disable execution until a fresh valid plan is available; lock conflicting plan generation during execution.
- Clear the approved plan after execution and hide the execute control on failures.
- Synchronize all version metadata and add regression coverage for stale-plan handling.
\n\n## 1.0.6 - 2026-11-13\n- Added a visual local admin dashboard at `/admin` with service uptime, API counters, browser session state, recent activity, and a task planning/execution interface.\n- Added read-only admin status and event endpoints and in-memory request/error telemetry.\n- Kept the dashboard bound to the local bridge; it is not exposed as a public multi-user admin service.\n- Synchronized package, MCP, extension, bridge, and documentation version metadata.\n

## 1.0.7
- Unify MCP and Chrome extension on one local Playwright browser session through the bridge API.
- Add bridge endpoints for MCP page inspection, navigation, planning, approved execution, safe click/fill, screenshots, interactive elements, and accessibility outline.
- MCP server now proxies to the shared bridge instead of launching a separate browser.
- Synchronize package, extension, bridge, MCP, side-panel, README, and test versions.

## 1.0.8
- Fix the regression test file formatting and synchronize all release version markers.


## 1.1.1
- Add provider-neutral tool discovery, OpenAPI 3.1, and OpenAI, Anthropic, and Gemini function-tool schema adapters.
- Add a unified REST tool invocation endpoint mapped to the existing shared browser runtime.
- Require explicit approval for direct click/fill actions through the multi-provider API.
- Synchronize all release version markers.

## 1.1.1
- Correct provider-adapter regression test formatting and synchronize release versions.

## 1.1.1
- Correct version assertions in regression tests; keep all release markers synchronized.


## 1.1.2 - 2026-11-13
- Block navigation to loopback, private, link-local, metadata, and reserved IP literals and common local-only hostnames.
- Apply destination checks to browser HTTP(S) subresources and redirects through a Playwright context route guard.
- Add regression tests for private IPv4/IPv6, metadata endpoints, local hostnames, and public destinations.
- Synchronize package, bridge, MCP, Chrome extension, dashboard documentation, and test version markers.


## 1.1.3 - 2026-11-15
- Refresh the admin console navigation and correct its stale version label.
- Add responsive AI provider integration cards with copyable endpoint paths.
- Load the canonical browser tool catalog live from the local bridge and show each tool's approval requirement.
- Synchronize package, bridge, MCP, extension, side panel, README, changelog, and regression test version markers.


## 1.2.0 - 2026-11-15
- Fixed an approval bypass in the MCP direct click/fill routes: both MCP schemas and bridge handlers now require explicit approval for the exact action.
- Added regression tests covering MCP click/fill approval requirements.
- Added local task-template create, read, update, and delete controls to the admin dashboard; templates remain in the current browser's local storage.
- Hardened dashboard activity rendering by replacing HTML string interpolation with safe text nodes.
- Prevented overlapping status refreshes and made failed/empty AI plans non-executable.
- Fixed the stale dashboard version label and synchronized release metadata across runtime, MCP, extension, README, and tests.
- Improved responsive layout for task-template controls.


## 1.3.0 - 2026-11-15
- Redesigned the local admin dashboard visual hierarchy, card spacing, navigation, typography, focus states, and mobile breakpoints.
- Made the admin sidebar sticky on desktop and converted navigation into a compact horizontal strip on mobile.
- Added live client-side filtering for recent API activity by endpoint path or HTTP status.
- Added accessible skip navigation, visible keyboard focus, reduced-motion support, and narrow-screen layout refinements.
- Refined the Chrome extension side panel with a compact header, clearer task sections, improved output readability, and responsive spacing.
- Synchronized package, bridge, MCP, extension, dashboard, README, and regression-test version markers to 1.3.0.

 
## 1.4.0 - 2026-11-15
- Added local API key create/list/revoke management with cryptographically random tokens, SHA-256-only persistence, expiry, and read/write scopes.
- Protected REST tool invocation endpoints with Bearer authentication and scope checks; expired and revoked keys are rejected.
- Added responsive API key management UI with one-time key display and copy action.
- Fixed dashboard activity chart refresh using the latest event collection.
- Synchronized package, bridge, MCP, extension, dashboard, README, and test versions to 1.4.0.


## 1.5.0 - 2026-11-15
- Added a separate MCP Streamable HTTP transport at `/mcp`, authenticated with scoped API keys and bound to loopback by default.
- Kept the existing stdio MCP transport working.
- Added isolated Playwright BrowserContexts selected by `X-OpenFish-Session`; cookies and local storage are separated between sessions.
- Added browser session create/list/close APIs and admin console controls with idle expiry and cleanup.
- Added explicit read/write scope checks to HTTP MCP tool calls while retaining exact-action approval and existing safety policy.
- Added responsive session management UI and endpoint/version information.
- Synchronized package, bridge, stdio MCP, HTTP MCP, Chrome extension, dashboard, README, and tests to 1.5.0.


## 1.6.0 - 2026-11-15
- Added a persistent local registry for authenticated AI clients, including client ID, platform, API key identity, browser session, scopes, request count, and last activity.
- Added admin console visibility for connected/idle AI clients with a 90-second activity window.
- Added per-API-key rate limiting for REST browser tool calls (120 requests/minute by default; configurable).
- Forwarded MCP HTTP client metadata through the bridge and registered client activity on authenticated MCP requests.
- Synchronized package, bridge, MCP HTTP, Chrome extension, admin UI, README, changelog, and tests to 1.6.0.


## 1.7.0 - 2026-11-15
- Added an optional Cloudflare Worker + SQLite Durable Object WebSocket relay for remote MCP and allowlisted REST calls.
- Added a local outbound-only relay agent with authenticated reconnect, exponential backoff, WebSocket ping keepalive, and fixed local MCP/bridge targets.
- Added separate relay-secret and local OpenFish API-key handling; remote callers never choose arbitrary local destinations.
- Added request/response size caps, a bounded in-flight request queue, timeout handling, endpoint allowlists, and authenticated relay health status.
- Added Wrangler dev/deploy scripts and setup/security documentation.
- Synchronized all active application version markers to 1.7.0.
- Cloudflare deployment is not performed by this source release; account secrets and a deployment check are still required.


## 1.7.2 - 2026-11-15
- Added a manually triggered GitHub Actions workflow to deploy the Cloudflare relay and set its Worker secret without exposing secret values in logs.
- Documented the exact repository Actions secrets and one-click deployment path.
- Synchronized active application version markers and regression assertions to 1.7.2.


## 1.7.2 - 2026-11-16
- Fix Wrangler entry-point resolution for the config stored under `cloudflare/` by using the config-relative `worker.js` path.
- Synchronize the Cloudflare Worker, local bridge, MCP servers, Chrome extension, admin dashboard, package metadata, tests, and documentation to v1.7.2.


## 1.8.0 - 2026-11-16
- Refined the admin dashboard information hierarchy, responsive navigation, card spacing, form layouts, tables, and narrow-screen controls.
- Improved the Chrome side panel header, action hierarchy, output panels, touch targets, and responsive spacing.
- Synchronized application, Worker, MCP, extension, dashboard, documentation, and regression-test version markers to 1.8.0.


## 2.0.0 - 2026-11-16
- Added browser back, forward, and reload controls to the Chrome side panel.
- Exposed the same navigation controls as MCP tools and provider-neutral REST tools, sharing the active isolated browser session.
- Enforced the configured maximum number of named browser sessions and return HTTP 429 when the limit is reached; expired sessions are cleaned before allocation.
- Exposed the session limit in browser status and documented the configurable limit and session TTL.
- Synchronized package, bridge, MCP, extension, dashboard, Worker, documentation, and regression-test versions to 2.0.0.


## 2.0.0 - 2026-11-17
- Added multi-tab listing, creation, active-tab switching, and controlled tab closing to the shared Playwright browser session.
- Exposed tab management through the local bridge, stdio MCP, Streamable HTTP MCP, and provider-neutral tool catalog.
- Added a visual tab manager to the Chrome side panel with safe text rendering, refresh, new-tab URL validation, active-tab highlighting, and close confirmation.
- Required explicit approval for tab closing; prevent closing the last remaining tab and validate tab indices.
- Synchronized package, runtime, MCP, extension, dashboard, Worker, docs, and regression-test versions to 2.0.0.


## 2.1.0 - 2026-11-17
- Added an inline compressed JPEG screenshot preview in the Chrome side panel.
- Changed screenshot results from temporary filesystem paths to self-contained image data, avoiding ambiguous file locations for MCP clients.
- Kept screenshot capture available through the shared bridge, stdio MCP, Streamable HTTP MCP, and provider-neutral adapters.
- Synchronized package, runtime, Worker, MCP, extension, dashboard, README, changelog, and regression-test version markers to 2.1.0.


## 2.2.0 - 2026-11-17
- Added a private local browser library for bookmarks, browsing history, and a read-later list with bounded history retention and atomic persistence.
- Added per-URL tab grouping labels and pinned-state organization in the Chrome side panel.
- Exposed browser-library actions through the shared bridge, MCP stdio/HTTP, REST, and provider-neutral AI tool adapters.
- Added explicit approval checks for destructive library operations and tab-organization changes.
- Synchronized package, extension, runtime, Worker, MCP, dashboard, docs, and test release markers to 2.2.0.


## 2.3.0 - 2026-11-17
- Added per-page diagnostics for console warnings/errors, uncaught exceptions, failed requests, and HTTP errors with URL query redaction.
- Added reader-content extraction, in-page phrase search, and navigation/resource performance summaries.
- Added tab search, duplicate-tab, and recently closed-tab recovery.
- Exposed all new operations through the bridge, stdio MCP, Streamable HTTP MCP, and AI tool adapters.
- Synchronized package, extension, runtime, Worker, MCP, dashboard, docs, and tests to 2.3.0.


## 2.4.0 - 2026-11-17
- Added named local workspaces that save the current public tab URLs and restore them as new tabs without closing existing tabs.
- Added an approval-gated download manager for unique visible page links, with sanitized filenames, managed local storage, 25 MB per-file and 500 MB total limits, and explicit deletion.
- Added an approval-gated session privacy action to clear cookies, local/session storage, caches, service workers, and IndexedDB for the active isolated browser session.
- Exposed new operations through the bridge, MCP stdio/HTTP, REST, and AI tool adapters; added side-panel management UI.
- Synchronized package, extension, runtime, Worker, MCP, dashboard, docs, and tests to 2.4.0.


## 2.5.0 - 2026-11-17
- Added a searchable command palette and keyboard shortcuts for common browser actions.
- Added in-page text search controls to the Chrome side panel.
- Added portable JSON export/import for bookmarks, history, reading list, tab organization, and workspaces; imports merge data, validate public URLs, and require explicit approval.
- Backups exclude cookies, credentials, and downloaded files and enforce a 1 MB import limit.
- Exposed backup operations through REST and MCP; synchronized all release markers to 2.5.0.
