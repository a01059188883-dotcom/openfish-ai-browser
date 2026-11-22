import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../../../public/index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../../../public/app.js", import.meta.url), "utf8");
const css = await readFile(new URL("../../../public/app.css", import.meta.url), "utf8");

test("mobile browser workspace exposes the core navigation and library controls", () => {
  for (const id of ["url", "searchEngine", "back", "forward", "reload", "reader", "screenshot", "bookmark", "copyText", "bookmarks", "history", "clearHistory", "tabs", "addTab", "readLater", "readingList", "readingSearch", "exportData", "importData", "importDataFile"]) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
});

test("mobile browser workspace preserves legacy bookmarks and stores local history", () => {
  assert.match(app, /BOOKMARK_KEY="openfish\.bookmarks"/);
  assert.match(app, /HISTORY_KEY="openfish\.history\.v1"/);
  assert.match(app, /recordHistory\(/);
  assert.match(app, /searchEngineSetting/);
  assert.match(app, /READING_KEY="openfish\.readingList\.v1"/);
  assert.match(app, /renderReading/);
  assert.match(app, /openfish-browser-backup\.json/);
  assert.match(app, /file\.size>1024\*1024/);
  assert.match(app, /function renderTabs/);
  assert.match(app, /act\("newTab"\)/);
  assert.match(app, /act\("switchTab"/);
  assert.match(app, /act\("closeTab"/);
});

test("mobile browser workspace has responsive library and reader layouts", () => {
  assert.match(css, /library-grid/);
  assert.match(css, /reader-content/);
  assert.match(html, /id="downloads"/);
  assert.match(html, /id="refreshDownloads"/);
  assert.match(app, /async function downloadLink/);
  assert.match(app, /async function loadDownloads/);
  assert.match(app, /link-download/);
  assert.match(css, /@media\(max-width:640px\)/);
  assert.match(html, /v2\.23\.0/);
  assert.doesNotMatch(html, /Workers Free 每天最多 10 分钟/);
});
