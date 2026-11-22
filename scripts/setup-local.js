import { spawnSync } from "node:child_process";
import { copyFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const envPath = resolve(root, ".env");
const examplePath = resolve(root, ".env.example");
const windows = process.platform === "win32";
const npm = windows ? "npm.cmd" : "npm";

function run(command, args, label) {
  console.log("\n[OpenFish] " + label);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: windows,
    env: process.env
  });
  if (result.error) throw new Error(label + "启动失败：" + result.error.message);
  if (result.status !== 0) throw new Error(label + "失败，退出码：" + result.status);
}

async function exists(path) {
  try { await access(path, constants.F_OK); return true; }
  catch { return false; }
}

try {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) throw new Error("需要 Node.js 20 或更高版本，当前版本：" + process.versions.node);
  if (!(await exists(examplePath))) throw new Error("缺少 .env.example，请确认在 OpenFish 项目根目录运行。");

  if (!(await exists(envPath))) {
    await copyFile(examplePath, envPath, constants.COPYFILE_EXCL);
    console.log("[OpenFish] 已创建本机 .env 配置（未写入任何云端密钥）。");
  } else {
    console.log("[OpenFish] 检测到现有 .env，保留原配置，不覆盖。");
  }

  run(npm, ["install", "--no-audit", "--no-fund"], "安装 OpenFish 依赖");
  run(npm, ["exec", "--", "playwright", "install", "chromium"], "安装 Chromium 浏览器");
  console.log("\n[OpenFish] 初始化完成，正在启动本地浏览器和 MCP 服务。");
  run(process.execPath, ["scripts/start-local.js"], "启动 OpenFish");
} catch (error) {
  console.error("\n[OpenFish] " + error.message);
  process.exitCode = 1;
}
