import mobileAdminHtml from "./mobile-admin.html";
import { handleAuthVaultRoute } from "./auth-vault.js";
import { acquire, connect } from "@cloudflare/playwright";

const VERSION = "2.17.0";
const MAX_BODY_BYTES = 512 * 1024;
const guardedBrowserContexts = new WeakSet();
const ADMIN_PATHS = new Set(["/api/admin/status", "/api/admin/events", "/api/admin/relay-status", "/api/admin/tasks", "/api/browser/sessions"]);
const ALLOWED_PATH = path => path === "/mcp" || path === "/health" ||
  path === "/.well-known/openfish-tools.json" ||
  path === "/api/v1/tools" || path.startsWith("/api/v1/tools/") ||
  path.startsWith("/api/v1/adapters/") || path === "/api/v1/openapi.json" || path.startsWith("/api/v1/browser/") ||
  ADMIN_PATHS.has(path) || /^\/api\/admin\/tasks\/[A-Za-z0-9-]+(?:\/restore)?$/.test(path) || /^\/api\/browser\/sessions\/[A-Za-z0-9_-]+\/close$/.test(path) ||
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
    if (url.pathname.startsWith("/api/auth/")) {
      const headers = new Headers();
      for (const name of ["cookie", "origin", "content-type", "cf-connecting-ip"]) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      const body = ["POST", "PUT", "PATCH"].includes(request.method) ? await request.arrayBuffer() : undefined;
      const authPath = url.pathname.replace(/^\\/api/, "");
      if (["POST", "PUT"].includes(request.method) && body && body.byteLength > 8192) return json({ error: "Authentication request body too large." }, 413);
      const internal = new Request(new URL(authPath, request.url), { method: request.method, headers, body });
      return relayStub(env).fetch(internal);
    }
    // An authenticated HttpOnly session may use the admin APIs without ever
    // returning the Relay or Engine tokens to JavaScript.
    const sessionCheck = await relayStub(env).fetch(new Request("https://relay.internal/auth/validate", {
      method: "POST", headers: { cookie: request.headers.get("cookie") || "" }
    }));
    if (sessionCheck.ok) {
      const credentialResponse = await relayStub(env).fetch(new Request("https://relay.internal/auth/credentials", {
        method: "POST", headers: { cookie: request.headers.get("cookie") || "" }
      }));
      if (credentialResponse.ok) {
        const credentials = (await credentialResponse.json()).secrets || {};
        env = {
          ...env,
          OPENFISH_RELAY_TOKEN: credentials.OPENFISH_RELAY_TOKEN || env.OPENFISH_RELAY_TOKEN,
          BROWSER_ENGINE_TOKEN: credentials.BROWSER_ENGINE_TOKEN || env.BROWSER_ENGINE_TOKEN,
          BROWSER_ENGINE_URL: credentials.BROWSER_ENGINE_URL || env.BROWSER_ENGINE_URL
        };
        if (!request.headers.get("authorization") && env.OPENFISH_RELAY_TOKEN) {
          const headers = new Headers(request.headers);
          headers.set("authorization", "Bearer " + env.OPENFISH_RELAY_TOKEN);
          request = new Request(request, { headers });
        }
      }
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
          "/api/v1/browser/tabs": { get: { summary: "List tabs in the active browser session", responses: { "200": { description: "Open browser tabs and active tab index" } } } },
          "/api/v1/browser/navigate": { post: { summary: "Navigate to a public HTTP(S) URL", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" } } } } } }, responses: { "200": { description: "Navigation result" } } } },
          "/api/v1/browser/action": { post: { summary: "Interact with the active page", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["action"], properties: { action: { type: "string", enum: ["back", "forward", "reload", "click", "type", "press", "scroll", "clickLink", "newTab", "switchTab", "closeTab"] }, x: { type: "number" }, y: { type: "number" }, text: { type: "string" }, key: { type: "string" }, deltaY: { type: "number" }, index: { type: "integer", minimum: 0 }, url: { type: "string", format: "uri" } } } } } }, responses: { "200": { description: "Action result" } } } },
          "/api/v1/browser/close": { post: { summary: "Close the active browser session", responses: { "200": { description: "Session closed" } } } }
        }
      }), { headers: { "content-type": "application/vnd.oai.openapi+json;version=3.1", "cache-control": "public, max-age=300", "x-openfish-version": VERSION } });
    }
    if (url.pathname === "/api/ai/search") {
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
      if (!authorized(request, env)) return json({ error: "Unauthorized." }, 401);
      let payload;
      try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
      const query = String(payload.query || "").trim().slice(0, 300);
      if (!query) return json({ error: "A search query is required." }, 400);
      const headers = { "user-agent": "Mozilla/5.0 (compatible; OpenFishAI-Browser/2.16.1)", "accept": "text/html" };
      const sources = await Promise.allSettled([
        fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), { headers, signal: AbortSignal.timeout(12000) }),
        fetch("https://www.bing.com/search?q=" + encodeURIComponent(query), { headers, signal: AbortSignal.timeout(12000) })
      ]);
      const results = [];
      for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
        const settled = sources[sourceIndex];
        if (settled.status !== "fulfilled" || !settled.value.ok) continue;
        const html = (await settled.value.text()).slice(0, 1500000);
        const pattern = sourceIndex === 0
          ? /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
          : /<li class="b_algo"[\s\S]*?<h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let match, count = 0;
        while ((match = pattern.exec(html)) && count < 8) {
          let href = match[1].replace(/&amp;/g, "&");
          try { const parsed = new URL(href, sourceIndex === 0 ? "https://html.duckduckgo.com" : "https://www.bing.com"); href = parsed.searchParams.get("uddg") || href; } catch {}
          if (!/^https?:\/\//i.test(href)) continue;
          const title = match[2].replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim().slice(0, 240);
          if (title && !results.some(item => item.url === href)) { results.push({ title, url: href, engine: sourceIndex === 0 ? "DuckDuckGo" : "Bing" }); count++; }
        }
      }
      return json({ query, engines: [...new Set(results.map(item => item.engine))], results });
    }
    if (url.pathname === "/api/ai/fetch") {
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
      if (!authorized(request, env)) return json({ error: "Unauthorized." }, 401);
      let payload;
      try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
      const validPublicUrl = value => {
        let u;
        try { u = new URL(value); } catch { return null; }
        if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return null;
        const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
        if (!host || !host.includes(".") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".test") || host.endsWith(".example") || host.endsWith(".invalid") || host.endsWith(".onion") ||
          /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return null;
        return u;
      };
      let target = validPublicUrl(payload.url);
      if (!target) return json({ error: "Only public HTTP(S) URLs are allowed." }, 400);
      try {
        let response;
        for (let hop = 0; hop < 4; hop++) {
          response = await fetch(target.href, { redirect: "manual", signal: AbortSignal.timeout(12000), headers: { "user-agent": "Mozilla/5.0 (compatible; OpenFishAI-Browser/2.16.1)", "accept": "text/html,text/plain;q=0.9" } });
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get("location");
          if (!location || hop === 3) return json({ error: "Too many or invalid redirects." }, 502);
          target = validPublicUrl(new URL(location, target).href);
          if (!target) return json({ error: "Redirect target is not a public HTTP(S) URL." }, 400);
        }
        if (!response?.ok) return json({ error: "Source returned HTTP " + (response?.status || 502) }, 502);
        const type = response.headers.get("content-type") || "";
        if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) return json({ error: "Unsupported source content type: " + type.slice(0, 100) }, 415);
        const html = (await response.text()).slice(0, 600000);
        const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || target.hostname;
        const text = html.replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim().slice(0, 16000);
        return json({ url: response.url || target.href, title, text });
      } catch (error) { return json({ error: "Source fetch failed: " + String(error.message || error).slice(0, 200) }, 502); }
    }
    if (url.pathname.startsWith("/api/v1/browser/")) {
      const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type, X-OpenFish-Session", "access-control-max-age": "86400", "cache-control": "no-store" };
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (!authorized(request, env)) return json({ error: "Unauthorized. Supply the OpenFish relay Bearer token." }, 401);
      const routes = { "/api/v1/browser/status": ["/cloud/status", "GET"], "/api/v1/browser/view": ["/cloud/view", "GET"], "/api/v1/browser/tabs": ["/cloud/tabs", "GET"], "/api/v1/browser/navigate": ["/cloud/navigate", "POST"], "/api/v1/browser/action": ["/cloud/action", "POST"], "/api/v1/browser/close": ["/cloud/close", "POST"] };
      const route = routes[url.pathname];
      if (!route) return json({ error: "Browser API route not found." }, 404);
      if (request.method !== route[1]) return json({ error: "Method not allowed." }, 405);
      let body;
      if (request.method === "POST") {
        const raw = await request.text();
        if (raw.length > 16000) return json({ error: "Request too large." }, 413);
        body = raw || "{}";
      }
      const response = await relayStub(env).fetch(new Request("https://relay.internal" + route[0], { method: request.method, headers: { "content-type": "application/json", "x-openfish-session": request.headers.get("x-openfish-session") || "" }, body }));
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors)) headers.set(key, value);
      headers.set("x-openfish-version", VERSION);
      return new Response(response.body, { status: response.status, headers });
    }
    if (url.pathname.startsWith("/api/cloud-browser/")) {
      if (!authorized(request, env)) return json({ error: "Unauthorized. Supply the relay Bearer token." }, 401);
      const allowed = new Set(["/api/cloud-browser/status", "/api/cloud-browser/view", "/api/cloud-browser/tabs", "/api/cloud-browser/navigate", "/api/cloud-browser/action", "/api/cloud-browser/close", "/api/cloud-browser/download", "/api/cloud-browser/downloads", "/api/cloud-browser/downloads/file", "/api/cloud-browser/downloads/remove"]);
      if (!allowed.has(url.pathname)) return json({ error: "Cloud browser route not found." }, 404);
      const readOnlyRoute = ["/api/cloud-browser/status", "/api/cloud-browser/view", "/api/cloud-browser/tabs", "/api/cloud-browser/downloads"].includes(url.pathname);
      if (readOnlyRoute && request.method !== "GET") return json({ error: "Method not allowed." }, 405);
      if (!readOnlyRoute && request.method !== "POST") return json({ error: "Method not allowed." }, 405);
      const body = request.method === "POST" ? await request.text() : "";
      if (body.length > 16000) return json({ error: "Request too large." }, 413);
      return relayStub(env).fetch(new Request("https://relay.internal/cloud" + url.pathname.slice("/api/cloud-browser".length), { method: request.method, headers: { "content-type": "application/json", "x-openfish-session": request.headers.get("x-openfish-session") || "" }, body: body || undefined }));
    }
    if (env.ASSETS && ["/app.css", "/workspace.css", "/app.js", "/ai-workbench.js", "/favicon.ico", "/manifest.webmanifest"].includes(url.pathname)) return env.ASSETS.fetch(request);
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
    this.ctx = ctx; this.env = env; this.pending = new Map(); this.cloudLocks = new Map(); this.maxPending = 32; this.requestTimeoutMs = 45000;
  }
  async fetch(request) {
    const authResponse = await handleAuthVaultRoute(request, this.ctx, this.env);
    if (authResponse) return authResponse;
    const url = new URL(request.url);
    if (url.pathname.startsWith("/cloud/")) return this.withCloudSessionLock(request);
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

  async withCloudSessionLock(request) {
    const id = request.headers.get("x-openfish-session") || "";
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) return json({ error: "A valid X-OpenFish-Session header is required." }, 400);
    const previous = this.cloudLocks.get(id) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const queued = previous.then(() => current);
    this.cloudLocks.set(id, queued);
    await previous;
    try { return await this.handleCloudBrowser(request); }
    finally {
      release();
      if (this.cloudLocks.get(id) === queued) this.cloudLocks.delete(id);
    }
  }

  async handleCloudBrowser(request) {
    const url = new URL(request.url);
    const sessionId = request.headers.get("x-openfish-session") || "";
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId)) return new Response(JSON.stringify({ error: "A valid X-OpenFish-Session header is required." }), { status: 400, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    const storageKey = key => "cloudBrowser:" + sessionId + ":" + key;
    const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    // Optional self-hosted Playwright engine takes priority when both secrets are configured.
    // Cloudflare Browser Run remains the fallback, preserving existing deployments.
    if (this.env.BROWSER_ENGINE_URL && this.env.BROWSER_ENGINE_TOKEN) {
      const endpoint = new URL(url.pathname.slice("/cloud".length), this.env.BROWSER_ENGINE_URL.endsWith("/") ? this.env.BROWSER_ENGINE_URL : this.env.BROWSER_ENGINE_URL + "/");
      const method = url.pathname === "/cloud/status" || url.pathname === "/cloud/view" || url.pathname === "/cloud/tabs" || url.pathname === "/cloud/downloads" ? "GET" : "POST";
      const body = method === "POST" ? await request.text() : undefined;
      if (body && body.length > 16000) return jsonResponse({ error: "Request too large." }, 413);
      // File transfer may legitimately take longer; keep ordinary browser RPCs bounded.
      const upstreamTimeoutMs = url.pathname.startsWith("/cloud/download") ? 120000 : 45000;
      try {
        const upstream = await fetch(endpoint, {
          method,
          headers: { "authorization": "Bearer " + this.env.BROWSER_ENGINE_TOKEN, "x-openfish-session": sessionId, ...(body ? { "content-type": "application/json" } : {}) },
          body,
          signal: AbortSignal.timeout(upstreamTimeoutMs)
        });
        const headers = new Headers(upstream.headers);
        headers.set("cache-control", "no-store");
        headers.set("x-openfish-version", VERSION);
        return new Response(upstream.body, { status: upstream.status, headers });
      } catch (error) {
        return jsonResponse({ error: "Self-hosted browser engine unavailable: " + String(error?.message || error).slice(0, 250), code: "ENGINE_UNAVAILABLE" }, 502);
      }
    }
    if (["/cloud/download", "/cloud/downloads", "/cloud/downloads/file", "/cloud/downloads/remove"].includes(url.pathname)) return jsonResponse({ error: "Cloud downloads require the self-hosted Playwright engine. The configured Browser Run fallback does not expose a verified file-transfer API." }, 501);
    const validateTarget = raw => {
      let target;
      try { target = new URL(raw); } catch { throw new Error("请输入有效的网址"); }
      if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error("仅允许公开 HTTP/HTTPS 网页地址");
      const host = target.hostname.toLowerCase().replace(/^\\[|\\]$/g, "").replace(/\\.$/, "");
      if (host === "localhost" || host === "metadata.google.internal" || [".localhost", ".local", ".internal", ".home.arpa", ".test", ".invalid", ".example"].some(suffix => host.endsWith(suffix))) throw new Error("出于安全原因，不能访问本机、内网或云元数据地址");
      const ipv4 = host.match(/^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$/);
      if (ipv4) {
        const [a,b,c] = ipv4.slice(1).map(Number);
        if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) || (a === 203 && b === 0 && c === 113)) throw new Error("不能访问私有或保留 IP 地址");
      }
      if (host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/.test(host) || host.startsWith("ff") || host.startsWith("::ffff:") || host.startsWith("2001:db8:") || /^2001:0(?::|$)/.test(host) || /^2001:(10|20)(?::|$)/.test(host) || host.startsWith("2001:2:") || host.startsWith("2002:") || host.startsWith("64:ff9b:")) throw new Error("不能访问私有或保留 IPv6 地址");
      return target.toString();
    };
    const getBrowser = async () => {
      if (!this.env.BROWSER) throw new Error("Cloudflare Browser Run 尚未绑定。请检查 Worker Browser Binding。");
      let browser = null;
      const lastUsedAt = await this.ctx.storage.get(storageKey("cloudBrowserLastUsedAt"));
      if (lastUsedAt && Date.now() - Number(lastUsedAt) > 30 * 60 * 1000) {
        const expiredId = await this.ctx.storage.get(storageKey("cloudBrowserSessionId"));
        if (expiredId) { try { const expired = await connect(this.env.BROWSER, expiredId); await expired.close(); } catch {} }
        await this.ctx.storage.delete(storageKey("cloudBrowserSessionId"));
        await this.ctx.storage.delete(storageKey("cloudBrowserActiveTabIndex"));
      }
      const stored = await this.ctx.storage.get(storageKey("cloudBrowserSessionId"));
      if (stored) {
        try { browser = await connect(this.env.BROWSER, stored); }
        catch { await this.ctx.storage.delete(storageKey("cloudBrowserSessionId")); }
      }
      if (!browser) {
        const acquired = await acquire(this.env.BROWSER);
        browser = await connect(this.env.BROWSER, acquired.sessionId);
        await this.ctx.storage.put(storageKey("cloudBrowserSessionId"), acquired.sessionId);
      }
      const pages = browser.contexts().flatMap(context => context.pages());
      let page = pages[Number(await this.ctx.storage.get(storageKey("cloudBrowserActiveTabIndex"))) || 0] || pages[0];
      if (!page) {
        const context = browser.contexts()[0] || await browser.newContext();
        page = await context.newPage();
        await this.ctx.storage.put(storageKey("cloudBrowserActiveTabIndex"), 0);
      }
      await page.setViewportSize({ width: 1280, height: 820 });
      const context = page.context();
      if (!guardedBrowserContexts.has(context)) {
        if (typeof context.routeWebSocket === "function") {
          context.routeWebSocket("**/*", socket => socket.close({ code: 1008, reason: "WebSocket access is disabled by OpenFish network policy." }));
        }
        await context.route("**/*", async route => {
          try { validateTarget(route.request().url()); await route.continue(); }
          catch { await route.abort("blockedbyclient").catch(() => {}); }
        });
        guardedBrowserContexts.add(context);
      }
      await this.ctx.storage.put(storageKey("cloudBrowserLastUsedAt"), Date.now());
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
    if (url.pathname === "/cloud/tabs") {
      let browser;
      try {
        const connected = await getBrowser(); browser = connected.browser;
        const pages = browser.contexts().flatMap(context => context.pages());
        const activeIndex = pages.indexOf(connected.page);
        const tabs = await Promise.all(pages.map(async (tab, index) => ({ index, active: index === activeIndex, title: await tab.title().catch(() => ""), url: tab.url() })));
        return jsonResponse({ ok: true, tabs, activeIndex });
      } catch (error) { return jsonResponse({ error: String(error?.message || error).slice(0, 500) }, 502); }
      finally { if (browser) { try { await browser.disconnect(); } catch {} } }
    }
    if (url.pathname === "/cloud/view") {
      let browser;
      try {
        const connected = await getBrowser(); browser = connected.browser;
        const tabs = await Promise.all(browser.contexts().flatMap(context => context.pages()).map(async (tab, index) => ({ index, active: tab === connected.page, title: await tab.title().catch(() => ""), url: tab.url() })));
        return jsonResponse({ ok: true, ...(await snapshot(connected.page)), tabs, activeIndex: tabs.findIndex(tab => tab.active) });
      } catch (error) { return jsonResponse({ error: String(error?.message || error).slice(0, 500) }, 502); }
      finally { if (browser) { try { await browser.disconnect(); } catch {} } }
    }
    if (url.pathname === "/cloud/status") {
      const id = await this.ctx.storage.get(storageKey("cloudBrowserSessionId"));
      if (!id) return jsonResponse({ ok: true, connected: false, provider: "Cloudflare Browser Run", version: VERSION });
      try {
        const browser = await connect(this.env.BROWSER, id);
        const pages = browser.contexts().flatMap(context => context.pages());
        const active = pages[Number(await this.ctx.storage.get(storageKey("cloudBrowserActiveTabIndex"))) || 0] || pages[0];
        const current = active ? await active.url() : "";
        await browser.disconnect();
        return jsonResponse({ ok: true, connected: true, currentUrl: current, provider: "Cloudflare Browser Run", version: VERSION });
      } catch {
        await this.ctx.storage.delete(storageKey("cloudBrowserSessionId"));
        return jsonResponse({ ok: true, connected: false, provider: "Cloudflare Browser Run", version: VERSION });
      }
    }
    if (url.pathname === "/cloud/close") {
      const id = await this.ctx.storage.get(storageKey("cloudBrowserSessionId"));
      if (id) { try { const browser = await connect(this.env.BROWSER, id); await browser.close(); } catch {} }
      await this.ctx.storage.delete(storageKey("cloudBrowserSessionId"));
      await this.ctx.storage.delete(storageKey("cloudBrowserActiveTabIndex"));
      await this.ctx.storage.delete(storageKey("cloudBrowserLastUsedAt"));
      return jsonResponse({ ok: true, closed: true });
    }
    let payload = {};
    try { payload = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON body." }, 400); }
    let browser;
    try {
      const connected = await getBrowser();
      browser = connected.browser;
      let page = connected.page;
      if (url.pathname === "/cloud/navigate") {
        const target = validateTarget(payload.url);
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 25000 });
      } else if (url.pathname === "/cloud/action") {
        const action = payload.action;
        if (action === "newTab") {
          const context = page.context();
          page = await context.newPage();
          await page.setViewportSize({ width: 1280, height: 820 });
          if (payload.url) {
            const target = validateTarget(payload.url);
            await page.goto(target, { waitUntil: "domcontentloaded", timeout: 25000 });
          }
          await this.ctx.storage.put(storageKey("cloudBrowserActiveTabIndex"), context.pages().indexOf(page));
        } else if (action === "switchTab") {
          const pages = browser.contexts().flatMap(context => context.pages());
          const index = Number(payload.index);
          if (!Number.isInteger(index) || index < 0 || index >= pages.length) throw new Error("标签页编号无效");
          page = pages[index];
          await this.ctx.storage.put(storageKey("cloudBrowserActiveTabIndex"), index);
        } else if (action === "closeTab") {
          const pages = browser.contexts().flatMap(context => context.pages());
          const index = payload.index === undefined ? pages.indexOf(page) : Number(payload.index);
          if (!Number.isInteger(index) || index < 0 || index >= pages.length) throw new Error("标签页编号无效");
          const previouslyActive = page;
          await pages[index].close();
          const remaining = browser.contexts().flatMap(context => context.pages());
          page = remaining.includes(previouslyActive) ? previouslyActive : (remaining[Math.min(index, remaining.length - 1)] || await (browser.contexts()[0] || await browser.newContext()).newPage());
          await page.setViewportSize({ width: 1280, height: 820 });
          await this.ctx.storage.put(storageKey("cloudBrowserActiveTabIndex"), Math.max(0, browser.contexts().flatMap(context => context.pages()).indexOf(page)));
        } else if (action === "back") await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null);
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
      const tabs = await Promise.all(browser.contexts().flatMap(context => context.pages()).map(async (tab, index) => ({ index, active: tab === page, title: await tab.title().catch(() => ""), url: tab.url() })));
      return jsonResponse({ ok: true, ...result, tabs, activeIndex: tabs.findIndex(tab => tab.active) });
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