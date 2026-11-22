const COOKIE = "__Host-openfish_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PASSWORD_ITERATIONS = 310000;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const encoder = new TextEncoder();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers } });
}
function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function fromBase64url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)), char => char.charCodeAt(0));
}
function randomToken(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}
async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
async function hex(bytes) {
  return [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
}
async function passwordHash(password, salt, iterations = PASSWORD_ITERATIONS) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, material, 256);
  return new Uint8Array(bits);
}
function constantTimeEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}
function cookieValue(request) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return value.join("=");
  }
  return "";
}
function cookieHeader(token, maxAge = SESSION_TTL_MS / 1000) {
  return token
    ? `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`
    : `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
function safeOrigin(request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}
function cleanUsername(value) {
  return String(value || "").trim().toLowerCase().slice(0, 64);
}
function clientAddress(request) {
  return request.headers.get("cf-connecting-ip") || "unknown";
}
function validSecret(value) {
  return typeof value === "string" && value.length >= 32 && value.length <= 4096;
}
async function audit(ctx, action, username = "admin") {
  const key = "audit:" + Date.now() + ":" + randomToken(6);
  await ctx.storage.put(key, { at: new Date().toISOString(), action, username });
  const rows = await ctx.storage.list({ prefix: "audit:" });
  if (rows.size > 200) {
    const keys = [...rows.keys()].sort().slice(0, rows.size - 200);
    if (keys.length) await ctx.storage.delete(keys);
  }
}
async function sessionRecord(ctx, request) {
  const token = cookieValue(request);
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  const key = "session:" + await hex(await sha256(token));
  const record = await ctx.storage.get(key);
  if (!record || record.expiresAt <= Date.now()) {
    if (record) await ctx.storage.delete(key);
    return null;
  }
  return { key, record };
}
async function vaultKey(env) {
  if (!validSecret(env.OPENFISH_VAULT_KEY)) throw new Error("Cloud vault is not configured. Set OPENFISH_VAULT_KEY as a Cloudflare Worker secret.");
  return crypto.subtle.importKey("raw", await sha256(env.OPENFISH_VAULT_KEY), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function readVault(ctx, env) {
  const stored = await ctx.storage.get("vault:encrypted");
  if (!stored) return {};
  const key = await vaultKey(env);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(stored.iv) }, key, fromBase64url(stored.data));
  return JSON.parse(new TextDecoder().decode(plain));
}
async function writeVault(ctx, env, secrets) {
  const key = await vaultKey(env);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const plain = encoder.encode(JSON.stringify(secrets));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  await ctx.storage.put("vault:encrypted", { iv: base64url(iv), data: base64url(new Uint8Array(encrypted)), updatedAt: Date.now() });
}
function publicVault(secrets) {
  return Object.fromEntries(["OPENFISH_RELAY_TOKEN", "BROWSER_ENGINE_TOKEN", "BROWSER_ENGINE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"].map(name => [
    name,
    secrets[name] ? { configured: true, masked: name.endsWith("_URL") ? secrets[name].replace(/^(https?:\/\/)[^/]+/, "$1••••") : "••••••••" + secrets[name].slice(-4) } : { configured: false, masked: "" }
  ]));
}

export async function validateCloudSession(ctx, request) {
  const found = await sessionRecord(ctx, request);
  return found ? { ok: true, username: found.record.username } : { ok: false };
}

export async function handleAuthVaultRoute(request, ctx, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/auth/")) return null;
  if (["/auth/bootstrap", "/auth/login", "/auth/logout", "/auth/vault"].includes(path) && request.method !== "GET" &&
      (!request.headers.get("origin") || !safeOrigin(request))) return json({ error: "Same-origin request required." }, 403);
  const readJson = async () => {
    const length = Number(request.headers.get("content-length") || 0);
    if (length > 8192) throw new Error("Request body too large.");
    let data;
    try { data = await request.json(); } catch { throw new Error("Invalid JSON body."); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid JSON body.");
    return data;
  };

  if (path === "/auth/bootstrap" && request.method === "POST") {
    let body;
    try { body = await readJson(); } catch (error) { return json({ error: error.message }, 400); }
    if (!validSecret(env.OPENFISH_BOOTSTRAP_SECRET)) return json({ error: "First-run bootstrap is disabled. Configure OPENFISH_BOOTSTRAP_SECRET in Cloudflare Worker secrets first." }, 503);
    if (!validSecret(body.bootstrapSecret) || !constantTimeEqual(encoder.encode(body.bootstrapSecret), encoder.encode(env.OPENFISH_BOOTSTRAP_SECRET))) return json({ error: "Invalid bootstrap authorization." }, 401);
    if (await ctx.storage.get("auth:user")) return json({ error: "Administrator account has already been initialized." }, 409);
    const username = cleanUsername(body.username);
    const password = String(body.password || "");
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) return json({ error: "Username must be 3–64 characters: a-z, 0-9, dot, underscore or hyphen." }, 400);
    if (password.length < 14 || password.length > 256) return json({ error: "Use a unique password with at least 14 characters." }, 400);
    if (!validSecret(env.OPENFISH_VAULT_KEY)) return json({ error: "Cloud vault encryption is not configured. Set OPENFISH_VAULT_KEY before bootstrap." }, 503);
    const salt = new Uint8Array(16); crypto.getRandomValues(salt);
    const digest = await passwordHash(password, salt);
    await ctx.storage.put("auth:user", { username, salt: base64url(salt), passwordHash: base64url(digest), iterations: PASSWORD_ITERATIONS, createdAt: Date.now(), role: "owner" });
    await audit(ctx, "admin.bootstrap", username);
    return json({ ok: true, initialized: true, message: "Administrator created. Remove OPENFISH_BOOTSTRAP_SECRET from Worker secrets after first login." }, 201);
  }

  if (path === "/auth/login" && request.method === "POST") {
    let body;
    try { body = await readJson(); } catch (error) { return json({ error: error.message }, 400); }
    const address = clientAddress(request);
    const rateKey = "login-rate:" + await hex(await sha256(address));
    const now = Date.now();
    let rate = await ctx.storage.get(rateKey) || { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    if (rate.resetAt <= now) rate = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    if (rate.count >= MAX_LOGIN_ATTEMPTS) return json({ error: "Too many login attempts. Try again after 15 minutes." }, 429, { "retry-after": String(Math.ceil((rate.resetAt - now) / 1000)) });
    const user = await ctx.storage.get("auth:user");
    const username = cleanUsername(body.username);
    const password = String(body.password || "");
    const candidate = await passwordHash(password.length <= 256 ? password : "", user ? fromBase64url(user.salt) : new Uint8Array(16), user?.iterations || PASSWORD_ITERATIONS);
    const valid = Boolean(user) && username === user.username && password.length <= 256 &&
      constantTimeEqual(candidate, fromBase64url(user.passwordHash));
    if (!valid) {
      rate.count++;
      await ctx.storage.put(rateKey, rate, { expirationTtl: Math.ceil(LOGIN_WINDOW_MS / 1000) });
      await audit(ctx, "auth.login.failed", username || "unknown");
      return json({ error: "Invalid username or password." }, 401);
    }
    await ctx.storage.delete(rateKey);
    const token = randomToken(32);
    const sessionKey = "session:" + await hex(await sha256(token));
    await ctx.storage.put(sessionKey, { username: user.username, role: user.role, createdAt: now, expiresAt: now + SESSION_TTL_MS }, { expirationTtl: Math.ceil(SESSION_TTL_MS / 1000) });
    await audit(ctx, "auth.login.success", user.username);
    return json({ ok: true, user: { username: user.username, role: user.role }, expiresIn: SESSION_TTL_MS / 1000 }, 200, { "set-cookie": cookieHeader(token) });
  }

  if (path === "/auth/logout" && request.method === "POST") {
    const found = await sessionRecord(ctx, request);
    if (found) { await ctx.storage.delete(found.key); await audit(ctx, "auth.logout", found.record.username); }
    return json({ ok: true }, 200, { "set-cookie": cookieHeader("") });
  }

  if (path === "/auth/me" && request.method === "GET") {
    const found = await sessionRecord(ctx, request);
    if (!found) return json({ authenticated: false }, 200, { "set-cookie": cookieHeader("") });
    return json({ authenticated: true, user: { username: found.record.username, role: found.record.role }, expiresAt: new Date(found.record.expiresAt).toISOString() });
  }

  if (path === "/auth/validate" && request.method === "POST") {
    const found = await sessionRecord(ctx, request);
    return json(found ? { ok: true, username: found.record.username, role: found.record.role } : { ok: false }, found ? 200 : 401);
  }

  if (path === "/auth/credentials" && request.method === "POST") {
    const found = await sessionRecord(ctx, request);
    if (!found || found.record.role !== "owner") return json({ error: "Unauthorized." }, 401);
    const secrets = await readVault(ctx, env);
    return json({ ok: true, secrets });
  }

  if (path === "/auth/relay-verify" && request.method === "POST") {
    const supplied = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") || "")?.[1] || "";
    if (!validSecret(supplied)) return json({ ok: false }, 401);
    const expected = (await readVault(ctx, env)).OPENFISH_RELAY_TOKEN || "";
    const valid = validSecret(expected) && constantTimeEqual(encoder.encode(supplied), encoder.encode(expected));
    return json({ ok: valid }, valid ? 200 : 401);
  }

  if (path === "/auth/vault" && request.method === "GET") {
    const found = await sessionRecord(ctx, request);
    if (!found || found.record.role !== "owner") return json({ error: "Unauthorized." }, 401);
    return json({ ok: true, secrets: publicVault(await readVault(ctx, env)) });
  }

  if (path === "/auth/vault" && request.method === "PUT") {
    const found = await sessionRecord(ctx, request);
    if (!found || found.record.role !== "owner") return json({ error: "Unauthorized." }, 401);
    let body;
    try { body = await readJson(); } catch (error) { return json({ error: error.message }, 400); }
    const incoming = body.secrets;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return json({ error: "A secrets object is required." }, 400);
    const current = await readVault(ctx, env);
    const next = { ...current };
    for (const name of ["OPENFISH_RELAY_TOKEN", "BROWSER_ENGINE_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"]) {
      if (Object.hasOwn(incoming, name) && incoming[name] !== "") {
        if (!validSecret(incoming[name])) return json({ error: name + " must contain at least 32 characters." }, 400);
        next[name] = incoming[name];
      }
    }
    if (Object.hasOwn(incoming, "BROWSER_ENGINE_URL") && incoming.BROWSER_ENGINE_URL !== "") {
      let parsed;
      try { parsed = new URL(incoming.BROWSER_ENGINE_URL); } catch { return json({ error: "BROWSER_ENGINE_URL must be a valid HTTPS URL." }, 400); }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) return json({ error: "BROWSER_ENGINE_URL must use HTTPS and contain no embedded credentials." }, 400);
      next.BROWSER_ENGINE_URL = parsed.origin;
    }
    if (Object.hasOwn(incoming, "clear") && Array.isArray(incoming.clear)) {
      for (const name of incoming.clear) if (["OPENFISH_RELAY_TOKEN", "BROWSER_ENGINE_TOKEN", "BROWSER_ENGINE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"].includes(name)) delete next[name];
    }
    await writeVault(ctx, env, next);
    await audit(ctx, "vault.updated", found.record.username);
    return json({ ok: true, secrets: publicVault(next) });
  }

  return json({ error: "Not found." }, 404);
}
