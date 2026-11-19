import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteCompletedDownload, validateDownloadStorage } from "../download-storage.js";

test("completed rejected downloads are removed through Playwright Download.delete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfish-download-delete-"));
  try {
    const path = join(directory, "large.bin");
    await writeFile(path, "large");
    let deleted = false;
    await deleteCompletedDownload({ delete: async () => { deleted = true; await rm(path); } }, path);
    assert.equal(deleted, true);
    await assert.rejects(readFile(path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("completed rejected downloads fall back to unlink when Download.delete fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfish-download-fallback-"));
  try {
    const path = join(directory, "large.bin");
    await writeFile(path, "large");
    await deleteCompletedDownload({ delete: async () => { throw new Error("delete unavailable"); } }, path);
    await assert.rejects(readFile(path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("download storage defaults safely for local development and rejects missing required mount", async () => {
  assert.deepEqual(await validateDownloadStorage(), { mode: "playwright-default" });
  await assert.rejects(validateDownloadStorage({ required: true }), /path is not configured/);
});

test("configured download directory is checked for write access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfish-download-storage-"));
  try {
    const result = await validateDownloadStorage({ directory });
    assert.equal(result.mode, "configured");
    assert.ok(result.capacityBytes > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
