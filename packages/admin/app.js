const $ = id => document.getElementById(id);
const TEMPLATE_KEY = "openfish.taskTemplates.v1";
let plan = null;
let pollBusy = false;

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
  const body = $("events");
  body.replaceChildren();
  if (!events.length) {
    const row = document.createElement("tr");
    const cell = textNode("td", "暂无活动记录，执行操作后会显示在这里", "muted");
    cell.colSpan = 4;
    row.append(cell);
    body.append(row);
    return;
  }
  for (const event of events) {
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
    $("mode").textContent = status.browser?.remote ? "远程" : "本地";
    $("version").textContent = status.version || "1.2.0";
    const events = Array.isArray(activity.events) ? activity.events : [];
    renderEvents(events);
    drawBars(events);
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
renderTemplates();
refresh();
window.setInterval(refresh, 10000);
