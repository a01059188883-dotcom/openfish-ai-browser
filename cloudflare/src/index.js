import { launch } from "@cloudflare/playwright";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { validatePublicUrl, validateSteps, IRREVERSIBLE, SENSITIVE } from "./safety.js";

const VERSION = "1.2.0-cloudflare-preview";
const MAX_TEXT = 20000;
const MAX_STEPS = 8;
function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}
function sessionKey(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw new Error("session_id must be 8-80 safe characters.");
  return "session:" + id;
}
async function loadSession(id) {
  if (!env.SESSIONS) return {};
  return await env.SESSIONS.get(sessionKey(id), "json") || {};
}
async function saveSession(id, data) {
  if (env.SESSIONS) await env.SESSIONS.put(sessionKey(id), JSON.stringify(data), { expirationTtl: 86400 });
}
async function withBrowser(sessionId, operation, requireSaved = false) {
  const saved = await loadSession(sessionId);
  if (requireSaved && !saved.url) throw new Error("No saved page for this session. First open a URL in the same task, or bind a SESSIONS KV namespace to persist sessions between calls.");
  const browser = await launch(env.BROWSER);
  let context;
  try {
    context = await browser.newContext(saved.storageState ? { storageState: saved.storageState } : {});
    await context.route("**/*", async route => {
      try {
        const requestUrl = new URL(route.request().url());
        if (["http:", "https:"].includes(requestUrl.protocol)) validatePublicUrl(requestUrl.href);
        await route.continue();
      } catch {
        await route.abort();
      }
    });
    const page = await context.newPage();
    if (saved.url) await page.goto(validatePublicUrl(saved.url).href, { waitUntil: "domcontentloaded", timeout: 30000 });
    const result = await operation(page);
    const url = page.url();
    let storageState;
    try { storageState = await context.storageState(); } catch { storageState = saved.storageState; }
    await saveSession(sessionId, { url, storageState, updatedAt: new Date().toISOString() });
    return { ...result, session_id: sessionId, current_url: url, session_persistence: env.SESSIONS ? "KV (24h)" : "per-request only; bind SESSIONS KV to persist cookies, local storage, and the last URL" };
  } finally {
    try { if (context) await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}
async function executeSteps({ session_id, steps, approved = false }) {
  sessionKey(session_id);
  validateSteps(steps, approved);
  const requireSaved = !steps.some(step => step.action === "navigate");
  return withBrowser(session_id, async page => {
    const results = [];
    for (const step of steps) {
      if (step.action === "navigate") {
        const target = validatePublicUrl(step.url);
        await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 30000 });
        results.push({ action: "navigate", title: await page.title(), url: page.url() });
      } else if (step.action === "inspect") {
        results.push({ action: "inspect", title: await page.title(), url: page.url(), text: (await page.locator("body").innerText().catch(() => "")).slice(0, MAX_TEXT) });
      } else {
        const locator = page.locator(step.selector);
        const count = await locator.count();
        if (count !== 1 || !(await locator.isVisible()) || !(await locator.isEnabled())) throw new Error("Target must be unique, visible, and enabled.");
        if (step.action === "click") {
          const details = await locator.evaluate(el => ({ text: (el.innerText || el.getAttribute("aria-label") || "").trim(), type: el.getAttribute("type"), name: el.getAttribute("name") }));
          if (details.type === "submit" || IRREVERSIBLE.test([details.text, details.name].join(" "))) throw new Error("Potentially irreversible actions are blocked.");
          await locator.click();
          results.push({ action: "click", selector: step.selector, completed: true });
        } else {
          const details = await locator.evaluate(el => ({ type: el.getAttribute("type"), name: el.getAttribute("name"), id: el.id, autocomplete: el.getAttribute("autocomplete"), label: el.getAttribute("aria-label") }));
          if (details.type === "password" || SENSITIVE.test(Object.values(details).join(" "))) throw new Error("Sensitive fields are blocked.");
          if (!await locator.evaluate(el => ["INPUT","TEXTAREA"].includes(el.tagName) || el.isContentEditable)) throw new Error("Only ordinary text fields can be filled.");
          await locator.fill(step.value);
          results.push({ action: "fill", selector: step.selector, completed: true });
        }
      }
    }
    return { results, title: await page.title(), text: (await page.locator("body").innerText().catch(() => "")).slice(0, MAX_TEXT) };
  }, requireSaved);
}
function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
function createServer() {
  const server = new McpServer({ name: "openfish-ai-browser-cloud", version: VERSION });
  server.registerTool("open_page", { description: "Open a public HTTP(S) URL in an isolated Cloudflare Browser Run session.", inputSchema: { url: z.string().url(), session_id: z.string().min(8).max(80).optional() } }, async ({ url, session_id }) => textResult(await executeSteps({ session_id: session_id || crypto.randomUUID(), steps: [{ action: "navigate", url }, { action: "inspect" }] })));
  server.registerTool("read_page", { description: "Read the current page title, URL, and visible text from the saved session.", inputSchema: { session_id: z.string().min(8).max(80) } }, async ({ session_id }) => textResult(await withBrowser(session_id, async page => ({ title: await page.title(), url: page.url(), text: (await page.locator("body").innerText().catch(() => "")).slice(0, MAX_TEXT) }), true)));
  server.registerTool("plan_task", { description: "Create a non-executing review plan. The user must inspect and explicitly approve any mutating plan.", inputSchema: { goal: z.string().min(1).max(2000), url: z.string().url().optional(), session_id: z.string().min(8).max(80).optional() } }, async ({ goal, url, session_id }) => {
    const steps = url ? [{ action: "navigate", url }, { action: "inspect" }] : [{ action: "inspect" }];
    return textResult({ status: "plan_ready_for_review", summary: goal, steps, session_id: session_id || crypto.randomUUID(), warning: "This is a deterministic draft, not an AI-generated plan. No action has been executed." });
  });
  server.registerTool("execute_plan", { description: "Execute a reviewed plan. Explicit approval is required for clicks and form fills; high-risk actions remain blocked.", inputSchema: { steps: z.array(z.object({ action: z.enum(["navigate","inspect","click","fill"]), url: z.string().optional(), selector: z.string().optional(), value: z.string().optional(), reason: z.string().optional() })).min(1).max(MAX_STEPS), approved: z.boolean(), session_id: z.string().min(8).max(80) } }, async ({ steps, approved, session_id }) => textResult(await executeSteps({ session_id: session_id, steps, approved })));
  server.registerTool("list_interactive_elements", { description: "List visible links, buttons, and ordinary form controls.", inputSchema: { session_id: z.string().min(8).max(80) } }, async ({ session_id }) => textResult(await withBrowser(session_id, async page => ({ elements: await page.locator("a,button,input:not([type=password]),textarea,select,[role=button]").evaluateAll(nodes => nodes.slice(0,150).filter(el => el.getClientRects().length).map((el,index) => ({ index, tag: el.tagName.toLowerCase(), text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0,180), type: el.getAttribute("type"), id: el.id || null, href: el.href || null, disabled: Boolean(el.disabled) }))) }), true)));
  server.registerTool("get_accessibility_snapshot", { description: "Read headings and landmarks from the current page.", inputSchema: { session_id: z.string().min(8).max(80) } }, async ({ session_id }) => textResult(await withBrowser(session_id, async page => await page.locator("body").evaluate(body => ({ headings: [...body.querySelectorAll("h1,h2,h3")].slice(0,60).map(el => ({ level: Number(el.tagName.slice(1)), text: (el.innerText || "").trim().slice(0,240) })), landmarks: [...body.querySelectorAll("main,nav,header,footer,form,[role=main],[role=navigation]")].slice(0,30).map(el => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), label: el.getAttribute("aria-label"), text: (el.innerText || "").trim().slice(0,500) })) })), true)));
  server.registerTool("click_element", { description: "Click one unique visible button-like element after explicit user approval.", inputSchema: { selector: z.string().min(1).max(500), approved: z.boolean(), session_id: z.string().min(8).max(80) } }, async ({ selector, approved, session_id }) => textResult(await executeSteps({ session_id: session_id, approved, steps: [{ action: "click", selector }] })));
  server.registerTool("fill_element", { description: "Fill one ordinary text field after explicit user approval. Sensitive fields are blocked.", inputSchema: { selector: z.string().min(1).max(500), value: z.string().max(10000), approved: z.boolean(), session_id: z.string().min(8).max(80) } }, async ({ selector, value, approved, session_id }) => textResult(await executeSteps({ session_id: session_id, approved, steps: [{ action: "fill", selector, value }] })));
  server.registerTool("take_screenshot", { description: "Capture the current browser viewport.", inputSchema: { session_id: z.string().min(8).max(80) } }, async ({ session_id }) => {
    const result = await withBrowser(session_id, async page => ({ image: await page.screenshot({ type: "png" }) }), true);
    const bytes = result.image;
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { content: [{ type: "image", data: btoa(binary), mimeType: "image/png" }, { type: "text", text: JSON.stringify({ session_id: result.session_id, current_url: result.current_url }) }] };
  });
  return server;
}
const mcpHandler = createMcpHandler(createServer);

function authorized(request, env) {
  const expected = env.OPENFISH_API_TOKEN;
  if (!expected || expected.length < 24) return false;
  const supplied = request.headers.get("authorization") || "";
  return supplied === `Bearer ${expected}`;
}
function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = (env.ALLOWED_EXTENSION_ORIGIN || "").split(",").map(x => x.trim()).filter(Boolean);
  if (origin && origin !== new URL(request.url).origin && !allowed.includes(origin)) return {};
  return origin ? { "access-control-allow-origin": origin, "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,content-type", "vary": "Origin" } : {};
}
export default {
  async fetch(request, bindings, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, bindings) });
    if (url.pathname === "/health") return json({ ok: true, name: "OpenFish AI Browser", version: VERSION, browserRun: Boolean(bindings.BROWSER) });
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      if (!authorized(request, bindings)) return json({ error: "Unauthorized. Configure OPENFISH_API_TOKEN and send it as a Bearer token." }, 401, corsHeaders(request, bindings));
      return mcpHandler(request, bindings, ctx);
    }
    if (url.pathname.startsWith("/api/")) {
      if (!authorized(request, bindings)) return json({ error: "Unauthorized." }, 401, corsHeaders(request, bindings));
      if (request.method === "GET" && url.pathname === "/api/v1/tools") {
        return json({ name: "OpenFish AI Browser", version: VERSION, transport: "MCP Streamable HTTP", mcp: "/mcp", tools: ["open_page","read_page","plan_task","execute_plan","list_interactive_elements","get_accessibility_snapshot","click_element","fill_element","take_screenshot"] }, 200, corsHeaders(request, bindings));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/execute") {
        try { const body = await request.json(); return json(await executeSteps(body), 200, corsHeaders(request, bindings)); }
        catch (error) { return json({ error: error.message || "Browser task failed." }, 400, corsHeaders(request, bindings)); }
      }
      return json({ error: "Not found." }, 404, corsHeaders(request, bindings));
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return bindings.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
    }
    return bindings.ASSETS.fetch(request);
  }
};
