const $ = id => document.getElementById(id);
const TEMPLATE_KEY = "openfish.taskTemplates.v1";
let plan = null;
let currentTaskId = null;
let taskSearchTimer = null;
let pollBusy = false;
let latestEvents = [];

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function textNode(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = String(value ?? "");
  if (className) node.className = className;
  return node;
}
function fmtTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}
function drawBars(events) {
  const counts = Array(12).fill(0);
  events.slice().reverse().forEach((event, index) => counts[index % 12]++);
  const max = Math.max(1, ...counts);
  const bars = $("bars");
  bars.replaceChildren();
  counts.forEach(count => {
    const bar = document.createElement("i");
    bar.style.height = `${Math.max(8, Math.round(count / max * 100))}%`;
    bars.append(bar);
  });
}
function renderEvents(events) {
  const filter = ($("eventFilter")?.value || "").trim().toLocaleLowerCase();
  const filtered = events.filter(event => !filter || String(event.path || "").toLocaleLowerCase().includes(filter) || String(event.status ?? "").includes(filter));
  $("eventCount").textContent = `${filtered.length} / ${events.length} 条记录`;
  const body = $("events");
  body.replaceChildren();
  if (!filtered.length) {
    const row = document.createElement("tr");
    const cell = textNode("td", filter ? "没有匹配的日志记录" : "暂无活动记录，执行操作后会显示在这里", "muted");
    cell.colSpan = 4;
    row.append(cell);
    body.append(row);
    return;
  }
  for (const event of filtered) {
    const row = document.createElement("tr");
    row.append(
      textNode("td", fmtTime(event.time)),
      textNode("td", event.path),
      textNode("td", event.status < 400 ? "成功" : "异常", event.status < 400 ? "status-good" : "status-bad"),
      textNode("td", event.status)
    );
    body.append(row);
  }
}
async function refresh() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const [status, activity] = await Promise.all([api("/api/admin/status"), api("/api/admin/events")]);
    $("connection").textContent = "服务已连接";
    $("connection").className = "pill ok";
    $("uptime").textContent = status.uptimeText ?? "—";
    $("requests").textContent = status.requests ?? 0;
    $("errors").textContent = status.errors ?? 0;
    $("browserState").textContent = status.browser?.connected ? "已连接" : "未启动";
    $("browserMode").textContent = status.browser?.remote ? "远程 Chromium" : "本地 Chromium";
    $("bridgeHealth").textContent = "正常";
    $("bridgeHealth").className = "status-good";
    $("browserHealth").textContent = status.browser?.connected ? "已连接" : "待启动";
    $("model").textContent = status.model || "未配置";
    $("ollamaHealth").textContent = status.ollama?.reachable ? (status.ollama.modelInstalled ? "已连接 · 模型就绪" : "已连接 · 缺少模型") : "不可达";
    $("ollamaHealth").className = status.ollama?.reachable && status.ollama.modelInstalled ? "status-good" : "status-bad";
    $("extensionHealth").textContent = status.extension?.connected ? "已连接 · " + (status.extension.version || "版本未知") : "未检测到连接";
    $("extensionHealth").className = status.extension?.connected ? "status-good" : "muted";
    if ($("clientCount")) $("clientCount").textContent = status.clientCount ?? 0;
    $("mode").textContent = status.browser?.remote ? "远程" : "本地";
    $("version").textContent = status.version || "2.16.0";
    latestEvents = Array.isArray(activity.events) ? activity.events : [];
    renderEvents(latestEvents);
    drawBars(latestEvents);
  } catch (error) {
    $("connection").textContent = "连接失败";
    $("connection").className = "pill pending";
    $("bridgeHealth").textContent = error.message;
    $("bridgeHealth").className = "status-bad";
  } finally {
    pollBusy = false;
  }
}
function invalidatePlan() {
  plan = null;
  currentTaskId = null;
  $("approve").disabled = true;
  $("plan").textContent = "任务已修改，请重新生成计划并审核。";
  $("plan").className = "plan empty";
}
$("goal").addEventListener("input", invalidatePlan);
$("makePlan").addEventListener("click", async () => {
  const goal = $("goal").value.trim();
  if (!goal) {
    $("plan").textContent = "请先填写任务描述";
    return;
  }
  invalidatePlan();
  $("makePlan").disabled = true;
  $("plan").textContent = "正在生成计划…";
  try {
    const result = await api("/api/plan", { goal });
    if (!Array.isArray(result.steps) || !result.steps.length) throw new Error("AI 未返回可执行步骤，请调整任务描述。");
    plan = result;
    currentTaskId = result.taskId || null;
    $("plan").textContent = JSON.stringify(result, null, 2);
    $("approve").disabled = false;
  } catch (error) {
    plan = null;
    $("plan").textContent = "生成失败：" + error.message;
  } finally {
    $("makePlan").disabled = false;
    refresh();
    loadTasks();
  }
});
$("approve").addEventListener("click", async () => {
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return;
  if (!window.confirm("请确认你已逐条检查完整计划，并批准执行。高风险操作仍会被拦截。")) return;
  const approvedPlan = plan;
  $("approve").disabled = true;
  $("makePlan").disabled = true;
  $("plan").textContent = "执行中…";
  try {
    const result = await api("/api/execute", { plan: approvedPlan, taskId: currentTaskId, approved: true });
    $("plan").textContent = JSON.stringify(result, null, 2);
    await loadTasks();
  } catch (error) {
    $("plan").textContent = "执行失败：" + error.message;
    await loadTasks();
  } finally {
    plan = null;
    $("makePlan").disabled = false;
    refresh();
  }
});
$("clear").addEventListener("click", () => {
  $("goal").value = "";
  invalidatePlan();
  $("plan").textContent = "等待生成任务计划…";
});
$("refresh").addEventListener("click", refresh);
$("refreshLog").addEventListener("click", refresh);
$("eventFilter").addEventListener("input", () => renderEvents(latestEvents));


function taskStatusLabel(status) {
  return ({ planned: "待审核", approved: "已批准", running: "执行中", succeeded: "成功", stopped: "已停止", failed: "失败" })[status] || status || "未知";
}
$("testOllama")?.addEventListener("click", async () => {
  const button = $("testOllama");
  button.disabled = true;
  button.textContent = "正在测试模型…";
  $("ollamaTestResult").textContent = "正在向本地 Ollama 发送最小测试提示…";
  try {
    const result = await api("/api/admin/ollama-test", {});
    $("ollamaTestResult").textContent = result.model + " · " + result.durationMs + " ms · " + result.response;
  } catch (error) { $("ollamaTestResult").textContent = "模型测试失败：" + error.message; }
  finally { button.disabled = false; button.textContent = "测试模型实际响应"; }
});
async function loadTasks() {
  const host = $("taskList");
  if (!host) return;
  try {
    const params = new URLSearchParams({ q: $("taskSearch")?.value || "", status: $("taskStatus")?.value || "", limit: "100" });
    const data = await api("/api/admin/tasks?" + params.toString());
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    $("taskCount").textContent = tasks.length + " 条 / 最多 " + (data.maxTasks || 500) + " 条";
    host.replaceChildren();
    if (!tasks.length) { host.append(textNode("p", "没有匹配的任务记录。", "muted")); return; }
    for (const task of tasks) {
      const row = document.createElement("div");
      row.className = "task-row";
      const details = document.createElement("div");
      details.className = "task-details";
      details.append(textNode("b", task.goal), textNode("small", task.id + " · " + fmtTime(task.createdAt) + " · " + (task.source || "unknown")));
      const state = textNode("span", taskStatusLabel(task.status), "task-status status-" + task.status);
      const actions = document.createElement("div");
      actions.className = "task-actions";
      const view = textNode("button", "查看");
      view.type = "button";
      view.addEventListener("click", async () => {
        try { const detail = await api("/api/admin/tasks/" + encodeURIComponent(task.id)); $("taskDetail").textContent = JSON.stringify(detail.task, null, 2); }
        catch (error) { $("taskDetail").textContent = "读取失败：" + error.message; }
      });
      const restore = textNode("button", "恢复计划", "primary");
      restore.type = "button";
      restore.disabled = !task.hasPlan && !task.plan;
      restore.addEventListener("click", async () => {
        restore.disabled = true;
        try {
          const result = await api("/api/admin/tasks/" + encodeURIComponent(task.id) + "/restore", {});
          plan = result.task.plan;
          currentTaskId = result.task.id;
          $("goal").value = result.task.goal;
          $("plan").textContent = JSON.stringify(result.task, null, 2);
          $("plan").className = "plan";
          $("approve").disabled = !plan?.steps?.length;
          $("taskDetail").textContent = JSON.stringify(result.task, null, 2);
          await loadTasks();
          $("goal").scrollIntoView({ behavior: "smooth", block: "center" });
        } catch (error) { window.alert("恢复失败：" + error.message); restore.disabled = false; }
      });
      actions.append(view, restore);
      row.append(details, state, actions);
      host.append(row);
    }
  } catch (error) { host.replaceChildren(textNode("p", "读取任务历史失败：" + error.message, "muted")); }
}
$("refreshTasks")?.addEventListener("click", loadTasks);
$("taskStatus")?.addEventListener("change", loadTasks);
$("taskSearch")?.addEventListener("input", () => {
  window.clearTimeout(taskSearchTimer);
  taskSearchTimer = window.setTimeout(loadTasks, 220);
});

async function loadToolCatalog() {
  const host = $("toolCatalog");
  const count = $("toolCount");
  if (!host || !count) return;
  try {
    const data = await api("/api/v1/tools");
    const tools = Array.isArray(data.tools) ? data.tools : [];
    count.textContent = tools.length + " 项工具";
    host.replaceChildren();
    for (const tool of tools) {
      const item = document.createElement("div");
      item.className = "tool-item";
      item.append(
        textNode("b", tool.name),
        textNode("span", tool.description),
        textNode("small", tool.approval === "explicit" ? "需要明确批准" : "只读 / 规划")
      );
      host.append(item);
    }
    if (!tools.length) host.append(textNode("p", "当前没有可用工具", "muted"));
  } catch (error) {
    count.textContent = "读取失败";
    host.replaceChildren(textNode("p", error.message, "muted"));
  }
}
function readTemplates() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TEMPLATE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item.id === "string" && typeof item.title === "string" && typeof item.goal === "string") : [];
  } catch {
    return [];
  }
}
function writeTemplates(items) {
  localStorage.setItem(TEMPLATE_KEY, JSON.stringify(items));
  renderTemplates();
}
function selectedTemplateId() {
  return $("templateSelect").value;
}
function renderTemplates() {
  const select = $("templateSelect");
  const selected = select.value;
  select.replaceChildren(new Option("选择模板…", ""));
  for (const item of readTemplates()) select.add(new Option(item.title, item.id));
  if (readTemplates().some(item => item.id === selected)) select.value = selected;
}
$("templateCreate").addEventListener("click", () => {
  const goal = $("goal").value.trim();
  if (!goal) return window.alert("先填写任务描述，再保存为模板。");
  const title = window.prompt("为任务模板命名：", goal.slice(0, 32));
  if (!title?.trim()) return;
  const items = readTemplates();
  items.unshift({ id: crypto.randomUUID(), title: title.trim().slice(0, 80), goal, updatedAt: new Date().toISOString() });
  writeTemplates(items);
  $("templateSelect").value = items[0].id;
});
$("templateLoad").addEventListener("click", () => {
  const item = readTemplates().find(entry => entry.id === selectedTemplateId());
  if (!item) return window.alert("请先选择一个任务模板。");
  $("goal").value = item.goal;
  invalidatePlan();
});
$("templateUpdate").addEventListener("click", () => {
  const id = selectedTemplateId();
  const goal = $("goal").value.trim();
  if (!id || !goal) return window.alert("请选择模板并填写新的任务内容。");
  const items = readTemplates();
  const index = items.findIndex(item => item.id === id);
  if (index < 0) return window.alert("模板不存在，可能已被删除。");
  items[index] = { ...items[index], goal, updatedAt: new Date().toISOString() };
  writeTemplates(items);
  $("templateSelect").value = id;
});
$("templateDelete").addEventListener("click", () => {
  const id = selectedTemplateId();
  if (!id) return window.alert("请先选择要删除的模板。");
  const items = readTemplates();
  const item = items.find(entry => entry.id === id);
  if (!item || !window.confirm(`确定删除模板“${item.title}”吗？`)) return;
  writeTemplates(items.filter(entry => entry.id !== id));
});
document.querySelectorAll("[data-copy]").forEach(button => button.addEventListener("click", async () => {
  const value = location.origin + button.dataset.copy;
  try {
    await navigator.clipboard.writeText(value);
    const previous = button.textContent;
    button.textContent = "已复制";
    window.setTimeout(() => button.textContent = previous, 1400);
  } catch {
    button.textContent = "复制失败，请手动复制";
  }
}));

function integrationConfigText() {
  const key = $("integrationApiKey")?.value.trim() || "";
  const url = $("integrationMcpUrl")?.value.trim() || "";
  const sessionId = $("integrationSession")?.value.trim() || "default";
  if (!key) throw new Error("请先粘贴 OpenFish API 密钥。");
  if (!/^https?:\/\//i.test(url) || !url.endsWith("/mcp")) throw new Error("MCP 地址必须是 http(s) URL，并以 /mcp 结尾。");
  if (sessionId !== "default" && !/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId)) throw new Error("浏览器会话 ID 格式不正确。");
  const headers = { Authorization: "Bearer " + key, "X-OpenFish-Client": $("integrationClient").value, "X-OpenFish-Platform": $("integrationClient").value };
  if (sessionId !== "default") headers["X-OpenFish-Session"] = sessionId;
  const config = { mcpServers: { "openfish-browser": { url, headers } } };
  return JSON.stringify(config, null, 2);
}
function refreshIntegrationConfig() {
  const output = $("integrationConfig");
  if (!output) return;
  try { output.textContent = integrationConfigText(); }
  catch (error) { output.textContent = error.message; }
}
$("generateIntegration")?.addEventListener("click", refreshIntegrationConfig);
["integrationClient", "integrationMcpUrl", "integrationApiKey", "integrationSession"].forEach(id => $(id)?.addEventListener("input", refreshIntegrationConfig));
$("copyIntegrationConfig")?.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(integrationConfigText()); $("copyIntegrationConfig").textContent = "已复制"; }
  catch (error) { window.alert("复制配置失败：" + error.message); }
});
function relayCurlCommand() {
  const base = $("relayWorkerUrl")?.value.trim().replace(/\/$/, "") || "";
  const token = $("relayAccessToken")?.value.trim() || "";
  if (!/^https:\/\//i.test(base)) throw new Error("Worker 地址必须使用 HTTPS。");
  if (!token) throw new Error("请先填写 Relay Token。");
  return "curl \"" + base + "/api/v1/browser/status\" \\\n  -H \"Authorization: Bearer " + token + "\"";
}
$("copyRelayCurl")?.addEventListener("click", async () => {
  try {
    const command = relayCurlCommand();
    $("relayConfigPreview").textContent = command;
    await navigator.clipboard.writeText(command);
    $("copyRelayCurl").textContent = "已复制";
  } catch (error) { $("relayConfigPreview").textContent = error.message; }
});
["relayWorkerUrl", "relayAccessToken"].forEach(id => $(id)?.addEventListener("input", () => {
  try { $("relayConfigPreview").textContent = relayCurlCommand(); }
  catch (error) { $("relayConfigPreview").textContent = error.message; }
}));
$("copyRestExample")?.addEventListener("click", async () => {
  try {
    const key = $("integrationApiKey").value.trim();
    const base = $("integrationMcpUrl").value.trim().replace(/\/mcp$/, "").replace(/:8788$/, ":8787");
    if (!key) throw new Error("请先粘贴 OpenFish API 密钥。");
    if (!/^https?:\/\//i.test(base)) throw new Error("请填写有效的服务地址。");
    const command = `curl -X POST "${base}/api/v1/tools/read_page" \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -H "X-OpenFish-Client: rest-client" \\\n  -d '{}'`;
    await navigator.clipboard.writeText(command);
    $("copyRestExample").textContent = "已复制";
  } catch (error) { window.alert("生成 REST 示例失败：" + error.message); }
});
async function loadApiKeys() {
  const host = $("keyList");
  if (!host) return;
  try {
    const data = await api("/api/admin/keys");
    host.replaceChildren();
    if (!data.keys?.length) {
      host.append(textNode("p", "还没有 API 密钥。创建后可供外部 AI 客户端调用 REST 工具接口。", "muted"));
      return;
    }
    for (const key of data.keys) {
      const row = document.createElement("div");
      row.className = "key-row";
      const details = document.createElement("div");
      details.className = "key-details";
      details.append(textNode("b", key.name), textNode("code", key.prefix + "••••••••"),
        textNode("small", "权限：" + key.scopes.join(", ") + " · 到期：" + fmtTime(key.expiresAt)));
      const status = key.revokedAt ? "已撤销" : Date.parse(key.expiresAt) <= Date.now() ? "已过期" : "有效";
      details.append(textNode("small", "状态：" + status + " · 最近使用：" + (key.lastUsedAt ? fmtTime(key.lastUsedAt) : "从未使用")));
      row.append(details);
      if (!key.revokedAt && Date.parse(key.expiresAt) > Date.now()) {
        const revoke = textNode("button", "撤销", "danger");
        revoke.type = "button";
        revoke.addEventListener("click", async () => {
          if (!window.confirm("确定撤销密钥“" + key.name + "”？撤销后无法恢复。")) return;
          revoke.disabled = true;
          try { await api("/api/admin/keys/" + encodeURIComponent(key.id) + "/revoke", {}); await loadApiKeys(); }
          catch (error) { window.alert("撤销失败：" + error.message); revoke.disabled = false; }
        });
        row.append(revoke);
      }
      host.append(row);
    }
  } catch (error) {
    host.replaceChildren(textNode("p", "读取密钥失败：" + error.message, "muted"));
  }
}
$("createKey")?.addEventListener("click", async () => {
  const name = $("keyName").value.trim();
  if (!name) return window.alert("请先填写密钥名称。");
  const scopes = $("keyScopes").value === "write" ? ["browser:read", "browser:write"] : ["browser:read"];
  const button = $("createKey");
  button.disabled = true;
  try {
    const result = await api("/api/admin/keys", { name, scopes, expiresInDays: Number($("keyExpiry").value) });
    const notice = $("newKeyNotice");
    notice.hidden = false;
    notice.replaceChildren(textNode("b", "密钥已生成，请立即复制保存（仅显示这一次）"), textNode("code", result.key, "new-key-value"));
    const copy = textNode("button", "复制密钥", "primary");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(result.key);
      copy.textContent = "已复制";
    });
    notice.append(copy);
    $("integrationApiKey").value = result.key;
    refreshIntegrationConfig();
    $("keyName").value = "";
    await loadApiKeys();
  } catch (error) {
    window.alert("生成失败：" + error.message);
  } finally { button.disabled = false; }
});


async function loadSessions() {
  const host = $("sessionList");
  if (!host) return;
  try {
    const data = await api("/api/browser/sessions");
    host.replaceChildren();
    if (!data.sessions?.length) {
      host.append(textNode("p", "尚无已创建的浏览器会话。", "muted"));
      return;
    }
    for (const session of data.sessions) {
      const row = document.createElement("div");
      row.className = "session-row";
      const details = document.createElement("div");
      details.className = "session-details";
      details.append(textNode("b", session.name || "浏览器会话"));
      details.append(textNode("code", session.id));
      details.append(textNode("small", "状态：" + (session.active ? "已启动" : "待启动") + " · 最近活动：" + (session.lastUsedAt ? fmtTime(session.lastUsedAt) : "尚无活动")));
      const actions = document.createElement("div");
      actions.className = "session-actions";
      const copy = textNode("button", "复制会话 ID");
      copy.type = "button";
      copy.addEventListener("click", async () => {
        await navigator.clipboard.writeText(session.id);
        copy.textContent = "已复制";
      });
      actions.append(copy);
      if (session.id !== "default") {
        const close = textNode("button", "关闭", "danger");
        close.type = "button";
        close.addEventListener("click", async () => {
          if (!window.confirm("确定关闭此会话？会清除该会话的页面与 Cookie。")) return;
          close.disabled = true;
          try {
            await api("/api/browser/sessions/" + encodeURIComponent(session.id) + "/close", {});
            await loadSessions();
          } catch (error) { window.alert("关闭会话失败：" + error.message); close.disabled = false; }
        });
        actions.append(close);
      }
      row.append(details, actions);
      host.append(row);
    }
  } catch (error) {
    host.replaceChildren(textNode("p", "读取会话失败：" + error.message, "muted"));
  }
}
$("createSession")?.addEventListener("click", async () => {
  const button = $("createSession");
  button.disabled = true;
  try {
    await api("/api/browser/sessions", { name: $("sessionName").value.trim() || "AI Client" });
    $("sessionName").value = "";
    await loadSessions();
  } catch (error) { window.alert("创建会话失败：" + error.message); }
  finally { button.disabled = false; }
});
$("refreshSessions")?.addEventListener("click", loadSessions);

async function loadClients() {
  const host = $("clientList");
  if (!host) return;
  try {
    const data = await api("/api/admin/clients");
    host.replaceChildren();
    const clients = Array.isArray(data.clients) ? data.clients : [];
    if (!clients.length) { host.append(textNode("p", "尚无 AI 客户端连接记录。客户端首次通过 MCP HTTP 或 REST 接口访问后会显示在这里。", "muted")); return; }
    for (const client of clients) {
      const row = document.createElement("div"); row.className = "session-row";
      const details = document.createElement("div"); details.className = "session-details";
      details.append(textNode("b", client.keyName + " · " + client.clientId), textNode("small", client.platform + " · 会话 " + client.sessionId), textNode("small", "最近活动：" + fmtTime(client.lastSeenAt) + " · 请求 " + client.requestCount + " 次"));
      const state = textNode("span", client.status === "connected" ? "在线" : "空闲", client.status === "connected" ? "status-good" : "muted");
      row.append(details, state); host.append(row);
    }
  } catch (error) { host.replaceChildren(textNode("p", "读取客户端失败：" + error.message, "muted")); }
}
$("refreshClients")?.addEventListener("click", loadClients);

renderTemplates();
loadToolCatalog();
loadApiKeys();
loadSessions();
loadClients();
refresh();
window.setInterval(refresh, 10000);
window.setInterval(loadClients, 15000);
