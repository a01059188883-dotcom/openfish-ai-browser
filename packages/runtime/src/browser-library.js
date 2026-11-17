import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { validateHttpUrl } from "./safety.js";

const STORE = resolve(process.env.OPENFISH_DATA_DIR || ".openfish", "browser-library.json");
const MAX_HISTORY = 3000;
let state;
let writeQueue = Promise.resolve();
function emptyState() { return { schemaVersion: 1, bookmarks: [], history: [], readingList: [], tabOrganization: [], workspaces: [] }; }
async function load() {
  if (state) return state;
  try { const parsed = JSON.parse(await readFile(STORE, "utf8")); state = { ...emptyState(), ...(parsed && typeof parsed === "object" ? parsed : {}) }; for (const key of ["bookmarks", "history", "readingList", "tabOrganization", "workspaces"]) if (!Array.isArray(state[key])) state[key] = []; }
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

export async function saveWorkspace({ name, tabs }) {
  const cleanName = cleanText(name, "", 60);
  if (!cleanName) throw Object.assign(new Error("Workspace name is required."), { statusCode: 400 });
  if (!Array.isArray(tabs) || !tabs.length || tabs.length > 30) throw Object.assign(new Error("A workspace must contain between 1 and 30 tabs."), { statusCode: 400 });
  const normalizedTabs = [];
  for (const tab of tabs) {
    const url = normalizeUrl(tab.url);
    if (!normalizedTabs.some(item => item.url === url)) normalizedTabs.push({ url, title: cleanText(tab.title, url, 180) });
  }
  if (!normalizedTabs.length) throw Object.assign(new Error("No valid public tabs were found to save."), { statusCode: 400 });
  const data = await load();
  const now = new Date().toISOString();
  const workspace = { id: randomUUID(), name: cleanName, tabs: normalizedTabs, createdAt: now, updatedAt: now };
  data.workspaces.unshift(workspace);
  await persist();
  return { ...workspace, tabs: workspace.tabs.map(tab => ({ ...tab })) };
}
export async function listWorkspaces() {
  return (await load()).workspaces.map(item => ({ ...item, tabs: item.tabs.map(tab => ({ ...tab })) }));
}
export async function getWorkspace(id) {
  const item = (await load()).workspaces.find(workspace => workspace.id === id);
  if (!item) throw Object.assign(new Error("Workspace not found."), { statusCode: 404 });
  return { ...item, tabs: item.tabs.map(tab => ({ ...tab })) };
}
export async function removeWorkspace(id, approved) {
  if (approved !== true) throw Object.assign(new Error("Explicit approval is required to delete a workspace."), { statusCode: 403 });
  const data = await load();
  const index = data.workspaces.findIndex(item => item.id === id);
  if (index < 0) throw Object.assign(new Error("Workspace not found."), { statusCode: 404 });
  data.workspaces.splice(index, 1);
  await persist();
  return { removed: true, id };
}

export async function exportBrowserLibrary() {
  const data = await load();
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), data: JSON.parse(JSON.stringify(data)) };
}
export async function importBrowserLibrary(payload, approved) {
  if (approved !== true) throw Object.assign(new Error("Explicit approval is required to import browser data."), { statusCode: 403 });
  const serialized = JSON.stringify(payload ?? {});
  if (Buffer.byteLength(serialized, "utf8") > 1024 * 1024) throw Object.assign(new Error("Browser library backup exceeds the 1 MB import limit."), { statusCode: 413 });
  const source = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  if (!source || typeof source !== "object") throw Object.assign(new Error("Invalid browser library backup."), { statusCode: 400 });
  const data = await load();
  const safeItems = (items, max) => Array.isArray(items) ? items.slice(0, max) : [];
  const upsertByUrl = (target, item) => {
    const index = target.findIndex(existing => existing.url === item.url);
    if (index >= 0) target[index] = { ...target[index], ...item };
    else target.unshift(item);
  };
  let imported = { bookmarks: 0, history: 0, readingList: 0, tabOrganization: 0, workspaces: 0 };
  for (const raw of safeItems(source.bookmarks, 5000)) {
    try { const url = normalizeUrl(raw.url); upsertByUrl(data.bookmarks, { id: randomUUID(), url, title: cleanText(raw.title, url), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); imported.bookmarks++; } catch {}
  }
  const importedHistory = [];
  for (const raw of safeItems(source.history, MAX_HISTORY)) {
    try { const url = normalizeUrl(raw.url); importedHistory.push({ id: randomUUID(), url, title: cleanText(raw.title, url), visitedAt: Number.isFinite(Date.parse(raw.visitedAt)) ? new Date(raw.visitedAt).toISOString() : new Date().toISOString() }); } catch {}
  }
  data.history = [...data.history, ...importedHistory].sort((a,b) => Date.parse(b.visitedAt) - Date.parse(a.visitedAt)).slice(0, MAX_HISTORY);
  imported.history = importedHistory.length;
  for (const raw of safeItems(source.readingList, 5000)) {
    try { const url = normalizeUrl(raw.url); upsertByUrl(data.readingList, { id: randomUUID(), url, title: cleanText(raw.title, url), note: cleanText(raw.note, "", 500), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), readAt: null }); imported.readingList++; } catch {}
  }
  for (const raw of safeItems(source.tabOrganization, 1000)) {
    try { const url = normalizeUrl(raw.url); const existing = data.tabOrganization.find(item => item.url === url); const item = { url, groupName: cleanText(raw.groupName, "", 40), pinned: Boolean(raw.pinned), updatedAt: new Date().toISOString() }; if (existing) Object.assign(existing, item); else data.tabOrganization.push(item); imported.tabOrganization++; } catch {}
  }
  for (const raw of safeItems(source.workspaces, 100)) {
    try {
      const tabs = [];
      for (const tab of safeItems(raw.tabs, 30)) { try { const url = normalizeUrl(tab.url); if (!tabs.some(item => item.url === url)) tabs.push({ url, title: cleanText(tab.title, url) }); } catch {} }
      const name = cleanText(raw.name, "", 60);
      if (name && tabs.length) { data.workspaces.unshift({ id: randomUUID(), name, tabs, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); imported.workspaces++; }
    } catch {}
  }
  await persist();
  return { imported, totals: await getLibraryStats(), workspaces: (await listWorkspaces()).length };
}
