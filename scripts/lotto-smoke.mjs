import { chromium } from "playwright";

const target = process.env.LOTTO_SMOKE_URL || "https://korea-lotto-3vx.pages.dev";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on("pageerror", error => pageErrors.push(error.message));
try {
  const response = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
  if (!response || response.status() >= 400) throw new Error(`KOREA LOTTO returned HTTP ${response?.status() ?? "no response"}`);
  await page.locator("body").waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(2500);
  const title = await page.title();
  const bodyText = (await page.locator("body").innerText()).trim();
  if (!title) throw new Error("KOREA LOTTO page title is empty.");
  if (bodyText.length < 80) throw new Error("KOREA LOTTO page content is unexpectedly short.");
  if (!/(로또|연금복권|Lotto|Pension|KOREA LOTTO|韩国乐透)/i.test(bodyText)) {
    throw new Error("Lottery app identity/content was not found on the page.");
  }
  if (pageErrors.length) throw new Error(`Browser runtime errors: ${pageErrors.join(" | ")}`);
  const visibleControls = await page.locator("a:visible,button:visible,[role=button]:visible").count();
  console.log(JSON.stringify({
    ok: true, target, httpStatus: response.status(), title,
    bodyCharacters: bodyText.length, visibleControls,
    viewport: "390x844", pageErrors
  }, null, 2));
} finally {
  await browser.close();
}
