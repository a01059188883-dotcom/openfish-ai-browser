import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { validateHttpUrl } from "./safety.js";

const STORE = resolve(process.env.OPENFISH_DATA_DIR || ".openfish", "browser-library.json");
const MAX_HISTORY = 3000;
let state;
let writeQueue = Promise.resolve();
function emptyState() { return { schemaVersion: 1, bookmarks: [], history: [], readingList: [], tabOrganization: [] }; }
async function load() {
  if (state) return state;
  try { const parsed = JSON.parse(await readFile(STORE, "utf8")); state = { ...emptyState(), ...(parsed && typeof parsed === "object" ? parsed : {}) }; for (const key of ["bookmarks", "history", "readingList", "tabOrganization"]) if (!Array.isArray(state[key])) state[key] = []; }
  catch (error) { if (error.code !== "ENOENT") throw error; state = emptyState(); }
  return state;
}
async function persist() {
  const snapshot = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(async () => { await mkdir(dirname(STORE), { recursive: true, mode: 0o700 }); const temp = STORE + "." + process.pid + ".tmp"; await writeFile(temp, snapshot, { mode: 0o600 }); await rename(temp, STORE); });
  return writeQueue;
}
function cleanText(value, fallback = "", max = 180) { return String(value ?? fallback).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max); }
function normalizeUrl(value) { const url = validateHttpUrl(value); url.hash = ""; return url.href; }
export async function addBookmark({ url, title }) {
  const data = await load(); const normalized = normalizeUrl(url); const existing = data.bookmarks.find(item => item.url === normalized);
  if (existing) { existing.title = cleanText(title, existing.title) || existing.title; existing.updatedAt = new Date().toISOString(); await persist(); return { item: { ...existing }, created: false }; }
  const now = new Date().toISOString(); const item = { id: randomUUID(), url: normalized, title: cleanText(title, normalized), createdAt: now, updatedAt: now }; data.bookmarks.unshift(item); await persist(); return { item: { ...item }, created: true };
}
export async function listBookmarks(query = "") { const q = cleanText(query, "", 200).toLowerCase(); return (await load()).bookmarks.filter(item => !q || (item.title + " " + item.url).toLowerCase().includes(q)).map(item => ({ ...item })); }
export async function removeBookmark(id, approved) { if (approved !== true) throw Object.assign(new Error("Explicit approval is required to remove a bookmark."), { statusCode: 403 }); const data = await load(); const index = data.bookmarks.findIndex(item => item.id === id); if (index < 0) throw Object.assign(new Error("Bookmark not found."), { statusCode: 404 }); const [item] = data.bookmarks.splice(index, 1); await persist(); return { removed: true, id: item.id }; }
export async function recordVisit({ url, title }) {
  let normalized; try { normalized = normalizeUrl(url); } catch { return null; }
  const data = await load(); const now = new Date().toISOString(); const last = data.history[0];
  if (last && last.url === normalized && Date.now() - Date.parse(last.visitedAt) < 30000) { last.title = cleanText(title, last.title) || last.title; last.visitedAt = now; }
  else data.history.unshift({ id: randomUUID(), url: normalized, title: cleanText(title, normalized), visitedAt: now });
  data.history.length = Math.min(data.history.length, MAX_HISTORY); await persist(); return { ...data.history[0] };
}
export async function listHistory({ query = "", limit = 100 } = {}) { const q = cleanText(query, "", 200).toLowerCase(); const cap = Math.max(1, Math.min(500, Number.isInteger(Number(limit)) ? Number(limit) : 100)); return (await load()).history.filter(item => !q || (item.title + " " + item.url).toLowerCase().includes(q)).slice(0, cap).map(item => ({ ...item })); }
export async function clearHistory(approved) { if (approved !== true) throw Object.assign(new Error("Explicit approval is required to clear browsing history."), { statusCode: 403 }); const data = await load(); const removed = data.history.length; data.history = []; await persist(); return { cleared: true, removed }; }
export async function addReadingItem({ url, title, note = "" }) {
  const data = await load(); const normalized = normalizeUrl(url); const existing = data.readingList.find(item => item.url === normalized);
  if (existing) { existing.title = cleanText(title, existing.title) || existing.title; existing.note = cleanText(note, existing.note, 500); existing.updatedAt = new Date().toISOString(); await persist(); return { item: { ...existing }, created: false }; }
  const now = new Date().toISOString(); const item = { id: randomUUID(), url: normalized, title: cleanText(title, normalized), note: cleanText(note, "", 500), createdAt: now, updatedAt: now, readAt: null }; data.readingList.unshift(item); await persist(); return { item: { ...item }, created: true };
}
export async function listReadingItems(query = "") { const q = cleanText(query, "", 200).toLowerCase(); return (await load()).readingList.filter(item => !q || (item.title + " " + item.url + " " + item.note).toLowerCase().includes(q)).map(item => ({ ...item })); }
export async function removeReadingItem(id, approved) { if (approved !== true) throw Object.assign(new Error("Explicit approval is required to remove a reading-list item."), { statusCode: 403 }); const data = await load(); const index = data.readingList.findIndex(item => item.id === id); if (index < 0) throw Object.assign(new Error("Reading-list item not found."), { statusCode: 404 }); data.readingList.splice(index, 1); await persist(); return { removed: true, id }; }
export async function setTabOrganization({ url, groupName, pinned }, approved) {
  if (approved !== true) throw Object.assign(new Error("Explicit approval is required to change tab organization."), { statusCode: 403 });
  const normalized = normalizeUrl(url); const data = await load(); let item = data.tabOrganization.find(entry => entry.url === normalized);
  if (!item) { item = { url: normalized, groupName: "", pinned: false, updatedAt: new Date().toISOString() }; data.tabOrganization.push(item); }
  if (groupName !== undefined) item.groupName = cleanText(groupName, "", 40); if (pinned !== undefined) item.pinned = Boolean(pinned); item.updatedAt = new Date().toISOString(); await persist(); return { ...item };
}
export async function getTabOrganization(url) { try { const normalized = normalizeUrl(url); const item = (await load()).tabOrganization.find(entry => entry.url === normalized); return item ? { ...item } : { groupName: "", pinned: false }; } catch { return { groupName: "", pinned: false }; } }
export async function getLibraryStats() { const data = await load(); return { bookmarks: data.bookmarks.length, history: data.history.length, readingList: data.readingList.length }; }
