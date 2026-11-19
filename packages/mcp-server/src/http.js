import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.OPENFISH_MCP_HTTP_PORT || 8788);
const HOST = process.env.OPENFISH_MCP_HTTP_HOST || "127.0.0.1";
const BRIDGE = (process.env.OPENFISH_BRIDGE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const VERSION = "2.13.2";

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
  server.tool("go_back", "Go back one page in the current isolated browser tab.", {}, args => call("go_back", args, true));
  server.tool("go_forward", "Go forward one page in the current isolated browser tab.", {}, args => call("go_forward", args, true));
  server.tool("reload_page", "Reload the current page in the isolated browser tab.", {}, args => call("reload_page", args, true));
  server.tool("list_tabs", "List tabs in the current isolated browser session.", {}, args => call("list_tabs", args));
  server.tool("new_tab", "Open a new tab, optionally at a public HTTP(S) URL.", { url: z.string().url().optional() }, args => call("new_tab", args, true));
  server.tool("switch_tab", "Switch to a tab by its current list index.", { index: z.number().int().min(0) }, args => call("switch_tab", args, true));
  server.tool("close_tab", "Close a tab by its current list index after explicit approval. The last tab cannot be closed.", { index: z.number().int().min(0), approved: z.literal(true) }, args => call("close_tab", args, true));
  server.tool("list_bookmarks", "List local browser bookmarks.", { query: z.string().max(200).optional() }, args => call("list_bookmarks", args));
  server.tool("add_bookmark", "Save a public URL as a local bookmark.", { url: z.string().url(), title: z.string().max(180).optional() }, args => call("add_bookmark", args, true));
  server.tool("remove_bookmark", "Remove a bookmark after explicit approval.", { id: z.string(), approved: z.literal(true) }, args => call("remove_bookmark", args, true));
  server.tool("list_history", "Search local browsing history.", { query: z.string().max(200).optional(), limit: z.number().int().min(1).max(500).optional() }, args => call("list_history", args));
  server.tool("clear_history", "Clear local history after explicit approval.", { approved: z.literal(true) }, args => call("clear_history", args, true));
  server.tool("list_reading_list", "List pages saved for later reading.", {}, args => call("list_reading_list", args));
  server.tool("add_reading_item", "Save a page for later reading.", { url: z.string().url(), title: z.string().max(180).optional(), note: z.string().max(500).optional() }, args => call("add_reading_item", args, true));
  server.tool("remove_reading_item", "Remove a reading-list item after explicit approval.", { id: z.string(), approved: z.literal(true) }, args => call("remove_reading_item", args, true));
  server.tool("organize_tab", "Assign a tab to a group and/or pin it after explicit approval.", { url: z.string().url(), groupName: z.string().max(40).optional(), pinned: z.boolean().optional(), approved: z.literal(true) }, args => call("organize_tab", args, true));
  server.tool("get_page_diagnostics", "Read recent console errors, page exceptions, failed requests, and HTTP errors.", { limit: z.number().int().min(1).max(100).optional() }, args => call("get_page_diagnostics", args));
  server.tool("clear_page_diagnostics", "Clear diagnostics captured for the current page.", {}, args => call("clear_page_diagnostics", args));
  server.tool("extract_reader_content", "Extract a clean reading view with title, description, headings, and main article text.", {}, args => call("extract_reader_content", args));
  server.tool("find_in_page", "Find a phrase in the current page and return nearby snippets.", { query: z.string().min(1).max(200) }, args => call("find_in_page", args));
  server.tool("get_page_performance", "Read navigation timing and resource-transfer summaries.", {}, args => call("get_page_performance", args));
  server.tool("list_recently_closed_tabs", "List recently closed tabs available for restoration.", {}, args => call("list_recently_closed_tabs", args));
  server.tool("duplicate_tab", "Duplicate a browser tab by its current list index.", { index: z.number().int().min(0) }, args => call("duplicate_tab", args, true));
  server.tool("reopen_closed_tab", "Restore the most recently closed tab after explicit approval.", { approved: z.literal(true) }, args => call("reopen_closed_tab", args, true));
  server.tool("search_tabs", "Search open tabs by title, URL, or group label.", { query: z.string().min(1).max(200) }, args => call("search_tabs", args));
  server.tool("save_workspace", "Save the currently open public tabs as a named local workspace.", { name: z.string().min(1).max(60) }, args => call("save_workspace", args, true));
  server.tool("list_workspaces", "List saved local browser workspaces.", {}, args => call("list_workspaces", args));
  server.tool("restore_workspace", "Restore a saved workspace by opening its saved URLs after explicit approval.", { id: z.string(), approved: z.literal(true) }, args => call("restore_workspace", args, true));
  server.tool("remove_workspace", "Delete a saved workspace after explicit approval.", { id: z.string(), approved: z.literal(true) }, args => call("remove_workspace", args, true));
  server.tool("download_link", "Download a file from one unique visible link in the active page after explicit approval.", { selector: z.string().min(1).max(500), approved: z.literal(true) }, args => call("download_link", args, true));
  server.tool("list_downloads", "List files downloaded and managed by OpenFish.", {}, args => call("list_downloads", args));
  server.tool("remove_download", "Delete a managed downloaded file after explicit approval.", { id: z.string(), approved: z.literal(true) }, args => call("remove_download", args, true));
  server.tool("clear_session_data", "Clear cookies and site storage for the active isolated browser session after explicit approval.", { approved: z.literal(true) }, args => call("clear_session_data", args, true));
  server.tool("export_browser_library", "Export local bookmarks, history, reading list, tab organization and workspaces as JSON. Excludes cookies and downloaded files.", {}, args => call("export_browser_library", args));
  server.tool("import_browser_library", "Merge a validated browser library backup after explicit approval.", { data: z.record(z.string(), z.unknown()), approved: z.literal(true) }, args => call("import_browser_library", args, true));
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
