import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "openfish-api-keys-"));
process.env.OPENFISH_DATA_DIR = directory;
const keys = await import("../src/api-keys.js");

test("API keys are generated once, stored hashed, scoped, expiring, and revocable", async () => {
  try {
    const created = await keys.createApiKey({
      name: "integration test",
      scopes: ["browser:read", "tools:read"],
      expiresInDays: 30
    });
    assert.match(created.key, /^ofb_live_[A-Za-z0-9_-]+$/);
    assert.equal((await keys.authenticateApiKey(created.key, "browser:read")).name, "integration test");
    assert.deepEqual(await keys.authenticateApiKey(created.key, "browser:write"), { forbidden: true });
    const stored = await readFile(join(directory, "api-keys.json"), "utf8");
    assert.ok(!stored.includes(created.key));
    assert.ok(stored.includes(created.record.prefix));
    assert.equal((await keys.listApiKeys()).length, 1);
    await keys.revokeApiKey(created.record.id);
    assert.equal(await keys.authenticateApiKey(created.key, "browser:read"), null);
    assert.ok((await keys.listApiKeys())[0].revokedAt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("API key creation validates scopes and expiry bounds", async () => {
  await assert.rejects(() => keys.createApiKey({ name: "bad scope", scopes: ["admin:*"], expiresInDays: 30 }), /supported scopes/);
  await assert.rejects(() => keys.createApiKey({ name: "bad expiry", scopes: ["browser:read"], expiresInDays: 500 }), /between 1 and 365/);
});
