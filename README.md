# OpenFish AI Browser

Open-source, free-first browser automation starter. Version: **1.0.8**.

## What is included
- **MCP server** (`packages/mcp-server`): browser tools for ChatGPT-compatible MCP clients, including plan review and explicitly approved sequential execution.
- **Chrome extension** (`packages/chrome-extension`): side panel to inspect the current page, generate an AI plan, review it, and explicitly approve execution.
- **Browser runtime** (`packages/runtime`): Playwright browser session, local by default; can connect to a remote Chromium endpoint with `BROWSER_WS_ENDPOINT`.
- **Local AI planner**: optional Ollama integration (default model `qwen2.5:3b`) creates constrained JSON plans.
- **Safety defaults**: no credential collection; sensitive fields and potentially irreversible actions are blocked during plan execution.

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

## Visual admin dashboard\nOpen `http://127.0.0.1:8787/admin` after starting the bridge to open the local control panel. It displays bridge uptime, API request/error counts, browser connection mode, recent API activity, and a task planner with explicit approval before execution. Dashboard telemetry is held in process memory and resets when the bridge restarts. The panel is served only by the local bridge; it is not a public cloud admin site.\n\n## Unified local runtime (v1.0.8)\nThe bridge is the single owner of the Playwright browser. Both the Chrome side panel and the stdio MCP server call the same local bridge API; MCP no longer launches a second browser process. Start `npm run start:bridge` before launching either client. The MCP server exposes `open_page`, `read_page`, `plan_task`, `execute_plan`, `click_element`, `fill_element`, `take_screenshot`, `list_interactive_elements`, and `get_accessibility_snapshot`.\n\n## Review and execution flow
1. Ask the local AI planner to generate a plan for the current page.
2. Review the complete plan in the Chrome side panel or MCP response.
3. Explicitly approve the exact plan using the side-panel confirmation or the MCP `execute_plan` tool with `approved: true`.
4. The runtime executes steps in order and stops on the first failure or blocked action.

The side panel invalidates old plans when the task text changes, disables execution until a fresh plan is generated, and clears the plan after execution. The executor accepts at most 8 steps. It requires unique, visible, enabled targets; only button-like controls may be clicked, and only ordinary editable fields may be filled. Passwords, tokens, recovery codes, payment/identity fields, hidden fields, and potentially irreversible actions (such as payment, sending, deletion, publishing, and form submission) are blocked. Review each plan before approval. The executor does not bypass CAPTCHAs, access controls, paywalls, or site restrictions.

## Cloud browser
Set `BROWSER_WS_ENDPOINT` to a Chromium Playwright-compatible WebSocket endpoint and run the bridge/MCP server in a trusted server environment. A free local setup is included; a permanently available cloud browser needs compute hosting and may not remain free.

## Deployment readiness
This is a local-first developer tool, not yet a hardened multi-user SaaS. Before public hosting, add authentication, per-user browser isolation, SSRF/private-network protections, rate limits, a durable task queue, observability, and deployment secret management. Set `ALLOWED_EXTENSION_ORIGIN=chrome-extension://YOUR_EXTENSION_ID` in `.env` to pin the local bridge to your extension ID; leave it blank only during initial unpacked-extension setup.

## Safety
- Never paste passwords, recovery codes, payment details, or API keys into task prompts.
- Manually complete any blocked high-risk action only after independently reviewing the page and consequences.
- Stop if the page content or requested action differs from the plan you approved.
