const API = "http://127.0.0.1:8787";
const $ = id => document.getElementById(id);
let currentPlan = null;
let libraryTab = "bookmarks";
let libraryItems = [];
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

$("captureScreenshot").addEventListener("click", async () => {
  const button = $("captureScreenshot");
  const preview = $("screenshotPreview");
  button.disabled = true;
  button.textContent = "截图生成中…";
  try {
    const data = await request("/api/mcp/take_screenshot", {});
    if (!data.imageDataUrl || !data.imageDataUrl.startsWith("data:image/jpeg;base64,")) throw new Error("截图数据格式无效。");
    $("screenshotImage").src = data.imageDataUrl;
    $("screenshotCaption").textContent = data.url || "当前网页";
    preview.hidden = false;
  } catch (error) {
    preview.hidden = true;
    $("page").textContent = "截图失败：" + error.message;
  } finally {
    button.disabled = false;
    button.textContent = "网页截图";
  }
});
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
    $("page").textContent = `${data.title || ""}\n${data.url || ""}\n\n${data.message || "网页操作完成。"}`;
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
    const query = ($("tabsSearch")?.value || "").trim().toLowerCase();
    const visibleTabs = data.tabs.filter(tab => !query || (tab.title + " " + tab.url + " " + tab.groupName).toLowerCase().includes(query));
    if (!visibleTabs.length) { const empty=document.createElement("p"); empty.className="hint"; empty.textContent="没有匹配的标签页"; list.append(empty); return; }
    for (const tab of visibleTabs) {
      const row = document.createElement("div"); row.className = "tab-row" + (tab.active ? " active" : "");
      const select = document.createElement("button"); select.type = "button"; select.className = "tab-select";
      const title = document.createElement("strong"); title.textContent = (tab.pinned ? "📌 " : "") + (tab.groupName ? "[" + tab.groupName + "] " : "") + (tab.title || "新标签页");
      const url = document.createElement("span"); url.textContent = tab.url || "about:blank";
      select.append(title, url);
      select.addEventListener("click", async () => { try { await request("/api/mcp/switch_tab", {index:tab.index}); await refreshTabs(); } catch(e) { list.textContent = e.message; } });
      const close = document.createElement("button"); close.type = "button"; close.className = "tab-close compact"; close.textContent = "关闭"; close.disabled = data.tabs.length <= 1;
      close.addEventListener("click", async () => { if (!window.confirm("确认关闭这个标签页？")) return; try { await request("/api/mcp/close_tab", {index:tab.index,approved:true}); await refreshTabs(); } catch(e) { list.textContent = e.message; } });
      const duplicate = document.createElement("button"); duplicate.type = "button"; duplicate.className = "compact"; duplicate.textContent = "复制";
      duplicate.addEventListener("click", async () => { try { await request("/api/mcp/duplicate_tab", {index:tab.index}); await refreshTabs(); } catch(e) { list.textContent = e.message; } });
      const organize = document.createElement("button"); organize.type = "button"; organize.className = "compact"; organize.textContent = "分组";
      organize.addEventListener("click", async () => { const groupName = window.prompt("输入标签分组名称（留空取消分组）：", tab.groupName || ""); if (groupName === null) return; try { await request("/api/library/tab/organize", {url:tab.url,groupName,pinned:tab.pinned,approved:true}); await refreshTabs(); } catch(e) { list.textContent = e.message; } });
      const pin = document.createElement("button"); pin.type = "button"; pin.className = "compact"; pin.textContent = tab.pinned ? "取消固定" : "固定";
      pin.addEventListener("click", async () => { try { await request("/api/library/tab/organize", {url:tab.url,groupName:tab.groupName || "",pinned:!tab.pinned,approved:true}); await refreshTabs(); } catch(e) { list.textContent = e.message; } });
      const actions = document.createElement("div"); actions.className = "tab-actions"; actions.append(duplicate,organize,pin,close); row.append(select, actions); list.append(row);
    }
  } catch(error) { list.textContent = "标签页读取失败：" + error.message; }
}
$("refreshTabs").addEventListener("click", refreshTabs);
$("tabsSearch").addEventListener("input", refreshTabs);
$("restoreClosedTab").addEventListener("click", async () => { if (!window.confirm("恢复最近关闭的标签页？")) return; try { await request("/api/mcp/reopen_closed_tab", {approved:true}); await refreshTabs(); } catch(e) { $("tabsList").textContent = e.message; } });
$("newTab").addEventListener("click", async () => {
  const button = $("newTab"); button.disabled = true;
  try { const url = $("newTabUrl").value.trim(); await request("/api/mcp/new_tab", url ? {url} : {}); $("newTabUrl").value = ""; await refreshTabs(); }
  catch(error) { $("tabsList").textContent = "新建失败：" + error.message; }
  finally { button.disabled = false; }
});
async function getActivePageInfo() { const data = await request("/api/mcp/read_page", {}, "GET"); return { url: data.url, title: data.title || data.url }; }
function renderLibrary() {
  const host = $("libraryList"); host.replaceChildren(); const q = $("librarySearch").value.trim().toLocaleLowerCase();
  const rows = libraryItems.filter(item => !q || (item.title + " " + item.url).toLocaleLowerCase().includes(q));
  if (!rows.length) { const empty = document.createElement("p"); empty.className = "hint"; empty.textContent = "没有匹配的记录"; host.append(empty); return; }
  for (const item of rows) {
    const row = document.createElement("div"); row.className = "library-row"; const open = document.createElement("button"); open.type = "button"; open.className = "library-open";
    const title = document.createElement("strong"); title.textContent = item.title || item.url; const url = document.createElement("span"); url.textContent = item.url; open.append(title,url);
    open.addEventListener("click", async () => { try { await request("/api/mcp/open_page", {url:item.url}); await refreshTabs(); } catch(e) { host.textContent = e.message; } });
    row.append(open);
    if (libraryTab !== "history") { const remove = document.createElement("button"); remove.type = "button"; remove.className = "compact"; remove.textContent = "移除"; remove.addEventListener("click", async () => { if (!window.confirm("确定从资料库移除此项？")) return; try { await request(libraryTab === "bookmarks" ? "/api/library/bookmarks/remove" : "/api/library/reading-list/remove", {id:item.id,approved:true}); await refreshLibrary(); } catch(e) { host.textContent = e.message; } }); row.append(remove); }
    host.append(row);
  }
}
async function refreshLibrary() {
  const host = $("libraryList"); host.textContent = "正在读取…";
  try { const path = libraryTab === "bookmarks" ? "/api/library/bookmarks" : libraryTab === "reading" ? "/api/library/reading-list" : "/api/library/history?limit=200"; const data = await request(path, {}, "GET"); libraryItems = libraryTab === "bookmarks" ? data.bookmarks : libraryTab === "reading" ? data.items : data.history; renderLibrary(); }
  catch(e) { host.textContent = "资料库读取失败：" + e.message; }
}
document.querySelectorAll("[data-library-tab]").forEach(button => button.addEventListener("click", () => { libraryTab = button.dataset.libraryTab; document.querySelectorAll("[data-library-tab]").forEach(item => item.classList.toggle("selected", item === button)); refreshLibrary(); }));
$("librarySearch").addEventListener("input", renderLibrary); $("refreshLibrary").addEventListener("click", refreshLibrary);
$("saveBookmark").addEventListener("click", async () => { try { const page = await getActivePageInfo(); await request("/api/library/bookmarks/add", page); document.querySelector('[data-library-tab="bookmarks"]').click(); } catch(e) { $("libraryList").textContent = e.message; } });
$("saveReading").addEventListener("click", async () => { try { const page = await getActivePageInfo(); await request("/api/library/reading-list/add", page); document.querySelector('[data-library-tab="reading"]').click(); } catch(e) { $("libraryList").textContent = e.message; } });
$("readerMode").addEventListener("click", async () => { const button=$("readerMode"); button.disabled=true; try { const data=await request("/api/mcp/extract_reader_content",{}, "GET"); $("page").textContent = data.title + "\n" + data.url + "\n" + (data.description ? data.description + "\n\n" : "") + data.text; } catch(e) { $("page").textContent="阅读模式失败："+e.message; } finally { button.disabled=false; } });
$("pageDiagnostics").addEventListener("click", async () => { const button=$("pageDiagnostics"); button.disabled=true; try { const data=await request("/api/mcp/get_page_diagnostics",{}, "GET"); $("page").textContent = data.diagnostics.length ? JSON.stringify(data.diagnostics,null,2) : "当前页面未发现控制台错误、页面异常或 HTTP 请求错误。"; } catch(e) { $("page").textContent="页面诊断失败："+e.message; } finally { button.disabled=false; } });
$("pagePerformance").addEventListener("click", async () => { const button=$("pagePerformance"); button.disabled=true; try { const data=await request("/api/mcp/get_page_performance",{}, "GET"); $("page").textContent=JSON.stringify(data,null,2); } catch(e) { $("page").textContent="性能分析失败："+e.message; } finally { button.disabled=false; } });
health();
refreshTabs();
refreshLibrary();

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
