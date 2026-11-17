import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { validateHttpUrl } from "./safety.js";
import { recordVisit, getTabOrganization } from "./browser-library.js";

const sessionContext = new AsyncLocalStorage();
const sessions = new Map();
const SESSION_TTL_MS = Math.max(60000, Number(process.env.OPENFISH_SESSION_TTL_MS || 30 * 60 * 1000));
const MAX_SESSIONS = Math.max(2, Math.min(50, Number(process.env.OPENFISH_MAX_SESSIONS || 20)));
let browser;
let browserConnectPromise;
let pendingSessionCreations = 0;
const trackedPages = new WeakSet();
const diagnosticsByPage = new WeakMap();
function safeDiagnosticUrl(value) { try { const url = new URL(value); return url.origin + url.pathname; } catch { return ""; } }
function recordDiagnostic(page, type, message, url = page.url()) { let rows = diagnosticsByPage.get(page); if (!rows) { rows = []; diagnosticsByPage.set(page, rows); } rows.unshift({ time: new Date().toISOString(), type, message: String(message || "").slice(0, 1000), url: safeDiagnosticUrl(url) }); rows.length = Math.min(rows.length, 100); }
function trackPage(page) { if (trackedPages.has(page)) return page; trackedPages.add(page); page.on("load", () => { const url = page.url(); page.title().then(title => recordVisit({ url, title })).catch(() => {}); }); page.on("console", message => { if (["error", "warning"].includes(message.type())) recordDiagnostic(page, "console-" + message.type(), message.text(), message.location().url || page.url()); }); page.on("pageerror", error => recordDiagnostic(page, "page-error", error.message)); page.on("requestfailed", request => recordDiagnostic(page, "request-failed", request.failure()?.errorText || "Request failed", request.url())); page.on("response", response => { if (response.status() >= 400) recordDiagnostic(page, "http-" + response.status(), response.statusText(), response.url()); }); return page; }
async function newTrackedPage(context) { return trackPage(await context.newPage()); }

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
    session = { id: sessionId, context: await createContext(), page: null, recentlyClosed: [], createdAt: new Date().toISOString(), lastUsedAt: null, expiresAt: null };
    sessions.set(sessionId, session);
  }
  touch(session);
  if (!session.page || session.page.isClosed()) {
    session.page = await newTrackedPage(session.context);
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
    const session = { id, name: String(name || "New session").trim().slice(0, 60) || "New session", context, page: null, recentlyClosed: [], createdAt: new Date().toISOString(), lastUsedAt: null, expiresAt: null };
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
  if (!pages.length) { session.page = await newTrackedPage(session.context); session.page.setDefaultTimeout(12000); }
  pages = session.context.pages();
  if (!session.page || session.page.isClosed()) session.page = pages[0];
  return Promise.all(pages.map(async (page, index) => { trackPage(page); const organization = await getTabOrganization(page.url()); return { index, title: await page.title().catch(() => ""), url: page.url(), active: page === session.page, groupName: organization.groupName, pinned: organization.pinned }; }));
}
export async function createBrowserTab(url) {
  const session = await getSession(getCurrentBrowserSessionId());
  const page = await newTrackedPage(session.context); page.setDefaultTimeout(12000);
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
  const closing = pages[index], wasActive = closing === session.page;\n  session.recentlyClosed ||= [];\n  session.recentlyClosed.unshift({ url: closing.url(), title: await closing.title().catch(() => ""), closedAt: new Date().toISOString() });\n  session.recentlyClosed.length = Math.min(session.recentlyClosed.length, 10);\n  await closing.close();
  const remaining = session.context.pages();
  if (wasActive || !session.page || session.page.isClosed()) { session.page = remaining[Math.min(index, remaining.length - 1)]; await session.page.bringToFront(); }
  return { index, closed: true, activeUrl: session.page.url() };
}


export async function getPageDiagnostics(limit = 100) {
  const page = await getPage();
  return (diagnosticsByPage.get(page) || []).slice(0, Math.max(1, Math.min(100, Number(limit) || 100)));
}
export async function clearPageDiagnostics() {
  const page = await getPage();
  const rows = diagnosticsByPage.get(page) || [];
  const cleared = rows.length;
  diagnosticsByPage.set(page, []);
  return { cleared };
}
export async function listRecentlyClosedTabs() {
  const session = await getSession(getCurrentBrowserSessionId());
  return (session.recentlyClosed || []).map(item => ({ ...item }));
}
export async function duplicateBrowserTab(index) {
  const session = await getSession(getCurrentBrowserSessionId());
  const pages = session.context.pages();
  if (!Number.isInteger(index) || index < 0 || index >= pages.length) throw Object.assign(new Error("Browser tab index is out of range."), { statusCode: 404 });
  const source = pages[index];
  const url = source.url();
  const page = await newTrackedPage(session.context);
  page.setDefaultTimeout(12000);
  if (url.startsWith("http://") || url.startsWith("https://")) await page.goto(validateHttpUrl(url).href, { waitUntil: "domcontentloaded" });
  session.page = page;
  return { index: session.context.pages().indexOf(page), title: await page.title().catch(() => ""), url: page.url(), active: true };
}
export async function reopenClosedBrowserTab(approved) {
  if (approved !== true) throw Object.assign(new Error("Explicit approval is required to reopen a closed tab."), { statusCode: 403 });
  const session = await getSession(getCurrentBrowserSessionId());
  const item = (session.recentlyClosed || []).shift();
  if (!item) throw Object.assign(new Error("There are no recently closed tabs to restore."), { statusCode: 404 });
  const page = await newTrackedPage(session.context);
  page.setDefaultTimeout(12000);
  try {
    await page.goto(validateHttpUrl(item.url).href, { waitUntil: "domcontentloaded" });
    session.page = page;
    return { restored: true, tab: { index: session.context.pages().indexOf(page), title: await page.title().catch(() => item.title), url: page.url(), active: true } };
  } catch (error) {
    session.recentlyClosed.unshift(item);
    await page.close().catch(() => {});
    throw error;
  }
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
