import { chromium } from "playwright";
import { validateHttpUrl } from "./safety.js";

let browser;
let context;
let page;

export async function getPage() {
  if (!browser) {
    const endpoint = process.env.BROWSER_WS_ENDPOINT;
    browser = endpoint
      ? await chromium.connectOverCDP(endpoint)
      : await chromium.launch({ headless: process.env.HEADLESS !== "false" });
    context = endpoint
      ? browser.contexts()[0] || await browser.newContext()
      : await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = context.pages()[0] || await context.newPage();
    await context.route("**/*", async route => {
      const requestUrl = route.request().url();
      try {
        const parsed = new URL(requestUrl);
        if (["http:", "https:"].includes(parsed.protocol)) validateHttpUrl(requestUrl);
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    page.setDefaultTimeout(12000);
  }
  return page;
}

export function getBrowserStatus() {
  return {
    connected: Boolean(browser && browser.isConnected()),
    remote: Boolean(process.env.BROWSER_WS_ENDPOINT),
    url: page && !page.isClosed() ? page.url() : null
  };
}

export async function closeBrowser() {
  if (browser && !process.env.BROWSER_WS_ENDPOINT) await browser.close();
  browser = context = page = undefined;
}
