import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getPage } from "../../runtime/src/browser.js";
import { createPlan } from "../../runtime/src/ai-planner.js";
import { getPageContext } from "../../runtime/src/task.js";
import { executePlan } from "../../runtime/src/executor.js";
import { validateHttpUrl, isSensitiveField, isIrreversibleAction } from "../../runtime/src/safety.js";

const server = new McpServer({ name: "openfish-ai-browser", version: "1.0.6" });
const result = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

server.tool("plan_task", "Use the configured local Ollama model to propose a safe, reviewable browser action plan. It never executes the plan.", {
  goal: z.string().min(1).max(2000)
}, async ({ goal }) => {
  const context = await getPageContext();
  const plan = await createPlan(goal, context);
  return result({ status: "plan_ready_for_review", ...plan, warning: "Review every step. This tool only plans; it does not execute actions." });
});

server.tool("execute_plan", "Execute a reviewed browser plan sequentially. Call only after the user explicitly approves the exact plan. High-risk and sensitive actions are blocked.", {
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
}, async ({ plan, approved }) => result(await executePlan(plan, { approved })));

server.tool("open_page", "Open an HTTP(S) page in the controlled browser.", {
  url: z.string().url()
}, async ({ url }) => {
  const parsed = validateHttpUrl(url);
  const page = await getPage();
  await page.goto(parsed.href, { waitUntil: "domcontentloaded" });
  return result({ title: await page.title(), url: page.url() });
});

server.tool("read_page", "Read the current page title, URL, and visible text.", {}, async () => {
  const page = await getPage();
  return result({ title: await page.title(), url: page.url(), text: (await page.locator("body").innerText()).slice(0, 20000) });
});

server.tool("click_element", "Click an element using an explicit CSS selector. Do not use for purchases, sending, deletion, or final submission without user confirmation.", {
  selector: z.string().min(1).max(500)
}, async ({ selector }) => {
  const page = await getPage();
  const target = page.locator(selector).first();
  const details = await target.evaluate(el => ({
    tag: el.tagName.toLowerCase(), type: el.getAttribute("type"), name: el.getAttribute("name"),
    text: (el.innerText || el.getAttribute("aria-label") || el.value || "").trim().slice(0, 200),
    label: el.getAttribute("aria-label") || ""
  }));
  if (isIrreversibleAction(details)) {
    throw new Error("Blocked potentially irreversible action. Review the page and perform this action manually.");
  }
  await target.click();
  return result({ ok: true, clicked: selector, element: details, url: page.url() });
});

server.tool("fill_element", "Fill a form field using an explicit CSS selector and supplied text.", {
  selector: z.string().min(1).max(500),
  value: z.string().max(10000)
}, async ({ selector, value }) => {
  const page = await getPage();
  const target = page.locator(selector).first();
  const details = await target.evaluate(el => ({ type: el.getAttribute("type"), name: el.getAttribute("name"), id: el.id, autocomplete: el.getAttribute("autocomplete"), label: el.getAttribute("aria-label") || el.labels?.[0]?.innerText || "" }));
  if (isSensitiveField(details)) {
    throw new Error("Blocked sensitive credential field. Do not enter passwords, tokens, or recovery codes through OpenFish.");
  }
  await target.fill(value);
  return result({ ok: true, filled: selector });
});

server.tool("take_screenshot", "Capture the current browser page screenshot and return its path.", {}, async () => {
  const page = await getPage();
  const path = `openfish-${Date.now()}.png`;
  await page.screenshot({ path, fullPage: false });
  return result({ path, url: page.url() });
});

server.tool("list_interactive_elements", "List visible links, buttons, inputs, and selects with hints for choosing an explicit selector.", {}, async () => {
  const page = await getPage();
  const items = await page.locator("a,button,input,textarea,select,[role=button]").evaluateAll(nodes =>
    nodes.slice(0, 150).map((el, index) => ({
      index, tag: el.tagName.toLowerCase(), role: el.getAttribute("role"),
      text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || "").trim().slice(0, 180),
      type: el.getAttribute("type"), name: el.getAttribute("name"), id: el.id || null,
      href: el.href || null, disabled: Boolean(el.disabled), visible: Boolean(el.getClientRects().length)
    })).filter(item => item.visible)
  );
  return result(items);
});

server.tool("get_accessibility_snapshot", "Return a compact semantic outline of the current page.", {}, async () => {
  const page = await getPage();
  const snapshot = await page.locator("body").evaluate(body => ({
    headings: [...body.querySelectorAll("h1,h2,h3")].slice(0, 60).map(el => ({ level: Number(el.tagName.slice(1)), text: (el.innerText || "").trim().slice(0, 240) })),
    landmarks: [...body.querySelectorAll("main,nav,header,footer,form,[role=main],[role=navigation]")].slice(0, 30).map(el => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), label: el.getAttribute("aria-label"), text: (el.innerText || "").trim().slice(0, 500) }))
  }));
  return result({ title: await page.title(), url: page.url(), ...snapshot });
});

const transport = new StdioServerTransport();
await server.connect(transport);
