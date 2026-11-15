const LOCAL_API = "http://127.0.0.1:8787";
const $ = id => document.getElementById(id);
let currentPlan = null;
let cloud = { url: "", token: "", sessionId: "" };
function sessionId() {
  if (!cloud.sessionId) cloud.sessionId = "ext-" + crypto.randomUUID().replaceAll("-", "");
  return cloud.sessionId;
}
async function loadCloud() {
  const saved = await chrome.storage.local.get(["openfishCloudUrl","openfishCloudToken","openfishCloudSession"]);
  cloud = { url: saved.openfishCloudUrl || "", token: saved.openfishCloudToken || "", sessionId: saved.openfishCloudSession || "" };
  $("cloudUrl").value = cloud.url;
  $("cloudToken").value = cloud.token;
}
function apiBase() { return cloud.url ? cloud.url.replace(/\/$/, "") : LOCAL_API; }
async function request(path, body = {}, method = "POST") {
  const headers = { "content-type": "application/json" };
  if (cloud.url) headers.authorization = "Bearer " + cloud.token;
  const response = await fetch(apiBase() + path, { method, headers, body: method === "POST" ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}
async function cloudRun(steps, approved = false) {
  return request("/api/v1/execute", { session_id: sessionId(), steps, approved });
}
async function health() {
  try {
    const headers = cloud.url ? { authorization: "Bearer " + cloud.token } : {};
    const r = await fetch(apiBase() + "/health", { headers });
    if (!r.ok) throw new Error();
    $("status").textContent = cloud.url ? "Cloudflare 云端已连接" : "本地服务已连接";
  } catch { $("status").textContent = cloud.url ? "云端服务未连接" : "本地服务未启动"; }
}
$("saveCloud").addEventListener("click", async () => {
  try {
    const raw = $("cloudUrl").value.trim();
    const token = $("cloudToken").value.trim();
    if (raw) {
      const parsed = new URL(raw);
      if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("请填写 HTTPS Worker 根地址，不要添加路径。");
      if (token.length < 24) throw new Error("API Token 至少需要 24 个字符。");
      const granted = await chrome.permissions.request({ origins: [parsed.origin + "/*"] });
      if (!granted) throw new Error("未授予此 Worker 域名的访问权限。");
      cloud.url = parsed.origin; cloud.token = token; sessionId();
      await chrome.storage.local.set({ openfishCloudUrl: cloud.url, openfishCloudToken: cloud.token, openfishCloudSession: cloud.sessionId });
      $("status").textContent = "云端配置已保存";
    } else {
      cloud = { url: "", token: "", sessionId: "" };
      await chrome.storage.local.remove(["openfishCloudUrl","openfishCloudToken","openfishCloudSession"]);
      $("status").textContent = "已切换回本地模式";
    }
    await health();
  } catch (e) { $("status").textContent = e.message; }
});
$("inspect").addEventListener("click", async () => {
  $("page").textContent = "读取中…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (cloud.url) {
      if (!tab?.url?.startsWith("http")) throw new Error("当前标签页不是 HTTP(S) 网页。");
      const data = await cloudRun([{ action: "navigate", url: tab.url }, { action: "inspect" }]);
      $("page").textContent = JSON.stringify(data, null, 2);
    } else {
      if (tab?.url?.startsWith("http")) await request("/navigate", { url: tab.url });
      const data = await request("/api/inspect");
      $("page").textContent = `${data.title}\n${data.url}\n\n${data.text}`;
    }
  } catch (e) { $("page").textContent = e.message; }
});
$("goal").addEventListener("input", () => { currentPlan = null; $("execute").hidden = true; $("execute").disabled = true; });
$("run").addEventListener("click", async () => {
  currentPlan = null; $("execute").hidden = true; $("execute").disabled = true;
  const goal = $("goal").value.trim(); if (!goal) return $("result").textContent = "请先输入任务。";
  $("run").disabled = true; $("result").textContent = cloud.url ? "正在生成云端安全操作草案…" : "正在调用本地 AI 生成计划…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (cloud.url) {
      const steps = tab?.url?.startsWith("http") ? [{ action: "navigate", url: tab.url }, { action: "inspect" }] : [{ action: "inspect" }];
      currentPlan = { summary: goal, steps, session_id: sessionId(), warning: "云端预览版使用确定性操作草案，不会自动执行。请检查每一步。" };
    } else {
      currentPlan = await request("/api/plan", { goal, url: tab?.url?.startsWith("http") ? tab.url : undefined });
    }
    $("result").textContent = JSON.stringify(currentPlan, null, 2);
    $("execute").hidden = !Array.isArray(currentPlan.steps) || currentPlan.steps.length === 0;
    $("execute").disabled = $("execute").hidden;
  } catch (e) { currentPlan = null; $("execute").hidden = true; $("result").textContent = e.message; }
  finally { $("run").disabled = false; }
});
$("execute").addEventListener("click", async () => {
  if (!currentPlan?.steps?.length) return;
  const approved = window.confirm("请确认：你已逐条检查上方计划，并同意执行这些普通网页操作？付款、发送、删除、提交等高风险操作仍会被系统拦截。");
  if (!approved) return;
  const approvedPlan = currentPlan; $("result").textContent = "正在按审核计划逐步执行…"; $("execute").disabled = true; $("run").disabled = true;
  try {
    const data = cloud.url
      ? await cloudRun(approvedPlan.steps, true)
      : await request("/api/execute", { plan: approvedPlan, approved: true });
    $("result").textContent = JSON.stringify(data, null, 2);
  } catch (e) { $("result").textContent = e.message; }
  finally { currentPlan = null; $("execute").hidden = true; $("execute").disabled = true; $("run").disabled = false; }
});
await loadCloud();
health();
