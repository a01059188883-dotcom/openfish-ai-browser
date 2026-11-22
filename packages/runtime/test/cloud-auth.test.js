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
function request(path, { method = "GET", body, cookie = "", originHeader = origin, authorization = "" } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (authorization) headers.set("authorization", authorization);
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
  const openaiKey = "openai-api-key-test-value-that-is-at-least-32";
  const anthropicKey = "anthropic-api-key-test-value-that-is-at-least-32";
  const geminiKey = "gemini-api-key-test-value-that-is-at-least-32";
  const save = await handleAuthVaultRoute(request("/auth/vault", {
    method: "PUT", cookie,
    body: { secrets: { OPENFISH_RELAY_TOKEN: secret, BROWSER_ENGINE_TOKEN: engineToken, BROWSER_ENGINE_URL: "https://engine.openfish.example", OPENAI_API_KEY: openaiKey, ANTHROPIC_API_KEY: anthropicKey, GEMINI_API_KEY: geminiKey } }
  }), ctx, env);
  assert.equal(save.status, 200);
  const publicResult = await save.json();
  assert.equal(publicResult.secrets.OPENFISH_RELAY_TOKEN.configured, true);
  assert.equal(publicResult.secrets.OPENFISH_RELAY_TOKEN.masked.includes(secret), false);

  const serializedStorage = JSON.stringify([...ctx.values.entries()]);
  assert.equal(serializedStorage.includes(secret), false);
  assert.equal(serializedStorage.includes(engineToken), false);
  assert.equal(serializedStorage.includes(openaiKey), false);
  assert.equal(serializedStorage.includes(anthropicKey), false);
  assert.equal(serializedStorage.includes(geminiKey), false);

  const credentials = await handleAuthVaultRoute(request("/auth/credentials", { method: "POST", cookie }), ctx, env);
  assert.equal(credentials.status, 200);
  const decrypted = await credentials.json();
  assert.equal(decrypted.secrets.OPENFISH_RELAY_TOKEN, secret);
  assert.equal(decrypted.secrets.BROWSER_ENGINE_TOKEN, engineToken);
  assert.equal(decrypted.secrets.OPENAI_API_KEY, openaiKey);
  assert.equal(decrypted.secrets.ANTHROPIC_API_KEY, anthropicKey);
  assert.equal(decrypted.secrets.GEMINI_API_KEY, geminiKey);
  const clearOne = await handleAuthVaultRoute(request("/auth/vault", {
    method: "PUT", cookie, body: { secrets: { clear: ["OPENAI_API_KEY"] } }
  }), ctx, env);
  assert.equal(clearOne.status, 200);
  assert.equal((await clearOne.json()).secrets.OPENAI_API_KEY.configured, false);
  const afterClear = await handleAuthVaultRoute(request("/auth/credentials", { method: "POST", cookie }), ctx, env);
  assert.equal((await afterClear.json()).secrets.OPENAI_API_KEY, undefined);
  const relayVerify = await handleAuthVaultRoute(request("/auth/relay-verify", {
    method: "POST", authorization: "Bearer " + secret
  }), ctx, env);
  assert.equal(relayVerify.status, 200);
  const invalidRelayVerify = await handleAuthVaultRoute(request("/auth/relay-verify", {
    method: "POST", authorization: "Bearer " + "wrong-token-value-that-is-long-enough-123456"
  }), ctx, env);
  assert.equal(invalidRelayVerify.status, 401);

  const me = await handleAuthVaultRoute(request("/auth/me", { cookie }), ctx, env);
  assert.equal((await me.json()).authenticated, true);
  const logout = await handleAuthVaultRoute(request("/auth/logout", { method: "POST", cookie }), ctx, env);
  assert.equal(logout.status, 200);
  const afterLogout = await handleAuthVaultRoute(request("/auth/me", { cookie }), ctx, env);
  assert.equal((await afterLogout.json()).authenticated, false);
});

test("password change verifies current password and revokes all existing sessions", async () => {
  const ctx = makeContext();
  const oldPassword = "original-owner-password-long-enough";
  const bootstrap = await handleAuthVaultRoute(request("/auth/bootstrap", {
    method: "POST", body: { bootstrapSecret: env.OPENFISH_BOOTSTRAP_SECRET, username: "owner", password: oldPassword }
  }), ctx, env);
  assert.equal(bootstrap.status, 201);
  const login1 = await handleAuthVaultRoute(request("/auth/login", { method: "POST", body: { username: "owner", password: oldPassword } }), ctx, env);
  const cookie1 = login1.headers.get("set-cookie").split(";")[0];
  const login2 = await handleAuthVaultRoute(request("/auth/login", { method: "POST", body: { username: "owner", password: oldPassword } }), ctx, env);
  const cookie2 = login2.headers.get("set-cookie").split(";")[0];
  const denied = await handleAuthVaultRoute(request("/auth/password", {
    method: "PUT", cookie: cookie1, body: { currentPassword: "wrong-current-password", newPassword: "replacement-password-long-enough" }
  }), ctx, env);
  assert.equal(denied.status, 401);
  const changed = await handleAuthVaultRoute(request("/auth/password", {
    method: "PUT", cookie: cookie1, body: { currentPassword: oldPassword, newPassword: "replacement-password-long-enough" }
  }), ctx, env);
  assert.equal(changed.status, 200);
  const newCookie = changed.headers.get("set-cookie").split(";")[0];
  assert.match(changed.headers.get("set-cookie"), /HttpOnly/);
  assert.equal((await (await handleAuthVaultRoute(request("/auth/me", { cookie: cookie1 }), ctx, env)).json()).authenticated, false);
  assert.equal((await (await handleAuthVaultRoute(request("/auth/me", { cookie: cookie2 }), ctx, env)).json()).authenticated, false);
  assert.equal((await (await handleAuthVaultRoute(request("/auth/me", { cookie: newCookie }), ctx, env)).json()).authenticated, true);
  const oldLogin = await handleAuthVaultRoute(request("/auth/login", { method: "POST", body: { username: "owner", password: oldPassword } }), ctx, env);
  assert.equal(oldLogin.status, 401);
  const newLogin = await handleAuthVaultRoute(request("/auth/login", { method: "POST", body: { username: "owner", password: "replacement-password-long-enough" } }), ctx, env);
  assert.equal(newLogin.status, 200);
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
  assert.ok(allowlistLine.includes("/api/auth/password"));\n  assert.ok(allowlistLine.includes("/api/auth/vault/backup"));
  assert.equal(allowlistLine.includes("/api/auth/credentials"), false);
  assert.equal(allowlistLine.includes("/api/auth/relay-verify"), false);
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
  assert.ok(mobileAdmin.includes("/api/auth/password"));\n  assert.ok(mobileAdmin.includes("/api/auth/vault/backup"));\n  assert.ok(mobileAdmin.includes("加密备份与恢复"));
  assert.ok(mobileAdmin.includes("修改密码并退出其他设备"));
  assert.ok(mobileAdmin.includes("clearOpenAI"));
  assert.ok(mobileAdmin.includes("删除不再使用的密钥"));
  assert.ok(mobileAdmin.includes("OPENAI_API_KEY"));
  assert.ok(mobileAdmin.includes("ANTHROPIC_API_KEY"));
  assert.ok(mobileAdmin.includes("GEMINI_API_KEY"));
  assert.ok(workbench.includes("/api/ai/chat"));
  assert.equal(workbench.includes('id="of-key"'), false);
  assert.equal(workbench.includes('cfg.key||'), false);
  const worker = await readFile(new URL("../../../cloudflare/worker.js", import.meta.url), "utf8");
  assert.ok(worker.includes('url.pathname === "/api/ai/chat"'));
  assert.ok(worker.includes("https://api.openai.com/v1/chat/completions"));
  assert.ok(worker.includes("https://api.anthropic.com/v1/messages"));
  assert.ok(worker.includes("https://generativelanguage.googleapis.com/v1beta/models/"));
  assert.ok(worker.includes('if (!sessionCheck.ok) return json({ error: "Cloud login required." }, 401);'));
});

test("vault backup exports ciphertext only and restores atomically after passphrase verification", async () => {
  const ctx = makeContext();
  const password = "owner-password-for-vault-backup-tests";
  await handleAuthVaultRoute(request("/auth/bootstrap", { method: "POST", body: { bootstrapSecret: env.OPENFISH_BOOTSTRAP_SECRET, username: "owner", password } }), ctx, env);
  const login = await handleAuthVaultRoute(request("/auth/login", { method: "POST", body: { username: "owner", password } }), ctx, env);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const original = "original-relay-secret-value-that-is-over-32-characters";
  await handleAuthVaultRoute(request("/auth/vault", { method: "PUT", cookie, body: { secrets: { OPENFISH_RELAY_TOKEN: original } } }), ctx, env);
  const passphrase = "separate-backup-passphrase-long-enough";
  const exported = await handleAuthVaultRoute(request("/auth/vault/backup", { method: "POST", cookie, body: { action: "export", passphrase } }), ctx, env);
  assert.equal(exported.status, 200);
  const envelope = (await exported.json()).backup;
  assert.equal(envelope.cipher, "AES-256-GCM");
  assert.equal(JSON.stringify(envelope).includes(original), false);
  await handleAuthVaultRoute(request("/auth/vault", { method: "PUT", cookie, body: { secrets: { clear: ["OPENFISH_RELAY_TOKEN"] } } }), ctx, env);
  const wrong = await handleAuthVaultRoute(request("/auth/vault/backup", { method: "POST", cookie, body: { action: "restore", passphrase: "incorrect-backup-passphrase", backup: envelope } }), ctx, env);
  assert.equal(wrong.status, 400);
  assert.equal((await (await handleAuthVaultRoute(request("/auth/credentials", { method: "POST", cookie }), ctx, env)).json()).secrets.OPENFISH_RELAY_TOKEN, undefined);
  const restored = await handleAuthVaultRoute(request("/auth/vault/backup", { method: "POST", cookie, body: { action: "restore", passphrase, backup: envelope } }), ctx, env);
  assert.equal(restored.status, 200);
  const credentials = await handleAuthVaultRoute(request("/auth/credentials", { method: "POST", cookie }), ctx, env);
  assert.equal((await credentials.json()).secrets.OPENFISH_RELAY_TOKEN, original);
  const malformed = await handleAuthVaultRoute(request("/auth/vault/backup", { method: "POST", cookie, body: { action: "restore", passphrase, backup: { ...envelope, version: 999 } } }), ctx, env);
  assert.equal(malformed.status, 400);
});
