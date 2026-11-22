import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("Docker image includes the extracted network policy module", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.ok(dockerfile.includes("COPY server.js network-policy.js download-storage.js ./"));
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
  assert.equal(health.version, "1.3.6");
});

test("self-hosted engine exposes real multi-tab management actions", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /url\.pathname === "\/tabs"/);
  assert.match(server, /action === "newTab"/);
  assert.match(server, /if \(payload\.url\)/);
  assert.match(server, /await session\.page\.goto\(target/);
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
  assert.ok(index.includes("OpenFish AI Browser · v2.21.0"));
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
  assert.match(workflow, /h\.version!==\"1\.3\.6\"/);
  assert.ok(workflow.includes("id: engine"));
  assert.ok(workflow.includes('echo "url=$ENGINE_URL" >> "$GITHUB_OUTPUT"'));
  assert.match(workflow, /--no-traffic --tag=preflight/);
  assert.match(workflow, /--to-latest --remove-tags=preflight/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+push:/m, "production deployment must not run automatically on main pushes");
});

test("engine bearer authentication uses constant-time token comparison", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /timingSafeEqual/);
  assert.match(server, /supplied\.length === expected\.length && timingSafeEqual\(supplied, expected\)/);
});

 
test("engine reaps idle sessions periodically and refuses to close a busy session", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /const sessionReaper = setInterval\(/);
  assert.match(server, /sessionReaper\.unref\(\)/);
  assert.match(server, /void reapExpired\(\)\.catch\(/);
  assert.match(server, /session\?\.busy\) return send\(res, 429/);
});

 
test("download retrieval streams the stored file without base64 buffering", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /createReadStream\(item\.path\)/);
  assert.match(server, /await pipeline\(createReadStream\(item\.path\), res\)/);
  assert.match(server, /content-disposition/);
  assert.doesNotMatch(server, /dataBase64: data\.toString\("base64"\)/);
  assert.doesNotMatch(server, /const data = await readFile\(path\)/);
});

 


test("Worker keeps long upstream timeouts scoped to download routes", async () => {
  const worker = await readFile(new URL("../../../cloudflare/worker.js", import.meta.url), "utf8");
  assert.match(worker, /url\.pathname\.startsWith\("\/cloud\/download"\) \? 120000 : 45000/);
  assert.match(worker, /signal: AbortSignal\.timeout\(upstreamTimeoutMs\)/);
  assert.doesNotMatch(worker, /AbortSignal\.timeout\(120000\)/);
});

test("download responses encode RFC 5987 filename special characters", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /encodeURIComponent\(item\.filename\)\.replace\(\/\[!'\(\)\*\]\/g/);
});

test("mobile download refresh revokes stale object URLs", async () => {
  const app = await readFile(new URL("../../../public/app.js", import.meta.url), "utf8");
  assert.match(app, /for\(const objectUrl of downloadObjectUrls\.values\(\)\)URL\.revokeObjectURL\(objectUrl\)/);
  assert.match(app, /downloadObjectUrls\.clear\(\)/);
  assert.ok(app.indexOf('const result=await api("/api/cloud-browser/downloads")') < app.indexOf("URL.revokeObjectURL(objectUrl)"), "keep old save links alive if refresh fails");
});

test("completed downloads rejected by either storage limit are deleted", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /import \{ deleteCompletedDownload, validateDownloadStorage \} from "\.\/download-storage\.js"/);
  assert.match(server, /await deleteCompletedDownload\(download, path\)/);
  assert.match(server, /if \(info\.size > MAX_DOWNLOAD_BYTES\) \{ await deleteCompletedDownload\(download, path\);/);
  assert.match(server, /if \(used \+ info\.size > MAX_SESSION_DOWNLOAD_BYTES\) \{ await deleteCompletedDownload\(download, path\);/);
  assert.doesNotMatch(server, /await download\.cancel\(\)/);
});

test("production download storage is bounded tmpfs and fails closed when unavailable", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../../../.github/workflows/deploy-relay.yml", import.meta.url), "utf8");
  assert.match(server, /OPENFISH_REQUIRE_DOWNLOADS_TMPFS/);
  assert.match(await readFile(new URL("../download-storage.js", import.meta.url), "utf8"), /fsInfo\.type !== 0x01021994/);
  assert.match(await readFile(new URL("../download-storage.js", import.meta.url), "utf8"), /capacityBytes > maxBytes \+ fsInfo\.bsize/);
  assert.match(await readFile(new URL("../download-storage.js", import.meta.url), "utf8"), /writeFile\(probe, "ok", \{ flag: "wx" \}\)/);
  assert.match(server, /downloadsPath: DOWNLOADS_DIR/);
  assert.match(workflow, /--add-volume mount-path=\/downloads,type=in-memory,size-limit=64Mi/);
  assert.match(workflow, /OPENFISH_DOWNLOADS_DIR=\/downloads,OPENFISH_REQUIRE_DOWNLOADS_TMPFS=true/);
});

test("stream disconnects do not attempt to write a JSON error after headers", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /if \(res\.headersSent \|\| res\.destroyed\) \{ if \(!res\.destroyed\) res\.destroy\(error\); return; \}/);
  assert.match(server, /handle\(req, res\)\.catch\(error => \{ if \(res\.headersSent \|\| res\.destroyed\)/);
});
