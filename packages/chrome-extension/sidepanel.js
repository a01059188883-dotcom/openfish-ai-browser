const API = "http://127.0.0.1:8787";
const $ = id => document.getElementById(id);
let currentPlan = null;
async function request(path, body = {}, method = "POST") {
  const response = await fetch(API + path, { method, headers:{"content-type":"application/json"}, ...(method === "GET" ? {} : {body:JSON.stringify(body)}) });
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
async function browserAction(action) {
  const button = $(action === "go_back" ? "back" : action === "go_forward" ? "forward" : "reload");
  const label = button.textContent;
  button.disabled = true;
  try {
    const data = await request("/api/mcp/" + action, {});
    $("page").textContent = `${data.title || ""}\\n${data.url || ""}\\n\\n${data.message || "网页操作完成。"}`;
  } catch (error) { $("page").textContent = "操作失败：" + error.message; }
  finally { button.disabled = false; button.textContent = label; }
}
$("back").addEventListener("click", () => browserAction("go_back"));
$("forward").addEventListener("click", () => browserAction("go_forward"));
$("reload").addEventListener("click", () => browserAction("reload_page"));

async function refreshTabs() {
  const list = $("tabsList"); list.textContent = "正在读取标签页…";
  try {
    const data = await request("/api/mcp/list_tabs", {}, "GET"); list.replaceChildren();
    if (!data.tabs || !data.tabs.length) { const empty = document.createElement("p"); empty.className = "hint"; empty.textContent = "当前没有标签页"; list.append(empty); return; }
    for (const tab of data.tabs) {
      const row = document.createElement("div"); row.className = "tab-row" + (tab.active ? " active" : "");
      const select = document.createElement("button"); select.type = "button"; select.className = "tab-select";
      const title = document.createElement("strong"); title.textContent = tab.title || "新标签页";
      const url = document.createElement("span"); url.textContent = tab.url || "about:blank";
      select.append(title, url);
      select.addEventListener("click", async () => { try { await request("/api/mcp/switch_tab", {index:tab.index}); await refreshTabs(); } catch(e) { list.textContent = e.message; } });
      const close = document.createElement("button"); close.type = "button"; close.className = "tab-close compact"; close.textContent = "关闭"; close.disabled = data.tabs.length <= 1;
      close.addEventListener("click", async () => { if (!window.confirm("确认关闭这个标签页？")) return; try { await request("/api/mcp/close_tab", {index:tab.index,approved:true}); await refreshTabs(); } catch(e) { list.textContent = e.message; } });
      row.append(select, close); list.append(row);
    }
  } catch(error) { list.textContent = "标签页读取失败：" + error.message; }
}
$("refreshTabs").addEventListener("click", refreshTabs);
$("newTab").addEventListener("click", async () => {
  const button = $("newTab"); button.disabled = true;
  try { const url = $("newTabUrl").value.trim(); await request("/api/mcp/new_tab", url ? {url} : {}); $("newTabUrl").value = ""; await refreshTabs(); }
  catch(error) { $("tabsList").textContent = "新建失败：" + error.message; }
  finally { button.disabled = false; }
});
health();
refreshTabs();

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
