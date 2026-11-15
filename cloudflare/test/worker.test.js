import test from "node:test";
import assert from "node:assert/strict";
import { validatePublicUrl, validateSteps } from "../src/safety.js";

test("accepts public HTTPS URL", () => {
  assert.equal(validatePublicUrl("https://example.com/path").hostname, "example.com");
});
test("rejects non-http protocols and embedded credentials", () => {
  assert.throws(() => validatePublicUrl("file:///etc/passwd"));
  assert.throws(() => validatePublicUrl("https://user:pass@example.com"));
});
test("rejects localhost and private IPv4", () => {
  for (const url of ["http://localhost", "http://127.0.0.1", "http://10.0.0.2", "http://192.168.1.2", "http://169.254.169.254"]) {
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
