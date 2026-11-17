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
function formatBytes(value) { const n=Number(value)||0; return n<1024?n+" B":n<1024*1024?(n/1024).toFixed(1)+" KB":(n/1024/1024).toFixed(1)+" MB"; }
async function refreshWorkspaces() {
  const host=$("workspaceList"); host.textContent="正在读取…";
  try { const data=await request("/api/mcp/list_workspaces",{}, "GET"); host.replaceChildren(); const items=data.workspaces||[]; if(!items.length){const p=document.createElement("p");p.className="hint";p.textContent="还没有保存的工作区";host.append(p);return;}
    for(const item of items){const row=document.createElement("div");row.className="workspace-row";const info=document.createElement("div");info.className="workspace-info";const name=document.createElement("strong");name.textContent=item.name;const count=document.createElement("span");count.textContent=(item.tabs||[]).length+" 个标签";info.append(name,count);const actions=document.createElement("div");actions.className="workspace-actions";const restore=document.createElement("button");restore.type="button";restore.textContent="恢复";restore.addEventListener("click",async()=>{if(!window.confirm("恢复工作区将新建其保存的标签页，不会关闭当前标签。继续？"))return;try{await request("/api/mcp/restore_workspace",{id:item.id,approved:true});await refreshTabs();}catch(e){host.textContent=e.message;}});const remove=document.createElement("button");remove.type="button";remove.className="danger";remove.textContent="删除";remove.addEventListener("click",async()=>{if(!window.confirm("确定删除这个工作区快照？"))return;try{await request("/api/mcp/remove_workspace",{id:item.id,approved:true});await refreshWorkspaces();}catch(e){host.textContent=e.message;}});actions.append(restore,remove);row.append(info,actions);host.append(row);}
  } catch(e){host.textContent="工作区读取失败："+e.message;}
}
$("saveWorkspace").addEventListener("click",async()=>{const name=$("workspaceName").value.trim();if(!name){$("workspaceName").focus();return;}const button=$("saveWorkspace");button.disabled=true;try{await request("/api/mcp/save_workspace",{name});$("workspaceName").value="";await refreshWorkspaces();}catch(e){$("workspaceList").textContent="保存失败："+e.message;}finally{button.disabled=false;}});
$("refreshWorkspaces").addEventListener("click",refreshWorkspaces);
async function refreshDownloads(){const host=$("downloadsList");host.textContent="正在读取…";try{const data=await request("/api/mcp/list_downloads",{}, "GET");host.replaceChildren();const items=data.downloads||[];if(!items.length){const p=document.createElement("p");p.className="hint";p.textContent="暂无下载文件";host.append(p);return;}for(const item of items){const row=document.createElement("div");row.className="download-row";const info=document.createElement("div");info.className="download-info";const name=document.createElement("strong");name.textContent=item.filename;const meta=document.createElement("span");meta.textContent=formatBytes(item.size)+" · "+new Date(item.createdAt).toLocaleString();info.append(name,meta);const remove=document.createElement("button");remove.type="button";remove.className="compact danger";remove.textContent="删除";remove.addEventListener("click",async()=>{if(!window.confirm("确定删除本机下载文件“"+item.filename+"”？"))return;try{await request("/api/mcp/remove_download",{id:item.id,approved:true});await refreshDownloads();}catch(e){host.textContent=e.message;}});row.append(info,remove);host.append(row);}}catch(e){host.textContent="下载记录读取失败："+e.message;}}
$("refreshDownloads").addEventListener("click",refreshDownloads);
$("downloadLink").addEventListener("click",async()=>{const selector=$("downloadSelector").value.trim();if(!selector){$("downloadSelector").focus();return;}if(!window.confirm("将点击匹配的网页链接并下载文件到本机 OpenFish 下载目录。确认继续？"))return;const button=$("downloadLink");button.disabled=true;button.textContent="下载中…";try{const result=await request("/api/mcp/download_link",{selector,approved:true});$("downloadsList").textContent="下载完成："+result.filename+"（"+formatBytes(result.size)+"）";await refreshDownloads();}catch(e){$("downloadsList").textContent="下载失败："+e.message;}finally{button.disabled=false;button.textContent="下载选中的链接";}});
$("clearSessionData").addEventListener("click",async()=>{if(!window.confirm("这会清除当前隔离浏览器会话的 Cookie、站点存储、缓存和 Service Worker 注册，但不会删除书签和下载文件。确定继续？"))return;const button=$("clearSessionData");button.disabled=true;try{const data=await request("/api/mcp/clear_session_data",{approved:true});$("page").textContent="会话数据已清理。处理页面数："+data.pages+"。";}catch(e){$("page").textContent="清理失败："+e.message;}finally{button.disabled=false;}});
$("findInPage").addEventListener("click",async()=>{const query=$("findInPageQuery").value.trim();if(!query)return;$("findInPage").disabled=true;try{const data=await request("/api/mcp/find_in_page",{query});$("page").textContent="找到 "+data.totalMatches+" 处匹配\\n"+(data.matches||[]).map((item,i)=>(i+1)+". "+item.snippet).join("\\n\\n");}catch(e){$("page").textContent="查找失败："+e.message;}finally{$("findInPage").disabled=false;}});
$("findInPageQuery").addEventListener("keydown",event=>{if(event.key==="Enter")$("findInPage").click();});
$("exportLibrary").addEventListener("click",async()=>{const button=$("exportLibrary");button.disabled=true;try{const data=await request("/api/library/export",{}, "GET");const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download="openfish-browser-backup-"+new Date().toISOString().slice(0,10)+".json";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){$("libraryList").textContent="导出失败："+e.message;}finally{button.disabled=false;}});
$("importLibraryButton").addEventListener("click",()=>$("importLibraryFile").click());
$("importLibraryFile").addEventListener("change",async()=>{const file=$("importLibraryFile").files?.[0];if(!file)return;if(file.size>1024*1024){$("libraryList").textContent="备份文件超过 1 MB 限制。";return;}try{const data=JSON.parse(await file.text());if(!window.confirm("导入备份会合并书签、历史、稍后阅读和工作区，不会导入 Cookie 或下载文件。继续？"))return;const result=await request("/api/library/import",{data,approved:true});$("libraryList").textContent="导入完成："+JSON.stringify(result.imported);await refreshLibrary();await refreshWorkspaces();}catch(e){$("libraryList").textContent="导入失败："+e.message;}finally{$("importLibraryFile").value="";}});
function renderCommandResults(){const host=$("commandResults");host.replaceChildren();const q=$("commandSearch").value.trim().toLowerCase();const items=[
{label:"新建标签页",keywords:"new tab",target:"newTab"},{label:"搜索标签页",keywords:"tabs search",target:"tabsSearch"},{label:"恢复最近关闭标签",keywords:"restore reopen",target:"restoreClosedTab"},{label:"复制当前标签列表",keywords:"duplicate tab",target:"refreshTabs"},{label:"读取网页内容",keywords:"inspect read",target:"inspect"},{label:"网页截图",keywords:"screenshot capture",target:"captureScreenshot"},{label:"阅读模式",keywords:"reader article",target:"readerMode"},{label:"页面诊断",keywords:"diagnostics errors console",target:"pageDiagnostics"},{label:"性能分析",keywords:"performance speed",target:"pagePerformance"},{label:"查找网页文字",keywords:"find search text",target:"findInPageQuery"},{label:"保存工作区",keywords:"workspace save",target:"workspaceName"},{label:"导出资料库备份",keywords:"export backup bookmarks history",target:"exportLibrary"},{label:"导入资料库备份",keywords:"import backup",target:"importLibraryButton"},{label:"下载管理",keywords:"download files",target:"downloadSelector"},{label:"清理会话数据",keywords:"privacy clear cookies storage",target:"clearSessionData"},{label:"刷新浏览器资料库",keywords:"refresh bookmarks history",target:"refreshLibrary"}
];for(const item of items.filter(x=>!q||(x.label+" "+x.keywords).toLowerCase().includes(q))){const button=document.createElement("button");button.type="button";button.className="command-item";button.textContent=item.label;button.addEventListener("click",()=>{ $("commandPalette").hidden=true;const target=$(item.target);if(["tabsSearch","findInPageQuery","workspaceName","downloadSelector","newTabUrl"].includes(item.target))target.focus();else target.click();});host.append(button);}if(!host.children.length){const p=document.createElement("p");p.className="hint";p.textContent="没有匹配的命令";host.append(p);}}
function openCommandPalette(){$("commandPalette").hidden=false;$("commandSearch").value="";renderCommandResults();$("commandSearch").focus();}
$("openCommandPalette").addEventListener("click",openCommandPalette);$("closeCommandPalette").addEventListener("click",()=>$("commandPalette").hidden=true);$("commandSearch").addEventListener("input",renderCommandResults);
document.addEventListener("keydown",event=>{const mod=event.ctrlKey||event.metaKey;const key=event.key.toLowerCase();if(mod&&key==="k"){event.preventDefault();openCommandPalette();}else if(event.key==="Escape"&&!$("commandPalette").hidden){$("commandPalette").hidden=true;}else if(mod&&event.shiftKey&&key==="t"){event.preventDefault();$("restoreClosedTab").click();}else if(mod&&key==="l"&&document.activeElement?.tagName!=="INPUT"&&document.activeElement?.tagName!=="TEXTAREA"){event.preventDefault();$("newTabUrl").focus();}else if(mod&&event.shiftKey&&key==="s"){event.preventDefault();$("workspaceName").focus();}});
health();
refreshTabs();
refreshLibrary();
refreshWorkspaces();
refreshDownloads();

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
