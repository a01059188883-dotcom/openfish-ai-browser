import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";

async function verifyKey(baseUrl, key, clientId, fetchImpl) {
  if (!key) return false;
  try {
    const response = await fetchImpl(baseUrl + "/api/auth/verify", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({ scope: "browser:write", clientId, platform: "cloudflare-relay", sessionId: "default" }),
      signal: AbortSignal.timeout(2500)
    });
    return response.ok;
  } catch { return false; }
}

/**
 * Provision and persist a least-privilege local API key for the outbound relay
 * agent. The key is never logged and is stored in a user-only file.
 */
export async function ensureRelayApiKey({ bridgeUrl, clientId = "openfish-local-agent", keyPath = ".openfish/relay-agent-key", existingKey = "", fetchImpl = fetch }) {
  const base = String(bridgeUrl || "").replace(/\/$/, "");
  if (!base.startsWith("http://127.0.0.1:") && !base.startsWith("http://localhost:")) {
    throw new Error("Relay API-key bootstrap is restricted to the local Bridge.");
  }
  let storedKey = "";
  try { storedKey = (await readFile(keyPath, "utf8")).trim(); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const candidate of [existingKey, storedKey]) {
    if (await verifyKey(base, candidate, clientId, fetchImpl)) {
      await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
      await writeFile(keyPath, candidate + "\n", { mode: 0o600 });
      await chmod(keyPath, 0o600);
      return { key: candidate, created: false };
    }
  }
  const response = await fetchImpl(base + "/api/admin/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "OpenFish Cloud Relay Agent", scopes: ["browser:read", "browser:write"], expiresInDays: 365 }),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error("无法为本机 Relay 自动创建访问密钥（HTTP " + response.status + "）。");
  const payload = await response.json();
  if (typeof payload.key !== "string" || !payload.key.startsWith("ofb_live_")) {
    throw new Error("本机 Bridge 返回的 Relay 密钥格式无效。");
  }
  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
  await writeFile(keyPath, payload.key + "\n", { mode: 0o600 });
  await chmod(keyPath, 0o600);
  return { key: payload.key, created: true };
}
