import mobileAdminHtml from "./mobile-admin.html";
import puppeteer from "@cloudflare/puppeteer";

const VERSION = "2.8.0";
const MAX_BODY_BYTES = 512 * 1024;
const ADMIN_PATHS = new Set(["/api/admin/status", "/api/admin/events", "/api/admin/relay-status", "/api/browser/sessions"]);
const ALLOWED_PATH = path => path === "/mcp" || path === "/health" ||
  path === "/.well-known/openfish-tools.json" ||
  path === "/api/v1/tools" || path.startsWith("/api/v1/tools/") ||
  path.startsWith("/api/v1/adapters/") || path === "/api/v1/openapi.json" || path.startsWith("/api/v1/browser/") ||
  ADMIN_PATHS.has(path) || /^\/api\/browser\/sessions\/[A-Za-z0-9_-]+\/close$/.test(path) ||
  path === "/api/plan" || path === "/api/execute";

function bearer(request) {
  return /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") || "")?.[1] || "";
}
function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) diff |= (a.charCodeAt(i % a.length) || 0) ^ (b.charCodeAt(i % b.length) || 0);
  return diff === 0;
}
function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
function authorized(request, env) {
  const expected = env.OPENFISH_RELAY_TOKEN || "";
  return expected.length >= 32 && constantTimeEqual(bearer(request), expected);
}
function relayStub(env) {
  return env.OPENFISH_RELAY.get(env.OPENFISH_RELAY.idFromName("primary"));
}
function safeHeaders(request) {
  const headers = {};
  for (const name of ["content-type", "accept", "mcp-session-id", "x-openfish-session", "last-event-id"]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value.slice(0, 2048);
  }
  return headers;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/app" || url.pathname === "/app/") {
      if (env.ASSETS) return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
      return new Response("OpenFish mobile frontend assets are not configured.", { status: 503 });
    }
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      return new Response(mobileAdminHtml, { headers: {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      }});
    }
    // Public plugin discovery document; all browser operations remain bearer-authenticated.
    if (url.pathname === "/api/v1/openapi.json" && request.method === "GET") {
      return new Response(JSON.stringify({
        openapi: "3.1.0",
        info: { title: "OpenFish Browser Plugin API", version: VERSION, description: "Private browser API for first-party plugins. Authenticate with the OpenFish relay Bearer token." },
        servers: [{ url: url.origin }],
        security: [{ BearerAuth: [] }],
        components: { securitySchemes: { BearerAuth: { type: "http", scheme: "bearer", bearerFormat: "OpenFish Relay Token" } } },
        paths: {
          "/api/v1/browser/status": { get: { summary: "Browser session status", responses: { "200": { description: "Current cloud browser status" } } } },
          "/api/v1/browser/view": { get: { summary: "Read current page and screenshot", responses: { "200": { description: "Current page snapshot" } } } },
          "/api/v1/browser/navigate": { post: { summary: "Navigate to a public HTTP(S) URL", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" } } } } } }, responses: { "200": { description: "Navigation result" } } } },
          "/api/v1/browser/action": { post: { summary: "Interact with the active page", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["action"], properties: { action: { type: "string", enum: ["back", "forward", "reload", "click", "type", "press", "scroll", "clickLink"] }, x: { type: "number" }, y: { type: "number" }, text: { type: "string" }, key: { type: "string" }, deltaY: { type: "number" }, url: { type: "string", format: "uri" } } } } } }, responses: { "200": { description: "Action result" } } } },
          "/api/v1/browser/close": { post: { summary: "Close the active browser session", responses: { "200": { description: "Session closed" } } } }
        }
      }), { headers: { "content-type": "application/vnd.oai.openapi+json;version=3.1", "cache-control": "public, max-age=300", "x-openfish-version": VERSION } });
    }
    if (url.pathname.startsWith("/api/v1/browser/")) {
      const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type", "access-control-max-age": "86400", "cache-control": "no-store" };
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (!authorized(request, env)) return json({ error: "Unauthorized. Supply the OpenFish relay Bearer token." }, 401);
      const routes = { "/api/v1/browser/status": ["/cloud/status", "GET"], "/api/v1/browser/view": ["/cloud/view", "GET"], "/api/v1/browser/navigate": ["/cloud/navigate", "POST"], "/api/v1/browser/action": ["/cloud/action", "POST"], "/api/v1/browser/close": ["/cloud/close", "POST"] };
      const route = routes[url.pathname];
      if (!route) return json({ error: "Browser API route not found." }, 404);
      if (request.method !== route[1]) return json({ error: "Method not allowed." }, 405);
      let body;
      if (request.method === "POST") {
        const raw = await request.text();
        if (raw.length > 16000) return json({ error: "Request too large." }, 413);
        body = raw || "{}";
      }
      const response = await relayStub(env).fetch(new Request("https://relay.internal" + route[0], { method: request.method, headers: { "content-type": "application/json" }, body }));
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors)) headers.set(key, value);
      headers.set("x-openfish-version", VERSION);
      return new Response(response.body, { status: response.status, headers });
    }
    if (url.pathname.startsWith("/api/cloud-browser/")) {
      if (!authorized(request, env)) return json({ error: "Unauthorized. Supply the relay Bearer token." }, 401);
      const allowed = new Set(["/api/cloud-browser/status", "/api/cloud-browser/view", "/api/cloud-browser/navigate", "/api/cloud-browser/action", "/api/cloud-browser/close"]);
      if (!allowed.has(url.pathname)) return json({ error: "Cloud browser route not found." }, 404);
      if ((url.pathname.endsWith("/status") || url.pathname.endsWith("/view")) && request.method !== "GET") return json({ error: "Method not allowed." }, 405);
      if (!url.pathname.endsWith("/status") && !url.pathname.endsWith("/view") && request.method !== "POST") return json({ error: "Method not allowed." }, 405);
      const body = request.method === "POST" ? await request.text() : "";
      if (body.length > 16000) return json({ error: "Request too large." }, 413);
      return relayStub(env).fetch(new Request("https://relay.internal/cloud" + url.pathname.slice("/api/cloud-browser".length), { method: request.method, headers: { "content-type": "application/json" }, body: body || undefined }));
    }
    if (env.ASSETS && ["/app.css", "/app.js", "/favicon.ico", "/manifest.webmanifest"].includes(url.pathname)) return env.ASSETS.fetch(request);
    if (url.pathname === "/agent/connect") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "WebSocket upgrade required." }, 426);
      if (!authorized(request, env)) return json({ error: "Unauthorized relay agent." }, 401);
      return relayStub(env).fetch(new Request("https://relay.internal/connect", { headers: { Upgrade: "websocket" } }));
    }
    if (url.pathname === "/health" && request.method === "GET") {
      if (!authorized(request, env)) return json({ error: "Unauthorized." }, 401);
      return relayStub(env).fetch("https://relay.internal/status");
    }
    if (!authorized(request, env)) return json({ error: "Unauthorized. Supply the relay Bearer token." }, 401);
    const path = url.pathname;
    if (path === "/api/admin/relay-status") {
      if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
      return relayStub(env).fetch("https://relay.internal/status");
    }
    if (!ALLOWED_PATH(path)) return json({ error: "Relay path is not allowed." }, 404);
    if (path === "/mcp" && !["POST", "GET", "DELETE"].includes(request.method)) return json({ error: "MCP method not supported." }, 405);
    if (path !== "/mcp" && path !== "/health" && !["GET", "POST"].includes(request.method)) return json({ error: "Method not allowed." }, 405);
    if (path === "/api/admin/status" || path === "/api/admin/events" || path === "/api/browser/sessions") {
      if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
    }
    if (path === "/api/browser/sessions" && request.method !== "GET" && request.method !== "POST") return json({ error: "Method not allowed." }, 405);
    let body = "";
    if (request.method !== "GET" && request.method !== "HEAD") {
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > MAX_BODY_BYTES) return json({ error: "Request body exceeds 512 KB relay limit." }, 413);
      body = bytesToBase64(new Uint8Array(bytes));
    }
    const payload = { path: url.pathname + url.search, method: request.method, headers: safeHeaders(request), bodyBase64: body };
    const response = await relayStub(env).fetch(new Request("https://relay.internal/proxy", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
    }));
    if (!response.ok) return response;
    const result = await response.json();
    const bytes = result.bodyBase64 ? Uint8Array.from(atob(result.bodyBase64), c => c.charCodeAt(0)) : null;
    const headers = new Headers(result.headers || {});
    headers.set("cache-control", "no-store");
    headers.set("x-content-type-options", "nosniff");
    return new Response(bytes, { status: result.status || 502, headers });
  }
};

export class OpenFishRelay {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.pending = new Map(); this.maxPending = 32; this.requestTimeoutMs = 45000;
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/cloud/")) return this.handleCloudBrowser(request);
    if (url.pathname === "/connect") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });
      for (const socket of this.ctx.getWebSockets()) {
        const attachment = socket.deserializeAttachment() || {};
        if (attachment.role === "agent") { try { socket.close(1012, "Agent connection replaced"); } catch {} }
      }
      const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ role: "agent", connectedAt: Date.now(), protocol: "openfish-relay/1" });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/status") {
      const agents = this.ctx.getWebSockets().filter(socket => (socket.deserializeAttachment() || {}).role === "agent");
      return json({ ok: true, version: VERSION, connected: agents.length > 0, agents: agents.length, protocol: "openfish-relay/1" });
    }
    if (url.pathname !== "/proxy" || request.method !== "POST") return new Response("Not found", { status: 404 });
    const agents = this.ctx.getWebSockets().filter(socket => (socket.deserializeAttachment() || {}).role === "agent");
    const agent = agents[agents.length - 1];
    if (!agent || agent.readyState !== WebSocket.OPEN) return json({ error: "Local OpenFish agent is offline. Start the relay agent." }, 503);
    if (this.pending.size >= this.maxPending) return json({ error: "Relay is busy. Retry shortly." }, 429);
    const payload = await request.json();
    const path = typeof payload.path === "string" ? payload.path.split("?")[0] : "";
    if (typeof payload.path !== "string" || payload.path.length > 2048 || !ALLOWED_PATH(path)) return json({ error: "Invalid relay path." }, 400);
    const requestId = crypto.randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(requestId); resolve(json({ error: "Local agent request timed out." }, 504)); }, this.requestTimeoutMs);
      this.pending.set(requestId, result => { clearTimeout(timer); resolve(json(result)); });
      try { agent.send(JSON.stringify({ type: "request", requestId, ...payload })); }
      catch { clearTimeout(timer); this.pending.delete(requestId); resolve(json({ error: "Could not send request to local agent." }, 502)); }
    });
  }

  async handleCloudBrowser(request) {
    const url = new URL(request.url);
    const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    const validateTarget = raw => {
      let target;
      try { target = new URL(raw); } catch { throw new Error("请输入有效的网址"); }
      if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error("仅允许公开 HTTP/HTTPS 网页地址");
      const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host === "metadata.google.internal" || host === "169.254.169.254") throw new Error("出于安全原因，不能访问本机、内网或云元数据地址");
      const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (ipv4) {
        const [a,b] = ipv4.slice(1).map(Number);
        if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) throw new Error("不能访问私有或保留 IP 地址");
      }
      if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) throw new Error("不能访问私有 IPv6 地址");
      return target.toString();
    };
    const getBrowser = async () => {
      if (!this.env.BROWSER) throw new Error("Cloudflare Browser Run 尚未绑定。请检查 Worker Browser Binding。");
      let browser = null;
      const stored = await this.ctx.storage.get("cloudBrowserSessionId");
      if (stored) {
        try { browser = await puppeteer.connect(this.env.BROWSER, stored); }
        catch { await this.ctx.storage.delete("cloudBrowserSessionId"); }
      }
      if (!browser) {
        browser = await puppeteer.launch(this.env.BROWSER, { keep_alive: 1200000 });
        await this.ctx.storage.put("cloudBrowserSessionId", browser.sessionId());
      }
      let pages = await browser.pages();
      let page = pages[0];
      if (!page) page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 820 });
      return { browser, page };
    };
    const snapshot = async page => {
      const details = await page.evaluate(() => ({
        title: document.title || "",
        url: location.href,
        text: (document.body?.innerText || "").slice(0, 12000),
        links: Array.from(document.querySelectorAll("a[href]")).slice(0, 35).map(a => ({ text: (a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 100), href: a.href })).filter(a => a.text && /^https?:/.test(a.href)),
        canGoBack: history.length > 1
      }));
      const shot = await page.screenshot({ type: "jpeg", quality: 62, fullPage: false });
      return { ...details, screenshot: bytesToBase64(new Uint8Array(shot)), screenshotType: "image/jpeg" };
    };
    if (url.pathname === "/cloud/view") {
      let browser;
      try {
        const connected = await getBrowser(); browser = connected.browser;
        return jsonResponse({ ok: true, ...(await snapshot(connected.page)) });
      } catch (error) { return jsonResponse({ error: String(error?.message || error).slice(0, 500) }, 502); }
      finally { if (browser) { try { await browser.disconnect(); } catch {} } }
    }
    if (url.pathname === "/cloud/status") {
      const id = await this.ctx.storage.get("cloudBrowserSessionId");
      if (!id) return jsonResponse({ ok: true, connected: false, provider: "Cloudflare Browser Run", version: VERSION, freeAllowance: "10 minutes/day on Workers Free" });
      try {
        const browser = await puppeteer.connect(this.env.BROWSER, id);
        const pages = await browser.pages();
        const current = pages[0] ? await pages[0].url() : "";
        await browser.disconnect();
        return jsonResponse({ ok: true, connected: true, currentUrl: current, provider: "Cloudflare Browser Run", version: VERSION, freeAllowance: "10 minutes/day on Workers Free" });
      } catch {
        await this.ctx.storage.delete("cloudBrowserSessionId");
        return jsonResponse({ ok: true, connected: false, provider: "Cloudflare Browser Run", version: VERSION, freeAllowance: "10 minutes/day on Workers Free" });
      }
    }
    if (url.pathname === "/cloud/close") {
      const id = await this.ctx.storage.get("cloudBrowserSessionId");
      if (id) { try { const browser = await puppeteer.connect(this.env.BROWSER, id); await browser.close(); } catch {} }
      await this.ctx.storage.delete("cloudBrowserSessionId");
      return jsonResponse({ ok: true, closed: true });
    }
    let payload = {};
    try { payload = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON body." }, 400); }
    let browser;
    try {
      const connected = await getBrowser();
      browser = connected.browser;
      const page = connected.page;
      if (url.pathname === "/cloud/navigate") {
        const target = validateTarget(payload.url);
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 25000 });
      } else if (url.pathname === "/cloud/action") {
        const action = payload.action;
        if (action === "back") await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null);
        else if (action === "forward") await page.goForward({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null);
        else if (action === "reload") await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
        else if (action === "click") {
          const x = Number(payload.x), y = Number(payload.y);
          if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1280 || y > 820) throw new Error("点击坐标无效");
          await page.mouse.click(x, y);
          await new Promise(resolve => setTimeout(resolve, 700));
        } else if (action === "type") {
          const value = String(payload.text || "");
          if (!value || value.length > 500) throw new Error("输入内容不能为空且不能超过 500 字");
          await page.keyboard.type(value, { delay: 15 });
        } else if (action === "press") {
          const key = String(payload.key || "");
          if (!["Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageDown", "PageUp", "Home", "End"].includes(key)) throw new Error("不支持此按键");
          await page.keyboard.press(key);
        } else if (action === "scroll") {
          const delta = Math.max(-1200, Math.min(1200, Number(payload.deltaY) || 600));
          await page.evaluate(y => window.scrollBy(0, y), delta);
        } else if (action === "clickLink") {
          const target = validateTarget(payload.url);
          await page.goto(target, { waitUntil: "domcontentloaded", timeout: 25000 });
        } else throw new Error("不支持的浏览器操作");
      }
      const result = await snapshot(page);
      return jsonResponse({ ok: true, ...result });
    } catch (error) {
      return jsonResponse({ error: String(error?.message || error).slice(0, 500), code: /429|limit|quota/i.test(String(error)) ? "BROWSER_LIMIT" : "BROWSER_ERROR" }, 502);
    } finally {
      if (browser) { try { await browser.disconnect(); } catch {} }
    }
  }

  async webSocketMessage(socket, message) {
    const attachment = socket.deserializeAttachment() || {};
    if (attachment.role !== "agent" || typeof message !== "string" || message.length > 800000) return;
    let data; try { data = JSON.parse(message); } catch { return; }
    if (data.type === "heartbeat") { socket.send(JSON.stringify({ type: "heartbeat_ack", at: Date.now() })); return; }
    if (data.type !== "response" || typeof data.requestId !== "string") return;
    const complete = this.pending.get(data.requestId); if (!complete) return;
    this.pending.delete(data.requestId);
    const status = Number.isInteger(data.status) && data.status >= 100 && data.status <= 599 ? data.status : 502;
    const headers = {};
    for (const name of ["content-type", "mcp-session-id"]) if (typeof data.headers?.[name] === "string") headers[name] = data.headers[name].slice(0, 2048);
    const bodyBase64 = typeof data.bodyBase64 === "string" && data.bodyBase64.length <= 700000 ? data.bodyBase64 : "";
    complete({ status, headers, bodyBase64 });
  }
  async webSocketClose(socket) { try { socket.close(); } catch {} }
  async webSocketError(socket) { try { socket.close(1011, "Relay socket error"); } catch {} }
}