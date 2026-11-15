import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
test("dashboard control IDs are unique and JavaScript parses",()=>{const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(ids.length,new Set(ids).size);const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];assert.equal(script.length,1);assert.doesNotThrow(()=>new vm.Script(script[0][1]));});
