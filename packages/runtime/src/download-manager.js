import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { validateHttpUrl } from "./safety.js";

const DATA_DIR = resolve(process.env.OPENFISH_DATA_DIR || ".openfish");
const DOWNLOAD_DIR = resolve(DATA_DIR, "downloads");
const STORE = resolve(DATA_DIR, "downloads.json");
const MAX_FILE_BYTES = Math.max(1024 * 1024, Math.min(100 * 1024 * 1024, Number(process.env.OPENFISH_MAX_DOWNLOAD_BYTES || 25 * 1024 * 1024)));
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
let records;
let writeQueue = Promise.resolve();

async function load() {
  if (records) return records;
  try {
    const parsed = JSON.parse(await readFile(STORE, "utf8"));
    records = Array.isArray(parsed) ? parsed.filter(item => item && typeof item.id === "string" && typeof item.path === "string") : [];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    records = [];
  }
  return records;
}
async function persist() {
  const snapshot = JSON.stringify(records, null, 2);
  writeQueue = writeQueue.then(async () => {
    await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    const temp = STORE + "." + process.pid + ".tmp";
    await writeFile(temp, snapshot, { mode: 0o600 });
    await rename(temp, STORE);
  });
  return writeQueue;
}
function publicRecord(item) {
  return { id: item.id, filename: item.filename, url: item.url, size: item.size, createdAt: item.createdAt, path: item.path };
}
function safeFilename(value) {
  const name = basename(String(value || "download")).replace(/[\\u0000-\\u001f\\u007f]/g, "").replace(/[\\\\/:*?"<>|]/g, "_").replace(/^\\.+/, "").trim().slice(0, 120);
  return name || "download";
}
function insideDownloadDirectory(path) {
  const resolved = resolve(path);
  return resolved.startsWith(DOWNLOAD_DIR + sep);
}
export async function downloadLink(page, selector, approved) {
  if (approved !== true) throw Object.assign(new Error("Explicit approval is required to download a file."), { statusCode: 403 });
  if (typeof selector !== "string" || !selector.trim() || selector.length > 500) throw Object.assign(new Error("A valid link selector is required."), { statusCode: 400 });
  const locator = page.locator(selector);
  const count = await locator.count();
  if (count !== 1 || !(await locator.isVisible())) throw Object.assign(new Error("Download selector must identify exactly one visible link."), { statusCode: 400 });
  const details = await locator.evaluate(el => ({ tag: el.tagName.toLowerCase(), href: el.href || "", text: (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 160) }));
  if (details.tag !== "a" || !details.href) throw Object.assign(new Error("The selected element is not a link with a destination."), { statusCode: 400 });
  const url = validateHttpUrl(details.href).href;
  const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
  let download;
  try {
    await locator.click();
    download = await downloadPromise;
  } catch (error) {
    downloadPromise.catch(() => {});
    throw Object.assign(new Error("The selected link did not start a browser download: " + error.message), { statusCode: 502 });
  }
  const tempPath = await download.path();
  if (!tempPath) throw Object.assign(new Error("The browser did not provide a completed download file."), { statusCode: 502 });
  const info = await stat(tempPath);
  if (info.size > MAX_FILE_BYTES) {
    await download.cancel().catch(() => {});
    throw Object.assign(new Error("Download exceeds the configured per-file size limit."), { statusCode: 413 });
  }
  const data = await load();
  const usedBytes = data.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
  if (usedBytes + info.size > MAX_TOTAL_BYTES) {
    await download.cancel().catch(() => {});
    throw Object.assign(new Error("Local download storage is full (500 MB limit). Remove older downloads first."), { statusCode: 507 });
  }
  await mkdir(DOWNLOAD_DIR, { recursive: true, mode: 0o700 });
  const filename = safeFilename(download.suggestedFilename());
  const id = randomUUID();
  const path = join(DOWNLOAD_DIR, Date.now() + "-" + id.slice(0, 8) + "-" + filename);
  if (!insideDownloadDirectory(path)) throw Object.assign(new Error("Unsafe download destination."), { statusCode: 403 });
  await download.saveAs(path);
  const record = { id, filename, url, size: info.size, path, createdAt: new Date().toISOString() };
  data.unshift(record);
  await persist();
  return publicRecord(record);
}
export async function listDownloads() {
  return (await load()).map(publicRecord);
}
export async function removeDownload(id, approved) {
  if (approved !== true) throw Object.assign(new Error("Explicit approval is required to delete a downloaded file."), { statusCode: 403 });
  const data = await load();
  const index = data.findIndex(item => item.id === id);
  if (index < 0) throw Object.assign(new Error("Download record not found."), { statusCode: 404 });
  const [item] = data.splice(index, 1);
  if (!insideDownloadDirectory(item.path)) throw Object.assign(new Error("Download record points outside the managed download directory."), { statusCode: 403 });
  await unlink(item.path).catch(error => { if (error.code !== "ENOENT") throw error; });
  await persist();
  return { removed: true, id, filename: item.filename };
}
