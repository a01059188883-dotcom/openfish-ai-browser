import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BRIDGE = (process.env.OPENFISH_BRIDGE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const server = new McpServer({ name: "openfish-ai-browser", version: "1.1.0" });
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

server.tool("click_element", "Click a unique visible button-like target in the shared browser. Potentially irreversible actions are blocked.", {
  selector: z.string().min(1).max(500)
}, async ({ selector }) => result(await bridgeRequest("/api/mcp/click_element", { method: "POST", body: { selector } })));

server.tool("fill_element", "Fill a unique ordinary editable field in the shared browser. Credential, payment, identity, hidden, and sensitive fields are blocked.", {
  selector: z.string().min(1).max(500),
  value: z.string().max(10000)
}, async ({ selector, value }) => result(await bridgeRequest("/api/mcp/fill_element", { method: "POST", body: { selector, value } })));

server.tool("take_screenshot", "Capture the current page in the shared browser and return the screenshot file path.", {}, async () => result(await bridgeRequest("/api/mcp/take_screenshot", { method: "POST" })));

server.tool("list_interactive_elements", "List visible links, buttons, inputs, and selects from the shared browser.", {}, async () => result(await bridgeRequest("/api/mcp/list_interactive_elements")));

server.tool("get_accessibility_snapshot", "Return headings and landmarks from the current page in the shared browser.", {}, async () => result(await bridgeRequest("/api/mcp/get_accessibility_snapshot")));

await server.connect(new StdioServerTransport());
