import WebSocket from "ws";

const RELAY_URL = process.env.OPENFISH_RELAY_URL || "";
const RELAY_TOKEN = process.env.OPENFISH_RELAY_TOKEN || "";
const LOCAL_API_KEY = process.env.OPENFISH_LOCAL_API_KEY || "";
const BRIDGE_URL = (process.env.OPENFISH_BRIDGE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const MCP_URL = (process.env.OPENFISH_MCP_URL || "http://127.0.0.1:8788/mcp").replace(/\/$/, "");
const CLIENT_ID = process.env.OPENFISH_CLIENT_ID || "openfish-local-agent";
const MAX_BODY_BYTES = 512 * 1024;
const ALLOWED_PATH = path => path === "/mcp" || path === "/health" ||
  path === "/.well-known/openfish-tools.json" || path === "/api/v1/tools" ||
  path.startsWith("/api/v1/tools/") || path.startsWith("/api/v1/adapters/") || path === "/api/v1/openapi.json";

function validateConfig() {
  if (!RELAY_URL) throw new Error("OPENFISH_RELAY_URL is required (example: wss://your-worker.workers.dev/agent/connect).");
  const url = new URL(RELAY_URL);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("Relay URL must use wss:// (ws:// is allowed only for local development).");
  }
  if (RELAY_TOKEN.length < 32) throw new Error("OPENFISH_RELAY_TOKEN must be at least 32 characters.");
  if (LOCAL_API_KEY.length < 24) throw new Error("OPENFISH_LOCAL_API_KEY must be a local OpenFish API key.");
}
function localTarget(path) {
  if (!ALLOWED_PATH(path.split("?")[0])) throw new Error("Relay command path is not allowed.");
  return path === "/mcp" ? MCP_URL : `${BRIDGE_URL}${path}`;
}
function decodeBase64(value) {
  if (!value) return undefined;
  const buffer = Buffer.from(value, "base64");
  if (buffer.length > MAX_BODY_BYTES) throw new Error("Relay request body exceeds 512 KB.");
  return buffer;
}
async function handleRequest(socket, message) {
  if (message.type !== "request" || typeof message.requestId !== "string" || message.requestId.length > 80) return;
  let status = 502, headers = {}, bodyBase64 = "";
  try {
    const target = localTarget(message.path);
    const method = ["GET", "POST", "DELETE"].includes(message.method) ? message.method : "GET";
    const headersIn = message.headers && typeof message.headers === "object" ? message.headers : {};
    const headersOut = new Headers({
      authorization: `Bearer ${LOCAL_API_KEY}`,
      "x-openfish-client": CLIENT_ID,
      "x-openfish-platform": "cloudflare-relay"
    });
    for (const name of ["content-type", "accept", "mcp-session-id", "x-openfish-session", "last-event-id"]) {
      if (typeof headersIn[name] === "string") headersOut.set(name, headersIn[name].slice(0, 2048));
    }
    const response = await fetch(target, {
      method, headers: headersOut,
      body: method === "GET" || method === "HEAD" ? undefined : decodeBase64(message.bodyBase64),
      signal: AbortSignal.timeout(40000)
    });
    status = response.status;
    for (const name of ["content-type", "mcp-session-id"]) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BODY_BYTES) throw new Error("Local response exceeds 512 KB relay limit.");
    bodyBase64 = bytes.toString("base64");
  } catch (error) {
    status = 502;
    headers = { "content-type": "application/json; charset=utf-8" };
    bodyBase64 = Buffer.from(JSON.stringify({ error: error.message || "Local relay request failed." })).toString("base64");
  }
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "response", requestId: message.requestId, status, headers, bodyBase64 }));
  }
}

function connect() {
  const socket = new WebSocket(RELAY_URL, { headers: { authorization: `Bearer ${RELAY_TOKEN}` }, handshakeTimeout: 15000, maxPayload: 1024 * 1024 });
  let heartbeat, stableTimer;
  socket.on("open", () => {
    process.stdout.write("OpenFish relay agent connected. Local browser remains on this device.\n");
    heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, 25000);
    stableTimer = setTimeout(() => { attempts = 0; }, 60000);
  });
  socket.on("message", raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === "request") void handleRequest(socket, message);
  });
  socket.on("close", () => {
    if (heartbeat) clearInterval(heartbeat);
    if (stableTimer) clearTimeout(stableTimer);
    process.stderr.write("OpenFish relay disconnected; reconnecting shortly.\n");
    scheduleReconnect();
  });
  socket.on("error", error => process.stderr.write(`OpenFish relay socket error: ${error.message}\n`));
  return socket;
}
let attempts = 0, reconnectTimer;
function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5));
  reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, delay);
}
validateConfig();
connect();

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
