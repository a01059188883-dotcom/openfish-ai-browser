import { acquire, connect } from "@cloudflare/playwright";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { validatePublicUrl, validateSteps, IRREVERSIBLE, SENSITIVE } from "./safety.js";
import { summarizeBrowserLimits, isBrowserRateLimited, retryAfterMs } from "./browser-status.js";

const VERSION = "1.2.2-cloudflare-preview";
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
  if (requireSaved && !saved.url) throw new Error("No saved page for this session. First open a URL in the same task.");
  let browser;
  let browserSessionId = saved.browserSessionId;
  let reused = false;
  if (browserSessionId) {
    try { browser = await connect(env.BROWSER, browserSessionId); reused = true; }
    catch { browser = undefined; browserSessionId = undefined; }
  }
  if (!browser) {
    const acquired = await acquire(env.BROWSER);
    browserSessionId = acquired.sessionId;
    browser = await connect(env.BROWSER, browserSessionId);
  }
  let context;
  try {
    context = await browser.newContext(saved.storageState ? { storageState: saved.storageState } : {});
    await context.route("**/*", async route => {
      try {
        const requestUrl = new URL(route.request().url());
        if (["http:", "https:"].includes(requestUrl.protocol)) validatePublicUrl(requestUrl.href);
        await route.continue();
      } catch { await route.abort(); }
    });
    const page = await context.newPage();
    let history = Array.isArray(saved.history) ? saved.history.filter(item => { try { validatePublicUrl(item); return true; } catch { return false; } }).slice(-20) : [];
    if (!history.length && saved.url) history = [saved.url];
    let historyIndex = Number.isInteger(saved.historyIndex) ? Math.max(0, Math.min(saved.historyIndex, history.length - 1)) : history.length - 1;
    if (history.length) {
      for (let i = 0; i <= historyIndex; i++) await page.goto(validatePublicUrl(history[i]).href, { waitUntil: "domcontentloaded", timeout: 30000 });
    }
    const result = await operation(page, { history, historyIndex });
    if (result?._sessionState) {
      history = result._sessionState.history || history;
      historyIndex = Number.isInteger(result._sessionState.historyIndex) ? result._sessionState.historyIndex : historyIndex;
      delete result._sessionState;
    }
    const currentUrl = page.url();
    let storageState;
    try { storageState = await context.storageState(); } catch { storageState = saved.storageState; }
    const now = new Date().toISOString();
    const actionResults = Array.isArray(result?.results) ? result.results : [];
    const activity = [...(Array.isArray(saved.activity) ? saved.activity : []), ...actionResults.map(item => {
      let host = null;
      try { host = new URL(item.url || currentUrl).hostname; } catch {}
      return { at: now, action: String(item.action || "browser_action").slice(0,40), host };
    })].slice(-50);
    await saveSession(sessionId, { url: currentUrl, storageState, browserSessionId, history, historyIndex, activity, updatedAt: now });
    return { ...result, session_id: sessionId, current_url: currentUrl, browser_session_reused: reused, browser_run_session_id: browserSessionId, session_persistence: env.SESSIONS ? "Browser Run session + KV metadata/state (24h)" : "per-request metadata only; bind SESSIONS KV to persist" };
  } finally {
    try { if (context) await context.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
  }
}
function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
async function executeSteps({ session_id, steps, approved = false }) {
  sessionKey(session_id);
  validateSteps(steps, approved);
  const requireSaved = !steps.some(step => step.action === "navigate");
  return withBrowser(session_id, async (page, state) => {
    const results = [];
    let history = [...state.history];
    let historyIndex = state.historyIndex;
    for (const step of steps) {
      if (step.action === "navigate") {
        const target = validatePublicUrl(step.url);
        await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 30000 });
        history = [...history.slice(0, historyIndex + 1), target.href].slice(-20);
        historyIndex = history.length - 1;
        results.push({ action: "navigate", title: await page.title(), url: page.url() });
      } else if (step.action === "back") {
        if (historyIndex > 0) { historyIndex--; await page.goto(validatePublicUrl(history[historyIndex]).href, { waitUntil: "domcontentloaded", timeout: 30000 }); }
        results.push({ action: "back", moved: historyIndex < state.historyIndex, url: page.url() });
      } else if (step.action === "forward") {
        if (historyIndex < history.length - 1) { historyIndex++; await page.goto(validatePublicUrl(history[historyIndex]).href, { waitUntil: "domcontentloaded", timeout: 30000 }); }
        results.push({ action: "forward", moved: historyIndex > state.historyIndex, url: page.url() });
      } else if (step.action === "reload") {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
        results.push({ action: "reload", url: page.url() });
      } else if (step.action === "inspect") {
        results.push({ action: "inspect", title: await page.title(), url: page.url(), text: (await page.locator("body").innerText().catch(() => "")).slice(0, MAX_TEXT) });
      } else if (step.action === "elements") {
        const elements = await page.locator("a,button,input:not([type=password]),textarea,select,[role=button]").evaluateAll(nodes => nodes.slice(0,150).filter(el => el.getClientRects().length).map((el,index) => ({ index, tag: el.tagName.toLowerCase(), text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0,180), type: el.getAttribute("type"), id: el.id || null, href: el.href || null, disabled: Boolean(el.disabled) })));
        results.push({ action: "elements", elements });
      } else if (step.action === "accessibility") {
        const snapshot = await page.locator("body").evaluate(body => ({ headings: [...body.querySelectorAll("h1,h2,h3")].slice(0,60).map(el => ({ level: Number(el.tagName.slice(1)), text: (el.innerText || "").trim().slice(0,240) })), landmarks: [...body.querySelectorAll("main,nav,header,footer,form,[role=main],[role=navigation]")].slice(0,30).map(el => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), label: el.getAttribute("aria-label"), text: (el.innerText || "").trim().slice(0,500) })) }));
        results.push({ action: "accessibility", snapshot });
      } else if (step.action === "screenshot") {
        const bytes = await page.screenshot({ type: "png" });
        results.push({ action: "screenshot", data_url: "data:image/png;base64," + toBase64(bytes) });
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
    const finalText = (await page.locator("body").innerText().catch(() => "")).slice(0, MAX_TEXT);
    return { results, title: await page.title(), text: finalText, history: history.slice(), history_index: historyIndex, _sessionState: { history, historyIndex } };
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
  server.registerTool("navigate_back", { description: "Navigate to the previous URL in the saved session history.", inputSchema: { session_id: z.string().min(8).max(80) } }, async ({ session_id }) => textResult(await executeSteps({ session_id, steps: [{ action: "back" }] })));
  server.registerTool("navigate_forward", { description: "Navigate to the next URL in the saved session history.", inputSchema: { session_id: z.string().min(8).max(80) } }, async ({ session_id }) => textResult(await executeSteps({ session_id, steps: [{ action: "forward" }] })));
  server.registerTool("reload_page", { description: "Reload the current saved page.", inputSchema: { session_id: z.string().min(8).max(80) } }, async ({ session_id }) => textResult(await executeSteps({ session_id, steps: [{ action: "reload" }] })));
  server.registerTool("get_session_status", { description: "Read saved URL, history count, persistence state, and recent action metadata for a browser session.", inputSchema: { session_id: z.string().min(8).max(80) } }, async ({ session_id }) => {
    const saved = await loadSession(session_id);
    return textResult({ session_id, exists: Boolean(saved.url), current_url: saved.url || null, history_count: Array.isArray(saved.history) ? saved.history.length : (saved.url ? 1 : 0), updated_at: saved.updatedAt || null, has_saved_storage_state: Boolean(saved.storageState), browser_session_saved: Boolean(saved.browserSessionId), activity: (saved.activity || []).slice(-20) });
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
        return json({ name: "OpenFish AI Browser", version: VERSION, transport: "MCP Streamable HTTP", mcp: "/mcp", tools: ["open_page","read_page","plan_task","execute_plan","navigate_back","navigate_forward","reload_page","list_interactive_elements","get_accessibility_snapshot","click_element","fill_element","take_screenshot","get_session_status"] }, 200, corsHeaders(request, bindings));
      }
      if (request.method === "GET" && url.pathname === "/api/v1/session") {
        try {
          const id = url.searchParams.get("session_id");
          sessionKey(id);
          const saved = await loadSession(id);
          return json({ session_id: id, exists: Boolean(saved.url), current_url: saved.url || null, history_count: Array.isArray(saved.history) ? saved.history.length : (saved.url ? 1 : 0), updated_at: saved.updatedAt || null, has_saved_storage_state: Boolean(saved.storageState), browser_session_saved: Boolean(saved.browserSessionId), activity: (saved.activity || []).slice(-30) }, 200, corsHeaders(request, bindings));
        } catch (error) { return json({ error: error.message }, 400, corsHeaders(request, bindings)); }
      }
      if (request.method === "POST" && url.pathname === "/api/v1/session/clear") {
        try {
          const body = await request.json();
          sessionKey(body.session_id);
          if (bindings.SESSIONS) await bindings.SESSIONS.delete(sessionKey(body.session_id));
          return json({ ok: true, session_id: body.session_id, cleared: true, note: "Saved KV metadata and storage state cleared. This does not forcibly terminate an already-running remote Browser Run instance." }, 200, corsHeaders(request, bindings));
        } catch (error) { return json({ error: error.message }, 400, corsHeaders(request, bindings)); }
      }
      if (request.method === "POST" && url.pathname === "/api/v1/plan") {
        try {
          const body = await request.json();
          const goal = String(body.goal || "").trim();
          if (!goal || goal.length > 2000) throw new Error("Task goal must contain 1-2000 characters.");
          const steps = body.url ? [{ action: "navigate", url: validatePublicUrl(body.url).href }, { action: "inspect" }] : [{ action: "inspect" }];
          return json({ status: "plan_ready_for_review", planner: "deterministic-template", summary: goal, session_id: body.session_id || crypto.randomUUID(), steps, warning: "This is a deterministic draft, not an LLM-generated plan. Review and edit it before execution." }, 200, corsHeaders(request, bindings));
        } catch (error) { return json({ error: error.message }, 400, corsHeaders(request, bindings)); }
      }
      if (request.method === "GET" && url.pathname === "/api/v1/browser-status") {
        try {
          const limits = await bindings.BROWSER.limits();
          return json({ ok: true, version: VERSION, browser_run: summarizeBrowserLimits(limits) }, 200, corsHeaders(request, bindings));
        } catch (error) {
          return json({ ok: false, error: error.message || "Browser Run status unavailable." }, 503, corsHeaders(request, bindings));
        }
      }
      if (request.method === "POST" && url.pathname === "/api/v1/execute") {
        try { const body = await request.json(); return json(await executeSteps(body), 200, corsHeaders(request, bindings)); }
        catch (error) {
          const message = error.message || "Browser task failed.";
          if (isBrowserRateLimited(error)) {
            let waitMs = null;
            try { waitMs = retryAfterMs(await bindings.BROWSER.limits()); } catch {}
            const headers = waitMs === null ? corsHeaders(request, bindings) : { ...corsHeaders(request, bindings), "retry-after": String(Math.max(1, Math.ceil(waitMs / 1000))) };
            return json({ error: message, code: "BROWSER_RATE_LIMITED", retry_after_ms: waitMs, guidance: waitMs === null ? "Do not repeatedly retry. Check Browser Run limits in the dashboard before trying again." : "Wait for the indicated interval, then retry once." }, 429, headers);
          }
          return json({ error: message }, 400, corsHeaders(request, bindings));
        }
      }
      return json({ error: "Not found." }, 404, corsHeaders(request, bindings));
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return bindings.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
    }
    return bindings.ASSETS.fetch(request);
  }
};
