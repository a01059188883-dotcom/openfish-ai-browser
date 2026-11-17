import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "openfish-library-"));
process.env.OPENFISH_DATA_DIR = directory;
const library = await import("../src/browser-library.js");

test("bookmarks and reading list persist locally and reject unsafe URLs", async () => {
  try {
    const saved = await library.addBookmark({ url: "https://example.com/path#top", title: "Example" });
    assert.equal(saved.created, true);
    assert.equal(saved.item.url, "https://example.com/path");
    assert.equal((await library.addBookmark({ url: "https://example.com/path", title: "Updated" })).created, false);
    assert.equal((await library.listBookmarks("updated")).length, 1);
    await assert.rejects(() => library.addBookmark({ url: "http://127.0.0.1" }));
    const readLater = await library.addReadingItem({ url: "https://example.org", title: "Read later" });
    assert.equal((await library.listReadingItems()).length, 1);
    await assert.rejects(() => library.removeReadingItem(readLater.item.id, false), error => error.statusCode === 403);
    await library.removeReadingItem(readLater.item.id, true);
    const stored = JSON.parse(await readFile(join(directory, "browser-library.json"), "utf8"));
    assert.equal(stored.bookmarks.length, 1);
    assert.equal(stored.readingList.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("history deduplicates quick reloads and clear requires approval", async () => {
  try {
    await library.recordVisit({ url: "https://example.com", title: "First" });
    await library.recordVisit({ url: "https://example.com", title: "Updated title" });
    await library.recordVisit({ url: "https://example.net", title: "Second" });
    assert.equal((await library.listHistory()).length, 2);
    assert.equal((await library.listHistory({ query: "updated" })).length, 1);
    await assert.rejects(() => library.clearHistory(false), error => error.statusCode === 403);
    const result = await library.clearHistory(true);
    assert.equal(result.removed, 2);
    assert.equal((await library.listHistory()).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tab grouping and pin metadata require explicit approval", async () => {
  try {
    await assert.rejects(() => library.setTabOrganization({ url: "https://example.com", groupName: "Work" }, false), error => error.statusCode === 403);
    const item = await library.setTabOrganization({ url: "https://example.com", groupName: "Work", pinned: true }, true);
    assert.equal(item.groupName, "Work");
    assert.equal(item.pinned, true);
    assert.deepEqual(await library.getTabOrganization("https://example.com"), { ...item });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
