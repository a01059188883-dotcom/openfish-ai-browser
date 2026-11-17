import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BRIDGE = (process.env.OPENFISH_BRIDGE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const server = new McpServer({ name: "openfish-ai-browser", version: "2.6.0" });
const result = value => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

async function bridgeRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(`${BRIDGE}${path}`, {
      method: options.method || "GET",
      headers: options.body ? { "content-type": "application/json" } : {},
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(95000)
    });
  } catch {
    throw new Error(`Cannot connect to the shared OpenFish runtime at ${BRIDGE}. Start it with npm run start:bridge first.`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `OpenFish runtime returned HTTP ${response.status}`);
  return data;
}

server.tool("open_page", "Open an HTTP(S) page in the shared OpenFish browser used by the Chrome extension and dashboard.", {
  url: z.string().url()
}, async ({ url }) => result(await bridgeRequest("/api/mcp/open_page", { method: "POST", body: { url } })));

server.tool("read_page", "Read the current page title, URL, and visible text from the shared OpenFish browser.", {}, async () => result(await bridgeRequest("/api/mcp/read_page")));

server.tool("plan_task", "Use the configured local Ollama model to propose a safe plan in the shared browser. It never executes the plan.", {
  goal: z.string().min(1).max(2000)
}, async ({ goal }) => result(await bridgeRequest("/api/mcp/plan_task", { method: "POST", body: { goal } })));

server.tool("execute_plan", "Execute a reviewed browser plan in the shared browser. Call only after the user explicitly approves the exact plan. High-risk actions are blocked.", {
  plan: z.object({
    summary: z.string().optional(),
    steps: z.array(z.object({
      action: z.enum(["navigate", "click", "fill", "inspect"]),
      url: z.string().optional(),
      selector: z.string().optional(),
      value: z.string().optional(),
      reason: z.string().optional()
    }).passthrough()).max(8)
  }),
  approved: z.literal(true).describe("Must be true only after the user has reviewed and explicitly approved this exact plan.")
}, async ({ plan, approved }) => result(await bridgeRequest("/api/mcp/execute_plan", { method: "POST", body: { plan, approved } })));

server.tool("click_element", "Click a unique visible button-like target in the shared browser. Requires explicit user approval; potentially irreversible actions remain blocked.", {
  selector: z.string().min(1).max(500),
  approved: z.literal(true).describe("Must be true only after the user explicitly approves this exact click.")
}, async ({ selector, approved }) => result(await bridgeRequest("/api/mcp/click_element", { method: "POST", body: { selector, approved } })));

server.tool("fill_element", "Fill a unique ordinary editable field in the shared browser. Requires explicit user approval; credential, payment, identity, hidden, and sensitive fields remain blocked.", {
  selector: z.string().min(1).max(500),
  value: z.string().max(10000),
  approved: z.literal(true).describe("Must be true only after the user explicitly approves this exact field and value.")
}, async ({ selector, value, approved }) => result(await bridgeRequest("/api/mcp/fill_element", { method: "POST", body: { selector, value, approved } })));

server.tool("take_screenshot", "Capture the current browser viewport and return a compressed inline JPEG data URL.", {}, async () => result(await bridgeRequest("/api/mcp/take_screenshot", { method: "POST" })));

server.tool("list_interactive_elements", "List visible links, buttons, inputs, and selects from the shared browser.", {}, async () => result(await bridgeRequest("/api/mcp/list_interactive_elements")));

server.tool("get_accessibility_snapshot", "Return headings and landmarks from the current page in the shared browser.", {}, async () => result(await bridgeRequest("/api/mcp/get_accessibility_snapshot")));
server.tool("go_back", "Go back one page in the shared browser tab.", {}, async () => result(await bridgeRequest("/api/mcp/go_back", { method: "POST", body: {} })));
server.tool("go_forward", "Go forward one page in the shared browser tab.", {}, async () => result(await bridgeRequest("/api/mcp/go_forward", { method: "POST", body: {} })));
server.tool("reload_page", "Reload the current page in the shared browser tab.", {}, async () => result(await bridgeRequest("/api/mcp/reload_page", { method: "POST", body: {} })));
server.tool("list_tabs", "List tabs in the shared browser session.", {}, async () => result(await bridgeRequest("/api/mcp/list_tabs")));
server.tool("new_tab", "Open a new tab, optionally at a public HTTP(S) URL.", { url: z.string().url().optional() }, async args => result(await bridgeRequest("/api/mcp/new_tab", { method: "POST", body: args })));
server.tool("switch_tab", "Switch active tab by its current list index.", { index: z.number().int().min(0) }, async args => result(await bridgeRequest("/api/mcp/switch_tab", { method: "POST", body: args })));
server.tool("close_tab", "Close a tab only after explicit approval. The last tab cannot be closed.", { index: z.number().int().min(0), approved: z.literal(true) }, async args => result(await bridgeRequest("/api/mcp/close_tab", { method: "POST", body: args })));

server.tool("list_bookmarks", "List local browser bookmarks.", { query: z.string().max(200).optional() }, async args => result(await bridgeRequest("/api/library/bookmarks" + (args.query ? "?q=" + encodeURIComponent(args.query) : ""), undefined, "GET")));
server.tool("add_bookmark", "Save a public URL as a local bookmark.", { url: z.string().url(), title: z.string().max(180).optional() }, async args => result(await bridgeRequest("/api/library/bookmarks/add", { method: "POST", body: args })));
server.tool("remove_bookmark", "Remove a bookmark after explicit approval.", { id: z.string(), approved: z.literal(true) }, async args => result(await bridgeRequest("/api/library/bookmarks/remove", { method: "POST", body: args })));
server.tool("list_history", "Search local browsing history.", { query: z.string().max(200).optional(), limit: z.number().int().min(1).max(500).optional() }, async args => result(await bridgeRequest("/api/library/history?limit=" + (args.limit || 100) + (args.query ? "&q=" + encodeURIComponent(args.query) : ""), undefined, "GET")));
server.tool("clear_history", "Clear local history after explicit approval.", { approved: z.literal(true) }, async args => result(await bridgeRequest("/api/library/history/clear", { method: "POST", body: args })));
server.tool("list_reading_list", "List pages saved for later reading.", {}, async () => result(await bridgeRequest("/api/library/reading-list", undefined, "GET")));
server.tool("add_reading_item", "Save a page for later reading.", { url: z.string().url(), title: z.string().max(180).optional(), note: z.string().max(500).optional() }, async args => result(await bridgeRequest("/api/library/reading-list/add", { method: "POST", body: args })));
server.tool("remove_reading_item", "Remove a reading-list item after explicit approval.", { id: z.string(), approved: z.literal(true) }, async args => result(await bridgeRequest("/api/library/reading-list/remove", { method: "POST", body: args })));
server.tool("organize_tab", "Assign a tab to a group and/or pin it after explicit approval.", { url: z.string().url(), groupName: z.string().max(40).optional(), pinned: z.boolean().optional(), approved: z.literal(true) }, async args => result(await bridgeRequest("/api/library/tab/organize", { method: "POST", body: args })));

server.tool("get_page_diagnostics", "Read recent console errors, page exceptions, failed requests, and HTTP errors.", { limit: z.number().int().min(1).max(100).optional() }, async args => result(await bridgeRequest("/api/mcp/get_page_diagnostics")));
server.tool("clear_page_diagnostics", "Clear diagnostics captured for the current page.", {}, async () => result(await bridgeRequest("/api/mcp/clear_page_diagnostics", { method: "POST", body: {} })));
server.tool("extract_reader_content", "Extract a clean reading view with title, description, headings, and main article text.", {}, async () => result(await bridgeRequest("/api/mcp/extract_reader_content", undefined)));
server.tool("find_in_page", "Find a phrase in the current page and return nearby snippets.", { query: z.string().min(1).max(200) }, async args => result(await bridgeRequest("/api/mcp/find_in_page", { method: "POST", body: args })));
server.tool("get_page_performance", "Read navigation timing and resource-transfer summaries.", {}, async () => result(await bridgeRequest("/api/mcp/get_page_performance", undefined)));
server.tool("list_recently_closed_tabs", "List recently closed tabs available for restoration.", {}, async () => result(await bridgeRequest("/api/mcp/list_recently_closed_tabs", undefined)));
server.tool("duplicate_tab", "Duplicate a browser tab by its current list index.", { index: z.number().int().min(0) }, async args => result(await bridgeRequest("/api/mcp/duplicate_tab", { method: "POST", body: args })));
server.tool("reopen_closed_tab", "Restore the most recently closed tab after explicit approval.", { approved: z.literal(true) }, async args => result(await bridgeRequest("/api/mcp/reopen_closed_tab", { method: "POST", body: args })));
server.tool("search_tabs", "Search open tabs by title, URL, or group label.", { query: z.string().min(1).max(200) }, async args => { const data = await bridgeRequest("/api/mcp/list_tabs", undefined); const q = args.query.toLowerCase(); return result({tabs:(data.tabs || []).filter(tab => (tab.title + " " + tab.url + " " + tab.groupName).toLowerCase().includes(q))}); });

server.tool("save_workspace", "Save the currently open public tabs as a named local workspace.", { name: z.string().min(1).max(60) }, async args => result(await bridgeRequest("/api/mcp/save_workspace", { method: "POST", body: args })));
server.tool("list_workspaces", "List saved local browser workspaces.", {}, async () => result(await bridgeRequest("/api/mcp/list_workspaces")));
server.tool("restore_workspace", "Restore a saved workspace by opening its saved URLs after explicit approval.", { id: z.string(), approved: z.literal(true) }, async args => result(await bridgeRequest("/api/mcp/restore_workspace", { method: "POST", body: args })));
server.tool("remove_workspace", "Delete a saved workspace after explicit approval.", { id: z.string(), approved: z.literal(true) }, async args => result(await bridgeRequest("/api/mcp/remove_workspace", { method: "POST", body: args })));
server.tool("download_link", "Download a file from one unique visible link in the active page after explicit approval.", { selector: z.string().min(1).max(500), approved: z.literal(true) }, async args => result(await bridgeRequest("/api/mcp/download_link", { method: "POST", body: args })));
server.tool("list_downloads", "List files downloaded and managed by OpenFish.", {}, async () => result(await bridgeRequest("/api/mcp/list_downloads")));
server.tool("remove_download", "Delete a managed downloaded file after explicit approval.", { id: z.string(), approved: z.literal(true) }, async args => result(await bridgeRequest("/api/mcp/remove_download", { method: "POST", body: args })));
server.tool("clear_session_data", "Clear cookies and site storage for the active isolated browser session after explicit approval.", { approved: z.literal(true) }, async args => result(await bridgeRequest("/api/mcp/clear_session_data", { method: "POST", body: args })));

server.tool("export_browser_library", "Export local bookmarks, history, reading list, tab organization and workspaces as JSON. Excludes cookies and downloaded files.", {}, async () => result(await bridgeRequest("/api/library/export")));
server.tool("import_browser_library", "Merge a validated browser library backup after explicit approval.", { data: z.record(z.string(), z.unknown()), approved: z.literal(true) }, async args => result(await bridgeRequest("/api/library/import", { method: "POST", body: args })));

await server.connect(new StdioServerTransport());
