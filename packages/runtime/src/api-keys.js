import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const STORE = resolve(process.env.OPENFISH_DATA_DIR || ".openfish", "api-keys.json");
const SCOPES = new Set(["browser:read", "browser:write"]);
let cache;
let writeQueue = Promise.resolve();

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
async function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(await readFile(STORE, "utf8"));
    cache = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    cache = [];
  }
  return cache;
}
async function persist() {
  const snapshot = JSON.stringify(cache, null, 2);
  writeQueue = writeQueue.then(async () => {
    await mkdir(dirname(STORE), { recursive: true, mode: 0o700 });
    const temp = `${STORE}.${process.pid}.tmp`;
    await writeFile(temp, snapshot, { mode: 0o600 });
    await rename(temp, STORE);
  });
  return writeQueue;
}
function publicRecord(record) {
  return {
    id: record.id, name: record.name, prefix: record.prefix,
    scopes: record.scopes, createdAt: record.createdAt,
    expiresAt: record.expiresAt, lastUsedAt: record.lastUsedAt || null,
    revokedAt: record.revokedAt || null
  };
}
export async function listApiKeys() {
  return (await load()).map(publicRecord).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function createApiKey({ name, scopes, expiresInDays = 90 }) {
  const cleanName = String(name || "").trim().slice(0, 60);
  if (!cleanName) throw Object.assign(new Error("API key name is required."), { statusCode: 400 });
  if (!Array.isArray(scopes) || !scopes.length || scopes.some(scope => !SCOPES.has(scope))) {
    throw Object.assign(new Error("Select one or more supported scopes."), { statusCode: 400 });
  }
  const days = Number(expiresInDays);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw Object.assign(new Error("Expiry must be between 1 and 365 days."), { statusCode: 400 });
  }
  const raw = `ofb_live_${randomBytes(32).toString("base64url")}`;
  const now = new Date();
  const record = {
    id: randomBytes(12).toString("hex"), name: cleanName, prefix: raw.slice(0, 14),
    hash: digest(raw), scopes: [...new Set(scopes)],
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + days * 86400000).toISOString()
  };
  const records = await load();
  records.push(record);
  await persist();
  return { key: raw, record: publicRecord(record) };
}
export async function revokeApiKey(id) {
  const records = await load();
  const record = records.find(item => item.id === id);
  if (!record) throw Object.assign(new Error("API key not found."), { statusCode: 404 });
  if (!record.revokedAt) {
    record.revokedAt = new Date().toISOString();
    await persist();
  }
  return publicRecord(record);
}
export async function authenticateApiKey(raw, requiredScope) {
  if (typeof raw !== "string" || !raw.startsWith("ofb_live_") || raw.length > 128) return null;
  const candidate = Buffer.from(digest(raw), "hex");
  const records = await load();
  const record = records.find(item => {
    const expected = Buffer.from(item.hash, "hex");
    return expected.length === candidate.length && timingSafeEqual(expected, candidate);
  });
  if (!record || record.revokedAt || Date.parse(record.expiresAt) <= Date.now()) return null;
  if (!record.scopes.includes(requiredScope)) return { forbidden: true };
  record.lastUsedAt = new Date().toISOString();
  persist().catch(() => {});
  return { id: record.id, name: record.name, scopes: record.scopes };
}
