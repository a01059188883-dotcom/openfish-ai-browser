export function validateHttpUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); }
  catch { throw Object.assign(new Error("A valid HTTP(S) URL is required."), { statusCode: 400 }); }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw Object.assign(new Error("Only HTTP and HTTPS URLs are allowed."), { statusCode: 400 });
  }
  if (parsed.username || parsed.password) {
    throw Object.assign(new Error("URLs containing embedded credentials are not allowed."), { statusCode: 400 });
  }
  return parsed;
}

const SENSITIVE_FIELD = /password|passwd|secret|token|otp|one.?time.?code|recovery|credit.?card|card.?number|cvv|cvc|ssn|social.?security/i;
const IRREVERSIBLE_ACTION = /submit|purchase|buy now|pay|checkout|send|delete|remove|confirm|publish|post|transfer|付款|支付|购买|提交|发送|删除|确认|发布|转账|결제|구매|삭제|전송|게시/i;

export function isSensitiveField(details = {}) {
  return details.type === "password" || SENSITIVE_FIELD.test(
    `${details.name || ""} ${details.autocomplete || ""} ${details.id || ""} ${details.label || ""}`
  );
}

export function isIrreversibleAction(details = {}) {
  return details.type === "submit" || IRREVERSIBLE_ACTION.test(
    `${details.text || ""} ${details.label || ""} ${details.name || ""}`
  );
}

export function validatePlan(plan) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length > 8) {
    throw new Error("AI plan failed validation.");
  }
  const allowed = new Set(["navigate", "click", "fill", "inspect"]);
  for (const step of plan.steps) {
    if (!step || !allowed.has(step.action)) throw new Error("AI plan contains a disallowed action.");
    if (step.action === "navigate") validateHttpUrl(step.url);
    if (["click", "fill"].includes(step.action) && (typeof step.selector !== "string" || !step.selector.trim() || step.selector.length > 500)) {
      throw new Error("AI plan contains an invalid selector.");
    }
    if (step.action === "fill") {
      if (typeof step.value !== "string" || step.value.length > 10000) throw new Error("AI plan contains an invalid field value.");
      if (isSensitiveField({ name: step.selector, label: step.reason })) throw new Error("AI plan attempted to fill a sensitive field.");
    }
  }
  return plan;
}
