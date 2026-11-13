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
