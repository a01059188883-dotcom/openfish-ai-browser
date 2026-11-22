import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("Streamable HTTP MCP endpoint supports tokenless loopback mode and retains remote API-key auth", async () => {
  const source = await readFile(resolve("packages/mcp-server/src/http.js"), "utf8");
  const sdk = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  assert.equal(typeof sdk.StreamableHTTPServerTransport, "function");
  assert.ok(source.includes('from "@modelcontextprotocol/sdk/server/streamableHttp.js"'));
  assert.ok(source.includes('new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })'));
  assert.ok(source.includes('transport.handleRequest(req, res, body)'));
  assert.ok(source.includes('process.env.OPENFISH_MCP_HTTP_HOST || "127.0.0.1"'));
  assert.ok(source.includes('Authorization: Bearer API_KEY'));
  assert.ok(source.includes('process.env.OPENFISH_LOCAL_NO_AUTH !== "false"'));
  assert.ok(source.includes("localNoAuthRequest"));
  assert.ok(source.includes("isLoopbackAddress(req.socket.remoteAddress)"));
  assert.ok(source.includes("if (!localNoAuthRequest)"));
  assert.ok(source.includes("if (write && token)"));
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
  assert.equal(pkg.version, "2.21.0");
  assert.equal(pkg.scripts["start:mcp:http"], "node --env-file=.env packages/mcp-server/src/http.js");
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
  assert.equal(pkg.version, "2.21.0");
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
  assert.equal(pkg.version, "2.21.0");
  assert.equal(pkg.scripts["start:relay-agent"], "node --env-file=.env packages/runtime/src/relay-agent.js");
  assert.ok(pkg.scripts.check.includes("node --check cloudflare/worker.js"));
});


test("GitHub Actions deploys cloud login bootstrap and vault secrets without Worker bearer-token copies", async () => {
  const workflow = await readFile(resolve(".github/workflows/deploy-relay.yml"), "utf8");
  assert.ok(workflow.includes("workflow_dispatch"));
  assert.ok(workflow.includes("secrets.CLOUDFLARE_API_TOKEN"));
  assert.ok(workflow.includes("secrets.CLOUDFLARE_ACCOUNT_ID"));
  assert.ok(workflow.includes("secrets.OPENFISH_BOOTSTRAP_SECRET"));
  assert.ok(workflow.includes("secrets.OPENFISH_VAULT_KEY"));
  assert.equal(workflow.includes("secrets.OPENFISH_RELAY_TOKEN"), false);
  assert.ok(workflow.includes("secrets.GCP_WORKLOAD_IDENTITY_PROVIDER"));
  assert.ok(workflow.includes("secrets.GCP_SERVICE_ACCOUNT"));
  assert.ok(workflow.includes("google-github-actions/auth@v2"));
  assert.ok(workflow.includes("gcloud run deploy openfish-browser-engine"));
  assert.ok(workflow.includes("--no-traffic --tag=preflight"));
  assert.ok(workflow.includes("status.traffic[?tag=preflight].url"));
  assert.ok(workflow.includes("gcloud run services update-traffic openfish-browser-engine"));
  assert.ok(workflow.includes("--to-latest --remove-tags=preflight"));
  assert.doesNotMatch(workflow, /^\s+push:/m, "production relay deployment must be manual-only");
  assert.doesNotMatch(workflow, /branches:\s*\[main\]/, "merging to main must not deploy production");
  assert.ok(workflow.includes("group: openfish-cloudrun-engine-deploy"));
  assert.ok(workflow.includes("cancel-in-progress: false"));
  assert.ok(workflow.indexOf('h.version!=="1.3.6"') < workflow.indexOf("gcloud run services update-traffic"));
  assert.ok(workflow.includes("h.version!==\"1.3.6\""));
  assert.ok(workflow.includes("secrets.BROWSER_ENGINE_TOKEN"));
  assert.equal(workflow.includes("wrangler@4 secret put BROWSER_ENGINE_URL"), false);
  assert.equal(workflow.includes("wrangler@4 secret put BROWSER_ENGINE_TOKEN"), false);
  assert.ok(workflow.includes("wrangler@4 deploy"));
  assert.ok(workflow.includes("wrangler@4 secret put OPENFISH_BOOTSTRAP_SECRET"));
  assert.ok(workflow.includes("wrangler@4 secret put OPENFISH_VAULT_KEY"));
  assert.ok(workflow.includes('if [ -n "$OPENFISH_BOOTSTRAP_SECRET" ]'));
  assert.ok(workflow.includes("npm run check"));
  assert.ok(workflow.includes("npm test"));
});

test("HTTP MCP execute_plan accepts the durable task ID returned by plan_task", async () => {
  const httpMcp = await readFile(resolve("packages/mcp-server/src/http.js"), "utf8");
  assert.ok(httpMcp.includes("taskId: z.string().uuid().optional()"));
  assert.ok(httpMcp.includes('call("execute_plan", args, true)'));
});


test("mobile admin uses server-side login and encrypted token vault", async () => {
  const html = await readFile(resolve("cloudflare/mobile-admin.html"), "utf8");
  const auth = await readFile(resolve("cloudflare/auth-vault.js"), "utf8");
  assert.ok(html.includes('id="loginUser"'));
  assert.ok(html.includes('id="loginPassword"'));
  assert.ok(html.includes('api("/api/auth/login"'));
  assert.ok(html.includes('api("/api/auth/vault"'));
  assert.ok(html.includes('id="saveVault"'));
  assert.ok(html.includes('id="logoutAdmin"'));
  assert.equal(html.includes('id="rememberToken"'), false);
  assert.equal(html.includes('localStorage.setItem("openfish.relay.token"'), false);
  assert.equal(auth.includes("PBKDF2"), true);
  assert.equal(auth.includes("AES-GCM"), true);
  assert.equal(auth.includes("HttpOnly; Secure; SameSite=Strict"), true);
});


test("AI integration center generates MCP configuration and keeps API key scopes separate", async () => {
  const html = await readFile(resolve("packages/admin/index.html"), "utf8");
  const app = await readFile(resolve("packages/admin/app.js"), "utf8");
  const keys = await readFile(resolve("packages/runtime/src/api-keys.js"), "utf8");
  const httpMcp = await readFile(resolve("packages/mcp-server/src/http.js"), "utf8");
  assert.ok(html.includes('id="integrationClient"'));
  assert.ok(html.includes('id="integrationMcpUrl"'));
  assert.ok(html.includes('id="integrationApiKey"'));
  assert.ok(html.includes('id="copyIntegrationConfig"'));
  assert.ok(html.includes('id="relayWorkerUrl"'));
  assert.ok(html.includes('id="relayAccessToken"'));
  assert.ok(html.includes('id="copyRelayCurl"'));
  assert.ok(app.includes('mcpServers: { "openfish-browser"'));
  assert.ok(app.includes('servers: { "openfish-browser": { type: "http"'));
  assert.ok(html.includes('value="vscode"'));
  assert.ok(app.includes('Authorization: "Bearer " + key'));
  assert.ok(app.includes('X-OpenFish-Session'));
  assert.ok(app.includes('/api/v1/tools/read_page'));
  assert.ok(app.includes('/api/v1/browser/status'));
  assert.ok(app.includes('Worker 地址必须使用 HTTPS'));
  assert.ok(keys.includes('const SCOPES = new Set(["browser:read", "browser:write"])'));
  assert.ok(httpMcp.includes('const VERSION = "2.21.0"'));
  assert.ok(httpMcp.includes('Authorization: Bearer API_KEY'));
});
