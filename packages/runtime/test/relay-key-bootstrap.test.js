import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRelayApiKey } from "../../../scripts/relay-key-bootstrap.js";

test("relay key bootstrap reuses a valid key without creating another credential", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openfish-relay-key-"));
  const keyPath = join(dir, "relay-key");
  const key = "ofb_live_existing_valid_key";
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.match(url, /\/api\/auth\/verify$/);
    assert.equal(options.headers.authorization, "Bearer " + key);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const result = await ensureRelayApiKey({ bridgeUrl: "http://127.0.0.1:8787", keyPath, existingKey: key, fetchImpl });
    assert.deepEqual(result, { key, created: false });
    assert.equal(calls, 1);
    assert.equal((await readFile(keyPath, "utf8")).trim(), key);
    assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("relay key bootstrap replaces invalid credentials with a scoped local key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openfish-relay-key-"));
  const keyPath = join(dir, "relay-key");
  await (await import("node:fs/promises")).writeFile(keyPath, "ofb_live_revoked\n");
  const fresh = "ofb_live_newly_generated_key";
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/auth/verify")) return new Response("{}", { status: 401 });
    return new Response(JSON.stringify({ key: fresh, record: { scopes: ["browser:read", "browser:write"] } }), { status: 201 });
  };
  try {
    const result = await ensureRelayApiKey({ bridgeUrl: "http://127.0.0.1:8787", keyPath, fetchImpl });
    assert.deepEqual(result, { key: fresh, created: true });
    assert.equal(calls.length, 2);
    const payload = JSON.parse(calls[1].options.body);
    assert.deepEqual(payload.scopes, ["browser:read", "browser:write"]);
    assert.equal(payload.expiresInDays, 365);
    assert.equal((await readFile(keyPath, "utf8")).trim(), fresh);
    assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("relay key bootstrap refuses non-loopback Bridge URLs", async () => {
  await assert.rejects(
    ensureRelayApiKey({ bridgeUrl: "https://public.example.com" }),
    /restricted to the local Bridge/
  );
});
