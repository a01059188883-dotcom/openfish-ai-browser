# OpenFish AI Browser

Open-source, free-first browser automation starter. Version: **1.0.2**.

## What is included
- **MCP server** (`packages/mcp-server`): browser tools for ChatGPT-compatible MCP clients.
- **Chrome extension** (`packages/chrome-extension`): side panel that can inspect the current page and send a natural-language task to the local bridge.
- **Browser runtime** (`packages/runtime`): Playwright browser session, local by default; can connect to a remote Chromium endpoint with `BROWSER_WS_ENDPOINT`.
- **Local AI planner**: optional Ollama integration (default model `qwen2.5:3b`) creates constrained JSON plans; it does not auto-run risky steps.
- **Safety defaults**: no credential collection, no automatic purchases/submissions, confirmation required for sensitive actions.

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

## Cloud browser
Set `BROWSER_WS_ENDPOINT` to a Chromium Playwright-compatible WebSocket endpoint and run the bridge/MCP server in a trusted server environment. A free local setup is included; a permanently available cloud browser needs compute hosting and may not remain free.

## Current 1.0 scope
Working foundation: page navigation, snapshots, clicking, filling, task execution with a constrained action loop, Chrome side panel page inspection, and local HTTP bridge. It is a starter, not yet a fully autonomous hosted SaaS. Add user authentication, per-user isolation, rate limits, a durable task queue, observability, and deployment secrets before exposing it publicly. Set `ALLOWED_EXTENSION_ORIGIN=chrome-extension://YOUR_EXTENSION_ID` in `.env` to pin the local bridge to your installed extension ID; leave it blank only during initial unpacked-extension setup.

## Safety
- Do not use it to bypass CAPTCHAs, access controls, paywalls, or site restrictions.
- Review actions before submitting forms, sending messages, deleting data, or making purchases.
- Never paste passwords, recovery codes, or API keys into task prompts.
