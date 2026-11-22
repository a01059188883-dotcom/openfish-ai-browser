import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [ui, worker, index, pkg, engine] = await Promise.all([
  readFile(new URL("./ai-workbench.js", import.meta.url), "utf8"),
  readFile(new URL("../cloudflare/worker.js", import.meta.url), "utf8"),
  readFile(new URL("./index.html", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../services/browser-engine/server.js", import.meta.url), "utf8")
]);

test("AI workbench exposes all ten requested capability areas", () => {
  for (const id of ["chat", "research", "agent", "skills", "memory", "write", "models", "files", "workspace", "voice"]) {
    assert.ok(ui.includes('data-pane="' + id + '"'), "missing pane: " + id);
  }
});

test("AI workbench supports page and multi-tab context with workspace snapshots", () => {
  assert.ok(ui.includes("/api/cloud-browser/view"));
  assert.ok(ui.includes("/api/cloud-browser/tabs"));
  assert.ok(ui.includes("switchTab"));
  assert.ok(ui.includes("openfish.ai.workspaces.v1"));
});

test("AI model adapters and user-local memory and skills are wired", () => {
  for (const provider of ["ollama", "openai", "anthropic", "gemini"]) assert.ok(ui.includes(provider));
  assert.ok(ui.includes("openfish.ai.memory.v1"));
  assert.ok(ui.includes("openfish.ai.skills.v1"));
});

test("research uses authenticated search and source extraction endpoints", () => {
  assert.ok(ui.includes("/api/ai/search"));
  assert.ok(ui.includes("/api/ai/fetch"));
  assert.ok(worker.includes('url.pathname === "/api/ai/search"'));
  assert.ok(worker.includes('url.pathname === "/api/ai/fetch"'));
});

test("document and image analysis adapters are present", () => {
  for (const feature of ["pdf.min.mjs", "mammoth", "xlsx", "inlineData", "image_url"]) assert.ok(ui.includes(feature));
});

test("agent requires explicit approval, validates plans and includes bounded retries", () => {
  assert.ok(ui.includes('confirm("确认批准执行此计划'));
  assert.ok(ui.includes("function validatePlan(value)"));
  assert.ok(ui.includes("validatePlan(plan)"));
  assert.ok(ui.includes("validatePlan(next)"));
  assert.ok(ui.includes('$("of-goal").addEventListener("input"'));
  assert.ok(ui.includes("计划校验失败："));
  assert.ok(ui.includes("AGENT_ACTIONS.has(step.action)"));
  assert.ok(ui.includes("attempt<=2"));
  assert.ok(ui.includes("进度："));
});

test("writing panel reads the active page from the current multi-tab context", () => {
  assert.ok(ui.includes('ctx=await context();$("of-write").value=ctx.current?.text'));
});

test("agent-created tabs navigate to the approved target URL", () => {
  assert.ok(engine.includes("if (payload.url)"));
  assert.ok(engine.includes("await session.page.goto(target"));
});

test("research source fetch rejects IP literals and revalidates redirects", () => {
  assert.ok(worker.includes('host.includes(":")'));
  assert.ok(worker.includes('host.endsWith(".localhost")'));
  assert.ok(worker.includes('host.endsWith(".local")'));
  assert.ok(worker.includes("1,3") && worker.includes("test(host)"));
  assert.ok(worker.includes("validPublicUrl(new URL(location, target).href)"));
});

test("mobile AI workbench has touch-sized controls and horizontal tab scrolling", () => {
  for (const feature of ["min-height:42px", "overflow-x:auto", "max-width:600px"]) assert.ok(ui.includes(feature));
});

test("workbench asset and app version are synchronized to 2.17.0", () => {
  assert.ok(index.includes("ai-workbench.js?v=2.17.0"));
  assert.ok(index.includes("OpenFish AI Browser · v2.17.0"));
  assert.ok(worker.includes('const VERSION = "2.17.0"'));
  assert.ok(pkg.includes('"version": "2.17.0"'));
});
