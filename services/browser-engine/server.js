import http from "node:http";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT || 8788);
const TOKEN = process.env.OPENFISH_ENGINE_TOKEN || "";
const HOST = process.env.HOST || "0.0.0.0";
const MAX_BODY = 16_000;
const NAV_TIMEOUT = 25_000;
let browser;
let context;
let page;
let busy = false;

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  return p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255) ||
    p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
    (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 192 && p[1] === 0) || (p[0] === 198 && (p[1] === 18 || p[1] === 19));
}
function isPrivateIPv6(ip) {
  const v = ip.toLowerCase().split("%")[0];
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || /^fe[89ab]/.test(v) ||
    v.startsWith("::ffff:") || v === "2001:db8::";
}
export async function validateTarget(raw) {
  let target;
  try { target = new URL(raw); } catch { throw new Error("请输入有效的网址"); }
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error("仅允许公开 HTTP/HTTPS 网页地址");
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host === "metadata.google.internal") throw new Error("不能访问本机、内网或云元数据地址");
  if (isIP(host) === 4 && isPrivateIPv4(host)) throw new Error("不能访问私有或保留 IP 地址");
  if (isIP(host) === 6 && isPrivateIPv6(host)) throw new Error("不能访问私有或保留 IPv6 地址");
  if (!isIP(host)) {
    const records = await lookup(host, { all: true, verbatim: true });
    if (!records.length || records.some(x => isIP(x.address) === 4 ? isPrivateIPv4(x.address) : isPrivateIPv6(x.address))) {
      throw new Error("域名解析到私有或保留 IP，已阻止访问");
    }
  }
  return target.toString();
}
async function ensurePage() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    context = await browser.newContext({ viewport: { width: 1280, height: 820 }, acceptDownloads: false });
    page = await context.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  }
  if (!page || page.isClosed()) page = await context.newPage();
  return page;
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
    if (Buffer.byteLength(raw) > MAX_BODY) throw new Error("请求内容过大");
  }
  return raw ? JSON.parse(raw) : {};
}
async function handle(req, res) {
  if (TOKEN.length < 32 || req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: "Unauthorized" });
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/health" && req.method === "GET") return send(res, 200, { ok: true, engine: "OpenFish Self-hosted Playwright", version: "1.0.0" });
  if (url.pathname === "/status" && req.method === "GET") {
    return send(res, 200, { ok: true, connected: Boolean(browser?.isConnected() && page && !page.isClosed()), provider: "Self-hosted Playwright + Chromium", currentUrl: page && !page.isClosed() ? page.url() : "" });
  }
  if (url.pathname === "/close" && req.method === "POST") {
    if (browser) await browser.close().catch(() => {});
    browser = context = page = undefined;
    return send(res, 200, { ok: true, closed: true });
  }
  if (!["/view", "/navigate", "/action"].includes(url.pathname)) return send(res, 404, { error: "Not found" });
  if ((url.pathname === "/view" && req.method !== "GET") || (url.pathname !== "/view" && req.method !== "POST")) return send(res, 405, { error: "Method not allowed" });
  if (busy) return send(res, 429, { error: "Browser is busy. Retry shortly." });
  busy = true;
  try {
    const payload = req.method === "POST" ? await readBody(req) : {};
    const current = await ensurePage();
    if (url.pathname === "/navigate") {
      const target = await validateTarget(payload.url);
      await current.goto(target, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    } else if (url.pathname === "/action") {
      const action = payload.action;
      if (action === "back") await current.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
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
    return send(res, 200, await snapshot(current));
  } catch (error) {
    return send(res, 502, { error: String(error?.message || error).slice(0, 500), code: /429|limit|quota/i.test(String(error)) ? "BROWSER_LIMIT" : "BROWSER_ERROR" });
  } finally { busy = false; }
}
if (TOKEN.length < 32) {
  console.error("OPENFISH_ENGINE_TOKEN must be set to a random secret of at least 32 characters.");
  process.exit(1);
}
const server = http.createServer((req, res) => { handle(req, res).catch(error => send(res, 500, { error: String(error?.message || error) })); });
server.listen(PORT, HOST, () => console.log(`OpenFish self-hosted browser engine listening on ${HOST}:${PORT}`));
async function shutdown() {
  server.close();
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
