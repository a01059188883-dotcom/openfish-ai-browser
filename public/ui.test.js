import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("public browser loads the mobile-first workspace design", async () => {
  const html = await read("./index.html");
  const css = await read("./workspace.css");
  assert.match(html, /\/workspace\.css/);
  assert.match(html, /viewport-fit=cover/);
  assert.doesNotMatch(html, /maximum-scale=1/);
  assert.match(html, /v2\.14\.1/);
  assert.match(css, /@media\(max-width:700px\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /grid-template-columns:38px 38px 38px/);
});

test("admin and mobile admin load the v2.14.1 responsive visual system", async () => {
  const admin = await read("../packages/admin/style.css");
  const adminHtml = await read("../packages/admin/index.html");
  const mobile = await read("../cloudflare/mobile-admin.html");
  assert.match(admin, /@media\(max-width:620px\)/);
  assert.match(admin, /position:sticky/);
  assert.match(adminHtml, /v2\.14\.1/);
  assert.match(mobile, /OpenFish v2\.14\.1 mobile admin visual refinement/);
  assert.match(mobile, /env\(safe-area-inset-bottom\)/);
});

test("application package version is synchronized", async () => {
  const pkg = JSON.parse(await read("../package.json"));
  assert.equal(pkg.version, "2.14.1");
});

test("Cloud Run deployment refuses traffic shift without bounded tmpfs health", async () => {
  const workflow = await read("../.github/workflows/deploy-relay.yml");
  assert.match(workflow, /downloadStorage\?\.mode!==\"required-tmpfs\"/);
  assert.match(workflow, /downloadStorage\.capacityBytes>64\*1024\*1024/);
});
