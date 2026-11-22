import http from "node:http";
import { readFile } from "node:fs/promises";
import { getPage, getBrowserStatus, runWithBrowserSession, createBrowserSession, listBrowserSessions, closeBrowserSession, hasBrowserSession, listBrowserTabs, createBrowserTab, switchBrowserTab, closeBrowserTab, getPageDiagnostics, clearPageDiagnostics, listRecentlyClosedTabs, duplicateBrowserTab, reopenClosedBrowserTab, saveCurrentWorkspace, getSavedWorkspaces, restoreSavedWorkspace, clearSessionData } from "./browser.js";
import { runTask, getPageContext } from "./task.js";
import { createTask, updateTask, getTask, listTasks, restoreTask } from "./task-store.js";
import { createPlan } from "./ai-planner.js";
import { executePlan } from "./executor.js";
import { validateHttpUrl } from "./safety.js";
import { authenticateApiKey, createApiKey, listApiKeys, revokeApiKey } from "./api-keys.js";
import { registerClient, listClients, checkClientRateLimit } from "./client-registry.js";
import { downloadLink, listDownloads, removeDownload } from "./download-manager.js";
import { addBookmark, listBookmarks, removeBookmark, listHistory, clearHistory, addReadingItem, listReadingItems, removeReadingItem, setTabOrganization, getLibraryStats, removeWorkspace, exportBrowserLibrary, importBrowserLibrary } from "./browser-library.js";

const PORT = Number(process.env.PORT || 8787);
const VERSION = "2.17.0";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const MODEL = process.env.OPENFISH_MODEL || "qwen2.5:3b";
let ollamaCache = null;
let extensionLastSeenAt = null;
let extensionVersion = null;
async function testOllamaModel() {
  const base = OLLAMA_URL.endsWith("/") ? OLLAMA_URL.slice(0, -1) : OLLAMA_URL;
  const started = Date.now();
  const response = await fetch(`${base}/api/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: MODEL, prompt: "Reply with exactly: OK", stream: false, options: { num_predict: 8 } }), signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
  const data = await response.json();
  const answer = String(data.response || "").trim();
  if (!answer) throw new Error("Ollama returned an empty model response.");
  return { ok: true, model: MODEL, response: answer.slice(0, 160), durationMs: Date.now() - started };
}
async function getOllamaStatus() {
  if (ollamaCache && Date.now() - ollamaCache.checkedAtMs < 15000) return ollamaCache.value;
  try {
    const response = await fetch(`${OLLAMA_URL.endsWith("/") ? OLLAMA_URL.slice(0, -1) : OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
    const payload = await response.json();
    const models = Array.isArray(payload.models) ? payload.models.map(item => item.name).filter(Boolean) : [];
    const value = { reachable: true, model: MODEL, modelInstalled: models.some(name => name === MODEL || name.startsWith(MODEL + ":")), installedModels: models.slice(0, 30), checkedAt: new Date().toISOString() };
    ollamaCache = { checkedAtMs: Date.now(), value };
    return value;
  } catch (error) {
    const value = { reachable: false, model: MODEL, modelInstalled: false, installedModels: [], error: String(error.message || error).slice(0, 180), checkedAt: new Date().toISOString() };
    ollamaCache = { checkedAtMs: Date.now(), value };
    return value;
  }
}
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const startedAt = Date.now();
const metrics = { requests: 0, errors: 0, events: [] };
const adminAssets = new Map([
  ["/admin", ["../../admin/index.html", "text/html; charset=utf-8"]],
  ["/admin/", ["../../admin/index.html", "text/html; charset=utf-8"]],
  ["/admin/app.js", ["../../admin/app.js", "text/javascript; charset=utf-8"]],
  ["/admin/style.css", ["../../admin/style.css", "text/css; charset=utf-8"]]
]);

function send(res, status, data) {
  const path = res.reqPath || "";
  if (path.startsWith("/api/") && !["/api/admin/status", "/api/admin/events"].includes(path)) {
    metrics.requests += 1;
    if (status >= 400) metrics.errors += 1;
    metrics.events.unshift({ time: new Date().toISOString(), path, status });
    metrics.events.length = Math.min(metrics.events.length, 30);
  }
  const origin = res.reqOrigin;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...(origin ? { "access-control-allow-origin": origin, "vary": "Origin" } : {}),
    ...(res.reqRateHeaders || {}),
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type, authorization"
  });
  res.end(JSON.stringify(data));
}
async function sendAsset(res, asset) {
  try {
    const [relativePath, contentType] = asset;
    const content = await readFile(new URL(relativePath, import.meta.url));
    res.writeHead(200, { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(content);
  } catch {
    send(res, 500, { error: "Admin asset could not be loaded." });
  }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let settled = false;
    req.on("data", chunk => {
      if (settled) return;
      raw += chunk;
      if (Buffer.byteLength(raw) > 1_000_000) {
        settled = true;
        reject(Object.assign(new Error("Payload too large (maximum 1 MB)."), { statusCode: 413 }));
        req.resume();
      }
    });
    req.on("end", () => {
      if (settled) return;
      try { resolve(JSON.parse(raw || "{}")); }
      catch { reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 })); }
    });
    req.on("error", error => { if (!settled) reject(error); });
  });
}


const TOOL_CATALOG = [{"name":"open_page","description":"Navigate the shared browser to a public HTTP(S) URL.","inputSchema":{"type":"object","properties":{"url":{"type":"string","format":"uri"}},"required":["url"],"additionalProperties":false},"approval":"not_required"},{"name":"read_page","description":"Read title, URL, and visible page text.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"approval":"not_required"},{"name":"plan_task","description":"Create a proposed browser action plan. Does not execute it.","inputSchema":{"type":"object","properties":{"goal":{"type":"string","minLength":1,"maxLength":2000}},"required":["goal"],"additionalProperties":false},"approval":"not_required"},{"name":"execute_plan","description":"Execute a reviewed plan. Requires explicit approval of the exact plan.","inputSchema":{"type":"object","properties":{"plan":{"type":"object"},"approved":{"type":"boolean","const":true},"taskId":{"type":"string","format":"uuid"}},"required":["plan","approved"],"additionalProperties":false},"approval":"explicit"},{"name":"list_interactive_elements","description":"List visible interactive page elements.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"approval":"not_required"},{"name":"get_accessibility_snapshot","description":"Read page headings and landmarks.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"approval":"not_required"},{"name":"go_back","description":"Go back one page in the current browser tab.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"approval":"not_required"},{"name":"go_forward","description":"Go forward one page in the current browser tab.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"approval":"not_required"},{"name":"reload_page","description":"Reload the current browser page.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"approval":"not_required"},{"name":"list_tabs","description":"List tabs in the current isolated browser session.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"approval":"not_required"},{"name":"new_tab","description":"Open a new tab, optionally navigating to a public HTTP(S) URL.","inputSchema":{"type":"object","properties":{"url":{"type":"string","format":"uri"}},"additionalProperties":false},"approval":"not_required"},{"name":"switch_tab","description":"Switch the active tab by its current list index.","inputSchema":{"type":"object","properties":{"index":{"type":"integer","minimum":0}},"required":["index"],"additionalProperties":false},"approval":"not_required"},{"name":"close_tab","description":"Close a tab by its current list index after explicit approval.","inputSchema":{"type":"object","properties":{"index":{"type":"integer","minimum":0},"approved":{"type":"boolean","const":true}},"required":["index","approved"],"additionalProperties":false},"approval":"explicit"},{"name":"click_element","description":"Click a unique visible button-like element; requires explicit approval.","inputSchema":{"type":"object","properties":{"selector":{"type":"string","minLength":1,"maxLength":500},"approved":{"type":"boolean","const":true}},"required":["selector","approved"],"additionalProperties":false},"approval":"explicit"},{"name":"fill_element","description":"Fill a unique ordinary field; requires explicit approval.","inputSchema":{"type":"object","properties":{"selector":{"type":"string","minLength":1,"maxLength":500},"value":{"type":"string","maxLength":10000},"approved":{"type":"boolean","const":true}},"required":["selector","value","approved"],"additionalProperties":false},"approval":"explicit"},{"name":"take_screenshot","description":"Capture the current browser viewport.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"approval":"not_required"},{"name":"list_bookmarks","description":"List local bookmarks.","inputSchema":{"type":"object","properties":{"query":{"type":"string","maxLength":200}},"required":[],"additionalProperties":false},"approval":"not_required"},{"name":"add_bookmark","description":"Save a public URL as a local bookmark.","inputSchema":{"type":"object","properties":{"url":{"type":"string","format":"uri"},"title":{"type":"string","maxLength":180}},"required":["url"],"additionalProperties":false},"approval":"not_required"},{"name":"remove_bookmark","description":"Remove a bookmark after explicit approval.","inputSchema":{"type":"object","properties":{"id":{"type":"string"},"approved":{"type":"boolean","const":true}},"required":["id","approved"],"additionalProperties":false},"approval":"explicit"},{"name":"list_history","description":"Search local browsing history.","inputSchema":{"type":"object","properties":{"query":{"type":"string","maxLength":200},"limit":{"type":"integer","minimum":1,"maximum":500}},"required":[],"additionalProperties":false},"approval":"not_required"},{"name":"clear_history","description":"Clear local history after explicit approval.","inputSchema":{"type":"object","properties":{"approved":{"type":"boolean","const":true}},"required":["approved"],"additionalProperties":false},"approval":"explicit"},{"name":"list_reading_list","description":"List pages saved for later reading.","inputSchema":{"type":"object","properties":{"query":{"type":"string","maxLength":200}},"required":[],"additionalProperties":false},"approval":"not_required"},{"name":"add_reading_item","description":"Save a page for later reading.","inputSchema":{"type":"object","properties":{"url":{"type":"string","format":"uri"},"title":{"type":"string","maxLength":180},"note":{"type":"string","maxLength":500}},"required":["url"],"additionalProperties":false},"approval":"not_required"},{"name":"remove_reading_item","description":"Remove a reading-list item after explicit approval.","inputSchema":{"type":"object","properties":{"id":{"type":"string"},"approved":{"type":"boolean","const":true}},"required":["id","approved"],"additionalProperties":false},"approval":"explicit"},{"name":"organize_tab","description":"Set tab group label and/or pinned state after explicit approval.","inputSchema":{"type":"object","properties":{"url":{"type":"string","format":"uri"},"groupName":{"type":"string","maxLength":40},"pinned":{"type":"boolean"},"approved":{"type":"boolean","const":true}},"required":["url","approved"],"additionalProperties":false},"approval":"explicit"},{"name":"get_page_diagnostics","description":"Read recent console errors, page exceptions, failed requests, and HTTP errors for the active page.","inputSchema":{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":100}},"required":[],"additionalProperties":false},"approval":"not_required"},{"name":"clear_page_diagnostics","description":"Clear captured diagnostics for the active page.","inputSchema":{"type":"object","properties":{},"required":[],"additionalProperties":false},"approval":"not_required"},{"name":"extract_reader_content","description":"Extract a clean reading view from the active page, including title, description, headings, and article text.","inputSchema":{"type":"object","properties":{},"required":[],"additionalProperties":false},"approval":"not_required"},{"name":"find_in_page","description":"Find occurrences of a phrase in the active page text.","inputSchema":{"type":"object","properties":{"query":{"type":"string","minLength":1,"maxLength":200}},"required":["query"],"additionalProperties":false},"approval":"not_required"},{"name":"get_page_performance","description":"Read navigation timing and resource-transfer summaries for the active page.","inputSchema":{"type":"object","properties":{},"required":[],"additionalProperties":false},"approval":"not_required"},{"name":"list_recently_closed_tabs","description":"List recently closed tabs that can be restored.","inputSchema":{"type":"object","properties":{},"required":[],"additionalProperties":false},"approval":"not_required"},{"name":"duplicate_tab","description":"Duplicate a browser tab by its current list index.","inputSchema":{"type":"object","properties":{"index":{"type":"integer","minimum":0}},"required":["index"],"additionalProperties":false},"approval":"not_required"},{"name":"reopen_closed_tab","description":"Restore the most recently closed tab after explicit approval.","inputSchema":{"type":"object","properties":{"approved":{"type":"boolean","const":true}},"required":["approved"],"additionalProperties":false},"approval":"explicit"},{"name":"search_tabs","description":"Search open tabs by title, URL, or group label.","inputSchema":{"type":"object","properties":{"query":{"type":"string","minLength":1,"maxLength":200}},"required":["query"],"additionalProperties":false},"approval":"not_required"},{"name":"save_workspace","description":"Save the currently open public tabs as a named local workspace.","inputSchema":{"type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":60}},"required":["name"],"additionalProperties":false},"approval":"not_required"},{"name":"list_workspaces","description":"List saved local browser workspaces.","inputSchema":{"type":"object","properties":{},"required":[],"additionalProperties":false},"approval":"not_required"},{"name":"restore_workspace","description":"Restore a saved workspace by opening its saved URLs; requires explicit approval.","inputSchema":{"type":"object","properties":{"id":{"type":"string"},"approved":{"type":"boolean","const":true}},"required":["id","approved"],"additionalProperties":false},"approval":"explicit"},{"name":"remove_workspace","description":"Delete a saved workspace after explicit approval.","inputSchema":{"type":"object","properties":{"id":{"type":"string"},"approved":{"type":"boolean","const":true}},"required":["id","approved"],"additionalProperties":false},"approval":"explicit"},{"name":"download_link","description":"Download a file from one unique visible link in the active page after explicit approval.","inputSchema":{"type":"object","properties":{"selector":{"type":"string","minLength":1,"maxLength":500},"approved":{"type":"boolean","const":true}},"required":["selector","approved"],"additionalProperties":false},"approval":"explicit"},{"name":"list_downloads","description":"List files downloaded and managed by OpenFish.","inputSchema":{"type":"object","properties":{},"required":[],"additionalProperties":false},"approval":"not_required"},{"name":"remove_download","description":"Delete a managed downloaded file after explicit approval.","inputSchema":{"type":"object","properties":{"id":{"type":"string"},"approved":{"type":"boolean","const":true}},"required":["id","approved"],"additionalProperties":false},"approval":"explicit"},{"name":"clear_session_data","description":"Clear cookies and site storage for the active isolated browser session after explicit approval.","inputSchema":{"type":"object","properties":{"approved":{"type":"boolean","const":true}},"required":["approved"],"additionalProperties":false},"approval":"explicit"},{"name":"export_browser_library","description":"Export local bookmarks, browsing history, reading list, tab organization, and workspaces as a JSON backup. Does not include cookies or downloaded files.","inputSchema":{"type":"object","properties":{},"required":[],"additionalProperties":false},"approval":"not_required"},{"name":"import_browser_library","description":"Merge a validated JSON backup into the local browser library after explicit approval.","inputSchema":{"type":"object","properties":{"data":{"type":"object"},"approved":{"type":"boolean","const":true}},"required":["data","approved"],"additionalProperties":false},"approval":"explicit"}];
function adapterTools(kind) {
  if (kind === "openai") return TOOL_CATALOG.map(t => ({ type: "function", function: { name: t.name, description: t.description + (t.approval === "explicit" ? " Explicit user approval is required." : ""), parameters: t.inputSchema, strict: true } }));
  if (kind === "anthropic") return TOOL_CATALOG.map(t => ({ name: t.name, description: t.description + (t.approval === "explicit" ? " Explicit user approval is required." : ""), input_schema: t.inputSchema }));
  if (kind === "gemini") return [{ functionDeclarations: TOOL_CATALOG.map(t => ({ name: t.name, description: t.description + (t.approval === "explicit" ? " Explicit user approval is required." : ""), parameters: t.inputSchema })) }];
  return TOOL_CATALOG;
}
async function invokeTool(name, args = {}) {
  const a = args || {};
  if (name === "open_page") {
    const parsed = validateHttpUrl(a.url);
    const page = await getPage(); await page.goto(parsed.href, { waitUntil: "domcontentloaded" });
    return { title: await page.title(), url: page.url() };
  }
  if (name === "read_page") {
    const page = await getPage(); return { title: await page.title().catch(() => ""), url: page.url(), text: (await page.locator("body").innerText().catch(() => "")).slice(0,20000) };
  }
  if (name === "plan_task") {
    const page = await getPageContext();
    const plan = await createPlan(a.goal, page);
    const task = await createTask({ goal: a.goal, plan, page: { title: page.title, url: page.url }, source: "mcp" });
    return { status: "plan_ready_for_review", ...plan, taskId: task.id, warning: "No action has been executed." };
  }
  if (name === "execute_plan") {
    if (a.approved !== true) throw Object.assign(new Error("Explicit approval of the exact plan is required."), { statusCode: 403 });
    const task = a.taskId ? await getTask(a.taskId) : await createTask({ goal: a.goal || "MCP approved browser plan", plan: a.plan, source: "mcp" });
    await updateTask(task.id, { status: "approved", plan: a.plan, message: "Explicit approval received" });
    await updateTask(task.id, { status: "running", message: "Execution started" });
    try {
      const result = await executePlan(a.plan, { approved: true });
      await updateTask(task.id, { status: result.status === "completed" ? "succeeded" : "stopped", result, message: result.status });
      return { ...result, taskId: task.id };
    } catch (error) {
      await updateTask(task.id, { status: "failed", error: error.message, message: "Execution failed" });
      throw error;
    }
  }
  if (name === "click_element" || name === "fill_element") {
    if (a.approved !== true) throw Object.assign(new Error("Explicit approval is required."), { statusCode: 403 });
    const step = name === "click_element" ? { action: "click", selector: a.selector } : { action: "fill", selector: a.selector, value: a.value };
    return executePlan({ steps: [step] }, { approved: true });
  }
  if (name === "list_interactive_elements") {
    const page = await getPage();
    return page.locator("a,button,input,textarea,select,[role=button]").evaluateAll(nodes => nodes.slice(0,150).map((el,index)=>({index,tag:el.tagName.toLowerCase(),role:el.getAttribute("role"),text:(el.innerText||el.getAttribute("aria-label")||el.getAttribute("placeholder")||el.getAttribute("name")||"").trim().slice(0,180),type:el.getAttribute("type"),name:el.getAttribute("name"),id:el.id||null,href:el.href||null,disabled:Boolean(el.disabled),visible:Boolean(el.getClientRects().length)})).filter(x=>x.visible));
  }
  if (name === "get_accessibility_snapshot") {
    const page = await getPage();
    return {title:await page.title(),url:page.url(),...(await page.locator("body").evaluate(body=>({headings:[...body.querySelectorAll("h1,h2,h3")].slice(0,60).map(el=>({level:Number(el.tagName.slice(1)),text:(el.innerText||"").trim().slice(0,240)})),landmarks:[...body.querySelectorAll("main,nav,header,footer,form,[role=main],[role=navigation]")].slice(0,30).map(el=>({tag:el.tagName.toLowerCase(),role:el.getAttribute("role"),label:el.getAttribute("aria-label"),text:(el.innerText||"").trim().slice(0,500)}))})))};
  }
  if (name === "list_tabs") return { tabs: await listBrowserTabs() };
  if (name === "new_tab") { if (a.url) validateHttpUrl(a.url); const tab = await createBrowserTab(a.url); return { tab, tabs: await listBrowserTabs() }; }
  if (name === "switch_tab") { const tab = await switchBrowserTab(a.index); return { tab, tabs: await listBrowserTabs() }; }
  if (name === "close_tab") { const result = await closeBrowserTab(a.index, a.approved); return { ...result, tabs: await listBrowserTabs() }; }
  if (name === "go_back" || name === "go_forward" || name === "reload_page") {
    const page = await getPage();
    if (name === "go_back") await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 });
    else if (name === "go_forward") await page.goForward({ waitUntil: "domcontentloaded", timeout: 15000 });
    else await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
    return { action: name, title: await page.title().catch(() => ""), url: page.url(), message: name === "go_back" ? "Returned to the previous page when history was available." : name === "go_forward" ? "Moved forward when browser history was available." : "Page reloaded." };
  }
  if (name === "take_screenshot") {
    const page = await getPage();
    const bytes = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false });
    if (bytes.byteLength > 450 * 1024) throw Object.assign(new Error("Screenshot exceeds the 450 KB response limit. Reduce the browser viewport and try again."), { statusCode: 413 });
    return { imageDataUrl: "data:image/jpeg;base64," + bytes.toString("base64"), mimeType: "image/jpeg", url: page.url() };
  }
  if (name === "list_bookmarks") return { bookmarks: await listBookmarks(a.query) };
  if (name === "add_bookmark") return await addBookmark({ url: a.url, title: a.title });
  if (name === "remove_bookmark") return await removeBookmark(a.id, a.approved);
  if (name === "list_history") return { history: await listHistory({ query: a.query, limit: a.limit }) };
  if (name === "clear_history") return await clearHistory(a.approved);
  if (name === "list_reading_list") return { items: await listReadingItems(a.query) };
  if (name === "add_reading_item") return await addReadingItem({ url: a.url, title: a.title, note: a.note });
  if (name === "remove_reading_item") return await removeReadingItem(a.id, a.approved);
  if (name === "organize_tab") return { tab: await setTabOrganization({ url: a.url, groupName: a.groupName, pinned: a.pinned }, a.approved) };
  if (name === "get_page_diagnostics") return { diagnostics: await getPageDiagnostics(a.limit) };
  if (name === "clear_page_diagnostics") return await clearPageDiagnostics();
  if (name === "list_recently_closed_tabs") return { tabs: await listRecentlyClosedTabs() };
  if (name === "duplicate_tab") return { tab: await duplicateBrowserTab(a.index), tabs: await listBrowserTabs() };
  if (name === "reopen_closed_tab") return { ...(await reopenClosedBrowserTab(a.approved)), tabs: await listBrowserTabs() };
  if (name === "search_tabs") { const q = String(a.query || "").toLowerCase(); return { tabs: (await listBrowserTabs()).filter(tab => (tab.title + " " + tab.url + " " + tab.groupName).toLowerCase().includes(q)) }; }
  if (name === "extract_reader_content") { const page = await getPage(); return await page.evaluate(() => { const candidates = [...document.querySelectorAll("article,main,[role=main]")].filter(el => el.getClientRects().length); const target = candidates.sort((a,b) => (b.innerText || "").length - (a.innerText || "").length)[0] || document.body; return { title: document.title, url: location.href, description: document.querySelector("meta[name=description]")?.content || "", headings: [...target.querySelectorAll("h1,h2,h3")].slice(0,60).map(el => ({level:Number(el.tagName.slice(1)),text:(el.innerText || "").trim().slice(0,240)})), text: (target.innerText || "").trim().slice(0,25000) }; }); }
  if (name === "find_in_page") { const page = await getPage(); const query = String(a.query || "").trim(); const text = await page.locator("body").innerText().catch(() => ""); const lower = text.toLowerCase(), needle = query.toLowerCase(); const matches = []; let offset = 0; while (needle && matches.length < 30) { const index = lower.indexOf(needle, offset); if (index < 0) break; matches.push({index,snippet:text.slice(Math.max(0,index-100),Math.min(text.length,index+needle.length+140)).replace(/\s+/g," ").trim()}); offset = index + needle.length; } return { query, totalMatches: needle ? lower.split(needle).length - 1 : 0, matches }; }
  if (name === "get_page_performance") { const page = await getPage(); return await page.evaluate(() => { const nav = performance.getEntriesByType("navigation")[0]; const resources = performance.getEntriesByType("resource"); return { url: location.href, navigation: nav ? { duration: Math.round(nav.duration), responseStart: Math.round(nav.responseStart), domContentLoaded: Math.round(nav.domContentLoadedEventEnd), loadEventEnd: Math.round(nav.loadEventEnd), transferSize: nav.transferSize } : null, resources: { count: resources.length, transferSize: resources.reduce((sum,item)=>sum+(item.transferSize||0),0), zeroTransferSize: resources.filter(item=>item.transferSize===0).length } }; }); }
  if (name === "save_workspace") return await saveCurrentWorkspace(a.name);
  if (name === "list_workspaces") return { workspaces: await getSavedWorkspaces() };
  if (name === "restore_workspace") return await restoreSavedWorkspace(a.id, a.approved);
  if (name === "remove_workspace") return await removeWorkspace(a.id, a.approved);
  if (name === "download_link") return await downloadLink(await getPage(), a.selector, a.approved);
  if (name === "list_downloads") return { downloads: await listDownloads() };
  if (name === "remove_download") return await removeDownload(a.id, a.approved);
  if (name === "clear_session_data") return await clearSessionData(a.approved);
  if (name === "export_browser_library") return await exportBrowserLibrary();
  if (name === "import_browser_library") return await importBrowserLibrary(a.data, a.approved);
  throw Object.assign(new Error("Unknown OpenFish tool."), { statusCode: 404 });
}

const server = http.createServer(async (req, res) => {
  const requestedSession = req.headers["x-openfish-session"] || "default";
  if (requestedSession !== "default" && !/^[a-zA-Z0-9_-]{8,80}$/.test(requestedSession)) return send(res, 400, { error: "Invalid browser session ID." });
  if (requestedSession !== "default" && !hasBrowserSession(requestedSession)) return send(res, 404, { error: "Browser session not found or expired." });
  return runWithBrowserSession(requestedSession, async () => {
  const origin = req.headers.origin || "";
  const host = req.headers.host || "";
  res.reqPath = (req.url || "").split("?")[0];
  if (!ALLOWED_HOSTS.has(host)) return send(res, 403, { error: "Unexpected Host header." });
  const allowedOrigin = process.env.ALLOWED_EXTENSION_ORIGIN || "";
  const localOrigins = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
  const isExtensionOrigin = origin.startsWith("chrome-extension://") && Boolean(allowedOrigin) && origin === allowedOrigin;
  if (origin && !localOrigins.has(origin) && !isExtensionOrigin) {
    return send(res, 403, { error: "Origin not allowed. Set ALLOWED_EXTENSION_ORIGIN to your extension ID origin." });
  }
  res.reqOrigin = isExtensionOrigin ? origin : "";
  if (req.method === "OPTIONS") return send(res, 200, { ok: true });
  try {
    if (req.method === "GET" && adminAssets.has(res.reqPath)) return await sendAsset(res, adminAssets.get(res.reqPath));

    if (req.method === "GET" && ["/api/v1/tools", "/.well-known/openfish-tools.json"].includes(res.reqPath)) {
      return send(res, 200, { name: "OpenFish AI Browser", version: VERSION, protocol: "openfish-tools/1", tools: TOOL_CATALOG, adapters: ["/api/v1/adapters/openai", "/api/v1/adapters/anthropic", "/api/v1/adapters/gemini"], openapi: "/api/v1/openapi.json" });
    }
    if (req.method === "GET" && res.reqPath === "/api/v1/adapters/openai") return send(res, 200, { tools: adapterTools("openai") });
    if (req.method === "GET" && res.reqPath === "/api/v1/adapters/anthropic") return send(res, 200, { tools: adapterTools("anthropic") });
    if (req.method === "GET" && res.reqPath === "/api/v1/adapters/gemini") return send(res, 200, { tools: adapterTools("gemini") });
    if (req.method === "GET" && res.reqPath === "/api/v1/openapi.json") {
      const paths = {};
      for (const tool of TOOL_CATALOG) paths[`/api/v1/tools/${tool.name}`] = { post: { operationId: tool.name, summary: tool.description, requestBody: { required: true, content: { "application/json": { schema: tool.inputSchema } } }, responses: { "200": { description: "Tool result" } } } };
      return send(res, 200, { openapi: "3.1.0", info: { title: "OpenFish AI Browser API", version: VERSION }, servers: [{ url: `http://127.0.0.1:${PORT}` }], paths });
    }
    if (req.method === "POST" && res.reqPath === "/api/auth/verify") {
      const body = await readBody(req);
      const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || "");
      const scope = body.scope === "browser:write" ? "browser:write" : "browser:read";
      const identity = await authenticateApiKey(bearer?.[1], scope);
      if (!identity) return send(res, 401, { error: "Invalid, expired, or revoked API key." });
      if (identity.forbidden) return send(res, 403, { error: `API key lacks ${scope} scope.` });
      await registerClient(identity, { clientId: body.clientId, platform: body.platform, sessionId: body.sessionId });
      return send(res, 200, { ok: true, identity });
    }
    if (req.method === "GET" && res.reqPath === "/api/browser/sessions") {
      return send(res, 200, { sessions: listBrowserSessions(), ttlMs: Number(process.env.OPENFISH_SESSION_TTL_MS || 30 * 60 * 1000) });
    }
    if (req.method === "POST" && res.reqPath === "/api/browser/sessions") {
      const body = await readBody(req);
      return send(res, 201, { session: await createBrowserSession(body.name) });
    }
    if (req.method === "POST" && res.reqPath.startsWith("/api/browser/sessions/") && res.reqPath.endsWith("/close")) {
      const id = res.reqPath.slice("/api/browser/sessions/".length, -"/close".length);
      return send(res, 200, await closeBrowserSession(id));
    }
    if (req.method === "GET" && req.url === "/api/library/export") return send(res, 200, await exportBrowserLibrary());
    if (req.method === "POST" && req.url === "/api/library/import") { const body = await readBody(req); return send(res, 200, await importBrowserLibrary(body.data, body.approved)); }
    if (req.method === "GET" && res.reqPath === "/api/library/bookmarks") return send(res, 200, { bookmarks: await listBookmarks(new URL(req.url, "http://127.0.0.1").searchParams.get("q") || "") });
    if (req.method === "POST" && res.reqPath === "/api/library/bookmarks/add") { const body = await readBody(req); return send(res, 201, await addBookmark(body)); }
    if (req.method === "POST" && res.reqPath === "/api/library/bookmarks/remove") { const body = await readBody(req); return send(res, 200, await removeBookmark(body.id, body.approved)); }
    if (req.method === "GET" && res.reqPath === "/api/library/history") { const url = new URL(req.url, "http://127.0.0.1"); return send(res, 200, { history: await listHistory({ query: url.searchParams.get("q") || "", limit: Number(url.searchParams.get("limit") || 100) }) }); }
    if (req.method === "POST" && res.reqPath === "/api/library/history/clear") { const body = await readBody(req); return send(res, 200, await clearHistory(body.approved)); }
    if (req.method === "GET" && res.reqPath === "/api/library/reading-list") return send(res, 200, { items: await listReadingItems() });
    if (req.method === "POST" && res.reqPath === "/api/library/reading-list/add") { const body = await readBody(req); return send(res, 201, await addReadingItem(body)); }
    if (req.method === "POST" && res.reqPath === "/api/library/reading-list/remove") { const body = await readBody(req); return send(res, 200, await removeReadingItem(body.id, body.approved)); }
    if (req.method === "POST" && res.reqPath === "/api/library/tab/organize") { const body = await readBody(req); return send(res, 200, { tab: await setTabOrganization(body, body.approved) }); }
    if (req.method === "GET" && res.reqPath === "/api/library/stats") return send(res, 200, await getLibraryStats());
    if (req.method === "GET" && res.reqPath === "/api/admin/clients") {
      return send(res, 200, { clients: await listClients(), rateLimitPerMinute: Number(process.env.OPENFISH_RATE_LIMIT_PER_MINUTE || 120) });
    }
    if (req.method === "GET" && res.reqPath === "/api/admin/keys") {
      return send(res, 200, { keys: await listApiKeys() });
    }
    if (req.method === "POST" && res.reqPath === "/api/admin/keys") {
      const body = await readBody(req);
      return send(res, 201, await createApiKey(body));
    }
    if (req.method === "POST" && res.reqPath.startsWith("/api/admin/keys/") && res.reqPath.endsWith("/revoke")) {
      const id = res.reqPath.slice("/api/admin/keys/".length, -"/revoke".length);
      return send(res, 200, { key: await revokeApiKey(id) });
    }
    if (req.method === "POST" && res.reqPath.startsWith("/api/v1/tools/")) {
      const name = res.reqPath.slice("/api/v1/tools/".length);
      const body = await readBody(req);
      const writeTools = new Set(["open_page", "execute_plan", "click_element", "fill_element", "go_back", "go_forward", "reload_page", "new_tab", "switch_tab", "close_tab", "add_bookmark", "remove_bookmark", "clear_history", "add_reading_item", "remove_reading_item", "organize_tab", "duplicate_tab", "reopen_closed_tab", "save_workspace", "restore_workspace", "remove_workspace", "download_link", "remove_download", "clear_session_data", "import_browser_library"]);
      const requiredScope = writeTools.has(name) ? "browser:write" : "browser:read";
      const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || "");
      const identity = await authenticateApiKey(bearer?.[1], requiredScope);
      if (!identity) return send(res, 401, { error: "A valid OpenFish API key is required.", code: "API_KEY_REQUIRED" });
      if (identity.forbidden) return send(res, 403, { error: `API key lacks the ${requiredScope} scope.`, code: "INSUFFICIENT_SCOPE" });
      await registerClient(identity, { clientId: req.headers["x-openfish-client"], platform: req.headers["x-openfish-platform"], sessionId: requestedSession });
      const rate = checkClientRateLimit(identity.id, Number(process.env.OPENFISH_RATE_LIMIT_PER_MINUTE || 120));
      res.reqRateHeaders = { "x-ratelimit-limit": String(rate.limit), "x-ratelimit-remaining": String(rate.remaining), "x-ratelimit-reset": rate.resetAt };
      if (!rate.allowed) { res.setHeader("retry-after", String(rate.retryAfterSeconds)); return send(res, 429, { error: "API key rate limit exceeded.", code: "RATE_LIMITED", retryAfterSeconds: rate.retryAfterSeconds }); }
      return send(res, 200, { tool: name, result: await invokeTool(name, body) });
    }
    if (req.method === "POST" && res.reqPath === "/api/admin/ollama-test") {
      try { return send(res, 200, await testOllamaModel()); }
      catch (error) { return send(res, 503, { ok: false, model: MODEL, error: String(error.message || error).slice(0, 240) }); }
    }
    if (req.method === "POST" && res.reqPath === "/api/extension/heartbeat") {
      if (!res.reqOrigin?.startsWith("chrome-extension://")) return send(res, 403, { error: "Chrome extension origin is required." });
      const body = await readBody(req);
      extensionLastSeenAt = new Date().toISOString();
      extensionVersion = String(body.version || "").slice(0, 32) || null;
      return send(res, 200, { ok: true, version: VERSION, extensionVersion, lastSeenAt: extensionLastSeenAt });
    }
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, name: "OpenFish AI Browser", version: VERSION });
    if (req.method === "GET" && req.url === "/api/admin/status") {
      const browser = getBrowserStatus();
      const uptime = Math.floor((Date.now() - startedAt) / 1000);
      return send(res, 200, {
        name: "OpenFish AI Browser", version: VERSION, uptime,
        uptimeText: uptime < 60 ? `${uptime}s` : uptime < 3600 ? `${Math.floor(uptime / 60)}m ${uptime % 60}s` : `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
        requests: metrics.requests, errors: metrics.errors, maxBrowserSessions: getBrowserStatus().maxSessions,
        clientCount: (await listClients()).length,
        model: MODEL,
        ollama: await getOllamaStatus(),
        extension: { connected: Boolean(extensionLastSeenAt && Date.now() - Date.parse(extensionLastSeenAt) < 45000), version: extensionVersion, lastSeenAt: extensionLastSeenAt },
        browser, port: PORT
      });
    }
    if (req.method === "GET" && req.url === "/api/admin/events") return send(res, 200, { events: metrics.events });
    if (req.method === "GET" && res.reqPath === "/api/admin/tasks") {
      const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
      return send(res, 200, { tasks: await listTasks({ query: url.searchParams.get("q") || "", status: url.searchParams.get("status") || "", limit: url.searchParams.get("limit") || 100 }), maxTasks: Number(process.env.OPENFISH_MAX_TASKS || 500) });
    }
    if (req.method === "GET" && res.reqPath.startsWith("/api/admin/tasks/")) {
      const id = decodeURIComponent(res.reqPath.slice("/api/admin/tasks/".length));
      return send(res, 200, { task: await getTask(id) });
    }
    if (req.method === "POST" && res.reqPath.startsWith("/api/admin/tasks/") && res.reqPath.endsWith("/restore")) {
      const id = decodeURIComponent(res.reqPath.slice("/api/admin/tasks/".length, -"/restore".length));
      return send(res, 201, { task: await restoreTask(id), warning: "Restored plan requires fresh explicit approval." });
    }
    if (req.method === "POST" && res.reqPath.startsWith("/api/admin/tasks/") && res.reqPath.endsWith("/execute")) {
      const id = decodeURIComponent(res.reqPath.slice("/api/admin/tasks/".length, -"/execute".length));
      const body = await readBody(req);
      if (body.approved !== true) return send(res, 403, { error: "Explicit approval of this saved plan is required." });
      const task = await getTask(id);
      if (!task.plan || !Array.isArray(task.plan.steps)) return send(res, 409, { error: "Saved task has no executable plan." });
      await updateTask(id, { status: "approved", message: "Explicit approval received" });
      await updateTask(id, { status: "running", message: "Execution started" });
      try {
        const result = await executePlan(task.plan, { approved: true });
        const saved = await updateTask(id, { status: result.status === "completed" ? "succeeded" : "stopped", result, message: result.status });
        return send(res, 200, { task: saved, result });
      } catch (error) {
        await updateTask(id, { status: "failed", error: error.message, message: "Execution failed" });
        throw error;
      }
    }

    if (req.method === "POST" && req.url === "/api/mcp/plan_task") {
      const body = await readBody(req);
      const page = await getPageContext();
      const plan = await createPlan(body.goal, page);
      const task = await createTask({ goal: body.goal, plan, page: { title: page.title, url: page.url }, source: "mcp-http" });
      return send(res, 200, { status: "plan_ready_for_review", ...plan, taskId: task.id, warning: "No action has been executed." });
    }
    if (req.method === "POST" && req.url === "/api/mcp/execute_plan") {
      const body = await readBody(req);
      if (body.approved !== true) return send(res, 403, { error: "Explicit approval of the exact plan is required." });
      const task = body.taskId ? await getTask(body.taskId) : await createTask({ goal: body.goal || "MCP approved browser plan", plan: body.plan, source: "mcp-http" });
      await updateTask(task.id, { status: "approved", plan: body.plan, message: "Explicit approval received" });
      await updateTask(task.id, { status: "running", message: "Execution started" });
      try {
        const result = await executePlan(body.plan, { approved: true });
        await updateTask(task.id, { status: result.status === "completed" ? "succeeded" : "stopped", result, message: result.status });
        return send(res, 200, { ...result, taskId: task.id });
      } catch (error) {
        await updateTask(task.id, { status: "failed", error: error.message, message: "Execution failed" });
        throw error;
      }
    }
    if (req.method === "GET" && req.url === "/api/mcp/list_workspaces") return send(res, 200, { workspaces: await getSavedWorkspaces() });
    if (req.method === "POST" && req.url === "/api/mcp/save_workspace") { const body = await readBody(req); return send(res, 201, await saveCurrentWorkspace(body.name)); }
    if (req.method === "POST" && req.url === "/api/mcp/restore_workspace") { const body = await readBody(req); return send(res, 200, await restoreSavedWorkspace(body.id, body.approved)); }
    if (req.method === "POST" && req.url === "/api/mcp/remove_workspace") { const body = await readBody(req); return send(res, 200, await removeWorkspace(body.id, body.approved)); }
    if (req.method === "POST" && req.url === "/api/mcp/download_link") { const body = await readBody(req); return send(res, 201, await downloadLink(await getPage(), body.selector, body.approved)); }
    if (req.method === "GET" && req.url === "/api/mcp/list_downloads") return send(res, 200, { downloads: await listDownloads() });
    if (req.method === "POST" && req.url === "/api/mcp/remove_download") { const body = await readBody(req); return send(res, 200, await removeDownload(body.id, body.approved)); }
    if (req.method === "POST" && req.url === "/api/mcp/clear_session_data") { const body = await readBody(req); return send(res, 200, await clearSessionData(body.approved)); }
    if (req.method === "GET" && req.url === "/api/mcp/get_page_diagnostics") return send(res, 200, { diagnostics: await getPageDiagnostics() });
    if (req.method === "POST" && req.url === "/api/mcp/clear_page_diagnostics") return send(res, 200, await clearPageDiagnostics());
    if (req.method === "GET" && req.url === "/api/mcp/list_recently_closed_tabs") return send(res, 200, { tabs: await listRecentlyClosedTabs() });
    if (req.method === "POST" && req.url === "/api/mcp/duplicate_tab") { const body = await readBody(req); return send(res, 200, { tab: await duplicateBrowserTab(body.index), tabs: await listBrowserTabs() }); }
    if (req.method === "POST" && req.url === "/api/mcp/reopen_closed_tab") { const body = await readBody(req); return send(res, 200, { ...(await reopenClosedBrowserTab(body.approved)), tabs: await listBrowserTabs() }); }
    if (req.method === "GET" && req.url === "/api/mcp/extract_reader_content") { const page = await getPage(); return send(res, 200, await page.evaluate(() => { const candidates = [...document.querySelectorAll("article,main,[role=main]")].filter(el => el.getClientRects().length); const target = candidates.sort((a,b) => (b.innerText || "").length - (a.innerText || "").length)[0] || document.body; return { title: document.title, url: location.href, description: document.querySelector("meta[name=description]")?.content || "", headings: [...target.querySelectorAll("h1,h2,h3")].slice(0,60).map(el => ({level:Number(el.tagName.slice(1)),text:(el.innerText || "").trim().slice(0,240)})), text: (target.innerText || "").trim().slice(0,25000) }; })); }
    if (req.method === "POST" && req.url === "/api/mcp/find_in_page") { const body = await readBody(req); const query = String(body.query || "").trim(); if (!query || query.length > 200) return send(res, 400, { error: "A search phrase of 1 to 200 characters is required." }); const page = await getPage(); const text = await page.locator("body").innerText().catch(() => ""); const lower = text.toLowerCase(), needle = query.toLowerCase(), matches = []; let offset = 0; while (matches.length < 30) { const index = lower.indexOf(needle, offset); if (index < 0) break; matches.push({index,snippet:text.slice(Math.max(0,index-100),Math.min(text.length,index+needle.length+140)).replace(/\s+/g," ").trim()}); offset = index + needle.length; } return send(res, 200, { query, totalMatches: needle ? lower.split(needle).length - 1 : 0, matches }); }
    if (req.method === "GET" && req.url === "/api/mcp/get_page_performance") { const page = await getPage(); return send(res, 200, await page.evaluate(() => { const nav = performance.getEntriesByType("navigation")[0]; const resources = performance.getEntriesByType("resource"); return { url: location.href, navigation: nav ? { duration: Math.round(nav.duration), responseStart: Math.round(nav.responseStart), domContentLoaded: Math.round(nav.domContentLoadedEventEnd), loadEventEnd: Math.round(nav.loadEventEnd), transferSize: nav.transferSize } : null, resources: { count: resources.length, transferSize: resources.reduce((sum,item)=>sum+(item.transferSize||0),0), zeroTransferSize: resources.filter(item=>item.transferSize===0).length } }; })); }
    if (req.method === "GET" && req.url === "/api/mcp/read_page") {
      const page = await getPage();
      return send(res, 200, { title: await page.title().catch(() => ""), url: page.url(), text: (await page.locator("body").innerText().catch(() => "")).slice(0, 20000) });
    }
    if (req.method === "GET" && req.url === "/api/mcp/list_interactive_elements") {
      const page = await getPage();
      const items = await page.locator("a,button,input,textarea,select,[role=button]").evaluateAll(nodes => nodes.slice(0, 150).map((el, index) => ({
        index, tag: el.tagName.toLowerCase(), role: el.getAttribute("role"),
        text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || "").trim().slice(0, 180),
        type: el.getAttribute("type"), name: el.getAttribute("name"), id: el.id || null,
        href: el.href || null, disabled: Boolean(el.disabled), visible: Boolean(el.getClientRects().length)
      })).filter(item => item.visible));
      return send(res, 200, items);
    }
    if (req.method === "GET" && req.url === "/api/mcp/get_accessibility_snapshot") {
      const page = await getPage();
      const snapshot = await page.locator("body").evaluate(body => ({
        headings: [...body.querySelectorAll("h1,h2,h3")].slice(0, 60).map(el => ({ level: Number(el.tagName.slice(1)), text: (el.innerText || "").trim().slice(0, 240) })),
        landmarks: [...body.querySelectorAll("main,nav,header,footer,form,[role=main],[role=navigation]")].slice(0, 30).map(el => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), label: el.getAttribute("aria-label"), text: (el.innerText || "").trim().slice(0, 500) }))
      }));
      return send(res, 200, { title: await page.title(), url: page.url(), ...snapshot });
    }
    if (req.method === "POST" && req.url === "/api/mcp/open_page") {
      const body = await readBody(req);
      const parsed = validateHttpUrl(body.url);
      const page = await getPage();
      await page.goto(parsed.href, { waitUntil: "domcontentloaded" });
      return send(res, 200, { title: await page.title(), url: page.url() });
    }
    if (req.method === "POST" && req.url === "/api/mcp/plan_task") {
      const body = await readBody(req);
      if (!String(body.goal || "").trim()) return send(res, 400, { error: "Task description is required." });
      const page = await getPageContext();
      const plan = await createPlan(body.goal, page);
      const task = await createTask({ goal: body.goal, plan, page: { title: page.title, url: page.url }, source: "admin" });
      return send(res, 200, { status: "plan_ready_for_review", ...plan, taskId: task.id, warning: "Review every step. No action has been executed." });
    }
    if (req.method === "POST" && req.url === "/api/mcp/execute_plan") {
      const body = await readBody(req);
      if (body.approved !== true) return send(res, 403, { error: "Explicit approval of the exact plan is required." });
      const task = body.taskId ? await getTask(body.taskId) : await createTask({ goal: body.goal || "Approved browser plan", plan: body.plan, source: "admin" });
      await updateTask(task.id, { status: "approved", plan: body.plan, message: "Explicit approval received" });
      await updateTask(task.id, { status: "running", message: "Execution started" });
      try {
        const result = await executePlan(body.plan, { approved: true });
        await updateTask(task.id, { status: result.status === "completed" ? "succeeded" : "stopped", result, message: result.status });
        return send(res, 200, { ...result, taskId: task.id });
      } catch (error) {
        await updateTask(task.id, { status: "failed", error: error.message, message: "Execution failed" });
        throw error;
      }
    }
    if (req.method === "POST" && req.url === "/api/mcp/click_element") {
      const body = await readBody(req);
      if (body.approved !== true) return send(res, 403, { error: "Explicit approval of this exact click is required." });
      return send(res, 200, await executePlan({ steps: [{ action: "click", selector: body.selector }] }, { approved: true }));
    }
    if (req.method === "POST" && req.url === "/api/mcp/fill_element") {
      const body = await readBody(req);
      if (body.approved !== true) return send(res, 403, { error: "Explicit approval of this exact field and value is required." });
      return send(res, 200, await executePlan({ steps: [{ action: "fill", selector: body.selector, value: body.value }] }, { approved: true }));
    }
    if (req.method === "GET" && req.url === "/api/mcp/list_tabs") return send(res, 200, { tabs: await listBrowserTabs() });
    if (req.method === "POST" && req.url === "/api/mcp/new_tab") { const body = await readBody(req); if (body.url) validateHttpUrl(body.url); const tab = await createBrowserTab(body.url); return send(res, 200, { tab, tabs: await listBrowserTabs() }); }
    if (req.method === "POST" && req.url === "/api/mcp/switch_tab") { const body = await readBody(req); const tab = await switchBrowserTab(body.index); return send(res, 200, { tab, tabs: await listBrowserTabs() }); }
    if (req.method === "POST" && req.url === "/api/mcp/close_tab") { const body = await readBody(req); const result = await closeBrowserTab(body.index, body.approved); return send(res, 200, { ...result, tabs: await listBrowserTabs() }); }
    if (req.method === "POST" && ["/api/mcp/go_back", "/api/mcp/go_forward", "/api/mcp/reload_page"].includes(req.url)) {
      const page = await getPage();
      const action = req.url.split("/").pop();
      if (action === "go_back") await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 });
      else if (action === "go_forward") await page.goForward({ waitUntil: "domcontentloaded", timeout: 15000 });
      else await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
      return send(res, 200, { action, title: await page.title().catch(() => ""), url: page.url() });
    }
    if (req.method === "POST" && req.url === "/api/mcp/take_screenshot") {
      const page = await getPage();
      const bytes = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false });
      if (bytes.byteLength > 450 * 1024) return send(res, 413, { error: "Screenshot exceeds the 450 KB response limit. Reduce the browser viewport and try again." });
      return send(res, 200, { imageDataUrl: "data:image/jpeg;base64," + bytes.toString("base64"), mimeType: "image/jpeg", url: page.url() });
    }
    if (req.method === "POST" && req.url === "/api/inspect") {
      const page = await getPage();
      return send(res, 200, { title: await page.title().catch(() => ""), url: page.url(), text: (await page.locator("body").innerText().catch(() => "")).slice(0, 12000) });
    }
    if (req.method === "POST" && req.url === "/api/task") {
      const body = await readBody(req);
      return send(res, 200, await runTask(body.goal, body.url));
    }
    if (req.method === "POST" && req.url === "/api/plan") {
      const body = await readBody(req);
      if (!String(body.goal || "").trim()) return send(res, 400, { error: "Task description is required." });
      if (body.url) {
        const parsed = validateHttpUrl(body.url);
        const page = await getPage();
        if (page.url() !== parsed.href) await page.goto(parsed.href, { waitUntil: "domcontentloaded" });
      }
      const plan = await createPlan(body.goal, await getPageContext());
      return send(res, 200, { status: "plan_ready_for_review", ...plan, warning: "Review every step. No action has been executed." });
    }
    if (req.method === "POST" && req.url === "/api/execute") {
      const body = await readBody(req);
      if (body.approved !== true) return send(res, 403, { error: "Explicit approval of the exact plan is required." });
      return send(res, 200, await executePlan(body.plan, { approved: true }));
    }
    if (req.method === "POST" && req.url === "/api/navigate") {
      const { url } = await readBody(req);
      const parsed = validateHttpUrl(url);
      const page = await getPage();
      await page.goto(parsed.href, { waitUntil: "domcontentloaded" });
      return send(res, 200, { ok: true, title: await page.title(), url: page.url() });
    }
    return send(res, 404, { error: "Not found" });
  } catch (error) {
    return send(res, error.statusCode || 500, { error: error.message || "Internal error" });
  }
  });
});
server.listen(PORT, "127.0.0.1", () => console.log(`OpenFish bridge listening on http://127.0.0.1:${PORT} (admin: /admin)`));
