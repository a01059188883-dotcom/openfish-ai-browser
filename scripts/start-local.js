import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { runLocalChecks } from "./local-checks.js";

const checks = await runLocalChecks();
for (const check of checks.checks) {
  const mark = check.ok ? "✓" : check.required ? "✗" : "!";
  console.log(mark + " " + check.name + "： " + check.detail);
}
if (!checks.requiredOk) {
  console.error("\n启动中止：请先运行 npm install 或 npx playwright install chromium，并解决端口占用等必需问题。");
  process.exit(1);
}

const envFile = existsSync(".env");
const args = [...(envFile ? ["--env-file=.env"] : []), "packages/runtime/src/bridge.js"];
const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
let stopping = false;
const stop = signal => {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null) child.kill(signal);
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

const base = "http://127.0.0.1:" + checks.port;
let ready = false;
for (let attempt = 0; attempt < 60 && child.exitCode === null; attempt++) {
  try {
    const response = await fetch(base + "/health", { signal: AbortSignal.timeout(700) });
    if (response.ok) { ready = true; break; }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 250));
}
if (!ready) {
  console.error("\nOpenFish 服务未能在 15 秒内就绪。请检查上方启动日志。");
  stop("SIGTERM");
  process.exitCode = 1;
} else {
  console.log("\nOpenFish 本机服务已就绪");
  console.log("管理后台：" + base + "/admin");
  console.log("健康检查：" + base + "/health");
  console.log("免 Token 模式：" + (process.env.OPENFISH_LOCAL_NO_AUTH === "false" ? "关闭" : "开启（仅本机回环地址）"));
  console.log("按 Ctrl+C 停止服务。\n");
}
if (child.exitCode === null) {
  await new Promise(resolve => child.once("exit", resolve));
}
