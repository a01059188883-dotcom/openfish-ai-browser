import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "openfish-downloads-"));
process.env.OPENFISH_DATA_DIR = directory;
const manager = await import("../src/download-manager.js");
const source = join(directory, "source.txt");
await writeFile(source, "safe test download");

function fakePage(href = "https://example.com/file") {
  const download = {
    path: async () => source,
    suggestedFilename: () => "../report.txt",
    saveAs: async destination => copyFile(source, destination),
    cancel: async () => {}
  };
  return {
    waitForEvent: async name => { assert.equal(name, "download"); return download; },
    locator: selector => ({
      count: async () => selector === "a#file" ? 1 : 2,
      isVisible: async () => true,
      evaluate: async () => ({ tag: "a", href, text: "Download" }),
      click: async () => {}
    })
  };
}

test("downloads require approval, validate public links, sanitize names and can be deleted", async () => {
  try {
    await assert.rejects(() => manager.downloadLink(fakePage(), "a#file", false), error => error.statusCode === 403);
    await assert.rejects(() => manager.downloadLink(fakePage("http://127.0.0.1/file"), "a#file", true), error => error.statusCode === 403);
    await assert.rejects(() => manager.downloadLink(fakePage(), "a", true), error => error.statusCode === 400);
    const record = await manager.downloadLink(fakePage(), "a#file", true);
    assert.equal(record.filename, "report.txt");
    assert.equal(record.size, 18);
    assert.equal((await stat(record.path)).size, 18);
    assert.equal((await manager.listDownloads()).length, 1);
    await assert.rejects(() => manager.removeDownload(record.id, false), error => error.statusCode === 403);
    await manager.removeDownload(record.id, true);
    assert.equal((await manager.listDownloads()).length, 0);
    await assert.rejects(() => stat(record.path), error => error.code === "ENOENT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
