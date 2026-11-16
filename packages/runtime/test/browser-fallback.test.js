import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("auto mode falls back to local Chromium when remote CDP is unavailable", () => {
  const script = `
    import { getPage, getBrowserStatus, closeBrowser } from "./packages/runtime/src/browser.js";
    await getPage();
    const status = getBrowserStatus();
    if (status.mode !== "local-fallback" || status.connected !== true) {
      throw new Error("Expected connected local-fallback mode; got " + JSON.stringify(status));
    }
    await closeBrowser();
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      OPENFISH_BROWSER_MODE: "auto",
      BROWSER_WS_ENDPOINT: "ws://127.0.0.1:9",
      HEADLESS: "true"
    }
  });
  assert.equal(result.status, 0, `fallback subprocess failed:\n${result.stdout}\n${result.stderr}`);
});
