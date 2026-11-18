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
  const pkg = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  assert.ok(bridge.includes("const ALLOWED_HOSTS = new Set(["));
  assert.ok(bridge.includes("127.0.0.1:${PORT}"));
  assert.ok(bridge.includes("const parsed = validateHttpUrl(body.url)"));
  assert.ok(bridge.includes(`const VERSION = "${pkg.version}"`));
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
  assert.ok(mcp.includes('approved: z.literal(true).describe("Must be true only after the user explicitly approves this exact click.")'));
  assert.ok(mcp.includes('approved: z.literal(true).describe("Must be true only after the user explicitly approves this exact field and value.")'));
  assert.ok(bridge.includes("Explicit approval of this exact click is required."));
  assert.ok(bridge.includes("Explicit approval of this exact field and value is required."));
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
  assert.equal(pkg.version, "2.8.0");
  assert.ok(bridge.includes('req.url === "/api/admin/status"'));
  assert.ok(bridge.includes('req.url === "/api/admin/events"'));
  assert.ok(bridge.includes('["../../admin/index.html"'));
  assert.ok(html.includes('href="/admin/style.css"'));
  assert.ok(html.includes('src="/admin/app.js"'));
  assert.ok(app.includes("/api/admin/status"));
  assert.ok(app.includes("/api/admin/events"));
  assert.ok(app.includes("/api/execute"));
  assert.ok(html.includes('id="integrations"'));
  assert.ok(html.includes('id="toolCatalog"'));
  assert.ok(app.includes("/api/v1/tools"));
  assert.ok(app.includes("navigator.clipboard.writeText"));
  assert.ok(html.includes('id="eventFilter"'));
  assert.ok(app.includes('$("eventFilter").addEventListener("input"'));
  assert.ok(app.includes("filtered = events.filter"));
  const adminCss = await readFile(resolve("packages/admin/style.css"), "utf8");
  const extensionCss = await readFile(resolve("packages/chrome-extension/style.css"), "utf8");
  assert.ok(adminCss.includes("prefers-reduced-motion"));
  assert.ok(adminCss.includes("skip-link"));
  assert.ok(adminCss.includes("@media(max-width:440px)"));
  assert.ok(extensionCss.includes("prefers-reduced-motion"));
  assert.ok(extensionCss.includes("@media(min-width:560px)"));
  for (const control of ["templateSelect", "templateLoad", "templateCreate", "templateUpdate", "templateDelete"]) assert.ok(html.includes(`id="${control}"`));
  for (const operation of ["templateCreate", "templateLoad", "templateUpdate", "templateDelete"]) assert.ok(app.includes(`$("${operation}")`));
  assert.ok(app.includes("textContent = String(value ?? \"\""));
});


test("MCP server proxies to the shared bridge instead of creating its own browser", async () => {
  const mcp = await readFile(resolve("packages/mcp-server/src/index.js"), "utf8");
  const bridge = await readFile(resolve("packages/runtime/src/bridge.js"), "utf8");
  assert.ok(mcp.includes("OPENFISH_BRIDGE_URL"));
  assert.ok(mcp.includes("/api/mcp/plan_task"));
  assert.ok(!mcp.includes('from "../../runtime/src/browser.js"'));
  for (const route of ["/api/mcp/read_page", "/api/mcp/open_page", "/api/mcp/execute_plan", "/api/mcp/click_element", "/api/mcp/fill_element", "/api/mcp/take_screenshot", "/api/mcp/list_interactive_elements", "/api/mcp/get_accessibility_snapshot"]) assert.ok(bridge.includes(route));
});


test("multi-provider adapter and REST tool catalog are exposed", async () => {
  const bridge = await readFile(resolve("packages/runtime/src/bridge.js"), "utf8");
  for (const route of ["/api/v1/tools", "/api/v1/adapters/openai", "/api/v1/adapters/anthropic", "/api/v1/adapters/gemini", "/api/v1/openapi.json", "/api/v1/tools/"]) assert.ok(bridge.includes(route));
  assert.ok(bridge.includes('kind === "openai"'));
  assert.ok(bridge.includes('kind === "anthropic"'));
  assert.ok(bridge.includes('kind === "gemini"'));
  assert.ok(bridge.includes('a.approved !== true'));
});


test("URL validation blocks private, loopback, metadata, and reserved destinations", () => {
  for (const url of ["http://127.0.0.1/","http://10.0.0.8/","http://192.168.1.1/","http://169.254.169.254/latest/meta-data/","http://[::1]/","http://[fd00::1]/","http://router.local/","http://metadata.google.internal/"]) {
    assert.throws(() => validateHttpUrl(url), error => error.statusCode === 403, url);
  }
  assert.equal(validateHttpUrl("https://example.com").hostname, "example.com");
});
test("browser context applies destination validation to HTTP requests", async () => {
  const browser = await readFile(resolve("packages/runtime/src/browser.js"), "utf8");
  assert.ok(browser.includes('context.route("**/*"'));
  assert.ok(browser.includes("validateHttpUrl(requestUrl)"));
  assert.ok(browser.includes('route.abort("blockedbyclient")'));
});

test("API key routes require scoped Bearer authentication and admin CRUD is present", async () => {
  const bridge = await readFile(resolve("packages/runtime/src/bridge.js"), "utf8");
  const html = await readFile(resolve("packages/admin/index.html"), "utf8");
  const app = await readFile(resolve("packages/admin/app.js"), "utf8");
  assert.ok(bridge.includes("authenticateApiKey(bearer?.[1], requiredScope)"));
  assert.ok(bridge.includes('"browser:write" : "browser:read"'));
  assert.ok(bridge.includes('res.reqPath === "/api/admin/keys"'));
  assert.ok(bridge.includes('res.reqPath.endsWith("/revoke")'));
  assert.ok(html.includes('id="apiKeys"'));
  assert.ok(html.includes('id="createKey"'));
  assert.ok(app.includes('api("/api/admin/keys")'));
  assert.ok(app.includes('api("/api/admin/keys/" + encodeURIComponent(key.id) + "/revoke"'));
  assert.ok(app.includes("仅显示这一次"));
});


test("browser navigation controls are available through Chrome and MCP clients", async () => {
  const bridge = await readFile(resolve("packages/runtime/src/bridge.js"), "utf8");
  const stdio = await readFile(resolve("packages/mcp-server/src/index.js"), "utf8");
  const httpMcp = await readFile(resolve("packages/mcp-server/src/http.js"), "utf8");
  const panel = await readFile(resolve("packages/chrome-extension/sidepanel.html"), "utf8");
  const panelJs = await readFile(resolve("packages/chrome-extension/sidepanel.js"), "utf8");
  for (const action of ["go_back", "go_forward", "reload_page"]) {
    assert.ok(bridge.includes(`"name":"${action}"`));
    assert.ok(stdio.includes(`server.tool("${action}"`));
    assert.ok(httpMcp.includes(`server.tool("${action}"`));
    assert.ok(bridge.includes(`/api/mcp/${action}`));
  }
  for (const id of ["back", "forward", "reload"]) assert.ok(panel.includes(`id="${id}"`));
  assert.ok(panelJs.includes("browserAction(action)"));
});

test("named browser sessions enforce the configured capacity", async () => {
  const browser = await readFile(resolve("packages/runtime/src/browser.js"), "utf8");
  assert.ok(browser.includes("MAX_SESSIONS"));
  assert.ok(browser.includes("pendingSessionCreations"));
  assert.ok(browser.includes("activeNamedSessions + pendingSessionCreations >= MAX_SESSIONS"));
  assert.ok(browser.includes("{ statusCode: 429 }"));
  assert.ok(browser.includes("maxSessions: MAX_SESSIONS"));
});


test("multi-tab management is exposed through runtime, MCP and Chrome side panel", async () => {
  const browser = await readFile(resolve("packages/runtime/src/browser.js"), "utf8");
  const bridge = await readFile(resolve("packages/runtime/src/bridge.js"), "utf8");
  const stdio = await readFile(resolve("packages/mcp-server/src/index.js"), "utf8");
  const httpMcp = await readFile(resolve("packages/mcp-server/src/http.js"), "utf8");
  const html = await readFile(resolve("packages/chrome-extension/sidepanel.html"), "utf8");
  const panel = await readFile(resolve("packages/chrome-extension/sidepanel.js"), "utf8");
  for (const fn of ["listBrowserTabs", "createBrowserTab", "switchBrowserTab", "closeBrowserTab"]) assert.ok(browser.includes("function " + fn));
  for (const tool of ["list_tabs", "new_tab", "switch_tab", "close_tab"]) {
    assert.ok(bridge.includes("\"name\":\"" + tool + "\""));
    assert.ok(bridge.includes("/api/mcp/" + tool));
    assert.ok(stdio.includes("server.tool(\"" + tool + "\""));
    assert.ok(httpMcp.includes("server.tool(\"" + tool + "\""));
  }
  assert.ok(browser.includes("approved !== true"));
  assert.ok(browser.includes("pages.length <= 1"));
  assert.ok(html.includes("id=\"tabsList\""));
  assert.ok(panel.includes("async function refreshTabs()"));
  assert.ok(panel.includes("approved:true"));
});

 
test("screenshot preview returns bounded inline JPEG data rather than a temporary path", async () => {
  const bridge = await readFile(resolve("packages/runtime/src/bridge.js"), "utf8");
  const panel = await readFile(resolve("packages/chrome-extension/sidepanel.js"), "utf8");
  const worker = await readFile(resolve("cloudflare/worker.js"), "utf8");
  const admin = await readFile(resolve("packages/admin/index.html"), "utf8");
  const pkg = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  assert.ok(bridge.includes('type: "jpeg", quality: 55'));
  assert.ok(bridge.includes("450 * 1024"));
  assert.ok(bridge.includes("imageDataUrl"));
  assert.ok(panel.includes("data:image/jpeg;base64,"));
  assert.ok(panel.includes('$("screenshotImage").src = data.imageDataUrl'));
  assert.ok(worker.includes('const VERSION = "' + pkg.version + '"'));
  assert.ok(admin.includes("v" + pkg.version));
});

 
test("browser productivity library is exposed through runtime, MCP, and side panel", async () => {
  const library = await readFile(resolve("packages/runtime/src/browser-library.js"), "utf8");
  const browser = await readFile(resolve("packages/runtime/src/browser.js"), "utf8");
  const bridge = await readFile(resolve("packages/runtime/src/bridge.js"), "utf8");
  const stdio = await readFile(resolve("packages/mcp-server/src/index.js"), "utf8");
  const httpMcp = await readFile(resolve("packages/mcp-server/src/http.js"), "utf8");
  const panel = await readFile(resolve("packages/chrome-extension/sidepanel.html"), "utf8");
  const panelJs = await readFile(resolve("packages/chrome-extension/sidepanel.js"), "utf8");
  for (const fn of ["addBookmark", "listBookmarks", "removeBookmark", "recordVisit", "listHistory", "clearHistory", "addReadingItem", "listReadingItems", "removeReadingItem", "setTabOrganization"]) assert.ok(library.includes("export async function " + fn));
  assert.ok(library.includes("MAX_HISTORY = 3000"));
  assert.ok(library.includes("approved !== true"));
  assert.ok(browser.includes("recordVisit({ url, title })"));
  for (const tool of ["list_bookmarks", "add_bookmark", "remove_bookmark", "list_history", "clear_history", "list_reading_list", "add_reading_item", "remove_reading_item", "organize_tab"]) {
    assert.ok(bridge.includes('"name":"' + tool + '"'));
    assert.ok(stdio.includes('server.tool("' + tool + '"'));
    assert.ok(httpMcp.includes('server.tool("' + tool + '"'));
  }
  assert.ok(panel.includes('id="libraryPanel"'));
  assert.ok(panel.includes('data-library-tab="history"'));
  assert.ok(panelJs.includes("async function refreshLibrary()"));
  assert.ok(panelJs.includes("/api/library/tab/organize"));
});


test("diagnostics, reader extraction, performance inspection, and tab recovery are exposed safely", async () => {
  const browser = await readFile(resolve("packages/runtime/src/browser.js"), "utf8");
  const bridge = await readFile(resolve("packages/runtime/src/bridge.js"), "utf8");
  const stdio = await readFile(resolve("packages/mcp-server/src/index.js"), "utf8");
  const httpMcp = await readFile(resolve("packages/mcp-server/src/http.js"), "utf8");
  const panel = await readFile(resolve("packages/chrome-extension/sidepanel.html"), "utf8");
  const panelJs = await readFile(resolve("packages/chrome-extension/sidepanel.js"), "utf8");
  for (const fn of ["getPageDiagnostics", "clearPageDiagnostics", "listRecentlyClosedTabs", "duplicateBrowserTab", "reopenClosedBrowserTab"]) assert.ok(browser.includes("function " + fn));
  for (const tool of ["get_page_diagnostics", "clear_page_diagnostics", "extract_reader_content", "find_in_page", "get_page_performance", "list_recently_closed_tabs", "duplicate_tab", "reopen_closed_tab", "search_tabs"]) {
    assert.ok(bridge.includes('"name":"' + tool + '"'));
    assert.ok(stdio.includes('server.tool("' + tool + '"'));
    assert.ok(httpMcp.includes('server.tool("' + tool + '"'));
  }
  assert.ok(browser.includes('rows.length = Math.min(rows.length, 100)'));
  assert.ok(browser.includes('session.recentlyClosed.length = Math.min(session.recentlyClosed.length, 10)'));
  assert.ok(browser.includes('approved !== true'));
  for (const id of ["readerMode", "pageDiagnostics", "pagePerformance", "tabsSearch", "restoreClosedTab"]) assert.ok(panel.includes('id="' + id + '"'));
  for (const control of ["readerMode", "pageDiagnostics", "pagePerformance", "restoreClosedTab"]) assert.ok(panelJs.includes('$("' + control + '")'));
});


test("workspaces, managed downloads, and session privacy controls are exposed safely", async () => {
  const browser = await readFile(resolve("packages/runtime/src/browser.js"), "utf8");
  const library = await readFile(resolve("packages/runtime/src/browser-library.js"), "utf8");
  const downloads = await readFile(resolve("packages/runtime/src/download-manager.js"), "utf8");
  const bridge = await readFile(resolve("packages/runtime/src/bridge.js"), "utf8");
  const stdio = await readFile(resolve("packages/mcp-server/src/index.js"), "utf8");
  const httpMcp = await readFile(resolve("packages/mcp-server/src/http.js"), "utf8");
  const panel = await readFile(resolve("packages/chrome-extension/sidepanel.html"), "utf8");
  const panelJs = await readFile(resolve("packages/chrome-extension/sidepanel.js"), "utf8");
  for (const fn of ["saveCurrentWorkspace", "getSavedWorkspaces", "restoreSavedWorkspace", "clearSessionData"]) assert.ok(browser.includes("function " + fn));
  for (const fn of ["saveWorkspace", "listWorkspaces", "getWorkspace", "removeWorkspace"]) assert.ok(library.includes("function " + fn));
  for (const fn of ["downloadLink", "listDownloads", "removeDownload"]) assert.ok(downloads.includes("function " + fn));
  assert.ok(downloads.includes("MAX_FILE_BYTES"));
  assert.ok(downloads.includes("MAX_TOTAL_BYTES"));
  assert.ok(downloads.includes("approved !== true"));
  for (const tool of ["save_workspace", "list_workspaces", "restore_workspace", "remove_workspace", "download_link", "list_downloads", "remove_download", "clear_session_data"]) {
    assert.ok(bridge.includes('"name":"' + tool + '"'));
    assert.ok(stdio.includes('server.tool("' + tool + '"'));
    assert.ok(httpMcp.includes('server.tool("' + tool + '"'));
  }
  assert.ok(panel.includes('id="workspacePanel"'));
  assert.ok(panel.includes('id="downloadsPanel"'));
  assert.ok(panelJs.includes("async function refreshWorkspaces()"));
  assert.ok(panelJs.includes("async function refreshDownloads()"));
  assert.ok(panelJs.includes("/api/mcp/clear_session_data"));
});


test("portable backup and command center are exposed with bounded import", async () => {
  const library = await readFile(resolve("packages/runtime/src/browser-library.js"), "utf8");
  const bridge = await readFile(resolve("packages/runtime/src/bridge.js"), "utf8");
  const stdio = await readFile(resolve("packages/mcp-server/src/index.js"), "utf8");
  const httpMcp = await readFile(resolve("packages/mcp-server/src/http.js"), "utf8");
  const html = await readFile(resolve("packages/chrome-extension/sidepanel.html"), "utf8");
  const panel = await readFile(resolve("packages/chrome-extension/sidepanel.js"), "utf8");
  assert.ok(library.includes("export async function exportBrowserLibrary"));
  assert.ok(library.includes("export async function importBrowserLibrary"));
  assert.ok(library.includes("1024 * 1024"));
  assert.ok(library.includes("approved !== true"));
  for (const tool of ["export_browser_library", "import_browser_library"]) {
    assert.ok(bridge.includes('"name":"' + tool + '"'));
    assert.ok(stdio.includes('server.tool("' + tool + '"'));
    assert.ok(httpMcp.includes('server.tool("' + tool + '"'));
  }
  assert.ok(html.includes('id="commandPalette"'));
  assert.ok(html.includes('id="exportLibrary"'));
  assert.ok(html.includes('id="importLibraryFile"'));
  assert.ok(panel.includes("function renderCommandResults()"));
  assert.ok(html.includes("Shift + T"));
  assert.ok(panel.includes('event.shiftKey&&key==="t"'));
  assert.ok(bridge.includes("/api/library/import"));
});
