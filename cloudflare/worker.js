const VERSION = "1.7.0";
const MAX_BODY_BYTES = 512 * 1024;
const ALLOWED_PATH = path => path === "/mcp" || path === "/health" ||
  path === "/.well-known/openfish-tools.json" ||
  path === "/api/v1/tools" || path.startsWith("/api/v1/tools/") ||
  path.startsWith("/api/v1/adapters/") || path === "/api/v1/openapi.json";

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
    if (!ALLOWED_PATH(url.pathname)) return json({ error: "Relay path is not allowed." }, 404);
    if (url.pathname === "/mcp" && !["POST", "GET", "DELETE"].includes(request.method)) {
      return json({ error: "MCP method not supported." }, 405);
    }
    if (url.pathname !== "/mcp" && url.pathname !== "/health" && request.method !== "GET" && request.method !== "POST") {
      return json({ error: "Method not allowed." }, 405);
    }
    let body = "";
    if (request.method !== "GET" && request.method !== "HEAD") {
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > MAX_BODY_BYTES) return json({ error: "Request body exceeds 512 KB relay limit." }, 413);
      body = bytesToBase64(new Uint8Array(bytes));
    }
    const payload = {
      path: url.pathname + url.search,
      method: request.method,
      headers: safeHeaders(request),
      bodyBase64: body
    };
    const response = await relayStub(env).fetch(new Request("https://relay.internal/proxy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
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
    this.ctx = ctx;
    this.env = env;
    this.pending = new Map();
    this.maxPending = 32;
    this.requestTimeoutMs = 45000;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/connect") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });
      for (const socket of this.ctx.getWebSockets()) {
        const attachment = socket.deserializeAttachment() || {};
        if (attachment.role === "agent") {
          try { socket.close(1012, "Agent connection replaced"); } catch {}
        }
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
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
    if (typeof payload.path !== "string" || payload.path.length > 2048 || !/^\/(mcp|health|\.well-known\/openfish-tools\.json|api\/v1\/)/.test(payload.path)) {
      return json({ error: "Invalid relay path." }, 400);
    }
    const requestId = crypto.randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(json({ error: "Local agent request timed out." }, 504));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, result => {
        clearTimeout(timer);
        resolve(json(result));
      });
      try {
        agent.send(JSON.stringify({ type: "request", requestId, ...payload }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(json({ error: "Could not send request to local agent." }, 502));
      }
    });
  }

  async webSocketMessage(socket, message) {
    const attachment = socket.deserializeAttachment() || {};
    if (attachment.role !== "agent" || typeof message !== "string" || message.length > 800000) return;
    let data;
    try { data = JSON.parse(message); } catch { return; }
    if (data.type === "heartbeat") {
      socket.send(JSON.stringify({ type: "heartbeat_ack", at: Date.now() }));
      return;
    }
    if (data.type !== "response" || typeof data.requestId !== "string") return;
    const complete = this.pending.get(data.requestId);
    if (!complete) return;
    this.pending.delete(data.requestId);
    const status = Number.isInteger(data.status) && data.status >= 100 && data.status <= 599 ? data.status : 502;
    const headers = {};
    for (const name of ["content-type", "mcp-session-id"]) {
      if (typeof data.headers?.[name] === "string") headers[name] = data.headers[name].slice(0, 2048);
    }
    const bodyBase64 = typeof data.bodyBase64 === "string" && data.bodyBase64.length <= 700000 ? data.bodyBase64 : "";
    complete({ status, headers, bodyBase64 });
  }

  async webSocketClose(socket) {
    try { socket.close(); } catch {}
  }

  async webSocketError(socket) {
    try { socket.close(1011, "Relay socket error"); } catch {}
  }
}
