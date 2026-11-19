(()=>{
"use strict";
const $=id=>document.getElementById(id), TOKEN_KEY="openfish.relay.token", BOOKMARK_KEY="openfish.bookmarks", HISTORY_KEY="openfish.history.v1", SEARCH_KEY="openfish.searchEngine";
let token=sessionStorage.getItem(TOKEN_KEY)||"",currentUrl="",lastView=null,busy=false,readerMode=false;
const readStore=(key,fallback)=>{try{const v=JSON.parse(localStorage.getItem(key)||"null");return Array.isArray(v)?v:fallback}catch{return fallback}};
let bookmarks=readStore(BOOKMARK_KEY,[]),historyItems=readStore(HISTORY_KEY,[]);
const toast=message=>{const el=$("toast");el.textContent=String(message);el.classList.add("show");clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove("show"),2600)};
const setState=(message,provider)=>{$("state").textContent=message;if(provider)$("provider").textContent=provider};
const save=(key,value)=>localStorage.setItem(key,JSON.stringify(value));
async function api(path,body){
 if(!token){token=prompt("请输入 Cloudflare Relay Token（与管理后台使用的 Token 相同）")||"";if(!token)throw Error("需要 Relay Token 才能使用云端浏览器");sessionStorage.setItem(TOKEN_KEY,token)}
 const response=await fetch(path,{method:body===undefined?"GET":"POST",headers:{"Authorization":"Bearer "+token,...(body===undefined?{}:{"Content-Type":"application/json"})},body:body===undefined?undefined:JSON.stringify(body),cache:"no-store"});
 const data=await response.json().catch(()=>({}));
 if(!response.ok){if(response.status===401){sessionStorage.removeItem(TOKEN_KEY);token=""}throw Error(data.error||("HTTP "+response.status))}
 return data;
}
function renderTabs(tabs=[]){
 const host=$("tabs");host.replaceChildren();
 if(!tabs.length){const empty=document.createElement("span");empty.className="muted";empty.textContent="尚无标签页";host.append(empty);return}
 tabs.forEach(tab=>{
  const item=document.createElement("div");item.className="tab-item"+(tab.active?" active":"");
  const select=document.createElement("button");select.className="tab-select";select.textContent=(tab.title||tab.url||"新标签页").slice(0,28);select.title=tab.url||tab.title||"新标签页";select.addEventListener("click",()=>act("switchTab",{index:tab.index}));
  const close=document.createElement("button");close.className="tab-close";close.type="button";close.textContent="×";close.setAttribute("aria-label","关闭标签页");close.addEventListener("click",event=>{event.stopPropagation();act("closeTab",{index:tab.index})});
  item.append(select,close);host.append(item);
 });
}
function render(d){
 lastView=d;currentUrl=d.url||currentUrl;$("url").value=currentUrl;$("pageTitle").textContent=d.title||"网页";$("pageUrl").textContent=currentUrl;$("pageText").textContent=d.text||"网页未返回可见文本";
 const viewport=$("viewport");viewport.replaceChildren();
 if(readerMode){const article=document.createElement("article");article.className="reader-content";const h=document.createElement("h2");h.textContent=d.title||"网页阅读";const p=document.createElement("p");p.textContent=d.text||"当前页面没有可提取的文字。";article.append(h,p);viewport.append(article)}
 else if(d.screenshot){const img=document.createElement("img");img.alt="当前网页截图；点击网页位置可交互";img.src="data:image/jpeg;base64,"+d.screenshot;img.addEventListener("click",event=>{const rect=img.getBoundingClientRect();const x=Math.round((event.clientX-rect.left)/rect.width*1280),y=Math.round((event.clientY-rect.top)/rect.height*820);$("coords").textContent="位置 "+x+", "+y;act("click",{x,y})});viewport.append(img)}
 const links=$("links");links.replaceChildren();(d.links||[]).slice(0,30).forEach(link=>{const a=document.createElement("a");a.href="#";a.textContent=(link.text||"网页链接")+" · "+link.href;a.addEventListener("click",event=>{event.preventDefault();navigate(link.href)});links.append(a)});
 renderTabs(d.tabs||[]);setState("浏览器在线",d.provider||"云端浏览器已连接");
}
async function run(path,body){if(busy)return;busy=true;setState("正在处理…");try{const data=await api(path,body);if(data.screenshot)render(data);else if(path.endsWith("/status"))setState(data.connected?"会话已连接":"浏览器待机",data.provider||"云端浏览器");else toast("操作完成");return data}catch(error){toast(error.message);setState("等待操作");throw error}finally{busy=false}}
function searchUrl(value){const engine=$("searchEngine").value;const q=encodeURIComponent(value);return engine==="bing"?"https://www.bing.com/search?q="+q:engine==="duckduckgo"?"https://duckduckgo.com/?q="+q:"https://www.google.com/search?q="+q}
async function navigate(raw){let value=String(raw||"").trim();if(!value)return;if(!/^https?:\/\//i.test(value)){if(value.includes(".")&&!value.includes(" "))value="https://"+value;else value=searchUrl(value)}$("url").value=value;try{const data=await run("/api/cloud-browser/navigate",{url:value});if(data){recordHistory({url:data.url||value,title:data.title||value});renderHistory()}}catch{}}
async function act(action,extra={}){try{return await run("/api/cloud-browser/action",{action,...extra})}catch{return null}}
function recordHistory(item){if(!item.url)return;historyItems=historyItems.filter(x=>x.url!==item.url);historyItems.unshift({url:item.url,title:item.title||item.url,visitedAt:new Date().toISOString()});historyItems=historyItems.slice(0,100);save(HISTORY_KEY,historyItems)}
function renderCollection(hostId,items,query,kind){const host=$(hostId);host.replaceChildren();const q=String(query||"").trim().toLowerCase();const filtered=items.filter(x=>(x.title+" "+x.url).toLowerCase().includes(q));if(!filtered.length){const span=document.createElement("span");span.className="muted";span.textContent=kind==="bookmark"?"没有匹配的收藏":"没有匹配的浏览记录";host.append(span);return}
 filtered.slice(0,100).forEach(item=>{const row=document.createElement("div");row.className="library-row";const link=document.createElement("a");link.href="#";link.textContent=(item.title||item.url)+" · "+item.url;link.addEventListener("click",e=>{e.preventDefault();navigate(item.url)});const action=document.createElement("button");action.className="row-delete";action.textContent=kind==="bookmark"?"删除":"移除";action.addEventListener("click",()=>{if(kind==="bookmark"){bookmarks=bookmarks.filter(x=>x.url!==item.url);save(BOOKMARK_KEY,bookmarks);renderBookmarks()}else{historyItems=historyItems.filter(x=>x.url!==item.url);save(HISTORY_KEY,historyItems);renderHistory()}});row.append(link,action);host.append(row)})}
function renderBookmarks(){renderCollection("bookmarks",bookmarks,$("bookmarkSearch").value,"bookmark");$("bookmarkCount").textContent=String(bookmarks.length)}
function renderHistory(){renderCollection("history",historyItems,$("historySearch").value,"history")}
$("go").addEventListener("click",()=>navigate($("url").value));$("url").addEventListener("keydown",e=>{if(e.key==="Enter")navigate($("url").value)});
$("back").addEventListener("click",()=>act("back"));$("forward").addEventListener("click",()=>act("forward"));$("reload").addEventListener("click",()=>act("reload"));$("start").addEventListener("click",()=>navigate("https://example.com"));$("newTab").addEventListener("click",()=>{readerMode=false;navigate("https://example.com")});$("addTab").addEventListener("click",()=>act("newTab"));
$("closeBrowser").addEventListener("click",async()=>{if(!confirm("结束云端浏览器会话？当前网页会关闭。"))return;try{await api("/api/cloud-browser/close",{});$("viewport").innerHTML='<div class="empty"><div class="orb">◉</div><h2>会话已结束</h2><p>再次输入网址即可启动新的浏览器会话</p></div>';currentUrl="";lastView=null;setState("已结束","浏览器待机")}catch(error){toast(error.message)}});
$("bookmark").addEventListener("click",()=>{if(!currentUrl)return toast("请先打开网页");if(bookmarks.some(x=>x.url===currentUrl))return toast("该网页已收藏");bookmarks.unshift({url:currentUrl,title:$("pageTitle").textContent,createdAt:new Date().toISOString()});bookmarks=bookmarks.slice(0,200);save(BOOKMARK_KEY,bookmarks);renderBookmarks();toast("已收藏到本机")});
$("screenshot").addEventListener("click",()=>{if(!lastView?.screenshot)return toast("当前没有网页截图");const a=document.createElement("a");a.href="data:image/jpeg;base64,"+lastView.screenshot;a.download="openfish-screenshot.jpg";a.click()});
$("copyText").addEventListener("click",async()=>{const text=$("pageText").textContent;if(!text||text.startsWith("打开网页"))return toast("当前没有可复制的页面文字");try{await navigator.clipboard.writeText(text);toast("页面文字已复制")}catch{toast("复制失败，请检查浏览器剪贴板权限")}});
$("reader").addEventListener("click",()=>{if(!lastView)return toast("请先打开网页");readerMode=!readerMode;render(lastView);$("reader").textContent=readerMode?"截图视图":"阅读"});
$("scrollUp").addEventListener("click",()=>act("scroll",{deltaY:-650}));$("scrollDown").addEventListener("click",()=>act("scroll",{deltaY:650}));
$("sendText").addEventListener("click",()=>{const text=$("typing").value;if(!text)return;act("type",{text});$("typing").value=""});$("typing").addEventListener("keydown",e=>{if(e.key==="Enter")$("sendText").click()});
$("enter").addEventListener("click",()=>act("press",{key:"Enter"}));$("tabKey").addEventListener("click",()=>act("press",{key:"Tab"}));$("escKey").addEventListener("click",()=>act("press",{key:"Escape"}));$("pageUp").addEventListener("click",()=>act("press",{key:"PageUp"}));$("pageDown").addEventListener("click",()=>act("press",{key:"PageDown"}));$("refreshInfo").addEventListener("click",()=>act("reload"));
document.querySelectorAll("[data-url]").forEach(button=>button.addEventListener("click",()=>navigate(button.dataset.url)));
document.querySelectorAll("[data-view]").forEach(button=>button.addEventListener("click",()=>{document.querySelectorAll("[data-view]").forEach(x=>x.classList.toggle("active",x===button));$("pageText").classList.toggle("hidden",button.dataset.view==="links");$("links").classList.toggle("hidden",button.dataset.view!=="links");if(button.dataset.view==="reader"||button.dataset.view==="summary"){readerMode=button.dataset.view==="reader";if(lastView)render(lastView);$("reader").textContent=readerMode?"截图视图":"阅读"}}));
$("bookmarkSearch").addEventListener("input",renderBookmarks);$("historySearch").addEventListener("input",renderHistory);
$("clearHistory").addEventListener("click",()=>{if(!historyItems.length)return;if(!confirm("清空本机保存的浏览历史？"))return;historyItems=[];save(HISTORY_KEY,historyItems);renderHistory()});
const savedSearch=localStorage.getItem(SEARCH_KEY)||"google";$("searchEngine").value=savedSearch;$("searchEngineSetting").value=savedSearch;
$("searchEngine").addEventListener("change",()=>{$("searchEngineSetting").value=$("searchEngine").value;localStorage.setItem(SEARCH_KEY,$("searchEngine").value)});
$("searchEngineSetting").addEventListener("change",()=>{$("searchEngine").value=$("searchEngineSetting").value;localStorage.setItem(SEARCH_KEY,$("searchEngineSetting").value)});
async function boot(){renderBookmarks();renderHistory();try{const status=await api("/api/cloud-browser/status");setState(status.connected?"云端会话可恢复":"浏览器待机",status.provider||"云端浏览器");if(status.connected){const view=await api("/api/cloud-browser/view");if(view.screenshot){render(view);recordHistory({url:view.url,title:view.title});renderHistory()}}}catch(error){setState("需要连接");if(token)toast(error.message)}}
boot();
})();