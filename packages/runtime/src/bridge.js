import http from "node:http";
import { readFile } from "node:fs/promises";
import { getPage, getBrowserStatus } from "./browser.js";
import { runTask, getPageContext } from "./task.js";
import { createPlan } from "./ai-planner.js";
import { executePlan } from "./executor.js";
import { validateHttpUrl } from "./safety.js";

const PORT = Number(process.env.PORT || 8787);
const VERSION = "1.1.1";
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
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
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


const TOOL_CATALOG = [{"name":"open_page","description":"Navigate the shared browser to a public HTTP(S) URL.","inputSchema":{"type":"object","properties":{"url":{"type":"string","format":"uri"}},"required":["url"],"additionalProperties":false},"approval":"not_required"},{"name":"read_page","description":"Read title, URL, and visible page text.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"approval":"not_required"},{"name":"plan_task","description":"Create a proposed browser action plan. Does not execute it.","inputSchema":{"type":"object","properties":{"goal":{"type":"string","minLength":1,"maxLength":2000}},"required":["goal"],"additionalProperties":false},"approval":"not_required"},{"name":"execute_plan","description":"Execute a reviewed plan. Requires explicit approval of the exact plan.","inputSchema":{"type":"object","properties":{"plan":{"type":"object"},"approved":{"type":"boolean","const":true}},"required":["plan","approved"],"additionalProperties":false},"approval":"explicit"},{"name":"list_interactive_elements","description":"List visible interactive page elements.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"approval":"not_required"},{"name":"get_accessibility_snapshot","description":"Read page headings and landmarks.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"approval":"not_required"},{"name":"click_element","description":"Click a unique visible button-like element; requires explicit approval.","inputSchema":{"type":"object","properties":{"selector":{"type":"string","minLength":1,"maxLength":500},"approved":{"type":"boolean","const":true}},"required":["selector","approved"],"additionalProperties":false},"approval":"explicit"},{"name":"fill_element","description":"Fill a unique ordinary field; requires explicit approval.","inputSchema":{"type":"object","properties":{"selector":{"type":"string","minLength":1,"maxLength":500},"value":{"type":"string","maxLength":10000},"approved":{"type":"boolean","const":true}},"required":["selector","value","approved"],"additionalProperties":false},"approval":"explicit"},{"name":"take_screenshot","description":"Capture the current browser viewport.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"approval":"not_required"}];
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
    const plan = await createPlan(a.goal, await getPageContext());
    return { status: "plan_ready_for_review", ...plan, warning: "No action has been executed." };
  }
  if (name === "execute_plan") {
    if (a.approved !== true) throw Object.assign(new Error("Explicit approval of the exact plan is required."), { statusCode: 403 });
    return executePlan(a.plan, { approved: true });
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
  if (name === "take_screenshot") {
    const page = await getPage(); const path = `openfish-${Date.now()}.png`; await page.screenshot({path,fullPage:false}); return {path,url:page.url()};
  }
  throw Object.assign(new Error("Unknown OpenFish tool."), { statusCode: 404 });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  const host = req.headers.host || "";
  res.reqPath = (req.url || "").split("?")[0];
  if (!ALLOWED_HOSTS.has(host)) return send(res, 403, { error: "Unexpected Host header." });
  const allowedOrigin = process.env.ALLOWED_EXTENSION_ORIGIN || "";
  const localOrigins = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
  const isExtensionOrigin = origin.startsWith("chrome-extension://") && (!allowedOrigin || origin === allowedOrigin);
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
    if (req.method === "POST" && res.reqPath.startsWith("/api/v1/tools/")) {
      const name = res.reqPath.slice("/api/v1/tools/".length);
      const body = await readBody(req);
      return send(res, 200, { tool: name, result: await invokeTool(name, body) });
    }
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, name: "OpenFish AI Browser", version: VERSION });
    if (req.method === "GET" && req.url === "/api/admin/status") {
      const browser = getBrowserStatus();
      const uptime = Math.floor((Date.now() - startedAt) / 1000);
      return send(res, 200, {
        name: "OpenFish AI Browser", version: VERSION, uptime,
        uptimeText: uptime < 60 ? `${uptime}s` : uptime < 3600 ? `${Math.floor(uptime / 60)}m ${uptime % 60}s` : `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
        requests: metrics.requests, errors: metrics.errors,
        model: process.env.OPENFISH_MODEL || "qwen2.5:3b",
        browser, port: PORT
      });
    }
    if (req.method === "GET" && req.url === "/api/admin/events") return send(res, 200, { events: metrics.events });

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
      const plan = await createPlan(body.goal, await getPageContext());
      return send(res, 200, { status: "plan_ready_for_review", ...plan, warning: "Review every step. No action has been executed." });
    }
    if (req.method === "POST" && req.url === "/api/mcp/execute_plan") {
      const body = await readBody(req);
      if (body.approved !== true) return send(res, 403, { error: "Explicit approval of the exact plan is required." });
      return send(res, 200, await executePlan(body.plan, { approved: true }));
    }
    if (req.method === "POST" && req.url === "/api/mcp/click_element") {
      const body = await readBody(req);
      return send(res, 200, await executePlan({ steps: [{ action: "click", selector: body.selector }] }, { approved: true }));
    }
    if (req.method === "POST" && req.url === "/api/mcp/fill_element") {
      const body = await readBody(req);
      return send(res, 200, await executePlan({ steps: [{ action: "fill", selector: body.selector, value: body.value }] }, { approved: true }));
    }
    if (req.method === "POST" && req.url === "/api/mcp/take_screenshot") {
      const page = await getPage();
      const path = `openfish-${Date.now()}.png`;
      await page.screenshot({ path, fullPage: false });
      return send(res, 200, { path, url: page.url() });
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
server.listen(PORT, "127.0.0.1", () => console.log(`OpenFish bridge listening on http://127.0.0.1:${PORT} (admin: /admin)`));
