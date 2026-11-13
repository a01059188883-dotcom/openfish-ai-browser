const API = "http://127.0.0.1:8787";
const $ = id => document.getElementById(id);
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
$("run").addEventListener("click", async () => {
  const goal = $("goal").value.trim(); if (!goal) return $("result").textContent = "请先输入任务。";
  $("result").textContent = "正在调用本地 AI 生成计划…";
  try { const [tab] = await chrome.tabs.query({active:true,currentWindow:true}); const data = await request("/api/plan",{goal,url:tab?.url?.startsWith("http") ? tab.url : undefined}); $("result").textContent = JSON.stringify(data,null,2); }
  catch(e) { $("result").textContent = e.message; }
});
health();
