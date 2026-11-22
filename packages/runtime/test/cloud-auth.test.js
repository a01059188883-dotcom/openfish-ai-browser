import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import { handleAuthVaultRoute } from "../../../cloudflare/auth-vault.js";

function makeContext() {
  const values = new Map();
  return {
    values,
    storage: {
      async get(key) { return values.get(key); },
      async put(key, value) { values.set(key, value); },
      async delete(keyOrKeys) {
        if (Array.isArray(keyOrKeys)) { for (const key of keyOrKeys) values.delete(key); return; }
        return values.delete(keyOrKeys);
      },
      async list({ prefix = "" } = {}) {
        return new Map([...values.entries()].filter(([key]) => key.startsWith(prefix)));
      }
    }
  };
}
const env = {
  OPENFISH_BOOTSTRAP_SECRET: "bootstrap-secret-value-that-is-long-enough-123",
  OPENFISH_VAULT_KEY: "vault-encryption-key-value-that-is-long-enough-456"
};
const origin = "https://openfish.example";
function request(path, { method = "GET", body, cookie = "", originHeader = origin } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (originHeader) headers.set("origin", originHeader);
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

test("cloud admin bootstrap, secure login, encrypted vault, and logout", async () => {
  const ctx = makeContext();
  const bootstrap = await handleAuthVaultRoute(request("/auth/bootstrap", {
    method: "POST",
    body: { bootstrapSecret: env.OPENFISH_BOOTSTRAP_SECRET, username: "owner", password: "this-is-a-very-long-test-password" }
  }), ctx, env);
  assert.equal(bootstrap.status, 201);
  const user = ctx.values.get("auth:user");
  assert.ok(user.passwordHash);
  assert.notEqual(user.passwordHash, "this-is-a-very-long-test-password");
  assert.equal((await handleAuthVaultRoute(request("/auth/bootstrap", {
    method: "POST",
    body: { bootstrapSecret: env.OPENFISH_BOOTSTRAP_SECRET, username: "owner", password: "another-very-long-test-password" }
  }), ctx, env)).status, 409);

  const badLogin = await handleAuthVaultRoute(request("/auth/login", {
    method: "POST", body: { username: "owner", password: "wrong-password" }
  }), ctx, env);
  assert.equal(badLogin.status, 401);

  const login = await handleAuthVaultRoute(request("/auth/login", {
    method: "POST", body: { username: "owner", password: "this-is-a-very-long-test-password" }
  }), ctx, env);
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(";")[0];

  const secret = "relay-token-that-is-at-least-thirty-two-characters-long";
  const engineToken = "engine-token-that-is-at-least-thirty-two-characters-long";
  const save = await handleAuthVaultRoute(request("/auth/vault", {
    method: "PUT", cookie,
    body: { secrets: { OPENFISH_RELAY_TOKEN: secret, BROWSER_ENGINE_TOKEN: engineToken, BROWSER_ENGINE_URL: "https://engine.openfish.example" } }
  }), ctx, env);
  assert.equal(save.status, 200);
  const publicResult = await save.json();
  assert.equal(publicResult.secrets.OPENFISH_RELAY_TOKEN.configured, true);
  assert.equal(publicResult.secrets.OPENFISH_RELAY_TOKEN.masked.includes(secret), false);

  const serializedStorage = JSON.stringify([...ctx.values.entries()]);
  assert.equal(serializedStorage.includes(secret), false);
  assert.equal(serializedStorage.includes(engineToken), false);

  const credentials = await handleAuthVaultRoute(request("/auth/credentials", { method: "POST", cookie }), ctx, env);
  assert.equal(credentials.status, 200);
  const decrypted = await credentials.json();
  assert.equal(decrypted.secrets.OPENFISH_RELAY_TOKEN, secret);
  assert.equal(decrypted.secrets.BROWSER_ENGINE_TOKEN, engineToken);

  const me = await handleAuthVaultRoute(request("/auth/me", { cookie }), ctx, env);
  assert.equal((await me.json()).authenticated, true);
  const logout = await handleAuthVaultRoute(request("/auth/logout", { method: "POST", cookie }), ctx, env);
  assert.equal(logout.status, 200);
  const afterLogout = await handleAuthVaultRoute(request("/auth/me", { cookie }), ctx, env);
  assert.equal((await afterLogout.json()).authenticated, false);
});

test("cloud auth rejects cross-origin state changes and invalid vault settings", async () => {
  const ctx = makeContext();
  const csrf = await handleAuthVaultRoute(request("/auth/bootstrap", {
    method: "POST", originHeader: "https://attacker.example",
    body: { bootstrapSecret: env.OPENFISH_BOOTSTRAP_SECRET, username: "owner", password: "this-is-a-very-long-test-password" }
  }), ctx, env);
  assert.equal(csrf.status, 403);
  const shortPassword = await handleAuthVaultRoute(request("/auth/bootstrap", {
    method: "POST",
    body: { bootstrapSecret: env.OPENFISH_BOOTSTRAP_SECRET, username: "owner", password: "short" }
  }), ctx, env);
  assert.equal(shortPassword.status, 400);
});

test("cloud auth enforces login throttling and keeps raw vault credentials off public routes", async () => {
  const ctx = makeContext();
  for (let i = 0; i < 5; i++) {
    const failed = await handleAuthVaultRoute(request("/auth/login", {
      method: "POST", body: { username: "nobody", password: "wrong-password" }
    }), ctx, env);
    assert.equal(failed.status, 401);
  }
  const throttled = await handleAuthVaultRoute(request("/auth/login", {
    method: "POST", body: { username: "nobody", password: "wrong-password" }
  }), ctx, env);
  assert.equal(throttled.status, 429);

  const worker = await readFile(new URL("../../../cloudflare/worker.js", import.meta.url), "utf8");
  const allowlistLine = worker.split("\n").find(line => line.includes("const publicAuthPaths"));
  assert.ok(allowlistLine);
  assert.ok(allowlistLine.includes("/api/auth/vault"));
  assert.equal(allowlistLine.includes("/api/auth/credentials"), false);
  assert.ok(worker.includes("if (!publicAuthPaths.has(url.pathname)) return json"));
});

test("cloud browser frontends use HttpOnly login cookies, not a client-side Relay Token", async () => {
  const publicApp = await readFile(new URL("../../../public/app.js", import.meta.url), "utf8");
  const workbench = await readFile(new URL("../../../public/ai-workbench.js", import.meta.url), "utf8");
  const mobileAdmin = await readFile(new URL("../../../cloudflare/mobile-admin.html", import.meta.url), "utf8");
  const scriptStart = mobileAdmin.indexOf("<script>") + "<script>".length;
  const scriptEnd = mobileAdmin.indexOf("</script>", scriptStart);
  assert.ok(scriptStart >= "<script>".length && scriptEnd > scriptStart);
  new Script(mobileAdmin.slice(scriptStart, scriptEnd));
  assert.ok(publicApp.includes('credentials:"same-origin"'));
  assert.equal(publicApp.includes("Authorization"), false);
  assert.equal(publicApp.includes("请输入 Cloudflare Relay Token"), false);
  assert.equal(workbench.includes('sessionStorage.getItem("openfish.relay.token")'), false);
  assert.equal(mobileAdmin.includes('localStorage.setItem("openfish.relay.token"'), false);
  assert.equal(mobileAdmin.includes('authorization:'), false);
  assert.ok(mobileAdmin.includes("/api/auth/login"));
});
