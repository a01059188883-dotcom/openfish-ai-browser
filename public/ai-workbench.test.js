import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [ui, worker, index, pkg] = await Promise.all([
  readFile(new URL("./ai-workbench.js", import.meta.url), "utf8"),
  readFile(new URL("../cloudflare/worker.js", import.meta.url), "utf8"),
  readFile(new URL("./index.html", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8")
]);

test("AI workbench exposes all ten requested capability areas", () => {
  for (const id of ["chat", "research", "agent", "skills", "memory", "write", "models", "files", "workspace", "voice"]) {
    assert.ok(ui.includes('data-pane="' + id + '"'), "missing pane: " + id);
  }
});

test("AI workbench supports page and multi-tab context with workspace snapshots", () => {
  assert.match(ui, /api\/cloud-browser\/view/);
  assert.match(ui, /api\/cloud-browser\/tabs/);
  assert.match(ui, /switchTab/);
  assert.match(ui, /openfish\.ai\.workspaces\.v1/);
});

test("AI model adapters and user-local memory and skills are wired", () => {
  for (const provider of ["ollama", "openai", "anthropic", "gemini"]) assert.ok(ui.includes(provider));
  assert.match(ui, /openfish\.ai\.memory\.v1/);
  assert.match(ui, /openfish\.ai\.skills\.v1/);
});

test("research uses authenticated search and source extraction endpoints", () => {
  assert.match(ui, /\/api\/ai\/search/);
  assert.match(ui, /\/api\/ai\/fetch/);
  assert.match(worker, /url\.pathname === "\/api\/ai\/search"/);
  assert.match(worker, /url\.pathname === "\/api\/ai\/fetch"/);
});

test("document and image analysis adapters are present", () => {
  assert.match(ui, /pdf\.min\.mjs/);
  assert.match(ui, /mammoth/);
  assert.match(ui, /xlsx/);
  assert.match(ui, /inlineData/);
  assert.match(ui, /image_url/);
});

test("agent requires explicit approval and includes bounded retries and progress", () => {
  assert.match(ui, /confirm\("确认批准执行此计划/);
  assert.match(ui, /attempt<=2/);
  assert.match(ui, /进度：/);
});

test("workbench asset is included in the production page and app version is synchronized", () => {
  assert.match(index, /ai-workbench\.js\?v=2\.14\.0/);
  assert.match(index, /OpenFish AI Browser · v2\.14\.0/);
  assert.match(worker, /const VERSION = "2\.14\.0"/);
  assert.match(pkg, /"version": "2\.14\.0"/);
});

test("agent validates a safe action allowlist and the writing panel uses the current page", () => {
  assert.match(ui, /function validatePlan\(value\)/);
  assert.match(ui, /AGENT_ACTIONS\.has\(step\.action\)/);
  assert.match(ui, /ctx\.current\?\.text/);
  assert.match(ui, /if \(payload\.url\)/);
});

test("research source fetch rejects IP-literal targets", () => {
  assert.ok(worker.includes("!host || /^\\\\d{1,3}(?:\\\\.\\\\d{1,3}){3}$/.test(host)"));
  assert.match(worker, /target = validPublicUrl\(new URL\(location, target\)\.href\)/);
});

test("mobile AI workbench has touch-sized controls and horizontal tab scrolling", () => {
  assert.match(ui, /min-height:42px/);
  assert.match(ui, /overflow-x:auto/);
  assert.match(ui, /max-width:600px/);
});
