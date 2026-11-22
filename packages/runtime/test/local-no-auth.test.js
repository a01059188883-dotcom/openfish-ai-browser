import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startBridge(t, localNoAuth) {
  const port = await freePort();
  const dataDir = await mkdtemp(join(tmpdir(), "openfish-local-auth-"));
  const child = spawn(process.execPath, ["packages/runtime/src/bridge.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), OPENFISH_DATA_DIR: dataDir, OPENFISH_LOCAL_NO_AUTH: localNoAuth, HEADLESS: "true" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { logs += chunk; });
  child.stderr.on("data", chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      await new Promise(resolve => {
        child.once("exit", resolve);
        child.kill("SIGTERM");
      });
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(base + "/health");
      if (response.ok) { ready = true; break; }
    } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, "local bridge should start: " + logs);
  return base;
}

test("local single-machine bridge allows browser tools without any API token by default", async t => {
  const base = await startBridge(t, "true");
  const health = await (await fetch(base + "/health")).json();
  assert.equal(health.localNoAuth, true);
  const status = await (await fetch(base + "/api/admin/status")).json();
  assert.equal(status.localNoAuth, true);
  assert.equal(typeof status.runtime.node, "string");
  assert.equal(typeof status.runtime.platform, "string");
  const response = await fetch(base + "/api/v1/tools/list_workspaces", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}"
  });
  assert.equal(response.status, 200);
  const relayed = await fetch(base + "/api/v1/tools/list_workspaces", {
    method: "POST", headers: { "content-type": "application/json", "x-openfish-platform": "cloudflare-relay" }, body: "{}"
  });
  assert.equal(relayed.status, 401, "Cloudflare relay forwarding must still present its separate local API key");
});

test("local tokenless mode can be disabled to require API keys", async t => {
  const base = await startBridge(t, "false");
  const response = await fetch(base + "/api/v1/tools/list_workspaces", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}"
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "API_KEY_REQUIRED");
});
