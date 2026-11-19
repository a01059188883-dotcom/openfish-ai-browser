import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../../../public/index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../../../public/app.js", import.meta.url), "utf8");
const css = await readFile(new URL("../../../public/app.css", import.meta.url), "utf8");

test("mobile browser workspace exposes the core navigation and library controls", () => {
  for (const id of ["url", "searchEngine", "back", "forward", "reload", "reader", "screenshot", "bookmark", "copyText", "bookmarks", "history", "clearHistory", "tabs", "addTab"]) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
});

test("mobile browser workspace preserves legacy bookmarks and stores local history", () => {
  assert.match(app, /BOOKMARK_KEY="openfish\.bookmarks"/);
  assert.match(app, /HISTORY_KEY="openfish\.history\.v1"/);
  assert.match(app, /recordHistory\(/);
  assert.match(app, /searchEngineSetting/);
  assert.match(app, /function renderTabs/);
  assert.match(app, /act\("newTab"\)/);
  assert.match(app, /act\("switchTab"/);
  assert.match(app, /act\("closeTab"/);
});

test("mobile browser workspace has responsive library and reader layouts", () => {
  assert.match(css, /library-grid/);
  assert.match(css, /reader-content/);
  assert.match(css, /@media\(max-width:640px\)/);
  assert.match(html, /v2\.12\.0/);
  assert.doesNotMatch(html, /Workers Free 每天最多 10 分钟/);
});
