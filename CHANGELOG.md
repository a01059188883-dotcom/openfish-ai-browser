# Changelog

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


## 1.7.1 - 2026-11-15
- Added a manually triggered GitHub Actions workflow to deploy the Cloudflare relay and set its Worker secret without exposing secret values in logs.
- Documented the exact repository Actions secrets and one-click deployment path.
- Synchronized active application version markers and regression assertions to 1.7.1.
