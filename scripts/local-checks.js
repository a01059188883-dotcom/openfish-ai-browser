import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { chromium } from "playwright";

export async function loadLocalEnv() {
  if (!existsSync(".env")) return;
  for (const line of (await readFile(".env", "utf8")).split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

export async function checkPort(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once("error", error => resolve({ ok: false, detail: error.code === "EADDRINUSE" ? "端口已被占用" : error.message }));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve({ ok: true, detail: "可用" })));
  });
}

export async function runLocalChecks() {
  await loadLocalEnv();
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const executable = chromium.executablePath();
  const port = Number(process.env.PORT || 8787);
  const mcpPort = Number(process.env.OPENFISH_MCP_HTTP_PORT || 8788);
  const relayUrl = process.env.OPENFISH_RELAY_URL || "";
  const relayToken = process.env.OPENFISH_RELAY_TOKEN || "";
  const relayConfigured = Boolean(relayUrl && relayToken);
  const relayPartial = Boolean(relayUrl) !== Boolean(relayToken);
  let relayValid = false;
  try { const relay = new URL(relayUrl); relayValid = relay.protocol === "wss:" && relayToken.length >= 32; } catch {}
  const [portCheck, mcpPortCheck, ollama] = await Promise.all([
    checkPort(port),
    checkPort(mcpPort),
    fetch((process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "") + "/api/tags", { signal: AbortSignal.timeout(1800) })
      .then(async response => {
        if (!response.ok) return { ok: false, detail: "Ollama HTTP " + response.status };
        const payload = await response.json();
        const model = process.env.OPENFISH_MODEL || "qwen2.5:3b";
        const models = Array.isArray(payload.models) ? payload.models.map(item => String(item.name || "")) : [];
        return { ok: true, model, installed: models.some(name => name === model || name.startsWith(model + ":")) };
      }).catch(() => ({ ok: false, detail: "未运行（浏览器基础操作不受影响）" }))
  ]);
  return {
    requiredOk: nodeMajor >= 20 && existsSync("node_modules") && existsSync(executable) && portCheck.ok && mcpPortCheck.ok,
    checks: [
      { name: "Node.js", ok: nodeMajor >= 20, required: true, detail: process.versions.node + (nodeMajor >= 20 ? "" : " · 需要 20+") },
      { name: "项目依赖", ok: existsSync("node_modules"), required: true, detail: existsSync("node_modules") ? "已安装" : "缺少依赖，请运行 npm install" },
      { name: "Playwright Chromium", ok: existsSync(executable), required: true, detail: existsSync(executable) ? "已安装" : "缺少浏览器，请运行 npx playwright install chromium" },
      { name: "本地浏览器端口 " + port, ok: portCheck.ok, required: true, detail: portCheck.detail },
      { name: "本地 MCP 端口 " + mcpPort, ok: mcpPortCheck.ok, required: true, detail: mcpPortCheck.detail },
      { name: "本地免 Token", ok: process.env.OPENFISH_LOCAL_NO_AUTH !== "false", required: false, detail: process.env.OPENFISH_LOCAL_NO_AUTH === "false" ? "已关闭（需要本机 API Key）" : "已启用（仅回环连接）" },
      { name: "云端 Relay", ok: relayValid, required: false, detail: relayValid ? "已配置，启动时自动连接" : relayPartial ? "配置不完整（需要同时设置 Relay URL 和 Token）" : relayConfigured ? "配置格式无效（Relay URL 必须使用 wss://，Token 至少 32 位）" : "未配置（本机浏览器不受影响）" },
      { name: "Ollama AI", ok: ollama.ok && ollama.installed, required: false, detail: !ollama.ok ? ollama.detail : ollama.installed ? ollama.model + " 已就绪" : "已连接，但缺少模型 " + (process.env.OPENFISH_MODEL || "qwen2.5:3b") }
    ],
    port,
    mcpPort,
    browserExecutable: existsSync(executable) ? "available" : "missing"
  };
}
