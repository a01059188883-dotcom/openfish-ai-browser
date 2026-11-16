import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { validateHttpUrl } from "./safety.js";

const sessionContext = new AsyncLocalStorage();
const sessions = new Map();
const SESSION_TTL_MS = Math.max(60000, Number(process.env.OPENFISH_SESSION_TTL_MS || 30 * 60 * 1000));
const MAX_SESSIONS = Math.max(2, Math.min(50, Number(process.env.OPENFISH_MAX_SESSIONS || 20)));
const BROWSER_MODE = ["auto", "local", "remote"].includes(process.env.OPENFISH_BROWSER_MODE)
  ? process.env.OPENFISH_BROWSER_MODE : "auto";
let browser;
let browserConnectPromise;
let activeBrowserMode = "disconnected";
let remoteFallbackReason = null;

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
async function connectBrowser() {
  const endpoint = process.env.BROWSER_WS_ENDPOINT;
  if (BROWSER_MODE === "remote" && !endpoint) {
    throw new Error("OPENFISH_BROWSER_MODE=remote requires BROWSER_WS_ENDPOINT.");
  }
  if (BROWSER_MODE !== "local" && endpoint) {
    try {
      const remote = await chromium.connectOverCDP(endpoint, { timeout: 12000 });
      activeBrowserMode = "remote";
      remoteFallbackReason = null;
      return remote;
    } catch (error) {
      remoteFallbackReason = String(error?.message || error).slice(0, 300);
      if (BROWSER_MODE === "remote") throw new Error(`Remote browser unavailable: ${remoteFallbackReason}`);
      process.stderr.write(`OpenFish: remote browser unavailable; falling back to local Chromium: ${remoteFallbackReason}\n`);
    }
  }
  const local = await chromium.launch({ headless: process.env.HEADLESS !== "false" });
  activeBrowserMode = endpoint && BROWSER_MODE === "auto" ? "local-fallback" : "local";
  return local;
}
async function getBrowser() {
  if (browser?.isConnected()) return browser;
  if (!browserConnectPromise) {
    browserConnectPromise = connectBrowser().then(instance => {
      browser = instance;
      return instance;
    }).finally(() => { browserConnectPromise = null; });
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
export function getBrowserStatus() {
  const id = getCurrentBrowserSessionId();
  const session = sessions.get(id);
  return {
    connected: Boolean(browser && browser.isConnected()),
    remote: activeBrowserMode === "remote",
    mode: activeBrowserMode,
    configuredMode: BROWSER_MODE,
    fallbackReason: remoteFallbackReason,
    sessionId: id,
    url: session?.page && !session.page.isClosed() ? session.page.url() : null,
    sessionCount: sessions.size
  };
}
export async function closeBrowser() {
  await Promise.all([...sessions.values()].map(session => session.context.close().catch(() => {})));
  sessions.clear();
  if (browser && activeBrowserMode !== "remote") await browser.close();
  browser = undefined;
  activeBrowserMode = "disconnected";
}
