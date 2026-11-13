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
