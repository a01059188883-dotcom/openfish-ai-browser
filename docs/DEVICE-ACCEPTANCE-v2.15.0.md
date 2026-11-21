# OpenFish v2.15.0 — Real-device acceptance

This checklist is the release gate for PR #39. CI success is necessary but does not replace a real Chrome/iPhone/Ollama acceptance run. Keep the PR in draft and do not deploy production until every applicable check is recorded as PASS.

## 0. Safe setup

- Use a trusted computer with Node.js 20+, Chrome, and Ollama installed.
- Keep the Bridge bound to `127.0.0.1`; do not expose port 8787 or 8788 directly to the internet.
- Copy `.env.example` to `.env`. Set `ALLOWED_EXTENSION_ORIGIN=chrome-extension://<your-exact-extension-id>`; do not use a wildcard.
- Keep relay/API tokens in the local environment or secret manager. Never paste them into task prompts, screenshots, GitHub issues, or this checklist.
- Keep `OPENFISH_DATA_DIR=.openfish` on a persistent disk. Do not treat an ephemeral Cloud Run writable layer as durable storage.

## 1. Bridge health and release version

Start the Bridge with `npm run start:bridge`, then run:

```sh
curl -fsS http://127.0.0.1:8787/health
curl -fsS http://127.0.0.1:8787/api/admin/status
```

PASS when the health response is successful and reports version `2.15.0`; the admin status reports the expected browser mode and configured integrations. Record the returned version and date.

## 2. Task-center persistence and recovery

1. Open `http://127.0.0.1:8787/admin`.
2. Create a harmless read-only plan (for example, open a public documentation page and read its title). Inspect the plan before approval.
3. Confirm the task appears in task history with a stable task ID and a review/pending-approval state.
4. Approve and execute only the harmless plan. Confirm the same task record changes state and includes event history.
5. Search for the task by a distinctive word and open its detail view.
6. Restore the saved plan. Confirm it returns to review and cannot execute until it is explicitly approved again.
7. Stop the Bridge cleanly, restart it, and confirm the task is still present.
8. For restart recovery, in a disposable test environment only, stop the process while a harmless test task is marked running; restart and confirm the interrupted task is recovered as failed rather than silently continuing.

Inspect the durable file locally if needed: `.openfish/tasks.json`. Confirm it is not committed to Git and has restrictive filesystem permissions. Do not include its contents in support logs because task text may contain private browsing context.

PASS when records survive a Bridge process restart, restored plans require fresh approval, and interrupted running tasks are visibly marked failed.

## 3. Ollama actual inference

1. Start Ollama and ensure the configured model is available (default: `qwen2.5:3b`).
2. Open the admin dashboard and click **Test actual model response** (Chinese UI may display an equivalent translated label).
3. Confirm the test returns generated text, not only a reachable status or model inventory.
4. Repeat once after restarting Ollama to ensure reconnect behavior.

The diagnostic endpoint is `POST /api/admin/ollama-test`. A successful PASS requires `ok: true` and a non-empty generated response. A reachable Ollama server without generated text is not a pass.

## 4. Chrome extension heartbeat and reconnect

1. Load the unpacked extension from `packages/chrome-extension` in `chrome://extensions`.
2. Confirm the extension ID exactly matches `ALLOWED_EXTENSION_ORIGIN` in the Bridge environment.
3. Open the side panel and confirm it can read the active page and create a plan.
4. Leave it open for at least 45 seconds; the Bridge admin status should show the extension connected and a recent heartbeat/version.
5. Stop and restart the Bridge. Confirm the extension retries and reconnects without reinstalling it.
6. Change tabs and verify page context updates; do not approve any unexpected or irreversible action.

PASS when the extension heartbeat remains fresh and reconnects after a Bridge restart.

## 5. MCP stdio and HTTP

1. Start the Bridge first.
2. Connect a local MCP client using `node packages/mcp-server/src/index.js` (stdio) and verify tool discovery.
3. Generate a harmless plan with `plan_task`; capture its returned task ID.
4. Execute using `execute_plan` with that same `taskId` and explicit `approved: true` only after reviewing the plan.
5. If HTTP MCP is enabled, start `npm run start:mcp:http` and test `http://127.0.0.1:8788/mcp` using a scoped local API key.
6. Confirm the task ID links the plan and execution record in the admin task history.

PASS when stdio and (if configured) HTTP MCP tool calls complete, preserve the task ID, and still enforce explicit approval.

## 6. Phone-to-cloud browser relay

1. Confirm the Cloudflare Worker and Cloud Run browser engine have been deployed separately with their required secrets and health checks. Do not put secrets in URLs.
2. On the local Bridge computer, start the Bridge, HTTP MCP service, and relay agent using the configured private environment values.
3. From iPhone Safari, open the private Worker `/admin` URL and authenticate with the relay credential through the UI.
4. Confirm browser status is connected, open a public test page, inspect its title/text, and create a harmless task.
5. Confirm task history on mobile can search, open details, and restore a plan to review. Verify execution still needs a fresh explicit approval.
6. Disconnect/reconnect the phone and restart the local relay agent once; confirm the session recovers.
7. Verify the Cloud Run engine reports the expected release version and that a real page can be opened. An authenticated health endpoint alone is not sufficient.

PASS when a real iPhone session can control the intended cloud browser through the authenticated relay and reconnect successfully.

## 7. Cloud persistence decision

The v2.15.0 task store is file-backed on the Bridge host. If the Bridge runs on a personal computer with a persistent disk, verify `.openfish` survives process restarts and OS restarts. If the Bridge runs inside Cloud Run or another replaceable container, do not claim durable task history until a persistent volume or external database is configured and tested across instance replacement. Cloud Run's ordinary container writable layer is not a durable cross-instance database.

## 8. Release sign-off

Record each result in the PR #39 discussion without credentials or private task contents:

| Gate | Result | Evidence |
| --- | --- | --- |
| Bridge health/version | NOT RUN | |
| Task persistence/recovery | NOT RUN | |
| Ollama actual inference | NOT RUN | |
| Chrome heartbeat/reconnect | NOT RUN | |
| MCP stdio + HTTP (if used) | NOT RUN | |
| iPhone relay + cloud browser | NOT RUN | |
| Cloud persistence configuration | NOT RUN | |

Only after all applicable rows are PASS should the PR be marked ready, reviewed, merged, and deployed. Keep production deployment manual and separately verify the deployed version after rollout.
