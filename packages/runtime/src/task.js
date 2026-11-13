import { getPage } from "./browser.js";
import { validateHttpUrl } from "./safety.js";

export async function getPageContext() {
  const page = await getPage();
  const [title, url, text, elements] = await Promise.all([
    page.title().catch(() => ""),
    Promise.resolve(page.url()),
    page.locator("body").innerText({ timeout: 5000 }).catch(() => ""),
    page.locator("a,button,input,textarea,select,[role=button]").evaluateAll(nodes => nodes.slice(0, 150).map(el => ({
      tag: el.tagName.toLowerCase(), id: el.id || null, name: el.getAttribute("name"),
      type: el.getAttribute("type"), role: el.getAttribute("role"),
      text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 120),
      href: el.href || null, disabled: Boolean(el.disabled), visible: Boolean(el.getClientRects().length)
    })).filter(el => el.visible))
  ]);
  return { title, url, text: text.slice(0, 12000), elements };
}

export async function runTask(goal, startUrl) {
  const normalized = String(goal || "").trim();
  if (!normalized) throw new Error("Task description is required.");
  if (normalized.length > 2000) throw new Error("Task description must be 2,000 characters or fewer.");
  const page = await getPage();
  if (startUrl) await page.goto(validateHttpUrl(startUrl).href, { waitUntil: "domcontentloaded" });
  const context = await getPageContext();
  return {
    status: "inspected",
    message: "Page context collected. Use plan_task with the local Ollama model to create a proposed action plan; actions are not run automatically.",
    goal: normalized,
    page: context
  };
}
