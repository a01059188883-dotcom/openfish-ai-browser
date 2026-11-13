const API = "http://127.0.0.1:8787";
const $ = id => document.getElementById(id);
let currentPlan = null;
async function request(path, body = {}) {
  const response = await fetch(API + path, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}
async function health() {
  try { const r = await fetch(API + "/health"); if (!r.ok) throw new Error(); $("status").textContent = "本地服务已连接"; }
  catch { $("status").textContent = "本地服务未启动"; }
}
$("inspect").addEventListener("click", async () => {
  $("page").textContent = "读取中…";
  try { const [tab] = await chrome.tabs.query({active:true,currentWindow:true}); if (tab?.url?.startsWith("http")) await request("/navigate",{url:tab.url}); const data = await request("/api/inspect"); $("page").textContent = `${data.title}\n${data.url}\n\n${data.text}`; }
  catch(e) { $("page").textContent = e.message; }
});
$("goal").addEventListener("input", () => {
  currentPlan = null;
  $("execute").hidden = true;
  $("execute").disabled = true;
});
$("run").addEventListener("click", async () => {
  currentPlan = null;
  $("execute").hidden = true;
  $("execute").disabled = true;
  const goal = $("goal").value.trim(); if (!goal) return $("result").textContent = "请先输入任务。";
  $("run").disabled = true;
  $("result").textContent = "正在调用本地 AI 生成计划…";
  try { const [tab] = await chrome.tabs.query({active:true,currentWindow:true}); const data = await request("/api/plan",{goal,url:tab?.url?.startsWith("http") ? tab.url : undefined}); currentPlan = data; $("result").textContent = JSON.stringify(data,null,2); $("execute").hidden = !Array.isArray(data.steps) || data.steps.length === 0; $("execute").disabled = $("execute").hidden; }
  catch(e) { currentPlan = null; $("execute").hidden = true; $("result").textContent = e.message; }
  finally { $("run").disabled = false; }
});
health();

$("execute").addEventListener("click", async () => {
  if (!currentPlan || !Array.isArray(currentPlan.steps) || currentPlan.steps.length === 0) return;
  const approved = window.confirm("请确认：你已逐条检查上方计划，并同意执行这些普通网页操作？付款、发送、删除、提交等高风险操作仍会被系统拦截。");
  if (!approved) return;
  const approvedPlan = currentPlan;
  $("result").textContent = "正在按审核计划逐步执行…";
  $("execute").disabled = true;
  $("run").disabled = true;
  try {
    const data = await request("/api/execute", { plan: approvedPlan, approved: true });
    $("result").textContent = JSON.stringify(data, null, 2);
  } catch (e) { $("result").textContent = e.message; }
  finally { currentPlan = null; $("execute").hidden = true; $("execute").disabled = true; $("run").disabled = false; }
});
