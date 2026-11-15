import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { validatePublicUrl, validateSteps } from "../src/safety.js";
import { summarizeBrowserLimits, isBrowserRateLimited, retryAfterMs } from "../src/browser-status.js";

test("accepts public HTTPS URL", () => assert.equal(validatePublicUrl("https://example.com/path").hostname, "example.com"));
test("rejects non-http protocols and embedded credentials", () => { assert.throws(() => validatePublicUrl("file:///etc/passwd")); assert.throws(() => validatePublicUrl("https://user:pass@example.com")); });
test("rejects localhost and private IPv4", () => { for (const url of ["http://localhost","http://127.0.0.1","http://10.0.0.2","http://192.168.1.2","http://169.254.169.254","http://[::1]","http://[fe80::1]"]) assert.throws(() => validatePublicUrl(url),url); });
test("requires explicit approval for mutating actions", () => { assert.throws(() => validateSteps([{action:"click",selector:"button"}],false)); assert.doesNotThrow(() => validateSteps([{action:"click",selector:"button"}],true)); });
test("accepts non-mutating browser controls", () => { for (const action of ["back","forward","reload","elements","accessibility","screenshot"]) assert.doesNotThrow(() => validateSteps([{action}],false)); });
test("rejects sensitive fills and oversized plans", () => { assert.throws(() => validateSteps([{action:"fill",selector:"input[name=password]",value:"x"}],true)); assert.throws(() => validateSteps(Array(9).fill({action:"inspect"}),true)); });
test("summarizes Browser Run limits without exposing session identifiers", () => { const status=summarizeBrowserLimits({activeSessions:[{id:"secret-session-id"}],allowedBrowserAcquisitions:0,maxConcurrentSessions:2,timeUntilNextAllowedBrowserAcquisition:4200}); assert.deepEqual(status,{active_sessions:1,max_concurrent_sessions:2,allowed_browser_acquisitions:0,time_until_next_allowed_acquisition_ms:4200,capacity_available:false}); assert.equal(JSON.stringify(status).includes("secret-session-id"),false); });
test("identifies Browser Run rate-limit errors and retry timing", () => { assert.equal(isBrowserRateLimited(new Error("code: 429: Rate limit exceeded")),true); assert.equal(isBrowserRateLimited(new Error("Target closed")),false); assert.equal(retryAfterMs({timeUntilNextAllowedBrowserAcquisition:5000}),5000); assert.equal(retryAfterMs({timeUntilNextAllowedBrowserAcquisition:0}),0); assert.equal(retryAfterMs({}),null); });
test("dashboard contains the full control surface and its script parses", () => {
  const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
  const required=["refreshAll","open","resume","read","screenshot","limits","testConnection","safetyTest","navigate","back","forward","reload","inspect","elements","accessibility","capture","copyText","downloadResult","clearOutput","makePlan","runPlan","validatePlan","clearPlan","sessionId","copySession","refreshSession","clearSession","copyMcp","loadTools","refreshActivity","saveToken","forgetToken","testToken","healthCheck","quotaCheck","allTests"];
  for(const id of required) assert.match(html,new RegExp('id="'+id+'"'),"missing control "+id);
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(ids.length,new Set(ids).size,"duplicate element IDs");
  const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length,1);
  assert.doesNotThrow(()=>new vm.Script(scripts[0][1]),"dashboard JavaScript syntax error");
  assert.match(html,/@media\(max-width:900px\)/);
});
