import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const STORE = resolve(process.env.OPENFISH_DATA_DIR || ".openfish", "clients.json");
const clients = new Map();
const rateWindows = new Map();
let loaded = false;
let writeQueue = Promise.resolve();
const MAX_CLIENTS = 200;
const CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ACTIVE_WINDOW_MS = 90 * 1000;

async function load() {
  if (loaded) return;
  loaded = true;
  try {
    const rows = JSON.parse(await readFile(STORE, "utf8"));
    if (Array.isArray(rows)) for (const row of rows.slice(-MAX_CLIENTS)) {
      if (row && typeof row.id === "string" && typeof row.clientId === "string") clients.set(row.id, row);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function persist() {
  const snapshot = JSON.stringify([...clients.values()].slice(-MAX_CLIENTS), null, 2);
  writeQueue = writeQueue.then(async () => {
    await mkdir(dirname(STORE), { recursive: true, mode: 0o700 });
    const temp = `${STORE}.${process.pid}.tmp`;
    await writeFile(temp, snapshot, { mode: 0o600 });
    await rename(temp, STORE);
  });
  return writeQueue;
}
function clean(value, fallback, max = 48) {
  return String(value || fallback).replace(/[^a-zA-Z0-9 _.-]/g, "").trim().slice(0, max) || fallback;
}
export async function registerClient(identity, metadata = {}) {
  await load();
  const keyId = clean(identity?.id, "unknown-key", 64);
  const clientId = clean(metadata.clientId, "default-client", 80);
  const id = `${keyId}:${clientId}`;
  const now = new Date().toISOString();
  const previous = clients.get(id) || {};
  const record = {
    id, keyId, keyName: clean(identity?.name, "API client", 60), clientId,
    platform: clean(metadata.platform, "unspecified", 40),
    sessionId: clean(metadata.sessionId, "default", 80),
    scopes: Array.isArray(identity?.scopes) ? identity.scopes : [],
    firstSeenAt: previous.firstSeenAt || now, lastSeenAt: now,
    requestCount: (previous.requestCount || 0) + 1
  };
  clients.delete(id);
  clients.set(id, record);
  const cutoff = Date.now() - CLIENT_TTL_MS;
  for (const [key, row] of clients) if (Date.parse(row.lastSeenAt) < cutoff) clients.delete(key);
  while (clients.size > MAX_CLIENTS) clients.delete(clients.keys().next().value);
  await persist();
  return publicClient(record);
}
function publicClient(row) {
  const active = Date.now() - Date.parse(row.lastSeenAt) <= ACTIVE_WINDOW_MS;
  return { ...row, status: active ? "connected" : "idle" };
}
export async function listClients() {
  await load();
  return [...clients.values()].map(publicClient).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}
export function checkClientRateLimit(keyId, limit = 120, windowMs = 60000) {
  const now = Date.now();
  let entry = rateWindows.get(keyId);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    rateWindows.set(keyId, entry);
  }
  entry.count += 1;
  const remaining = Math.max(0, limit - entry.count);
  return {
    allowed: entry.count <= limit,
    limit,
    remaining,
    resetAt: new Date(entry.resetAt).toISOString(),
    retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
  };
}
