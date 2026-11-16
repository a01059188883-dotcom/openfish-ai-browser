import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.OPENFISH_MCP_HTTP_PORT || 8788);
const HOST = process.env.OPENFISH_MCP_HTTP_HOST || "127.0.0.1";
const BRIDGE = (process.env.OPENFISH_BRIDGE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const VERSION = "1.9.0";

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw) > 1_000_000) {
        reject(Object.assign(new Error("Payload too large."), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 })); }
    });
    req.on("error", reject);
  });
}
function sendError(res, status, message) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: message }));
}
async function bridgeRequest(path, { token, sessionId, clientId, platform, body, method = "POST" }) {
  let response;
  try {
    response = await fetch(`${BRIDGE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "x-openfish-session": sessionId,
        "x-openfish-client": clientId,
        "x-openfish-platform": platform,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(95000)
    });
  } catch {
    throw new Error(`Cannot connect to OpenFish bridge at ${BRIDGE}. Start npm run start:bridge first.`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `OpenFish bridge returned HTTP ${response.status}`);
  return data.result ?? data;
}
async function verifyKey(token, scope = "browser:read", metadata = {}) {
  let response;
  try {
    response = await fetch(`${BRIDGE}/api/auth/verify`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ scope, ...metadata }),
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    throw new Error("Cannot verify API key with the local OpenFish bridge. Is the bridge running?");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || "API key verification failed."), { statusCode: response.status });
  return data.identity;
}
function toolResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
function createMcpServer(token, sessionId, clientMeta) {
  const server = new McpServer({ name: "openfish-ai-browser-http", version: VERSION });
  const call = async (name, args = {}, write = false) => {
    if (write) {
      await verifyKey(token, "browser:write", { ...clientMeta, sessionId });
    }
    return toolResult(await bridgeRequest(`/api/v1/tools/${name}`, { token, sessionId, ...clientMeta, body: args }));
  };
  server.tool("open_page", "Navigate the isolated browser session to a public HTTP(S) URL.", { url: z.string().url() }, args => call("open_page", args, true));
  server.tool("read_page", "Read the current page title, URL, and visible text.", {}, args => call("read_page", args));
  server.tool("plan_task", "Create a proposed plan without executing it.", { goal: z.string().min(1).max(2000) }, args => call("plan_task", args));
  server.tool("execute_plan", "Execute a reviewed plan only after explicit approval of the exact plan.", {
    plan: z.object({ summary: z.string().optional(), steps: z.array(z.object({
      action: z.enum(["navigate", "click", "fill", "inspect"]), url: z.string().optional(),
      selector: z.string().optional(), value: z.string().optional(), reason: z.string().optional()
    }).passthrough()).max(8) }),
    approved: z.literal(true).describe("Only true after explicit user approval of this exact plan.")
  }, args => call("execute_plan", args, true));
  server.tool("click_element", "Click a unique visible button-like target after explicit approval.", {
    selector: z.string().min(1).max(500), approved: z.literal(true)
  }, args => call("click_element", args, true));
  server.tool("fill_element", "Fill an ordinary editable field after explicit approval.", {
    selector: z.string().min(1).max(500), value: z.string().max(10000), approved: z.literal(true)
  }, args => call("fill_element", args, true));
  server.tool("take_screenshot", "Capture the current browser viewport.", {}, args => call("take_screenshot", args));
  server.tool("list_interactive_elements", "List visible interactive elements on the current page.", {}, args => call("list_interactive_elements", args));
  server.tool("get_accessibility_snapshot", "Read page headings and landmarks.", {}, args => call("get_accessibility_snapshot", args));
  return server;
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/mcp") return sendError(res, 404, "Not found.");
  if (!["POST", "GET", "DELETE"].includes(req.method || "")) {
    res.writeHead(405, { allow: "GET, POST, DELETE" }); return res.end();
  }
  const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || "");
  if (!bearer) return sendError(res, 401, "Authorization: Bearer API_KEY is required.");
  const sessionId = req.headers["x-openfish-session"] || "default";
  const clientMeta = {
    clientId: String(req.headers["x-openfish-client"] || "mcp-http").slice(0, 80),
    platform: String(req.headers["x-openfish-platform"] || "mcp-http").slice(0, 40)
  };
  if (sessionId !== "default" && !/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId)) return sendError(res, 400, "Invalid browser session ID.");
  try { await verifyKey(bearer[1], "browser:read", { ...clientMeta, sessionId }); }
  catch (error) { return sendError(res, error.statusCode || 401, error.message); }
  try {
    const body = req.method === "POST" ? await readBody(req) : undefined;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = createMcpServer(bearer[1], sessionId, clientMeta);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    sendError(res, error.statusCode || 500, error.message || "MCP request failed.");
  }
});
httpServer.listen(PORT, HOST, () => {
  process.stdout.write(`OpenFish Streamable HTTP MCP listening on http://${HOST}:${PORT}/mcp\n`);
});
