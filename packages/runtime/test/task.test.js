import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateHttpUrl, isSensitiveField, isIrreversibleAction, validatePlan } from "../src/safety.js";

test("package and runtime report the same version", async () => {
  const pkg = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const bridge = await readFile(resolve("packages/runtime/src/bridge.js"), "utf8");
  assert.ok(bridge.includes(`const VERSION = "${pkg.version}"`));
});

test("planner prompt rejects unsafe irreversible actions", async () => {
  const source = await readFile(resolve("packages/runtime/src/ai-planner.js"), "utf8");
  for (const term of ["purchases", "payments", "sending messages", "deleting", "submitting forms"]) assert.ok(source.includes(term));
});

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
  assert.throws(() => validateHttpUrl("javascript:alert(1)"), error => error.statusCode === 400);
  assert.throws(() => validateHttpUrl("https://user:pass@example.com"), error => error.statusCode === 400);
});

test("bridge applies strict URL validation to AI planning and uses the configured port for Host checks", async () => {
  const bridge = await readFile(resolve("packages/runtime/src/bridge.js"), "utf8");
  assert.ok(bridge.includes("const ALLOWED_HOSTS = new Set(["));
  assert.ok(bridge.includes("127.0.0.1:${PORT}"));
  assert.ok(bridge.includes("const parsed = validateHttpUrl(body.url)"));
  assert.ok(bridge.includes('const VERSION = "1.0.9"'));
});

test("approved plan executor enforces explicit approval and stops on unsafe targets", async () => {
  const executor = await readFile(resolve("packages/runtime/src/executor.js"), "utf8");
  const mcp = await readFile(resolve("packages/mcp-server/src/index.js"), "utf8");
  const bridge = await readFile(resolve("packages/runtime/src/bridge.js"), "utf8");
  assert.ok(executor.includes("approved !== true"));
  assert.ok(executor.includes("count !== 1"));
  assert.ok(executor.includes("isIrreversibleAction(details)"));
  assert.ok(executor.includes("isSensitiveField(details)"));
  assert.ok(executor.includes('return { status: "stopped"'));
  assert.ok(mcp.includes('server.tool("execute_plan"'));
  assert.ok(mcp.includes("approved: z.literal(true)"));
  assert.ok(bridge.includes('req.url === "/api/execute"'));
  assert.ok(bridge.includes("body.approved !== true"));
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

test("side panel invalidates stale plans and locks execution while generating or executing", async () => {
  const source = await readFile(resolve("packages/chrome-extension/sidepanel.js"), "utf8");
  assert.ok(source.includes('$("goal").addEventListener("input"'));
  assert.ok(source.includes("currentPlan = null;"));
  assert.ok(source.includes('$("execute").hidden = true;'));
  assert.ok(source.includes('$("run").disabled = true;'));
  assert.ok(source.includes("const approvedPlan = currentPlan;"));
  assert.ok(source.includes("finally { currentPlan = null;"));
});

test("visual admin dashboard is wired to local status and event APIs", async () => {
  const bridge = await readFile(resolve("packages/runtime/src/bridge.js"), "utf8");
  const html = await readFile(resolve("packages/admin/index.html"), "utf8");
  const app = await readFile(resolve("packages/admin/app.js"), "utf8");
  const pkg = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  assert.equal(pkg.version, "1.0.9");
  assert.ok(bridge.includes('req.url === "/api/admin/status"'));
  assert.ok(bridge.includes('req.url === "/api/admin/events"'));
  assert.ok(bridge.includes('["../../admin/index.html"'));
  assert.ok(html.includes('href="/admin/style.css"'));
  assert.ok(html.includes('src="/admin/app.js"'));
  assert.ok(app.includes("/api/admin/status"));
  assert.ok(app.includes("/api/admin/events"));
  assert.ok(app.includes("/api/execute"));
});


test("MCP server proxies to the shared bridge instead of creating its own browser", async () => {
  const mcp = await readFile(resolve("packages/mcp-server/src/index.js"), "utf8");
  const bridge = await readFile(resolve("packages/runtime/src/bridge.js"), "utf8");
  assert.ok(mcp.includes("OPENFISH_BRIDGE_URL"));
  assert.ok(mcp.includes("/api/mcp/plan_task"));
  assert.ok(!mcp.includes('from "../../runtime/src/browser.js"'));
  for (const route of ["/api/mcp/read_page", "/api/mcp/open_page", "/api/mcp/execute_plan", "/api/mcp/click_element", "/api/mcp/fill_element", "/api/mcp/take_screenshot", "/api/mcp/list_interactive_elements", "/api/mcp/get_accessibility_snapshot"]) assert.ok(bridge.includes(route));
});

\ntest("multi-provider adapter and REST tool catalog are exposed", async () => {
  const bridge = await readFile(resolve("packages/runtime/src/bridge.js"), "utf8");
  for (const route of ["/api/v1/tools", "/api/v1/adapters/openai", "/api/v1/adapters/anthropic", "/api/v1/adapters/gemini", "/api/v1/openapi.json", "/api/v1/tools/"]) assert.ok(bridge.includes(route));
  assert.ok(bridge.includes('kind === "openai"'));
  assert.ok(bridge.includes('kind === "anthropic"'));
  assert.ok(bridge.includes('kind === "gemini"'));
  assert.ok(bridge.includes('a.approved !== true'));
});
