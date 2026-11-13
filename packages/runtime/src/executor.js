import { getPage } from "./browser.js";
import { validatePlan, validateHttpUrl, isSensitiveField, isIrreversibleAction } from "./safety.js";

async function getUniqueTarget(page, selector) {
  const target = page.locator(selector);
  const count = await target.count();
  if (count !== 1) throw new Error(`Selector must match exactly one element; found ${count}: ${selector}`);
  const details = await target.evaluate(el => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute("type") || "",
    role: el.getAttribute("role") || "",
    name: el.getAttribute("name") || "",
    id: el.id || "",
    label: el.getAttribute("aria-label") || el.labels?.[0]?.innerText || "",
    text: (el.innerText || el.getAttribute("aria-label") || el.value || "").trim().slice(0, 200),
    autocomplete: el.getAttribute("autocomplete") || "",
    visible: Boolean(el.getClientRects().length),
    disabled: Boolean(el.disabled),
    editable: el.isContentEditable || ["input", "textarea"].includes(el.tagName.toLowerCase())
  }));
  if (!details.visible) throw new Error(`Target is not visible: ${selector}`);
  if (details.disabled) throw new Error(`Target is disabled: ${selector}`);
  return { target, details };
}

export async function executePlan(plan, { approved = false } = {}) {
  if (approved !== true) throw new Error("Explicit user approval is required before executing a plan.");
  validatePlan(plan);
  const page = await getPage();
  const results = [];
  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index];
    try {
      if (step.action === "navigate") {
        const url = validateHttpUrl(step.url).href;
        await page.goto(url, { waitUntil: "domcontentloaded" });
        results.push({ step: index + 1, action: step.action, ok: true, url: page.url() });
      } else if (step.action === "inspect") {
        const title = await page.title().catch(() => "");
        const text = (await page.locator("body").innerText().catch(() => "")).slice(0, 4000);
        results.push({ step: index + 1, action: step.action, ok: true, title, url: page.url(), text });
      } else if (step.action === "click") {
        const { target, details } = await getUniqueTarget(page, step.selector);
        if (!["button", "a"].includes(details.tag) && details.role !== "button" && !["button", "submit", "reset", "checkbox", "radio"].includes(details.type)) {
          throw new Error("Only visible buttons, links, and button-like controls can be clicked by an approved plan.");
        }
        if (isIrreversibleAction(details)) throw new Error("Blocked potentially irreversible action. Complete this step manually after reviewing the page.");
        await target.click();
        results.push({ step: index + 1, action: step.action, ok: true, selector: step.selector, url: page.url() });
      } else if (step.action === "fill") {
        const { target, details } = await getUniqueTarget(page, step.selector);
        if (!details.editable) throw new Error("Target is not an editable input or textarea.");
        if (details.type === "hidden" || isSensitiveField(details)) throw new Error("Blocked sensitive or hidden field.");
        await target.fill(step.value);
        results.push({ step: index + 1, action: step.action, ok: true, selector: step.selector });
      }
    } catch (error) {
      results.push({ step: index + 1, action: step.action, ok: false, error: error.message });
      return { status: "stopped", completed: results.filter(item => item.ok).length, total: plan.steps.length, results, currentUrl: page.url(), message: "Execution stopped at the first failed or blocked step. Review the page before continuing." };
    }
  }
  return { status: "completed", completed: results.length, total: plan.steps.length, results, currentUrl: page.url() };
}
