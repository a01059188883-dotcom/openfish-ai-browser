import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const STORE = resolve(process.env.OPENFISH_DATA_DIR || ".openfish", "tasks.json");
const requestedMaxTasks = Number(process.env.OPENFISH_MAX_TASKS || 500);
const MAX_TASKS = Number.isFinite(requestedMaxTasks) ? Math.max(50, Math.min(2000, Math.floor(requestedMaxTasks))) : 500;
const MAX_FIELD = 6000;
let records;
let loading;
let writeQueue = Promise.resolve();

function scrub(value, depth = 0) {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") {
    return value
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\s*[:=]\s*)["']?[^\s,"'}]+/gi, "$1[REDACTED]")
      .replace(/ofb_live_[A-Za-z0-9_-]{12,}/g, "[REDACTED_API_KEY]")
      .slice(0, MAX_FIELD);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map(item => scrub(item, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (/^(authorization|cookie|set-cookie|.*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret).*)$/i.test(key)) out[key] = "[REDACTED]";
      else out[key] = scrub(item, depth + 1);
    }
    return out;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return undefined;
}
async function load() {
  if (records) return records;
  if (loading) return loading;
  loading = (async () => {
    try {
      const parsed = JSON.parse(await readFile(STORE, "utf8"));
      return Array.isArray(parsed) ? parsed.filter(row => row && typeof row.id === "string").slice(-MAX_TASKS) : [];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return [];
    }
  })();
  try {
    records = await loading;
    let recovered = false;
    for (const task of records) {
      if (task.status === "running") {
        const now = new Date().toISOString();
        task.status = "failed";
        task.error = "Task interrupted by service restart.";
        task.updatedAt = now;
        task.finishedAt = now;
        task.events = [...(task.events || []), { at: now, status: "failed", message: "Recovered as failed after service restart" }].slice(-30);
        recovered = true;
      }
    }
    if (recovered) await persist();
    return records;
  } finally { loading = null; }
}
async function persist() {
  const snapshot = JSON.stringify(records.slice(-MAX_TASKS), null, 2);
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    await mkdir(dirname(STORE), { recursive: true, mode: 0o700 });
    const temp = `${STORE}.${process.pid}.tmp`;
    await writeFile(temp, snapshot, { mode: 0o600 });
    await rename(temp, STORE);
  });
  return writeQueue;
}
function publicTask(task, includeDetails = false) {
  const { plan, result, error, ...summary } = task;
  return includeDetails ? { ...summary, plan, result, error } : { ...summary, hasPlan: Boolean(plan) };
}
export async function createTask({ goal, plan = null, source = "admin", page = null, status = "planned" }) {
  const cleanGoal = String(goal || "").trim();
  if (!cleanGoal || cleanGoal.length > 2000) throw Object.assign(new Error("Task goal must contain 1–2,000 characters."), { statusCode: 400 });
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(), goal: scrub(cleanGoal), plan: scrub(plan), page: scrub(page),
    source: String(source).slice(0, 40), status, createdAt: now, updatedAt: now,
    approvedAt: null, startedAt: null, finishedAt: null, result: null, error: null,
    restoredFrom: null, events: [{ at: now, status, message: "Task created" }]
  };
  const rows = await load();
  rows.push(task);
  while (rows.length > MAX_TASKS) rows.shift();
  await persist();
  return publicTask(task, true);
}
export async function updateTask(id, patch = {}) {
  const rows = await load();
  const task = rows.find(row => row.id === id);
  if (!task) throw Object.assign(new Error("Task not found."), { statusCode: 404 });
  const now = new Date().toISOString();
  if (patch.status && ["planned", "approved", "running", "succeeded", "failed", "stopped"].includes(patch.status)) task.status = patch.status;
  if (Object.hasOwn(patch, "plan")) task.plan = scrub(patch.plan);
  if (Object.hasOwn(patch, "result")) task.result = scrub(patch.result);
  if (Object.hasOwn(patch, "error")) task.error = scrub(String(patch.error || "").slice(0, 2000));
  if (patch.status === "approved") task.approvedAt = now;
  if (patch.status === "running") task.startedAt = now;
  if (["succeeded", "failed", "stopped"].includes(patch.status)) task.finishedAt = now;
  task.updatedAt = now;
  task.events = [...(task.events || []), { at: now, status: task.status, message: scrub(String(patch.message || patch.status || "Task updated").slice(0, 240)) }].slice(-30);
  await persist();
  return publicTask(task, true);
}
export async function getTask(id) {
  const task = (await load()).find(row => row.id === id);
  if (!task) throw Object.assign(new Error("Task not found."), { statusCode: 404 });
  return publicTask(task, true);
}
export async function listTasks({ query = "", status = "", limit = 100 } = {}) {
  const q = String(query || "").trim().toLocaleLowerCase().slice(0, 200);
  const state = String(status || "").trim();
  const count = Math.max(1, Math.min(200, Number(limit) || 100));
  return (await load()).filter(task => (!state || task.status === state) && (!q || [task.goal, task.id, task.source, task.status].join(" ").toLocaleLowerCase().includes(q)))
    .slice(-count).reverse().map(task => publicTask(task));
}
export async function restoreTask(id) {
  const original = await getTask(id);
  if (!original.plan || !Array.isArray(original.plan.steps)) throw Object.assign(new Error("This task has no saved plan to restore."), { statusCode: 409 });
  const restored = await createTask({ goal: original.goal, plan: original.plan, source: "restore", page: original.page, status: "planned" });
  const rows = await load();
  const task = rows.find(row => row.id === restored.id);
  task.restoredFrom = original.id;
  task.events.push({ at: new Date().toISOString(), status: "planned", message: `Restored from task ${original.id}; fresh approval required` });
  await persist();
  return publicTask(task, true);
}
