/* ============================================================================
   Peer-Stream 控制台 — 界面逻辑
   作为传统脚本加载（非 module），以便 HTML 内联事件处理器可调用这些全局函数。
   ========================================================================== */

// DOM查询缓存
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

// ─── Phase 4 安全：协议自适应 + 登录令牌 ──────────────────────────────────────
// 页面为 HTTPS 时，WebSocket 自动使用 wss
const WS_PROTO = location.protocol === "https:" ? "wss" : "ws";
const getToken = () => localStorage.getItem("ps-token") || "";
const setToken = (t) => (t ? localStorage.setItem("ps-token", t) : localStorage.removeItem("ps-token"));
// 携带令牌的请求头（未登录则为空，兼容未启用 token 的旧版服务端）
const authHeaders = () => (getToken() ? { authorization: "Bearer " + getToken() } : {});
// 最近一次加载的 signal.json，用于嵌套对象字段的局部合并
window._signalCache = window._signalCache || {};

// ─── 登录页 ───────────────────────────────────────────────────────────────
function showLogin() {
  const lv = $("#login-view");
  if (lv) lv.hidden = false;
  const app = $("#app");
  if (app) app.style.filter = "blur(2px)";
}
function hideLogin() {
  const lv = $("#login-view");
  if (lv) lv.hidden = true;
  const app = $("#app");
  if (app) app.style.filter = "";
}
function togglePass() {
  const i = $("#login-pass");
  if (i) i.type = i.type === "password" ? "text" : "password";
}
// 登录表单提交：账号密码换取令牌并存入 localStorage
async function doLogin(event) {
  if (event) event.preventDefault();
  const username = ($("#login-user")?.value || "").trim();
  const password = $("#login-pass")?.value || "";
  try {
    const res = await fetch("./login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw decodeURIComponent(res.headers.get("error") || "登录失败");
    const { token } = await res.json();
    setToken(token);
    toast("登录成功", "ok");
    hideLogin();
    route(); // 重新进入当前视图
  } catch (e) {
    toast(`登录失败: ${e}`, "err");
  }
  return false;
}

// ─── 主题切换 ───────────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.body.setAttribute("data-theme", theme);
  localStorage.setItem("ps-theme", theme);
  const btn = $("#themeToggle");
  if (btn) {
    btn.setAttribute("icon", theme === "dark" ? "🌙" : "☀️");
    btn.setAttribute("title", theme === "dark" ? "深色" : "浅色");
  }
}
function toggleTheme() {
  applyTheme(document.body.getAttribute("data-theme") === "dark" ? "light" : "dark");
}
applyTheme(localStorage.getItem("ps-theme") || "dark");

// ─── Toast 通知 ──────────────────────────────────────────────────────────────
function toast(message, type = "info", timeout = 3200) {
  let box = $("#toast-container");
  if (!box) {
    box = document.createElement("div");
    box.id = "toast-container";
    document.body.appendChild(box);
  }
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .25s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 250);
  }, timeout);
}

// ─── 确认弹窗（替代原生 confirm，统一系统风格） ──────────────────────────────
// 返回 Promise<boolean>：点击「确定」resolve(true)，取消 / 背景 / Esc resolve(false)
function confirmDialog(message, opts = {}) {
  const { title = "确认操作", okText = "确定", cancelText = "取 消", danger = false } = opts;
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "confirm-modal";
    wrap.innerHTML =
      `<div class="modal-backdrop"></div>` +
      `<div class="confirm-card" role="alertdialog" aria-modal="true">` +
      `<header>${danger ? '<span class="confirm-ico">⚠️</span>' : ""}${escapeHtml(title)}</header>` +
      `<div class="confirm-body">${escapeHtml(message)}</div>` +
      `<footer>` +
      `<button type="button" class="btn-cancel">${escapeHtml(cancelText)}</button>` +
      `<button type="button" class="btn-ok ${danger ? "danger" : "primary"}">${escapeHtml(okText)}</button>` +
      `</footer></div>`;
    document.body.appendChild(wrap);

    const close = (val) => {
      document.removeEventListener("keydown", onKey);
      wrap.remove();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(false);
      else if (e.key === "Enter") close(true);
    };
    wrap.querySelector(".modal-backdrop").onclick = () => close(false);
    wrap.querySelector(".btn-cancel").onclick = () => close(false);
    wrap.querySelector(".btn-ok").onclick = () => close(true);
    document.addEventListener("keydown", onKey);
    wrap.querySelector(".btn-ok").focus();
  });
}

//更新成功提示
const handleUpdateSuccess = (btn) => {
  if (btn) {
    let normal = btn.getAttribute("title");
    let mini = btn.getAttribute("icon");
    btn.setAttribute("title", "更新成功");
    btn.setAttribute("icon", "✅");
    btn.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 200,
      iterations: 3,
      easing: "steps(2, jump-none)",
    });
    setTimeout(() => {
      btn.setAttribute("title", normal);
      btn.setAttribute("icon", mini);
    }, 1000);
  }
  toast("保存成功", "ok");
};

async function handleCheckUpdate() {
  const writeFiles = (SignalHtmlContent, SignalJSContent, PeerStreamContent) => {
    const contents = [
      { content: SignalHtmlContent, path: "/signal.html" },
      { content: SignalJSContent, path: "/signal.js" },
      { content: PeerStreamContent, path: "/peer-stream.js" },
    ];
    let fetchPromises = [];

    contents.forEach(({ content, path }) => {
      if (content) {
        fetchPromises.push(
          fetch("./write", {
            method: "POST",
            headers: {
              write: path,
              ...authHeaders(),
            },
            body: content,
          })
        );
      }
    });

    if (fetchPromises.length > 0) {
      Promise.all(fetchPromises)
        .then((responses) =>
          Promise.all(
            responses.map((response) => {
              if (!response.ok) {
                throw response.headers.get("error");
              }
              handleUpdateSuccess($("#checkUpdate"));
            })
          )
        )
        .catch((error) => {
          toast(`更新失败: ${error}`, "err");
          console.error("Update error:", error);
        });
    } else {
      console.log("No file to upload.");
    }
  };

  let SignalHtmlContent,
    SignalJSContent,
    PeerStreamContent = "";

  const checkUpdate = $("#checkUpdate");
  checkUpdate.setAttribute("title", "更新中...");
  checkUpdate.setAttribute("icon", "⏳");
  // 先通过github仓库尝试获取，如果失败，允许用户本地上传
  Promise.all([
    fetch("https://inveta.github.io/peer-stream/signal.html"),
    fetch("https://inveta.github.io/peer-stream/signal.js"),
    fetch("https://inveta.github.io/peer-stream/peer-stream.js"),
  ])
    .then((responses) =>
      Promise.all(
        responses.map((response) => {
          if (!response.ok) throw new Error(`Network response for ${response.url} was not ok`);
          return response.text();
        })
      )
    )
    .then((files) => {
      writeFiles(...files);
    })
    .catch((error) => {
      let inputElement = document.createElement("input");
      inputElement.type = "file";
      inputElement.multiple = true;
      inputElement.style.display = "none";

      const readFile = (file) => {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target.result);
          reader.onerror = (e) => reject(e);
          reader.readAsText(file);
        });
      };

      inputElement.addEventListener("change", (event) => {
        const files = event.target.files;
        const fileList = {
          "signal.html:text/html": (content) => (SignalHtmlContent = content),
          "signal.js:text/javascript": (content) => (SignalJSContent = content),
          "peer-stream.js:text/javascript": (content) => (PeerStreamContent = content),
        };

        if (files.length > 3) {
          checkUpdate.setAttribute("title", "检查更新");
          checkUpdate.setAttribute("icon", "🔍");
          toast("选择文件数量应小于等于3个！", "err");
          return;
        }

        let readPromises = [];

        Array.from(files).forEach((file) => {
          const fileKey = `${file.name}:${file.type}`;
          fileList[fileKey]
            ? readPromises.push(readFile(file).then(fileList[fileKey]))
            : toast("请上传 signal.html、signal.js 或 peer-stream.js 文件", "err");
        });
        Promise.all(readPromises)
          .then(() => {
            writeFiles(SignalHtmlContent, SignalJSContent, PeerStreamContent);
          })
          .catch((e) => {
            console.error("Error reading file:", e);
          });
      });
      inputElement.click();
    });
}

// 拉取配置（token 模式下需带令牌；401 触发登录页）。返回解析后的配置对象或 null
async function loadConfig() {
  const res = await fetch("./signal.json", { headers: authHeaders() });
  if (res.status === 401) { showLogin(); return null; }
  if (!res.ok) throw res.status;
  const data = await res.json();
  window._signalCache = data; // 缓存整份配置，供嵌套/数组字段局部合并
  hideLogin();
  return data;
}

//读取 signal.json，渲染系统管理表单
const renderConfigForm = async () => {
  try {
    const data = await loadConfig();
    if (!data) return;
    // 按 name 设置输入框的值（用于带点号的嵌套字段名）
    const setVal = (name, val) => {
      const el = $(`[name="${name}"]`);
      if (el && val != null) el.value = val;
    };
    const handlers = {
      iceServers: (value) => ($("[name=iceServers]").value = JSON.stringify(value, null, "\t")),
      auth: (value) => {
        if (value) { $("#auth").value = value; $("#http-auth").checked = true; }
        else $("#http-auth").checked = false;
      },
      UEVersion: (value) => ($("[name=UEVersion]").checked = value === 4.27),
      // 这些由专门视图管理，系统管理表单忽略
      UE5: () => {}, projects: () => {}, servers: () => {},
      // Phase 4 安全字段
      tls: (v) => { setVal("tls.cert", v?.cert); setVal("tls.key", v?.key); },
      token: (v) => { setVal("token.secret", v?.secret); setVal("token.ttl", v?.ttl); },
      rateLimit: (v) => { setVal("rateLimit.windowMs", v?.windowMs); setVal("rateLimit.max", v?.max); },
      ipWhitelist: (v) => {
        const el = $('[name="ipWhitelist"]');
        if (el) el.value = (v || []).join("\n");
      },
    };

    Object.keys(data).forEach((key) => {
      if (handlers[key]) {
        handlers[key](data[key]);
      } else {
        const input = $(`[name="${key}"]`);
        if (input) {
          if (input.type === "checkbox") input.checked = data[key];
          else input.value = data[key];
        }
      }
    });
  } catch (error) {
    toast(`读取配置失败: ${error}`, "err");
  }
};

//上传处理后的signal参数
const handleConfigUpdate = async (config, PORT_new, _retried = false) => {
  try {
    const response = await fetch("./signal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        signal: encodeURIComponent(JSON.stringify(config)),
        ...authHeaders(),
      },
    });
    if (!response.ok) {
      const err = decodeURIComponent(response.headers.get("error") || "");
      // 令牌失效：弹出登录页，登录后请重试保存
      if (err.includes("未授权")) { showLogin(); throw "请先登录"; }
      throw err;
    }
    handleUpdateSuccess(null);
    if (PORT_new) location.port = PORT_new;
    return true;
  } catch (error) {
    toast(`保存失败: ${error}`, "err");
    console.error(error);
    return false;
  }
};

//系统管理表单：字段变化时增量提交
const submitConfig = async (event) => {
  const id = event.target.id;
  const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;

  // 字段级校验
  const validators = {
    auth: (v) => /^[a-zA-Z0-9]+:[a-zA-Z0-9]+$/.test(v) || "请输入正确的用户名:密码格式，例如 admin:000000",
    iceServers: (v) => { try { JSON.parse(v); return true; } catch { return "iceServers 格式有误！"; } },
  };
  if (validators[id]) {
    const ok = validators[id](value);
    if (ok !== true) { toast(ok, "err"); return; }
  }

  let config = {};
  let PORT_new = null;

  // 嵌套对象字段（tls.cert / token.secret / rateLimit.max …）
  if (id.includes(".")) {
    const [parent, child] = id.split(".");
    const v = event.target.type === "number" ? (value === "" ? undefined : parseFloat(value)) : (value === "" ? undefined : value);
    const merged = { ...(window._signalCache[parent] || {}), [child]: v };
    config[parent] = merged;
    window._signalCache[parent] = merged;
    await handleConfigUpdate(config, null);
    return;
  }

  // IP 白名单：按换行 / 逗号拆分为数组
  if (id === "ipWhitelist") {
    const list = value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    config.ipWhitelist = list;
    window._signalCache.ipWhitelist = list;
    await handleConfigUpdate(config, null);
    return;
  }

  switch (event.target.type) {
    case "number":
      config[id] = parseFloat(value);
      if (id === "PORT" && value !== window.location.port) PORT_new = value;
      break;
    case "checkbox":
      // http-auth 开关映射到 auth；UEVersion 开关映射到 4.27/5
      if (id === "http-auth") config.auth = value ? ($("#auth")?.value || "admin:000000") : false;
      else if (id === "UEVersion") config.UEVersion = value ? 4.27 : 5;
      else config[id] = value;
      break;
    default:
      config[id] = event.target.name === "iceServers" ? JSON.parse(value) : value;
  }

  if (window._signalCache) Object.assign(window._signalCache, config);
  await handleConfigUpdate(config, PORT_new);
};

// 把秒数格式化为人类可读的运行时长
const fmtUptime = (sec) => {
  if (sec == null || isNaN(sec)) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (d) return `${d}天 ${h}时`;
  if (h) return `${h}时 ${m}分`;
  if (m) return `${m}分 ${s}秒`;
  return `${s}秒`;
};

// 哪些进程类型支持“断开/停止”操作
const KILLABLE = { "Unreal Engine": "killUE", "peer-stream": "killPlayer", "signal.js": "exit" };

let _adminWs = null;

// 通过管理后台 WebSocket 发送受限指令（不再使用 /eval）
function adminCmd(cmd, extra = {}) {
  if (!_adminWs || _adminWs.readyState !== WebSocket.OPEN) {
    toast("管理通道未连接", "err");
    return;
  }
  _adminWs.send(JSON.stringify({ cmd, ...extra }));
}

// ─── 表格分页（审计记录、实例列表可能有多页数据） ──────────────────────────────
const PAGE_SIZE = 10;
const _pageState = {}; // key -> 当前页码

// 计算带省略号的页码窗口（页数过多时只显示首尾与当前页附近）
function pageWindow(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const out = [1];
  if (page > 4) out.push("…");
  for (let i = Math.max(2, page - 1); i <= Math.min(pages - 1, page + 1); i++) out.push(i);
  if (page < pages - 3) out.push("…");
  out.push(pages);
  return out;
}

// 渲染分页控件；点击翻页时回调 rerender 重渲染当前页
function renderPager(key, total, pages, page, rerender) {
  const box = $(`[data-pager="${key}"]`);
  if (!box) return;
  if (total <= PAGE_SIZE) {
    box.innerHTML = total ? `<span class="pager-info">共 ${total} 条</span>` : "";
    box.onclick = null;
    return;
  }
  const btn = (p, label, dis, active) =>
    `<button type="button" class="pager-btn${active ? " active" : ""}" ${dis ? "disabled" : ""} data-go="${p}">${label}</button>`;
  const nums = pageWindow(page, pages)
    .map((n) => (n === "…" ? `<span class="pager-ellipsis">…</span>` : btn(n, n, false, n === page)))
    .join("");
  box.innerHTML =
    `<span class="pager-info">共 ${total} 条 · ${page}/${pages} 页</span>` +
    `<span class="pager-btns">${btn(page - 1, "‹", page <= 1, false)}${nums}${btn(page + 1, "›", page >= pages, false)}</span>`;
  box.onclick = (e) => {
    const b = e.target.closest("[data-go]");
    if (!b || b.disabled) return;
    const p = parseInt(b.dataset.go, 10);
    if (!isNaN(p)) { _pageState[key] = p; rerender(); }
  };
}

// 通用分页：rows 为全量数据，renderRows(slice, startIndex) 把当前页写入表格
function paginate(key, rows, renderRows) {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(_pageState[key] || 1, 1), pages);
  _pageState[key] = page;
  const start = (page - 1) * PAGE_SIZE;
  renderRows(rows.slice(start, start + PAGE_SIZE), start);
  renderPager(key, total, pages, page, () => paginate(key, rows, renderRows));
}

const procRowHtml = (a) => {
  const action = KILLABLE[a.type] ? (a.type === "signal.js" ? "停止" : "断开") : "";
  return `
    <tr data-type="${a.type}" data-port="${a.PORT ?? ""}">
      <td>${a.type ?? ""}</td>
      <td>${a.address ?? ""}</td>
      <td>${a.PORT ?? ""}</td>
      <td>${a.path ?? ""}</td>
      <td>${fmtUptime(a.uptime)}</td>
      <td>${a.players ?? "—"}</td>
      <td>${action}</td>
    </tr>`;
};

const renderDashboard = (data) => {
  const stats = data.stats || {};
  for (const key of ["players", "engines", "freeUe", "agents", "queued"]) {
    const el = $(`[data-stat="${key}"]`);
    if (el) el.textContent = stats[key] ?? 0;
  }
  const up = $(`[data-stat="uptime"]`);
  if (up) up.textContent = fmtUptime(stats.uptime);

  const procs = data.processes || [];
  const tbody = $(".proc-table tbody");
  if (!tbody) return;
  if (!procs.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">暂无实例</td></tr>`;
    const box = $('[data-pager="proc"]'); if (box) box.innerHTML = "";
    return;
  }
  // 实例列表为实时数据，保留当前页码（越界时由 paginate 自动收敛）
  paginate("proc", procs, (slice) => { tbody.innerHTML = slice.map(procRowHtml).join(""); });
};

const appendLog = (entry) => {
  const pre = $("[data-logs]");
  if (!pre) return;
  const time = entry.time || new Date(entry.ts).toLocaleTimeString();
  pre.textContent += `[${time}] ${entry.line}\n`;
  // 限制长度，避免无限增长
  const lines = pre.textContent.split("\n");
  if (lines.length > 400) pre.textContent = lines.slice(-400).join("\n");
  pre.scrollTop = pre.scrollHeight;
};

// ─── 主机资源卡片（CPU / 内存 / GPU） ───────────────────────────────────────
const fmtBytes = (b) => {
  if (!b) return "0";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(b < 10 && i > 0 ? 1 : 0) + " " + u[i];
};
const gaugeClass = (p) => (p >= 90 ? "hot" : p >= 70 ? "warn" : "");
const hostCard = (name, pct, val, sub) =>
  `<div class="host-card">
     <div class="hc-top"><span class="hc-name">${escapeHtml(name)}</span><span class="hc-val">${val}</span></div>
     <div class="gauge ${gaugeClass(pct)}"><span style="width:${Math.min(100, pct || 0)}%"></span></div>
     <div class="hc-sub">${escapeHtml(sub || "")}</div>
   </div>`;
function renderHostStats(msg) {
  const box = $("[data-host]");
  if (!box) return;
  const cards = [];
  cards.push(hostCard("CPU", msg.cpu, msg.cpu + "%",
    (msg.platform || "") + (msg.loadavg != null ? ` · 负载 ${msg.loadavg}` : "")));
  const m = msg.mem || {};
  cards.push(hostCard("内存", m.pct, (m.pct || 0) + "%", `${fmtBytes(m.used)} / ${fmtBytes(m.total)}`));
  (msg.gpu || []).forEach((g) => {
    const mp = g.memTotal ? Math.round((g.memUsed / g.memTotal) * 100) : 0;
    cards.push(hostCard(`GPU${g.index} · ${g.name}`, g.util, g.util + "%", `显存 ${g.memUsed} / ${g.memTotal} MB (${mp}%)`));
  });
  box.innerHTML = cards.join("");
}

// ─── 访问审计 ──────────────────────────────────────────────────────────────
const AUDIT_LABEL = {
  player_connect: "玩家接入", player_disconnect: "玩家断开",
  engine_connect: "实例上线", engine_disconnect: "实例下线",
  ue_start: "启动实例", admin_cmd: "管理操作",
};
const auditRowHtml = (r) => {
  const t = r.timeText || new Date(r.ts).toLocaleString();
  const warn = /disconnect|exit|kill/.test(r.event);
  const label = AUDIT_LABEL[r.event] || r.event;
  const ipport = [r.ip, r.port].filter((x) => x != null && x !== "").join(" : ");
  const detail = r.cmd || r.key || r.path || "";
  return `<tr>
    <td>${t}</td>
    <td><span class="evt-tag ${warn ? "warn" : ""}">${escapeHtml(label)}</span></td>
    <td>${escapeHtml(r.project || "—")}</td>
    <td>${escapeHtml(ipport || "—")}</td>
    <td>${escapeHtml(detail)}</td>
  </tr>`;
};

async function loadAudit() {
  const tbody = $("[data-audit]");
  if (!tbody) return;
  try {
    const res = await fetch("./audit", { headers: authHeaders() });
    if (res.status === 401) { showLogin(); return; }
    const rows = await res.json();
    if (!rows.length) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="5">暂无审计记录</td></tr>`;
      const box = $('[data-pager="audit"]'); if (box) box.innerHTML = "";
      return;
    }
    _pageState.audit = 1; // 手动刷新后回到第一页
    paginate("audit", rows, (slice) => { tbody.innerHTML = slice.map(auditRowHtml).join(""); });
  } catch (e) {
    console.error(e);
  }
}

// ─── 远程监控子菜单切换（服务器状态 / 实例管理，分开展示避免拥挤） ────────────────
let _monitorTab = "status";
function switchMonitorTab(name) {
  _monitorTab = name;
  $$("#view-monitor .sub-tab").forEach((b) => b.classList.toggle("active", b.dataset.subtab === name));
  $$("#view-monitor .monitor-module").forEach((m) => m.classList.toggle("active", m.dataset.sub === name));
}

const getProcess = () => {
  // 协议自适应 wss；token 模式下通过查询串携带令牌（WS 无法设置请求头）
  const tok = getToken();
  const url = `${WS_PROTO}://${location.host}/${navigator.platform}/admin${tok ? `?token=${encodeURIComponent(tok)}` : ""}`;
  const ws = new WebSocket(url, `exec-ue`);
  _adminWs = ws;
  ws.onopen = function () {
    console.info("✅ admin", ws);
    window.addEventListener("hashchange", () => ws.close(), { once: true });
  };

  ws.onmessage = function (e) {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === "admin") renderDashboard(msg);
    else if (msg.type === "host") renderHostStats(msg);
    else if (msg.type === "log") appendLog(msg);
    else if (msg.type === "logs") (msg.logs || []).forEach(appendLog);
    else if (msg.type === "ack" && msg.cmd === "auth" && !msg.ok) {
      // 管理通道鉴权失败：弹出登录页
      showLogin();
    } else if (msg.type === "ack") toast(msg.ok ? "操作成功" : `操作失败: ${msg.error || ""}`, msg.ok ? "ok" : "err");
  };

  ws.onclose = (e) => {
    if (_adminWs === ws) _adminWs = null;
    // 1008 = 服务端因未授权关闭：弹出登录页
    if (e.code === 1008) showLogin();
  };
};

async function tableClick(event) {
  const cell = event.target;
  if (cell.tagName !== "TD" || (cell.innerHTML !== "断开" && cell.innerHTML !== "停止")) return;
  const row = cell.parentElement;
  const type = row.dataset.type;
  const port = parseInt(row.dataset.port, 10);
  const cmd = KILLABLE[type];
  if (!cmd) return;
  if (cmd === "exit" && !(await confirmDialog("确定要停止信令服务器吗？停止后管理端将断开连接。", { title: "停止服务", okText: "停 止", danger: true }))) return;
  adminCmd(cmd, cmd === "exit" ? {} : { port });
}

async function getStats() {
  if (ps.pc.connectionState !== "connected") return;

  let cue = ` Current Time: ${ps.currentTime} s`;

  if (ps.VideoEncoderQP < 27) {
    document.documentElement.style.setProperty("--cue", "lime");
  } else if (ps.VideoEncoderQP < 36) {
    document.documentElement.style.setProperty("--cue", "orange");
    cue += `\n Spotty Network !`;
  } else {
    document.documentElement.style.setProperty("--cue", "red");
    cue += `\n Bad Network !!`;
  }

  cue += `\n Video Quantization Parameter: ${ps.VideoEncoderQP}`;

  let bytesReceived = "\n";
  let codec = "\n";

  const stats = await ps.pc.getStats(null);

  stats.forEach((stat) => {
    switch (stat.type) {
      case "data-channel": {
        cue += `\n Data Channel 🢁 ${stat.bytesSent.toLocaleString()} B 🢃 ${stat.bytesReceived.toLocaleString()} B`;
        break;
      }
      case "inbound-rtp": {
        if (stat.mediaType === "video") {
          cue += `\n 💻 ${stat.frameWidth} x ${stat.frameHeight} 📷 ${stat.framesPerSecond} FPS`;
          cue += `\n Frames Decoded: ${stat.framesDecoded.toLocaleString()}`;
          cue += `\n ${stat.packetsLost.toLocaleString()} packets lost, ${stat.framesDropped} frames dropped`;
          bytesReceived += ` video ${stat.bytesReceived.toLocaleString()} B 🢃`;
        } else if (stat.mediaType === "audio")
          bytesReceived += ` audio ${stat.bytesReceived.toLocaleString()} B 🢃`;
        break;
      }
      case "codec": {
        codec += " " + stat.mimeType;
        break;
      }
      case "transport": {
        const bitrate = ~~(
          ((stat.bytesReceived - this.bytesReceived) / (stat.timestamp - this.timestamp)) *
          (1000 * 8)
        );
        cue += `\n Bitrate 🢃 ${bitrate.toLocaleString()} bps`;
        this.bytesReceived = stat.bytesReceived;
        this.timestamp = stat.timestamp;
        break;
      }
      default: {
      }
    }
  });

  cue += bytesReceived;
  cue += codec;

  cue = new VTTCue(0, Number.MAX_SAFE_INTEGER, cue);
  cue.align = "start";

  for (const c of ps.textTracks[0].cues) {
    ps.textTracks[0].removeCue(c);
  }
  ps.textTracks[0].addCue(cue);

  ps.timeout = setTimeout(getStats, 1000);
}

// ─── 服务器管理 / UE工程管理 表格 ───────────────────────────────────────────
const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const GRID_DEFS = {
  servers: {
    title: "服务器",
    arrayKey: "servers",
    columns: [
      { key: "ip", label: "IP 地址" },
      { key: "gpu", label: "显卡序号" },
      { key: "vram", label: "显存", render: (v) => (v != null && v !== "" ? v + " G" : "") },
    ],
    fields: [
      { key: "ip", label: "IP 地址", type: "text", placeholder: "127.0.0.1（本机或远端 GPU 机器）", required: true, full: true },
      { key: "gpu", label: "显卡序号", type: "number", placeholder: "0" },
      { key: "vram", label: "显存 (G)", type: "number", placeholder: "16" },
    ],
  },
  projects: {
    title: "UE工程",
    arrayKey: "projects",
    columns: [
      { key: "name", label: "UE工程名称" },
      { key: "path", label: "UE路径" },
      { key: "version", label: "UE版本", render: (v) => "UE" + (v || 5) },
      { key: "preload", label: "预加载", render: (v) => (v ? "是" : "否") },
      { key: "vram", label: "GPU显存(G)" },
      { key: "urlPrefix", label: "UE工程标识" },
      { key: "args", label: "附加参数" },
    ],
    fields: [
      { key: "name", label: "UE工程名称", type: "text", required: true },
      { key: "urlPrefix", label: "UE工程标识 (urlPrefix)", type: "text", placeholder: "玩家以 /标识 访问该工程", required: true },
      { key: "path", label: "UE路径（绝对路径，.exe / .sh）", type: "text", placeholder: "C:\\App\\App.exe 或 /home/app.sh", required: true, full: true },
      { key: "version", label: "UE版本", type: "select", options: [["5", "UE5"], ["4.27", "UE4.27"]] },
      { key: "vram", label: "单实例 GPU 显存 (G)", type: "number", placeholder: "5（用于算每卡实例数）" },
      { key: "args", label: "附加参数", type: "text", placeholder: "可选，原样追加到启动命令", full: true },
      { key: "preload", label: "预加载", type: "checkbox" },
    ],
  },
};

const gridData = (name) => (window._signalCache?.[GRID_DEFS[name].arrayKey] || []).map((x) => ({ ...x }));

function renderGrid(name) {
  const def = GRID_DEFS[name];
  const rows = gridData(name);
  const tbody = $(`table[data-grid="${name}"] tbody`);
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${def.columns.length + 3}">暂无数据，点击「新增」添加</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((row, i) => {
      const cells = def.columns
        .map((c) => `<td>${escapeHtml(c.render ? c.render(row[c.key]) : row[c.key] ?? "")}</td>`)
        .join("");
      return `<tr data-i="${i}">
        <td class="col-check"><input type="checkbox" class="row-chk" /></td>
        <td>${i + 1}</td>
        ${cells}
        <td class="actions"><a onclick="openDialog('${name}',${i})">编辑</a><a onclick="deleteRow('${name}',${i})">删除</a></td>
      </tr>`;
    })
    .join("");
}

async function renderServersTable() { if (await loadConfig()) renderGrid("servers"); }
async function renderProjectsTable() { if (await loadConfig()) renderGrid("projects"); }

// ─── 编辑弹窗 ────────────────────────────────────────────────────────────────
let _modalCtx = null;
function fieldHtml(f, val) {
  const id = "fld_" + f.key;
  const cls = f.full ? " class=\"full\"" : "";
  if (f.type === "checkbox")
    return `<label class="switch"><input type="checkbox" id="${id}" ${val ? "checked" : ""}/><span>${f.label}</span></label>`;
  if (f.type === "select") {
    const opts = f.options
      .map(([v, l]) => `<option value="${v}" ${String(val) === v ? "selected" : ""}>${l}</option>`)
      .join("");
    return `<inline${cls}><label for="${id}">${f.label}</label><select id="${id}">${opts}</select></inline>`;
  }
  return `<inline${cls}><label for="${id}">${f.label}</label><input type="${f.type}" id="${id}" value="${escapeHtml(val ?? "")}" placeholder="${f.placeholder || ""}" ${f.required ? "required" : ""}/></inline>`;
}
function openDialog(name, index) {
  const def = GRID_DEFS[name];
  const row = index != null ? gridData(name)[index] : {};
  _modalCtx = { name, index };
  $("#modal-title").textContent = (index != null ? "编辑" : "新增") + def.title;
  $("#modal-body").innerHTML = def.fields.map((f) => fieldHtml(f, row[f.key])).join("");
  $("#modal").hidden = false;
}
const openServerDialog = () => openDialog("servers", null);
const openProjectDialog = () => openDialog("projects", null);
function closeModal() { $("#modal").hidden = true; _modalCtx = null; }

async function saveArray(name, arr) {
  const key = GRID_DEFS[name].arrayKey;
  window._signalCache[key] = arr;
  return handleConfigUpdate({ [key]: arr }, null);
}
async function saveModal(event) {
  if (event) event.preventDefault();
  if (!_modalCtx) return false;
  const { name, index } = _modalCtx;
  const def = GRID_DEFS[name];
  const row = {};
  for (const f of def.fields) {
    const el = $("#fld_" + f.key);
    if (!el) continue;
    if (f.type === "checkbox") row[f.key] = el.checked;
    else if (f.type === "number") row[f.key] = el.value === "" ? undefined : parseFloat(el.value);
    else row[f.key] = el.value;
  }
  const arr = gridData(name);
  if (index != null) arr[index] = row;
  else arr.push(row);
  if (await saveArray(name, arr)) { toast("保存成功", "ok"); closeModal(); renderGrid(name); }
  return false;
}
async function deleteRow(name, index) {
  const def = GRID_DEFS[name];
  if (!(await confirmDialog(`确定删除该${def.title}？删除后不可恢复。`, { title: "删除确认", okText: "删 除", danger: true }))) return;
  const arr = gridData(name);
  arr.splice(index, 1);
  if (await saveArray(name, arr)) { toast("已删除", "ok"); renderGrid(name); }
}
async function deleteChecked(name) {
  const idx = [];
  $$(`table[data-grid="${name}"] tbody .row-chk`).forEach((chk, i) => chk.checked && idx.push(i));
  if (!idx.length) { toast("请先勾选要删除的行", "err"); return; }
  const def = GRID_DEFS[name];
  if (!(await confirmDialog(`确定删除选中的 ${idx.length} 个${def.title}？删除后不可恢复。`, { title: "删除确认", okText: "删 除", danger: true }))) return;
  const arr = gridData(name).filter((_, i) => !idx.includes(i));
  saveArray(name, arr).then((ok) => ok && (toast("已删除", "ok"), renderGrid(name)));
}
function toggleAll(master, name) {
  $$(`table[data-grid="${name}"] tbody .row-chk`).forEach((chk) => (chk.checked = master.checked));
}

// 顶栏电源按钮：退出登录
async function appExit() {
  if (getToken()) {
    if (!(await confirmDialog("退出当前登录账号？", { title: "退出登录", okText: "退 出" }))) return;
    setToken("");
    showLogin();
  } else {
    toast("当前未启用登录（未配置 token.secret）", "info");
  }
}

// ─── 视图路由 ────────────────────────────────────────────────────────────────
function startPlayer() {
  const v = $('[data-view="peer-stream"]');
  if (v && !window.ps) {
    v.id = `${WS_PROTO}://${location.host}/`; // 共享模式连接（无工程前缀）
    import("./peer-stream.js");
  }
}
const VIEWS = {
  "#system": { view: "system", nav: "nav-system", init: renderConfigForm },
  "#servers": { view: "servers", nav: "nav-servers", init: renderServersTable },
  "#projects": { view: "projects", nav: "nav-projects", init: renderProjectsTable },
  "#monitor": { view: "monitor", nav: "nav-monitor", init: () => { switchMonitorTab(_monitorTab); getProcess(); loadAudit(); } },
  "#peer-stream": { view: "peer-stream", nav: "nav-player", init: startPlayer },
};
async function route() {
  let hash = location.hash;
  if (!VIEWS[hash]) { location.hash = "#system"; return; } // 触发再次 route
  const cfg = VIEWS[hash];
  if (_adminWs && hash !== "#monitor") { try { _adminWs.close(); } catch {} }
  $$("main > [data-view]").forEach((el) => el.classList.toggle("active", el.dataset.view === cfg.view));
  $$("aside a, aside button").forEach((el) => el.classList.remove("nav-active"));
  $("#" + cfg.nav)?.classList.add("nav-active");
  try { await cfg.init?.(); } catch (e) { console.error(e); }
}
window.addEventListener("hashchange", route);
window.addEventListener("DOMContentLoaded", async () => {
  try { await loadConfig(); } catch {}
  route();
});
