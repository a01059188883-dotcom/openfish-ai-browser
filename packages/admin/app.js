const $ = id => document.getElementById(id);
const TEMPLATE_KEY = "openfish.taskTemplates.v1";
let plan = null;
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
    if ($("clientCount")) $("clientCount").textContent = status.clientCount ?? 0;
    $("mode").textContent = status.browser?.remote ? "远程" : "本地";
    $("version").textContent = status.version || "2.3.0";
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
    $("plan").textContent = JSON.stringify(result, null, 2);
    $("approve").disabled = false;
  } catch (error) {
    plan = null;
    $("plan").textContent = "生成失败：" + error.message;
  } finally {
    $("makePlan").disabled = false;
    refresh();
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
    const result = await api("/api/execute", { plan: approvedPlan, approved: true });
    $("plan").textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    $("plan").textContent = "执行失败：" + error.message;
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
