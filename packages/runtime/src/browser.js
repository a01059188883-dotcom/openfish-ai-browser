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
  const id = randomUUID();
  const session = { id, name: String(name || "New session").trim().slice(0, 60) || "New session", context: await createContext(), page: null, createdAt: new Date().toISOString(), lastUsedAt: null, expiresAt: null };
  sessions.set(id, session);
  touch(session);
  return publicSession(session);
}
export function hasBrowserSession(id) {\n  listBrowserSessions();\n  return sessions.has(id);\n}\nexport function listBrowserSessions() {
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
export function getBrowserStatus() {
  const id = getCurrentBrowserSessionId();
  const session = sessions.get(id);
  return {
    connected: Boolean(browser && browser.isConnected()),
    remote: Boolean(process.env.BROWSER_WS_ENDPOINT),
    sessionId: id,
    url: session?.page && !session.page.isClosed() ? session.page.url() : null,
    sessionCount: sessions.size
  };
}
export async function closeBrowser() {
  await Promise.all([...sessions.values()].map(session => session.context.close().catch(() => {})));
  sessions.clear();
  if (browser && !process.env.BROWSER_WS_ENDPOINT) await browser.close();
  browser = undefined;
}
