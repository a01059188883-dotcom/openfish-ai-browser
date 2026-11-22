import { spawn } from "node:child_process";
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

const base = "http://127.0.0.1:" + checks.port;
const restartTimes = [];
let stopping = false;
let activeChild = null;
let restarts = 0;

function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log("\n收到 " + signal + "，正在安全停止 OpenFish…");
  if (activeChild && activeChild.exitCode === null) activeChild.kill(signal);
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

async function runChild() {
  const child = spawn(process.execPath, ["packages/runtime/src/bridge.js"], {
    stdio: "inherit",
    env: { ...process.env, OPENFISH_SUPERVISOR_RESTARTS: String(restarts) }
  });
  activeChild = child;
  let spawnError = null;
  const exitPromise = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  child.once("error", error => { spawnError = error; });
  let ready = false;
  for (let attempt = 0; attempt < 60 && child.exitCode === null && !spawnError && !stopping; attempt++) {
    try {
      const response = await fetch(base + "/health", { signal: AbortSignal.timeout(700) });
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (ready) {
    console.log("\nOpenFish 本机服务已就绪");
    console.log("管理后台：" + base + "/admin");
    console.log("健康检查：" + base + "/health");
    console.log("自动恢复次数：" + restarts);
    console.log("免 Token 模式：" + (process.env.OPENFISH_LOCAL_NO_AUTH === "false" ? "关闭" : "开启（仅本机回环地址）"));
  } else if (!stopping && child.exitCode === null) {
    console.error("OpenFish 启动健康检查失败，正在终止本次启动。");
    child.kill("SIGTERM");
  }
  const exit = child.exitCode === null ? await exitPromise : { code: child.exitCode, signal: child.signalCode };
  activeChild = null;
  return { ...exit, spawnError, ready };
}

console.log("OpenFish 本地守护进程已启动；异常退出时将有限次数自动恢复。");
while (!stopping) {
  const result = await runChild();
  if (stopping || (result.code === 0 && !result.signal)) break;
  const reason = result.spawnError?.message || (result.signal ? "signal " + result.signal : "exit code " + result.code);
  const policy = canRestart(restartTimes);
  if (!policy.allowed) {
    console.error("OpenFish 在 5 分钟内异常退出达到恢复上限（3 次），为避免无限重启已停止。");
    process.exitCode = 1;
    break;
  }
  restartTimes.splice(0, restartTimes.length, ...policy.recent);
  restartTimes.push(Date.now());
  restarts++;
  const delay = restartDelayMs(restarts);
  console.error("OpenFish 非正常退出（" + reason + "）；" + Math.ceil(delay / 1000) + " 秒后进行第 " + restarts + " 次自动恢复。");
  await wait(delay);
}
if (stopping) process.exitCode = 0;
