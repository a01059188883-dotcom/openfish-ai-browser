import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
    try { const r = await fetch(base + "/health"); if (r.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, "engine should start: " + childError);
  const denied = await fetch(base + "/status");
  assert.equal(denied.status, 401);
  const allowed = await fetch(base + "/health", { headers: { authorization: "Bearer " + token } });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).engine, "OpenFish Self-hosted Playwright");
});
