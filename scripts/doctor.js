import { runLocalChecks } from "./local-checks.js";

const result = await runLocalChecks();
console.log("\nOpenFish 本机环境检查\n");
for (const check of result.checks) {
  const mark = check.ok ? "✓" : check.required ? "✗" : "!";
  console.log(mark + " " + check.name + "： " + check.detail);
}
console.log("\n" + (result.requiredOk ? "基础运行条件满足。" : "基础运行条件未满足，请先修复标记为 ✗ 的项目。"));
console.log("本机管理后台：http://127.0.0.1:" + result.port + "/admin");\nconsole.log("MCP 一键连接地址：http://127.0.0.1:" + result.mcpPort + "/mcp");\nconsole.log("提示：运行 npm run start:local 会同时启动 Bridge 和 MCP，无需分别启动。");
if (!result.checks.find(item => item.name === "Ollama AI")?.ok) {
  console.log("提示：Ollama 仅用于本地 AI 计划生成；不安装也可以启动浏览器、打开网页和手动操作。");
}
if (!result.requiredOk) process.exitCode = 1;
