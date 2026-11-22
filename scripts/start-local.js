import { spawn } from "node:child_process";
import net from "node:net";
import { runLocalChecks } from "./local-checks.js";
import { canRestart, restartDelayMs } from "./supervisor-policy.js";
import { ensureRelayApiKey } from "./relay-key-bootstrap.js";

const checks = await runLocalChecks();
for (const check of checks.checks) {
  const mark = check.ok ? "✓" : check.required ? "✗" : "!";
  console.log(mark + " " + check.name + "： " + check.detail);
}
if (!checks.requiredOk) {
  console.error("\n启动中止：请先修复必需环境检查项目。");
  process.exit(1);
}

const bridgeUrl = "http://127.0.0.1:" + checks.port;
const mcpUrl = "http://127.0.0.1:" + checks.mcpPort + "/mcp";
const relayUrl = process.env.OPENFISH_RELAY_URL || "";
const relayToken = process.env.OPENFISH_RELAY_TOKEN || "";
const relayConfigured = Boolean(relayUrl && relayToken);
const restartTimes = [];
let stopping = false;
let children = [];

function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log("\n收到 " + signal + "，正在安全停止 OpenFish…");
  for (const child of children) if (child.exitCode === null) child.kill(signal);
}
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

async function wait(ms) {
  if (stopping) return;
  await new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

function tcpReady(port, timeoutMs = 500) {
  return new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function stopChildren(signal = "SIGTERM") {
  const running = children.filter(child => child.exitCode === null);
  for (const child of running) child.kill(signal);
  await Promise.all(running.map(child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 4000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
  })));
  children = [];
}

function addChild(spec, env = process.env) {
  const child = spawn(process.execPath, [spec.file], {
    stdio: "inherit",
    env: { ...env, OPENFISH_SUPERVISOR_RESTARTS: String(restartTimes.length) }
  });
  const exit = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal, name: spec.name })));
  child.once("error", error => console.error(spec.name + " 启动失败：" + error.message));
  children.push(child);
  return exit;
}

function remoteMcpAddress() {
  try {
    const url = new URL(relayUrl);
    if (url.protocol !== "wss:") return "";
    return "https://" + url.host + "/mcp";
  } catch { return ""; }
}

async function runStack() {
  const exits = [];
  children = [];
  exits.push(addChild({ name: "Bridge", file: "packages/runtime/src/bridge.js" }));
  exits.push(addChild({ name: "MCP HTTP", file: "packages/mcp-server/src/http.js" }));

  let ready = false;
  for (let attempt = 0; attempt < 80 && !stopping && children.every(child => child.exitCode === null); attempt++) {
    try {
      const response = await fetch(bridgeUrl + "/health", { signal: AbortSignal.timeout(700) });
      const mcpReady = await tcpReady(checks.mcpPort);
      if (response.ok && mcpReady) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready && !stopping) {
    console.error("OpenFish 本地服务未能全部就绪，正在重启服务组。");
    await stopChildren("SIGTERM");
    return { code: 1, ready: false };
  }
  if (ready && relayConfigured) {
    try {
      const provisioned = await ensureRelayApiKey({
        bridgeUrl,
        existingKey: process.env.OPENFISH_LOCAL_API_KEY || "",
        keyPath: process.env.OPENFISH_RELAY_KEY_FILE || ".openfish/relay-agent-key"
      });
      exits.push(addChild(
        { name: "Cloud Relay Agent", file: "packages/runtime/src/relay-agent.js" },
        { ...process.env, OPENFISH_LOCAL_API_KEY: provisioned.key }
      ));
      const address = remoteMcpAddress();
      console.log("远程云端 MCP 地址：" + (address || "Relay URL 配置无效"));
      console.log("远程连接授权：使用你已配置的 Relay Token；Token 不会打印到终端。");
      console.log("本机 Relay API 密钥已自动创建并安全保存，无需手动填写。");
    } catch (error) {
      console.error("云端 Relay 未启动，本机浏览器仍可正常使用：" + error.message);
    }
  } else if (ready && (relayUrl || relayToken)) {
    console.log("云端 Relay 尚未配置完整：请在本机 .env 中同时设置 OPENFISH_RELAY_URL 和 OPENFISH_RELAY_TOKEN。");
  }

  if (ready) {
    console.log("\nOpenFish 本地浏览器服务已全部就绪");
    console.log("一键管理地址：" + bridgeUrl + "/admin");
    console.log("浏览器 REST 地址：" + bridgeUrl + "/api/v1/tools");
    console.log("MCP 连接地址：" + mcpUrl);
    console.log("健康检查地址：" + bridgeUrl + "/health");
    console.log("连接方式：同一台电脑上的 AI 客户端使用 MCP 地址即可，本机默认免 Token。");
    if (!relayConfigured) console.log("远程连接：未启用；本机功能不受影响。");
  }

  const completed = await Promise.race(exits);
  await stopChildren("SIGTERM");
  return { ...completed, ready };
}

console.log("OpenFish 一键启动：Bridge + MCP；如已配置云 Relay，则自动生成本机代理密钥并连接云端。");
while (!stopping) {
  const result = await runStack();
  if (stopping || (result.code === 0 && !result.signal && result.ready)) break;
  const policy = canRestart(restartTimes);
  if (!policy.allowed) {
    console.error("OpenFish 在 5 分钟内异常退出达到恢复上限（3 次），为避免无限重启已停止。");
    process.exitCode = 1;
    break;
  }
  restartTimes.splice(0, restartTimes.length, ...policy.recent);
  restartTimes.push(Date.now());
  const delay = restartDelayMs(restartTimes.length);
  console.error("服务组异常退出；" + Math.ceil(delay / 1000) + " 秒后自动恢复（" + restartTimes.length + "/3）。");
  await wait(delay);
}
if (stopping) process.exitCode = 0;
