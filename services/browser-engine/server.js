import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { stat, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { basename } from "node:path";
import { chromium } from "playwright";
import { validateTarget } from "./network-policy.js";
import { deleteCompletedDownload, validateDownloadStorage } from "./download-storage.js";

const PORT = Number(process.env.PORT || 8788);
const TOKEN = process.env.OPENFISH_ENGINE_TOKEN || "";
const HOST = process.env.HOST || "0.0.0.0";
const MAX_BODY = 16_000;
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;
const MAX_SESSION_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const DOWNLOADS_DIR = process.env.OPENFISH_DOWNLOADS_DIR || "";
const REQUIRE_DOWNLOADS_TMPFS = process.env.OPENFISH_REQUIRE_DOWNLOADS_TMPFS === "true";
const NAV_TIMEOUT = 25_000;
const SESSION_TTL_MS = Math.max(60_000, Number(process.env.OPENFISH_ENGINE_SESSION_TTL_MS || 30 * 60 * 1000));
const MAX_SESSIONS = Math.max(1, Math.min(50, Number(process.env.OPENFISH_ENGINE_MAX_SESSIONS || 10)));
let downloadStorage = { mode: "playwright-default" };
let browser;
let browserPromise;
const sessions = new Map();
const sessionCreations = new Map();

function hasValidToken(req) {
  if (TOKEN.length < 32 || typeof req.headers.authorization !== "string") return false;
  const prefix = "Bearer ";
  const header = req.headers.authorization;
  if (!header.startsWith(prefix)) return false;
  const supplied = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(TOKEN);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
function sessionId(req) {
  const id = req.headers["x-openfish-session"];
  return typeof id === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(id) ? id : "";
}
async function getBrowser() {
  if (browser?.isConnected()) return browser;
  if (!browserPromise) browserPromise = chromium.launch({ headless: true, ...(DOWNLOADS_DIR ? { downloadsPath: DOWNLOADS_DIR } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage"] })
    .then(value => { browser = value; return value; })
    .finally(() => { browserPromise = null; });
  return browserPromise;
}
async function createSession(id) {
  if (sessions.size + sessionCreations.size > MAX_SESSIONS) {
    await reapExpired();
    if (sessions.size + sessionCreations.size > MAX_SESSIONS) throw Object.assign(new Error("Browser session limit reached. Close an idle session and retry."), { statusCode: 429 });
  }
  const instance = await getBrowser();
  const context = await instance.newContext({ viewport: { width: 1280, height: 820 }, acceptDownloads: true, serviceWorkers: "block" });
  await context.routeWebSocket("**/*", socket => socket.close({ code: 1008, reason: "WebSocket access is disabled by OpenFish network policy." }));
  await context.route("**/*", async route => {
    try { await validateTarget(route.request().url()); await route.continue(); }
    catch { await route.abort("blockedbyclient").catch(() => {}); }
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  const session = { id, context, page, downloads: new Map(), busy: false, lastUsedAt: Date.now(), createdAt: Date.now() };
  sessions.set(id, session);
  return session;
}
async function reapExpired() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (!session.busy && now - session.lastUsedAt > SESSION_TTL_MS) {
      sessions.delete(id);
      await session.context.close().catch(() => {});
    }
  }
}
const sessionReaper = setInterval(() => {
  void reapExpired().catch(error => console.error("Session cleanup failed:", error));
}, Math.min(60_000, Math.max(10_000, Math.floor(SESSION_TTL_MS / 2))));
sessionReaper.unref();

async function getSession(id) {
  await reapExpired();
  let session = sessions.get(id);
  if (!session) {
    let pending = sessionCreations.get(id);
    if (!pending) { pending = Promise.resolve().then(() => createSession(id)); sessionCreations.set(id, pending); }
    try { session = await pending; }
    finally { if (sessionCreations.get(id) === pending) sessionCreations.delete(id); }
  }
  session.lastUsedAt = Date.now();
  if (!session.page || session.page.isClosed()) {
    session.page = await session.context.newPage();
    session.page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  }
  return session;
}
async function listTabs(session) {
  return Promise.all(session.context.pages().map(async (tab, index) => ({
    index, active: tab === session.page,
    title: await tab.title().catch(() => ""),
    url: tab.url()
  })));
}
async function snapshot(current) {
  const details = await current.evaluate(() => ({
    title: document.title || "", url: location.href,
    text: (document.body?.innerText || "").slice(0, 12000),
    links: Array.from(document.querySelectorAll("a[href]")).slice(0, 35)
      .map(a => ({ text: (a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 100), href: a.href }))
      .filter(a => a.text && /^https?:/.test(a.href)),
    canGoBack: history.length > 1
  }));
  const shot = await current.screenshot({ type: "jpeg", quality: 62, fullPage: false });
  return { ok: true, ...details, screenshot: shot.toString("base64"), screenshotType: "image/jpeg" };
}
async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_BODY) throw Object.assign(new Error("请求内容过大"), { statusCode: 413 });
  }
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw Object.assign(new Error("Invalid JSON body."), { statusCode: 400 }); }
}
async function handle(req, res) {
  if (!hasValidToken(req)) return send(res, 401, { error: "Unauthorized" });
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/health" && req.method === "GET") return send(res, 200, { ok: true, engine: "OpenFish Self-hosted Playwright", version: "1.3.5", activeSessions: sessions.size, maxSessions: MAX_SESSIONS, downloadStorage });
  const id = sessionId(req);
  if (!id) return send(res, 400, { error: "A valid X-OpenFish-Session header is required." });
  if (url.pathname === "/close" && req.method === "POST") {
    const session = sessions.get(id);
    if (session?.busy) return send(res, 429, { error: "This browser session is busy. Retry closing it shortly." });
    if (session) { sessions.delete(id); await session.context.close().catch(() => {}); }
    return send(res, 200, { ok: true, closed: Boolean(session) });
  }
  if (!["/status", "/view", "/navigate", "/action", "/tabs", "/download", "/downloads", "/downloads/file", "/downloads/remove"].includes(url.pathname)) return send(res, 404, { error: "Not found" });
  if ((url.pathname === "/status" || url.pathname === "/view" || url.pathname === "/tabs" || url.pathname === "/downloads") ? req.method !== "GET" : req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  let session;
  try {
    session = await getSession(id);
    if (session.busy) return send(res, 429, { error: "This browser session is busy. Retry shortly." });
    session.busy = true;
    if (url.pathname === "/status") return send(res, 200, { ok: true, connected: Boolean(session.context && !session.page.isClosed()), provider: "Self-hosted Playwright + Chromium", currentUrl: session.page.url(), sessionId: id });
    if (url.pathname === "/tabs") return send(res, 200, { ok: true, tabs: await listTabs(session), activeIndex: session.context.pages().indexOf(session.page) });
    if (url.pathname === "/downloads") return send(res, 200, { ok: true, downloads: [...session.downloads.values()].map(({ data, path, ...item }) => item) });
    const payload = req.method === "POST" ? await readBody(req) : {};
    if (url.pathname === "/downloads/file") {
      if (payload.approved !== true) throw Object.assign(new Error("Explicit approval is required to retrieve a download."), { statusCode: 403 });
      const item = session.downloads.get(String(payload.id || ""));
      if (!item) throw Object.assign(new Error("Download not found. It may have expired with the browser session."), { statusCode: 404 });
      const fallbackName = item.filename.replace(/[^a-zA-Z0-9._-]/g, "_") || "download";
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(item.size),
        "content-disposition": `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(item.filename).replace(/[!'()*]/g, char => "%" + char.charCodeAt(0).toString(16).toUpperCase())}`,
        "cache-control": "no-store",
        "x-openfish-download-id": item.id,
        "x-openfish-download-filename": encodeURIComponent(item.filename)
      });
      await pipeline(createReadStream(item.path), res);
      return;
    }
    if (url.pathname === "/downloads/remove") {
      if (payload.approved !== true) throw Object.assign(new Error("Explicit approval is required to remove a download."), { statusCode: 403 });
      const item = session.downloads.get(String(payload.id || ""));
      if (!item) throw Object.assign(new Error("Download not found."), { statusCode: 404 });
      session.downloads.delete(item.id);
      if (item.path) await unlink(item.path).catch(error => { if (error.code !== "ENOENT") throw error; });
      return send(res, 200, { ok: true, removed: true, id: payload.id });
    }
    if (url.pathname === "/download") {
      if (payload.approved !== true) throw Object.assign(new Error("Explicit approval is required to download a file."), { statusCode: 403 });
      const target = await validateTarget(payload.url);
      const waitForDownload = session.page.waitForEvent("download", { timeout: 30_000 });
      const clicked = await session.page.locator("a[href]").evaluateAll((anchors, href) => {
        const link = anchors.find(anchor => anchor.href === href);
        if (!link) return false;
        link.click();
        return true;
      }, target);
      if (!clicked) { waitForDownload.catch(() => {}); throw Object.assign(new Error("The requested link is not present on the current page."), { statusCode: 404 }); }
      let download;
      try { download = await waitForDownload; }
      catch (error) { throw Object.assign(new Error("The selected link did not start a browser download: " + error.message), { statusCode: 502 }); }
      const path = await download.path();
      if (!path) throw Object.assign(new Error("The browser did not provide a completed download file."), { statusCode: 502 });
      const info = await stat(path);
      if (info.size > MAX_DOWNLOAD_BYTES) { await deleteCompletedDownload(download, path); throw Object.assign(new Error("Download exceeds the 15 MB per-file limit."), { statusCode: 413 }); }
      const used = [...session.downloads.values()].reduce((sum, item) => sum + item.size, 0);
      if (used + info.size > MAX_SESSION_DOWNLOAD_BYTES) { await deleteCompletedDownload(download, path); throw Object.assign(new Error("Session download storage is full (50 MB). Remove older downloads first."), { statusCode: 507 }); }
      const id = randomUUID();
      const filename = basename(String(download.suggestedFilename() || "download")).replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").replaceAll("\\", "_").replace(/^\.+/, "").trim().slice(0, 120) || "download";
      const record = { id, filename, size: info.size, url: target, createdAt: new Date().toISOString(), path };
      session.downloads.set(id, record);
      return send(res, 200, { ok: true, download: { id, filename, size: info.size, url: target, createdAt: record.createdAt } });
    }
    const current = session.page;
    if (url.pathname === "/navigate") {
      const target = await validateTarget(payload.url);
      await current.goto(target, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    } else if (url.pathname === "/action") {
      const action = payload.action;
      if (action === "newTab") {
        session.page = await session.context.newPage();
        session.page.setDefaultNavigationTimeout(NAV_TIMEOUT);
        if (payload.url) {
          const target = await validateTarget(payload.url);
          await session.page.goto(target, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
        }
      } else if (action === "switchTab") {
        const index = Number(payload.index), openPages = session.context.pages();
        if (!Number.isInteger(index) || index < 0 || index >= openPages.length) throw new Error("标签页编号无效");
        session.page = openPages[index];
      } else if (action === "closeTab") {
        const openPages = session.context.pages(), index = payload.index === undefined ? openPages.indexOf(session.page) : Number(payload.index);
        if (!Number.isInteger(index) || index < 0 || index >= openPages.length) throw new Error("标签页编号无效");
        const previouslyActive = session.page;
        await openPages[index].close();
        const remaining = session.context.pages();
        session.page = remaining.includes(previouslyActive) ? previouslyActive : (remaining[Math.min(index, remaining.length - 1)] || await session.context.newPage());
        session.page.setDefaultNavigationTimeout(NAV_TIMEOUT);
      } else if (action === "back") await current.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
      else if (action === "forward") await current.goForward({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
      else if (action === "reload") await current.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
      else if (action === "click") {
        const x = Number(payload.x), y = Number(payload.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1280 || y > 820) throw new Error("点击坐标无效");
        await current.mouse.click(x, y); await current.waitForTimeout(700);
      } else if (action === "type") {
        const value = String(payload.text || "");
        if (!value || value.length > 500) throw new Error("输入内容不能为空且不能超过 500 字");
        await current.keyboard.type(value, { delay: 15 });
      } else if (action === "press") {
        const key = String(payload.key || "");
        if (!["Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageDown", "PageUp", "Home", "End"].includes(key)) throw new Error("不支持此按键");
        await current.keyboard.press(key);
      } else if (action === "scroll") {
        const delta = Math.max(-1200, Math.min(1200, Number(payload.deltaY) || 600));
        await current.evaluate(y => window.scrollBy(0, y), delta);
      } else if (action === "clickLink") {
        const target = await validateTarget(payload.url);
        await current.goto(target, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      } else throw new Error("不支持的浏览器操作");
    }
    return send(res, 200, { ...(await snapshot(session.page)), tabs: await listTabs(session), activeIndex: session.context.pages().indexOf(session.page), sessionId: id });
  } catch (error) {
    if (res.headersSent || res.destroyed) { if (!res.destroyed) res.destroy(error); return; }
    return send(res, error.statusCode || 502, { error: String(error?.message || error).slice(0, 500), code: /429|limit|quota/i.test(String(error)) ? "BROWSER_LIMIT" : "BROWSER_ERROR" });
  } finally {
    if (session) { session.busy = false; session.lastUsedAt = Date.now(); }
  }
}
if (TOKEN.length < 32) {
  console.error("OPENFISH_ENGINE_TOKEN must be set to a random secret of at least 32 characters.");
  process.exit(1);
}
const server = http.createServer((req, res) => { handle(req, res).catch(error => { if (res.headersSent || res.destroyed) { if (!res.destroyed) res.destroy(error); } else send(res, 500, { error: String(error?.message || error) }); }); });
try {
  downloadStorage = await validateDownloadStorage({ directory: DOWNLOADS_DIR, required: REQUIRE_DOWNLOADS_TMPFS });
  server.listen(PORT, HOST, () => console.log(`OpenFish self-hosted browser engine listening on ${HOST}:${PORT}`));
} catch (error) {
  console.error("Download storage preflight failed:", error);
  process.exit(1);
}
async function shutdown() {
  server.close();
  for (const session of sessions.values()) await session.context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
