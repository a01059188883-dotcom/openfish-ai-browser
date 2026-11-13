import { chromium } from "playwright";

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
    page.setDefaultTimeout(12000);
  }
  return page;
}

export async function closeBrowser() {
  if (browser && !process.env.BROWSER_WS_ENDPOINT) await browser.close();
  browser = context = page = undefined;
}
