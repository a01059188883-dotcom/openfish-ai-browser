import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("package and runtime report the same version", async () => {
  const pkg = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const bridge = await readFile(resolve("packages/runtime/src/bridge.js"), "utf8");
  assert.match(bridge, new RegExp(`version: "${pkg.version}"`));
});

test("planner prompt rejects unsafe irreversible actions", async () => {
  const source = await readFile(resolve("packages/runtime/src/ai-planner.js"), "utf8");
  for (const term of ["purchases", "payments", "sending messages", "deleting", "submitting forms"]) assert.ok(source.includes(term));
});

import { validateHttpUrl, isSensitiveField, isIrreversibleAction, validatePlan } from "../src/safety.js";

test("release version is synchronized across user-facing packages", async () => {
  const pkg = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(resolve("packages/chrome-extension/manifest.json"), "utf8"));
  const mcp = await readFile(resolve("packages/mcp-server/src/index.js"), "utf8");
  const readme = await readFile(resolve("README.md"), "utf8");
  const sidepanel = await readFile(resolve("packages/chrome-extension/sidepanel.html"), "utf8");
  assert.equal(manifest.version, pkg.version);
  assert.match(mcp, new RegExp(`version: "${pkg.version}"`));
  assert.ok(readme.includes(`Version: **${pkg.version}**`));
  assert.ok(sidepanel.includes(`AI Browser · ${pkg.version}`));
});

test("URL validation permits HTTP(S) and rejects embedded credentials or other protocols", () => {
  assert.equal(validateHttpUrl("https://example.com/path").hostname, "example.com");
  assert.throws(() => validateHttpUrl("javascript:alert(1)"));
  assert.throws(() => validateHttpUrl("https://user:pass@example.com"));
});

test("safety helpers detect sensitive fields and irreversible actions", () => {
  assert.equal(isSensitiveField({ type: "password" }), true);
  assert.equal(isSensitiveField({ name: "credit_card_number" }), true);
  assert.equal(isIrreversibleAction({ text: "Buy now" }), true);
  assert.equal(isIrreversibleAction({ type: "submit" }), true);
  assert.equal(isIrreversibleAction({ text: "Open menu" }), false);
});

test("planner rejects unsafe URLs and malformed action plans", () => {
  assert.throws(() => validatePlan({ steps: [{ action: "navigate", url: "javascript:alert(1)" }] }));
  assert.throws(() => validatePlan({ steps: [{ action: "execute_shell" }] }));
  assert.throws(() => validatePlan({ steps: [{ action: "fill", selector: "#password", value: "secret" }] }));
  assert.doesNotThrow(() => validatePlan({ summary: "Inspect", steps: [{ action: "inspect", reason: "Read current page" }] }));
});
