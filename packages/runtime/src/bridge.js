import http from "node:http";
import { getPage } from "./browser.js";
import { runTask, getPageContext } from "./task.js";
import { createPlan } from "./ai-planner.js";
import { validateHttpUrl } from "./safety.js";

const PORT = Number(process.env.PORT || 8787);
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

function send(res, status, data) {
  const origin = res.reqOrigin;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...(origin ? { "access-control-allow-origin": origin, "vary": "Origin" } : {}),
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(JSON.stringify(data));
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
  if (!ALLOWED_HOSTS.has(host)) return send(res, 403, { error: "Unexpected Host header." });
  const allowedOrigin = process.env.ALLOWED_EXTENSION_ORIGIN || "";
  if (origin && (!origin.startsWith("chrome-extension://") || (allowedOrigin && origin !== allowedOrigin))) {
    return send(res, 403, { error: "Origin not allowed. Set ALLOWED_EXTENSION_ORIGIN to your extension ID origin." });
  }
  res.reqOrigin = origin;
  if (req.method === "OPTIONS") return send(res, 200, { ok: true });
  try {
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, name: "OpenFish AI Browser", version: "1.0.3" });
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
server.listen(PORT, "127.0.0.1", () => console.log(`OpenFish bridge listening on http://127.0.0.1:${PORT}`));
