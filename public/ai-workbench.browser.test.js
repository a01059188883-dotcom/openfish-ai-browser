import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

test("AI workbench mobile browser smoke test: tabs, page context, writing and safe workspace names", async t => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip("Playwright Chromium is not installed: " + error.message);
    return;
  }
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'><main class='quota-panel'></main><footer></footer>");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  try {
    await page.route("**/api/cloud-browser/tabs", route => route.fulfill({ json: { tabs: [{ index: 0, active: true, title: "首页", url: "https://example.com" }, { index: 1, active: false, title: "第二页", url: "https://example.org" }] } }));
    await page.route("**/api/cloud-browser/action", route => route.fulfill({ json: { ok: true } }));
    await page.route("**/api/cloud-browser/view", route => route.fulfill({ json: { title: "模拟页面", url: "https://example.com", text: "OpenFish 页面内容测试文本" } }));
    await page.goto("http://127.0.0.1:" + address.port + "/");
    await page.evaluate(() => {
      sessionStorage.setItem("openfish.relay.token", "test-token-for-local-browser-only");
      sessionStorage.setItem("openfish.browser.session", "test-session-123");
    });
    await page.addScriptTag({ path: fileURLToPath(new URL("./ai-workbench.js", import.meta.url)) });
    await page.locator("#openfish-ai-workbench").waitFor();
    assert.equal(await page.locator("[data-pane]").count(), 10);
    await page.locator("#of-context").click();
    await page.waitForFunction(() => document.querySelector("#of-chat").textContent.includes("OpenFish 页面内容测试文本"));
    await page.locator('[data-tab="write"]').click();
    await page.locator("#of-write-page").click();
    await page.waitForFunction(() => document.querySelector("#of-write").value.includes("OpenFish 页面内容测试文本"));
    await page.locator('[data-tab="memory"]').click();
    await page.locator("#of-memory").fill("授权保存的测试偏好");
    await page.locator("#of-save-memory").click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("openfish.ai.memory.v1"))[0].text), "授权保存的测试偏好");
    await page.locator('[data-tab="workspace"]').click();
    await page.locator("#of-workspace-name").fill("<img src=x onerror=alert(1)>");
    await page.locator("#of-save-workspace").click();
    assert.equal(await page.locator("#of-workspace-list img").count(), 0);
    const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, workbench: document.querySelector("#openfish-ai-workbench").getBoundingClientRect().width }));
    assert.ok(dimensions.document <= dimensions.viewport, "mobile layout must not cause page-level horizontal overflow: " + JSON.stringify(dimensions));
    assert.ok(dimensions.workbench <= dimensions.viewport, "workbench must fit mobile viewport: " + JSON.stringify(dimensions));
  } finally {
    await page.close();
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
