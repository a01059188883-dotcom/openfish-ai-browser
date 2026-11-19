import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("Docker image includes the extracted network policy module", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.ok(dockerfile.includes("COPY server.js network-policy.js ./"));
});

test("self-hosted engine requires a long private token and exposes authenticated health", async t => {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const token = "test-only-token-" + "x".repeat(40);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", OPENFISH_ENGINE_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let childError = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { childError += chunk; });
  t.after(() => child.kill("SIGTERM"));
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(base + "/health", { headers: { authorization: "Bearer " + token } }); if (r.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, "engine should start: " + childError);
  const denied = await fetch(base + "/status");
  assert.equal(denied.status, 401);
  const wrongToken = await fetch(base + "/health", { headers: { authorization: "Bearer " + "x".repeat(token.length) } });
  assert.equal(wrongToken.status, 401);
  const missingSession = await fetch(base + "/status", { headers: { authorization: "Bearer " + token } });
  assert.equal(missingSession.status, 400);
  assert.match((await missingSession.json()).error, /X-OpenFish-Session/);
  const allowed = await fetch(base + "/health", { headers: { authorization: "Bearer " + token } });
  assert.equal(allowed.status, 200);
  const health = await allowed.json();
  assert.equal(health.engine, "OpenFish Self-hosted Playwright");
  assert.equal(health.version, "1.3.3");
});

test("self-hosted engine exposes real multi-tab management actions", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /url\.pathname === "\/tabs"/);
  assert.match(server, /action === "newTab"/);
  assert.match(server, /action === "switchTab"/);
  assert.match(server, /action === "closeTab"/);
  assert.match(server, /tabs: await listTabs\(session\)/);
});


test("self-hosted engine enforces independent session identifiers and per-session contexts", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /const sessions = new Map\(\)/);
  assert.match(server, /x-openfish-session/);
  assert.match(server, /sessions\.get\(id\)/);
  assert.match(server, /instance\.newContext\(/);
  assert.match(server, /OPENFISH_ENGINE_SESSION_TTL_MS/);
  assert.match(server, /OPENFISH_ENGINE_MAX_SESSIONS/);
  assert.match(server, /acceptDownloads: true/);
  assert.match(server, /session\.context\.close\(\)/);
});

test("cloud download API is approval-gated and bounded per session", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /url\.pathname === "\/download"/);
  assert.match(server, /payload\.approved !== true/);
  assert.match(server, /MAX_DOWNLOAD_BYTES = 15 \* 1024 \* 1024/);
  assert.match(server, /MAX_SESSION_DOWNLOAD_BYTES = 50 \* 1024 \* 1024/);
  assert.match(server, /session\.downloads\.set\(id, record\)/);
  assert.match(server, /url\.pathname === "\/downloads\/remove"/);
  assert.match(server, /url\.pathname === "\/downloads\/file"/);
  assert.match(server, /Explicit approval is required to retrieve a download/);
});

test("mobile downloads remain resumable and require an explicit save tap", async () => {
  const app = await readFile(new URL("../../../public/app.js", import.meta.url), "utf8");
  const worker = await readFile(new URL("../../../cloudflare/worker.js", import.meta.url), "utf8");
  const index = await readFile(new URL("../../../public/index.html", import.meta.url), "utf8");
  assert.match(index, /OpenFish AI Browser · v2\.13\.2/);
  assert.match(app, /downloads\/file/);
  assert.match(app, /点按保存到手机/);
  assert.match(app, /downloadObjectUrls/);
  assert.match(worker, /api\/cloud-browser\/downloads\/file/);
});

test("release deployment builds and verifies Cloud Run before deploying the Worker", async () => {
  const workflow = await readFile(new URL("../../../.github/workflows/deploy-relay.yml", import.meta.url), "utf8");
  assert.ok(workflow.indexOf("Deploy self-hosted browser engine to Cloud Run") < workflow.indexOf("Deploy Cloudflare Worker and Durable Object"));
  assert.match(workflow, /google-github-actions\/auth@v2/);
  assert.match(workflow, /GCP_WORKLOAD_IDENTITY_PROVIDER/);
  assert.match(workflow, /h\.version!==\"1\.3\.2\"/);
  assert.match(workflow, /steps\.engine\.outputs\.url/);
  assert.match(workflow, /--no-traffic --tag=preflight/);
  assert.match(workflow, /--to-latest --remove-tags=preflight/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n  push:/);
  assert.doesNotMatch(workflow, /secrets\.BROWSER_ENGINE_URL/);
});

test("engine bearer authentication uses constant-time token comparison", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /timingSafeEqual/);
  assert.match(server, /supplied\.length === expected\.length && timingSafeEqual\(supplied, expected\)/);
});
