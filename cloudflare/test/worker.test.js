import test from "node:test";
import assert from "node:assert/strict";
import { validatePublicUrl, validateSteps } from "../src/safety.js";
import { summarizeBrowserLimits, isBrowserRateLimited, retryAfterMs } from "../src/browser-status.js";

test("accepts public HTTPS URL", () => {
  assert.equal(validatePublicUrl("https://example.com/path").hostname, "example.com");
});
test("rejects non-http protocols and embedded credentials", () => {
  assert.throws(() => validatePublicUrl("file:///etc/passwd"));
  assert.throws(() => validatePublicUrl("https://user:pass@example.com"));
});
test("rejects localhost and private IPv4", () => {
  for (const url of ["http://localhost", "http://127.0.0.1", "http://10.0.0.2", "http://192.168.1.2", "http://169.254.169.254", "http://[::1]", "http://[fe80::1]"]) {
    assert.throws(() => validatePublicUrl(url), url);
  }
});
test("requires explicit approval for mutating actions", () => {
  assert.throws(() => validateSteps([{ action: "click", selector: "button" }], false));
  assert.doesNotThrow(() => validateSteps([{ action: "click", selector: "button" }], true));
});
test("rejects sensitive fills and oversized plans", () => {
  assert.throws(() => validateSteps([{ action: "fill", selector: "input[name=password]", value: "x" }], true));
  assert.throws(() => validateSteps(Array(9).fill({ action: "inspect" }), true));
});

test("summarizes Browser Run limits without exposing session identifiers", () => {
  const status = summarizeBrowserLimits({
    activeSessions: [{ id: "secret-session-id" }],
    allowedBrowserAcquisitions: 0,
    maxConcurrentSessions: 2,
    timeUntilNextAllowedBrowserAcquisition: 4200
  });
  assert.deepEqual(status, {
    active_sessions: 1,
    max_concurrent_sessions: 2,
    allowed_browser_acquisitions: 0,
    time_until_next_allowed_acquisition_ms: 4200,
    capacity_available: false
  });
  assert.equal(JSON.stringify(status).includes("secret-session-id"), false);
});

test("identifies Browser Run rate-limit errors and retry timing", () => {
  assert.equal(isBrowserRateLimited(new Error("code: 429: Rate limit exceeded")), true);
  assert.equal(isBrowserRateLimited(new Error("Target closed")), false);
  assert.equal(retryAfterMs({ timeUntilNextAllowedBrowserAcquisition: 5000 }), 5000);
  assert.equal(retryAfterMs({ timeUntilNextAllowedBrowserAcquisition: 0 }), 0);
  assert.equal(retryAfterMs({}), null);
});
