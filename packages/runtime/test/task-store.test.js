import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("task history persists across module reloads, supports search and requires fresh approval on restore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openfish-task-store-"));
  const previousDir = process.env.OPENFISH_DATA_DIR;
  process.env.OPENFISH_DATA_DIR = dir;
  try {
    const store = await import("../src/task-store.js?first");
    const created = await store.createTask({
      goal: "Inspect the current public page",
      plan: { summary: "Inspect", steps: [{ action: "inspect", reason: "Read page" }] },
      source: "test"
    });
    await store.updateTask(created.id, { status: "approved", message: "User approved" });
    await store.updateTask(created.id, { status: "running" });
    await store.updateTask(created.id, { status: "succeeded", result: { status: "completed" } });
    const reloaded = await import("../src/task-store.js?second");
    const restored = await reloaded.getTask(created.id);
    assert.equal(restored.status, "succeeded");
    assert.equal(restored.result.status, "completed");
    assert.equal((await reloaded.listTasks({ query: "public page" })).length, 1);
    const copy = await reloaded.restoreTask(created.id);
    assert.equal(copy.status, "planned");
    assert.equal(copy.restoredFrom, created.id);
    assert.equal(copy.approvedAt, null);
    assert.equal(copy.plan.steps.length, 1);
  } finally {
    if (previousDir === undefined) delete process.env.OPENFISH_DATA_DIR;
    else process.env.OPENFISH_DATA_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  }
});

test("task history redacts credentials and caps record count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openfish-task-cap-"));
  const previousDir = process.env.OPENFISH_DATA_DIR;
  const previousMax = process.env.OPENFISH_MAX_TASKS;
  process.env.OPENFISH_DATA_DIR = dir;
  process.env.OPENFISH_MAX_TASKS = "50";
  try {
    const store = await import("../src/task-store.js?cap");
    const first = await store.createTask({ goal: "token=super-secret Bearer abcdefghijklmnop ofb_live_12345678901234567890" });
    assert.match(first.goal, /REDACTED/);
    assert.doesNotMatch(first.goal, /super-secret|abcdefghijklmnop|ofb_live_/);
    for (let i = 0; i < 54; i++) await store.createTask({ goal: "Task " + i });
    const rows = await store.listTasks({ limit: 200 });
    assert.equal(rows.length, 50);
    assert.ok(!rows.some(row => row.id === first.id));
  } finally {
    if (previousDir === undefined) delete process.env.OPENFISH_DATA_DIR;
    else process.env.OPENFISH_DATA_DIR = previousDir;
    if (previousMax === undefined) delete process.env.OPENFISH_MAX_TASKS;
    else process.env.OPENFISH_MAX_TASKS = previousMax;
    await rm(dir, { recursive: true, force: true });
  }
});
