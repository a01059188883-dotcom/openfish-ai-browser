const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".test", ".invalid", ".example"];
function isPrivateIPv4(host) {
  const p = host.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a,b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0);
}
export function validatePublicUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw new Error("A valid public HTTP(S) URL is required."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS URLs are allowed.");
  if (url.username || url.password) throw new Error("URLs containing embedded credentials are not allowed.");
  let host = url.hostname.toLowerCase().replaceAll("[", "").replaceAll("]", "");
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host === "localhost" || host === "metadata" || PRIVATE_SUFFIXES.some(s => host.endsWith(s)) ||
      isPrivateIPv4(host) || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:") || host.startsWith("ff")) {
    throw new Error("Private, loopback, link-local, and reserved destinations are blocked.");
  }
  return url;
}
const SENSITIVE = /password|passwd|secret|token|otp|recovery|credit.?card|card.?number|cvv|cvc|ssn|social.?security/i;
export const IRREVERSIBLE = /submit|purchase|buy now|pay|checkout|send|delete|remove|confirm|publish|post|transfer|付款|支付|购买|提交|发送|删除|确认|发布|转账|결제|구매|삭제|전송|게시/i;
export function validateSteps(steps, approved = false) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 8) throw new Error("A plan must contain 1 to 8 steps.");
  for (const step of steps) {
    if (!step || !["navigate","inspect","click","fill"].includes(step.action)) throw new Error("Unsupported browser action.");
    if (["click","fill"].includes(step.action) && approved !== true) throw new Error("Explicit approval of the exact plan is required.");
    if (step.action === "navigate") validatePublicUrl(step.url);
    if (["click","fill"].includes(step.action) && (typeof step.selector !== "string" || !step.selector.trim() || step.selector.length > 500)) throw new Error("Invalid selector.");
    if (step.action === "fill" && (typeof step.value !== "string" || step.value.length > 10000 || SENSITIVE.test(step.selector + " " + (step.reason || "")))) {
      throw new Error("Sensitive or invalid fields cannot be filled.");
    }
  }
  return steps;
}
