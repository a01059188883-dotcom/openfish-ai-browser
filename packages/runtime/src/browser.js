import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { validateHttpUrl } from "./safety.js";

const sessionContext = new AsyncLocalStorage();
const sessions = new Map();
const SESSION_TTL_MS = Math.max(60000, Number(process.env.OPENFISH_SESSION_TTL_MS || 30 * 60 * 1000));
const MAX_SESSIONS = Math.max(2, Math.min(50, Number(process.env.OPENFISH_MAX_SESSIONS || 20)));
let browser;
let browserConnectPromise;
let pendingSessionCreations = 0;

export function getCurrentBrowserSessionId() {
  return sessionContext.getStore() || "default";
}
export function runWithBrowserSession(sessionId, callback) {
  return sessionContext.run(sessionId || "default", callback);
}
function touch(session) {
  session.lastUsedAt = new Date().toISOString();
  session.expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
}
async function getBrowser() {
  if (browser?.isConnected()) return browser;
  if (!browserConnectPromise) {
    browserConnectPromise = (async () => {
      const endpoint = process.env.BROWSER_WS_ENDPOINT;
      browser = endpoint
        ? await chromium.connectOverCDP(endpoint)
        : await chromium.launch({ headless: process.env.HEADLESS !== "false" });
      return browser;
    })().finally(() => { browserConnectPromise = null; });
  }
  return browserConnectPromise;
}
async function createContext() {
  const instance = await getBrowser();
  const context = await instance.newContext({ viewport: { width: 1440, height: 900 } });
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
  return context;
}
async function getSession(sessionId) {
  let session = sessions.get(sessionId);
  if (!session) {
    session = { id: sessionId, context: await createContext(), page: null, createdAt: new Date().toISOString(), lastUsedAt: null, expiresAt: null };
    sessions.set(sessionId, session);
  }
  touch(session);
  if (!session.page || session.page.isClosed()) {
    session.page = await session.context.newPage();
    session.page.setDefaultTimeout(12000);
  }
  return session;
}
function validSessionId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(id) && id !== "default";
}
export async function createBrowserSession(name = "New session") {
  listBrowserSessions();
  const activeNamedSessions = [...sessions.keys()].filter(id => id !== "default").length;
  if (activeNamedSessions + pendingSessionCreations >= MAX_SESSIONS) {
    throw Object.assign(new Error(`Browser session limit reached (${MAX_SESSIONS}). Close an idle session before creating another.`), { statusCode: 429 });
  }
  pendingSessionCreations += 1;
  try {
    const id = randomUUID();
    const context = await createContext();
    const session = { id, name: String(name || "New session").trim().slice(0, 60) || "New session", context, page: null, createdAt: new Date().toISOString(), lastUsedAt: null, expiresAt: null };
    sessions.set(id, session);
    touch(session);
    return publicSession(session);
  } finally {
    pendingSessionCreations -= 1;
  }
}
export function hasBrowserSession(id) {
  listBrowserSessions();
  return sessions.has(id);
}
export function listBrowserSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (id !== "default" && Date.parse(session.expiresAt || 0) <= now) {
      session.context.close().catch(() => {});
      sessions.delete(id);
    }
  }
  return [...sessions.values()].map(publicSession);
}
function publicSession(session) {
  return { id: session.id, name: session.name || "Default session", createdAt: session.createdAt, lastUsedAt: session.lastUsedAt, expiresAt: session.expiresAt, active: Boolean(session.page && !session.page.isClosed()) };
}
export async function closeBrowserSession(id) {
  if (!validSessionId(id)) throw Object.assign(new Error("Invalid or protected browser session ID."), { statusCode: 400 });
  const session = sessions.get(id);
  if (!session) throw Object.assign(new Error("Browser session not found."), { statusCode: 404 });
  await session.context.close();
  sessions.delete(id);
  return { id, closed: true };
}
export async function getPage() {
  const id = getCurrentBrowserSessionId();
  const session = await getSession(id);
  return session.page;
}

export async function listBrowserTabs() {
  const session = await getSession(getCurrentBrowserSessionId());
  let pages = session.context.pages();
  if (!pages.length) { session.page = await session.context.newPage(); session.page.setDefaultTimeout(12000); }
  pages = session.context.pages();
  if (!session.page || session.page.isClosed()) session.page = pages[0];
  return Promise.all(pages.map(async (page, index) => ({ index, title: await page.title().catch(() => ""), url: page.url(), active: page === session.page })));
}
export async function createBrowserTab(url) {
  const session = await getSession(getCurrentBrowserSessionId());
  const page = await session.context.newPage(); page.setDefaultTimeout(12000);
  if (url) await page.goto(validateHttpUrl(url).href, { waitUntil: "domcontentloaded" });
  session.page = page;
  return { index: session.context.pages().indexOf(page), title: await page.title().catch(() => ""), url: page.url(), active: true };
}
export async function switchBrowserTab(index) {
  const session = await getSession(getCurrentBrowserSessionId()); const pages = session.context.pages();
  if (!Number.isInteger(index) || index < 0 || index >= pages.length) throw Object.assign(new Error("Browser tab index is out of range."), { statusCode: 404 });
  session.page = pages[index]; await session.page.bringToFront();
  return { index, title: await session.page.title().catch(() => ""), url: session.page.url(), active: true };
}
export async function closeBrowserTab(index, approved) {
  if (approved !== true) throw Object.assign(new Error("Explicit approval is required to close a browser tab."), { statusCode: 403 });
  const session = await getSession(getCurrentBrowserSessionId()); const pages = session.context.pages();
  if (!Number.isInteger(index) || index < 0 || index >= pages.length) throw Object.assign(new Error("Browser tab index is out of range."), { statusCode: 404 });
  if (pages.length <= 1) throw Object.assign(new Error("The last tab cannot be closed. Open another tab first."), { statusCode: 409 });
  const closing = pages[index], wasActive = closing === session.page; await closing.close();
  const remaining = session.context.pages();
  if (wasActive || !session.page || session.page.isClosed()) { session.page = remaining[Math.min(index, remaining.length - 1)]; await session.page.bringToFront(); }
  return { index, closed: true, activeUrl: session.page.url() };
}

export function getBrowserStatus() {
  const id = getCurrentBrowserSessionId();
  const session = sessions.get(id);
  return {
    connected: Boolean(browser && browser.isConnected()),
    remote: Boolean(process.env.BROWSER_WS_ENDPOINT),
    sessionId: id,
    url: session?.page && !session.page.isClosed() ? session.page.url() : null,
    sessionCount: sessions.size,
    maxSessions: MAX_SESSIONS
  };
}
export async function closeBrowser() {
  await Promise.all([...sessions.values()].map(session => session.context.close().catch(() => {})));
  sessions.clear();
  if (browser && !process.env.BROWSER_WS_ENDPOINT) await browser.close();
  browser = undefined;
}
