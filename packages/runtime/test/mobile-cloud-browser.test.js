import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("mobile frontend is served by the Worker and uses authenticated cloud browser routes", async () => {
  const worker = await readFile(resolve("cloudflare/worker.js"), "utf8");
  const config = await readFile(resolve("cloudflare/wrangler.toml"), "utf8");
  const html = await readFile(resolve("public/index.html"), "utf8");
  const app = await readFile(resolve("public/app.js"), "utf8");
  assert.ok(config.includes('[browser]'));
  assert.ok(config.includes('binding = "BROWSER"'));
  assert.ok(config.includes('[assets]'));
  assert.ok(worker.includes('import puppeteer from "@cloudflare/puppeteer"'));
  assert.ok(worker.includes('url.pathname.startsWith("/api/cloud-browser/")'));
  assert.ok(worker.includes('if (!authorized(request, env))'));
  assert.ok(worker.includes('puppeteer.launch(this.env.BROWSER'));
  assert.ok(worker.includes('puppeteer.connect(this.env.BROWSER, stored)'));
  assert.ok(worker.includes('browser.disconnect()'));
  assert.ok(worker.includes('validateTarget'));
  for (const id of ["url", "back", "forward", "reload", "go", "viewport", "sendText", "bookmark", "bookmarks"]) assert.ok(html.includes('id="' + id + '"'));
  for (const route of ["/api/cloud-browser/status", "/api/cloud-browser/view", "/api/cloud-browser/navigate", "/api/cloud-browser/action", "/api/cloud-browser/close"]) assert.ok(worker.includes(route));
  assert.ok(app.includes("data:image/jpeg;base64,"));
  assert.ok(app.includes("/api/cloud-browser/navigate"));
  assert.ok(app.includes("/api/cloud-browser/action"));
});
