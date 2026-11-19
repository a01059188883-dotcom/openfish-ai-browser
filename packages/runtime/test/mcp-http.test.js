import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("Streamable HTTP MCP endpoint is authenticated and loopback-bound by default", async () => {
  const source = await readFile(resolve("packages/mcp-server/src/http.js"), "utf8");
  const sdk = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  assert.equal(typeof sdk.StreamableHTTPServerTransport, "function");
  assert.ok(source.includes('from "@modelcontextprotocol/sdk/server/streamableHttp.js"'));
  assert.ok(source.includes('new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })'));
  assert.ok(source.includes('transport.handleRequest(req, res, body)'));
  assert.ok(source.includes('process.env.OPENFISH_MCP_HTTP_HOST || "127.0.0.1"'));
  assert.ok(source.includes('Authorization: Bearer API_KEY'));
  assert.ok(source.includes('await verifyKey(bearer[1], "browser:read", { ...clientMeta, sessionId })'));
  assert.ok(source.includes('verifyKey(token, "browser:write", { ...clientMeta, sessionId })'));
  assert.ok(source.includes('"x-openfish-session": sessionId'));
});

test("browser sessions use separate contexts and unknown session IDs are rejected", async () => {
  const browser = await readFile(resolve("packages/runtime/src/browser.js"), "utf8");
  const bridge = await readFile(resolve("packages/runtime/src/bridge.js"), "utf8");
  const html = await readFile(resolve("packages/admin/index.html"), "utf8");
  const app = await readFile(resolve("packages/admin/app.js"), "utf8");
  assert.ok(browser.includes("new Map()"));
  assert.ok(browser.includes("instance.newContext("));
  assert.ok(browser.includes("runWithBrowserSession"));
  assert.ok(browser.includes("SESSION_TTL_MS"));
  assert.ok(browser.includes("MAX_SESSIONS"));
  assert.ok(browser.includes("closeBrowserSession"));
  assert.ok(bridge.includes("hasBrowserSession(requestedSession)"));
  assert.ok(bridge.includes('res.reqPath === "/api/browser/sessions"'));
  assert.ok(bridge.includes('res.reqPath.endsWith("/close")'));
  assert.ok(bridge.includes('res.reqPath === "/api/auth/verify"'));
  assert.ok(html.includes('id="sessions"'));
  assert.ok(app.includes('api("/api/browser/sessions")'));
  assert.ok(html.includes("X-OpenFish-Session"));
});

test("release metadata includes HTTP MCP entry point", async () => {
  const pkg = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const httpMcp = await readFile(resolve("packages/mcp-server/src/http.js"), "utf8");
  assert.equal(pkg.version, "2.13.5");
  assert.equal(pkg.scripts["start:mcp:http"], "node packages/mcp-server/src/http.js");
  assert.ok(pkg.scripts.check.includes("node --check packages/mcp-server/src/http.js"));
  assert.ok(httpMcp.includes(`const VERSION = "${pkg.version}"`));
});


test("AI client registry persists client metadata and enforces per-key rate limits", async () => {
  const registry = await readFile(resolve("packages/runtime/src/client-registry.js"), "utf8");
  const bridge = await readFile(resolve("packages/runtime/src/bridge.js"), "utf8");
  const httpMcp = await readFile(resolve("packages/mcp-server/src/http.js"), "utf8");
  const admin = await readFile(resolve("packages/admin/app.js"), "utf8");
  assert.ok(registry.includes("clients.json"));
  assert.ok(registry.includes("ACTIVE_WINDOW_MS = 90 * 1000"));
  assert.ok(registry.includes("checkClientRateLimit"));
  assert.ok(bridge.includes('res.reqPath === "/api/admin/clients"'));
  assert.ok(bridge.includes("checkClientRateLimit(identity.id"));
  assert.ok(bridge.includes("registerClient(identity"));
  assert.ok(httpMcp.includes('"x-openfish-client": clientId'));
  assert.ok(httpMcp.includes('clientId: String(req.headers["x-openfish-client"] || "mcp-http")'));
  assert.ok(admin.includes('api("/api/admin/clients")'));
  const pkg = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  assert.equal(pkg.version, "2.13.5");
  assert.ok(pkg.scripts.check.includes("packages/runtime/src/client-registry.js"));
});


test("Cloudflare relay is authenticated, allowlisted, bounded, and outbound-only", async () => {
  const worker = await readFile(resolve("cloudflare/worker.js"), "utf8");
  const agent = await readFile(resolve("packages/runtime/src/relay-agent.js"), "utf8");
  const wrangler = await readFile(resolve("cloudflare/wrangler.toml"), "utf8");
  const pkg = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  assert.ok(worker.includes('url.pathname === "/agent/connect"'));
  assert.ok(worker.includes("OPENFISH_RELAY_TOKEN"));
  assert.ok(worker.includes("MAX_BODY_BYTES = 512 * 1024"));
  assert.ok(worker.includes("this.maxPending = 32"));
  assert.ok(worker.includes("this.requestTimeoutMs = 45000"));
  assert.ok(worker.includes("new_sqlite_classes") || wrangler.includes("new_sqlite_classes"));
  assert.ok(worker.includes('this.ctx.acceptWebSocket(server)'));
  assert.ok(worker.includes('path.startsWith("/api/v1/tools/")'));
  assert.ok(agent.includes('new WebSocket(RELAY_URL'));
  assert.ok(agent.includes('OPENFISH_LOCAL_API_KEY'));
  assert.ok(agent.includes('http://127.0.0.1:8787'));
  assert.ok(agent.includes('AbortSignal.timeout(40000)'));
  assert.ok(!agent.includes('new URL(message.destination'));
  assert.equal(pkg.version, "2.13.5");
  assert.equal(pkg.scripts["start:relay-agent"], "node --env-file=.env packages/runtime/src/relay-agent.js");
  assert.ok(pkg.scripts.check.includes("node --check cloudflare/worker.js"));
});


test("GitHub Actions relay deployment requires all Cloudflare secrets and installs Worker secret", async () => {
  const workflow = await readFile(resolve(".github/workflows/deploy-relay.yml"), "utf8");
  assert.ok(workflow.includes("workflow_dispatch"));
  assert.ok(workflow.includes("secrets.CLOUDFLARE_API_TOKEN"));
  assert.ok(workflow.includes("secrets.CLOUDFLARE_ACCOUNT_ID"));
  assert.ok(workflow.includes("secrets.OPENFISH_RELAY_TOKEN"));
  assert.ok(workflow.includes("secrets.GCP_WORKLOAD_IDENTITY_PROVIDER"));
  assert.ok(workflow.includes("secrets.GCP_SERVICE_ACCOUNT"));
  assert.ok(workflow.includes("google-github-actions/auth@v2"));
  assert.ok(workflow.includes("gcloud run deploy openfish-browser-engine"));
  assert.ok(workflow.includes("--no-traffic --tag=preflight"));
  assert.ok(workflow.includes("status.traffic[?tag=preflight].url"));
  assert.ok(workflow.includes("gcloud run services update-traffic openfish-browser-engine"));
  assert.ok(workflow.includes("--to-latest --remove-tags=preflight"));
  assert.ok(!workflow.includes("  push:"));
  assert.ok(workflow.includes("group: openfish-production-deploy"));
  assert.ok(workflow.includes("cancel-in-progress: false"));
  assert.ok(workflow.indexOf('h.version!=="1.3.5"') < workflow.indexOf("gcloud run services update-traffic"));
  assert.ok(workflow.includes("h.version!==\"1.3.5\""));
  assert.ok(workflow.includes("secrets.BROWSER_ENGINE_TOKEN"));
  assert.ok(workflow.includes("wrangler@4 secret put BROWSER_ENGINE_URL"));
  assert.ok(workflow.includes("wrangler@4 secret put BROWSER_ENGINE_TOKEN"));
  assert.ok(workflow.includes("wrangler@4 deploy"));
  assert.ok(workflow.includes("wrangler@4 secret put OPENFISH_RELAY_TOKEN"));
  assert.ok(workflow.includes("npm run check"));
  assert.ok(workflow.includes("npm test"));
});
