import { spawn } from "node:child_process";
import net from "node:net";
import { runLocalChecks } from "./local-checks.js";
import { canRestart, restartDelayMs } from "./supervisor-policy.js";

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

async function runStack() {
  const specs = [
    { name: "Bridge", file: "packages/runtime/src/bridge.js" },
    { name: "MCP HTTP", file: "packages/mcp-server/src/http.js" }
  ];
  const exits = [];
  children = specs.map(spec => {
    const child = spawn(process.execPath, [spec.file], {
      stdio: "inherit",
      env: { ...process.env, OPENFISH_SUPERVISOR_RESTARTS: String(restartTimes.length) }
    });
    child.once("error", error => exits.push({ code: 1, error }));
    exits.push(new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal, name: spec.name }))));
    return child;
  });

  let ready = false;
  for (let attempt = 0; attempt < 80 && !stopping && children.every(child => child.exitCode === null); attempt++) {
    try {
      const response = await fetch(bridgeUrl + "/health", { signal: AbortSignal.timeout(700) });
      const mcpReady = await tcpReady(checks.mcpPort);
      if (response.ok && mcpReady) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (ready) {
    console.log("\nOpenFish 本地浏览器服务已全部就绪");
    console.log("一键管理地址：" + bridgeUrl + "/admin");
    console.log("浏览器 REST 地址：" + bridgeUrl + "/api/v1/tools");
    console.log("MCP 连接地址：" + mcpUrl);
    console.log("健康检查地址：" + bridgeUrl + "/health");
    console.log("连接方式：本机使用默认免 Token，无需再单独启动 MCP 服务。");
  } else if (!stopping) {
    console.error("OpenFish 服务未能全部就绪，正在重启服务组。");
  }

  const completed = await Promise.race(exits.filter(item => item instanceof Promise));
  await stopChildren("SIGTERM");
  return { ...completed, ready };
}

console.log("OpenFish 一键启动：浏览器 Bridge + MCP HTTP；异常退出时有限次数自动恢复。");
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
