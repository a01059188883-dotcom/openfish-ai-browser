# OpenFish v2.16.1 device acceptance and persistence checklist

This checklist is the release gate for PR #39. Automated CI is necessary but does not replace tests against the actual Chrome installation, local Ollama host, MCP client, and phone.

## 1. Record the test environment

Record the date, OpenFish commit SHA, product version, OS, Chrome version, Node.js version, MCP client and version, and (if applicable) the Cloud Run revision. Do not include API keys, Relay Tokens, cookies, passwords, or private page contents in evidence.

Confirm the running build reports product version **2.16.1**. The self-hosted Chromium engine reports its own component version independently.

## 2. Local Bridge and extension

1. Start the Bridge with `npm run start:bridge`.
2. Open `http://127.0.0.1:8787/admin` and confirm the status panel reports the Bridge as available.
3. Load or reload `packages/chrome-extension` in `chrome://extensions`.
4. Open the extension side panel and confirm its heartbeat / connection status becomes online.
5. Navigate to a public test page and use the extension to read the page title and visible text.
6. Generate a harmless navigation-only plan, inspect the complete plan, and confirm execution stays disabled until explicit approval.
7. Approve that exact plan and verify the browser reaches the expected public test URL.
8. Change the task goal after generating a plan. Confirm the stale plan is invalidated and cannot be executed.

**Pass criteria:** Bridge and extension connect; read-only inspection works; plan changes invalidate old approval; approved navigation works; no secret or sensitive-field interaction is attempted.

## 3. Ollama inference (real model call)

1. Start Ollama on the machine reachable from the Bridge.
2. Confirm the configured model exists (default: `qwen2.5:3b`, unless `OPENFISH_MODEL` overrides it).
3. In the admin diagnostics, confirm Ollama is reachable and the configured model is installed.
4. Generate a short harmless plan and confirm the response is produced by the configured local model, not merely by a connectivity indicator.
5. Stop Ollama temporarily and verify diagnostics show an unavailable state without crashing the Bridge. Restart it and verify recovery.

**Pass criteria:** at least one real inference completes; unavailable/recovery states are reported accurately. A successful `/api/tags` check alone is not proof of inference.

## 4. MCP client integration

Run the HTTP MCP endpoint with `npm run start:mcp:http` and configure a dedicated, least-privilege API key in the client.

- Cursor / Cherry Studio: use the `mcpServers` configuration format.
- Visual Studio Code: use the native `servers` format with `type: "http"`.
- Endpoint: `http://127.0.0.1:8788/mcp`.

Test the following in the actual client:
1. Connect and list the OpenFish tools.
2. Call `read_page` and verify it returns the current test page.
3. Call `plan_task` with a harmless request and inspect the proposed plan.
4. Confirm a read-only key cannot invoke a write-scoped action.
5. With a separately issued write-scoped key, test one harmless approved browser action.
6. Revoke the test key and verify the client can no longer authenticate.

Never paste a raw API key into issue comments, logs, screenshots, or this checklist. The raw key is displayed only once; redact it from all evidence.

**Pass criteria:** real MCP handshake, tool discovery, read call, scope enforcement, explicit approval, and key revocation all work.

## 5. Phone-to-cloud-browser session

This test must use the actual phone and the intended deployed environment; desktop emulation is not a substitute.

1. Confirm the cloud browser engine is reachable only through the intended authenticated path.
2. Open the mobile admin interface on the phone and authenticate using the intended credential flow.
3. Create or select a browser session and navigate to a harmless public test page.
4. Refresh the mobile interface and verify the expected session is still selected while it remains alive.
5. Open a second isolated session and verify its tabs and page state do not leak into the first session.
6. Close one session and verify the other remains usable.
7. Verify unauthenticated requests are rejected. Do not expose the engine port directly to the public internet.

**Pass criteria:** phone can operate the intended remote browser session; session isolation, authentication, and close behavior are verified on the real deployment.

## 6. Durable task history and Cloud Run storage

The task store writes `tasks.json` under `OPENFISH_DATA_DIR`, defaulting to `.openfish/tasks.json` relative to the Bridge process working directory. Atomic file replacement protects against partially written JSON, but it does not make an ephemeral container filesystem durable.

For a persistent cloud deployment:

1. Provision a persistent volume or other durable storage mounted to the Bridge container.
2. Set `OPENFISH_DATA_DIR` to a directory on that persistent mount (for example, `/var/lib/openfish` only if that exact path is mounted and writable).
3. Ensure the runtime service identity can read/write the directory with restrictive permissions.
4. Create a harmless test task and verify it appears in task history.
5. Restart or replace the service instance, then verify the task remains available.
6. Verify interrupted `running` tasks are recovered as `failed` and that restoring a task creates a new planned task requiring fresh approval.

**Do not mark persistence as passed merely because the file exists inside a running container.** The restart/replacement test against the configured persistent mount is required. If the deployment platform cannot provide a persistent mount, use a durable database/object-backed task store before claiming durable cloud task history.

## 7. Evidence and release decision

For each section, record **PASS**, **FAIL**, or **NOT TESTED**, plus a short note and redacted screenshot/log excerpt where useful. Do not mark an item passed based only on source inspection or CI.

| Gate | Required evidence |
|---|---|
| Bridge + extension | Real Chrome extension heartbeat and harmless page read |
| Ollama | Successful local model inference |
| MCP client | Actual client handshake, tool call, scope enforcement, and revocation |
| Phone + cloud browser | Real phone session, isolation, authentication, and close test |
| Persistent task history | Task survives service restart/replacement on the mounted durable path |
| Extension origin | Exact `ALLOWED_EXTENSION_ORIGIN` configured for the installed extension ID |

Keep PR #39 in draft until all applicable gates are recorded as PASS and the deployment owner has reviewed the evidence. CI success alone does not authorize merge or production deployment.
