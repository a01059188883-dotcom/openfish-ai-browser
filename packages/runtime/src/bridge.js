import http from "node:http";
import { readFile } from "node:fs/promises";
import { getPage, getBrowserStatus } from "./browser.js";
import { runTask, getPageContext } from "./task.js";
import { createPlan } from "./ai-planner.js";
import { executePlan } from "./executor.js";
import { validateHttpUrl } from "./safety.js";

const PORT = Number(process.env.PORT || 8787);
const VERSION = "1.0.6";
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
