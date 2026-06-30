"5.1.3";

Object.assign(global, require("./signal.json"));

const fs = require('fs')
const child_process = require('child_process')
const crypto = require('crypto')
const os = require('os')

// 服务器启动时间（用于运行时长统计）
global.startedAt = Date.now();

// 解码子进程输出：Windows 中文控制台默认 GBK(cp936)，直接按 UTF-8 解析会乱码
function decodeOutput(buf) {
	if (buf == null) return '';
	if (typeof buf === 'string') return buf;
	try {
		const enc = process.platform === 'win32' ? 'gbk' : 'utf8';
		return new TextDecoder(enc).decode(buf);
	} catch {
		return buf.toString('utf8');
	}
}

// 服务器本地时区的时间字符串（日志/审计显示用，避免依赖浏览器时区导致时间不一致）
const _pad2 = (n) => String(n).padStart(2, '0');
function fmtClock(ts) {
	const d = new Date(ts);
	return `${_pad2(d.getHours())}:${_pad2(d.getMinutes())}:${_pad2(d.getSeconds())}`;
}
function fmtDateTime(ts) {
	const d = new Date(ts);
	return `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())} ${fmtClock(ts)}`;
}

// ════════════════════════════════════════════════════════════════════════════
// Phase 4 安全 / 公网就绪：HTTPS·WSS、Token 登录、IP 白名单、单 IP 限流
// 全部默认关闭——不配置则行为与旧版完全一致（零依赖，仅用 Node 内置模块）。
// ════════════════════════════════════════════════════════════════════════════

// 配置默认值（缺省即关闭对应能力）
global.tls = global.tls || null;            // { cert, key }：证书/私钥文件路径，存在则启用 HTTPS/WSS
global.ipWhitelist = global.ipWhitelist || []; // 字符串数组（精确 IP 或 CIDR）；为空=放行所有
global.rateLimit = global.rateLimit || null;   // { windowMs, max }：单 IP 时间窗内最大请求数
global.token = global.token || null;        // { secret, ttl }：配置 secret 后启用登录令牌鉴权
global.secure = false;                       // 运行期标记：当前是否以 HTTPS 提供服务

// 判断某个 WS 连接是否为管理后台（URL 可能带 ?token=，需先剥离查询串）
function isAdminWs(req) {
	return (req?.url || '').split('?')[0].endsWith('admin');
}

// ── 读取 POST 请求体 ──
function readBody(req) {
	return new Promise((res) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => res(Buffer.concat(chunks)));
	});
}

// ── Token：HMAC-SHA256 签名，格式 base64url(payload).base64url(sig) ──
function signToken(payload) {
	const secret = global.token?.secret;
	const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
	const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
	return `${body}.${sig}`;
}
function verifyToken(tok) {
	try {
		const secret = global.token?.secret;
		if (!secret || !tok) return null;
		const [body, sig] = String(tok).split('.');
		if (!body || !sig) return null;
		const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
		// 防时序攻击的等长比较
		const a = Buffer.from(sig), b = Buffer.from(expect);
		if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
		const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
		if (payload.exp && Date.now() > payload.exp) return null;
		return payload;
	} catch { return null; }
}
// token 模式是否开启
function tokenMode() { return !!global.token?.secret; }
// 从 HTTP 请求中提取 token（Authorization: Bearer xxx 或 token 头）
function tokenFromReq(req) {
	const h = req.headers['authorization'];
	if (h && h.startsWith('Bearer ')) return h.slice(7);
	return req.headers['token'] || null;
}

// ── IP 白名单（支持精确 IP 与 IPv4 CIDR）──
function ipToLong(ip) {
	const p = ip.split('.');
	if (p.length !== 4) return null;
	return ((+p[0] << 24) >>> 0) + (+p[1] << 16) + (+p[2] << 8) + (+p[3]);
}
function ipMatch(ip, rule) {
	if (rule.includes('/')) {
		const [base, bitsStr] = rule.split('/');
		const bits = +bitsStr;
		const a = ipToLong(ip), b = ipToLong(base);
		if (a == null || b == null) return false;
		const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
		return (a & mask) === (b & mask);
	}
	return ip === rule;
}
function ipAllowed(rawIp) {
	if (!global.ipWhitelist || !global.ipWhitelist.length) return true;
	const ip = getIPv4(rawIp);
	return global.ipWhitelist.some((rule) => ipMatch(ip, rule));
}

// ── 单 IP 限流（滑动时间窗计数）──
const _rlMap = new Map(); // ip -> { count, reset }
function rateOk(rawIp) {
	if (!global.rateLimit || !global.rateLimit.max) return true;
	const ip = getIPv4(rawIp);
	const now = Date.now();
	const win = global.rateLimit.windowMs || 60000;
	let e = _rlMap.get(ip);
	if (!e || now > e.reset) { e = { count: 0, reset: now + win }; _rlMap.set(ip, e); }
	e.count++;
	return e.count <= global.rateLimit.max;
}
// 定期清理过期的限流记录，避免 Map 无限增长
setInterval(() => {
	const now = Date.now();
	for (const [ip, e] of _rlMap) if (now > e.reset) _rlMap.delete(ip);
}, 60 * 1000);

// ════════════════════════════════════════════════════════════════════════════
// Phase 6 运维监控 + 访问审计（零依赖：os / child_process / fs 追加 NDJSON）
// ════════════════════════════════════════════════════════════════════════════

// ── 主机资源：CPU 占用（两次采样差值）/ 内存 / GPU(nvidia-smi) ──
let _prevCpu = os.cpus();
function cpuPercent() {
	const cur = os.cpus();
	let idle = 0, total = 0;
	for (let i = 0; i < cur.length && i < _prevCpu.length; i++) {
		const a = _prevCpu[i].times, b = cur[i].times;
		idle += b.idle - a.idle;
		total += (b.user + b.nice + b.sys + b.idle + b.irq) - (a.user + a.nice + a.sys + a.idle + a.irq);
	}
	_prevCpu = cur;
	return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
}
let _gpuCache = [];
function pollGpu() {
	child_process.exec(
		"nvidia-smi --query-gpu=index,utilization.gpu,memory.used,memory.total,name --format=csv,noheader,nounits",
		{ timeout: 4000 },
		(err, stdout) => {
			if (err) { _gpuCache = []; return; }
			_gpuCache = stdout.trim().split("\n").filter(Boolean).map((line) => {
				const p = line.split(",").map((s) => s.trim());
				return { index: +p[0], util: +p[1], memUsed: +p[2], memTotal: +p[3], name: p.slice(4).join(",") };
			});
		}
	);
}
function broadcastHostStats() {
	const total = os.totalmem(), free = os.freemem();
	const payload = JSON.stringify({
		type: "host",
		ts: Date.now(),
		cpu: cpuPercent(),
		mem: { total, used: total - free, pct: Math.round((1 - free / total) * 100) },
		gpu: _gpuCache,
		platform: process.platform,
		loadavg: os.loadavg ? +os.loadavg()[0].toFixed(2) : null,
	});
	for (const a of EXECUE.clients) {
		if (isAdminWs(a.req) && a.readyState === 1) { try { a.send(payload); } catch { } }
	}
}
// 仅在有管理后台连接时采样/广播，避免无人观看时空转 nvidia-smi
setInterval(() => {
	if (typeof EXECUE === "undefined") return;
	const hasAdmin = [...EXECUE.clients].some((a) => isAdminWs(a.req) && a.readyState === 1);
	if (!hasAdmin) return;
	pollGpu();              // 刷新 GPU 缓存（异步，供本次/下次广播使用）
	broadcastHostStats();
}, 3000);

// ── 访问审计：每行一条 JSON 追加到 access.ndjson ──
const AUDIT_FILE = __dirname + "/access.ndjson";
function audit(event, data) {
	try {
		fs.appendFile(AUDIT_FILE, JSON.stringify({ ts: Date.now(), event, ...data }) + "\n", () => { });
	} catch { }
}
// 读取最近 limit 条审计（最新在前）
function readAudit(limit = 200) {
	return new Promise((resolve) => {
		fs.readFile(AUDIT_FILE, "utf8", (err, data) => {
			if (err) return resolve([]);
			const lines = data.trim().split("\n").filter(Boolean).slice(-limit);
			const out = [];
			for (const l of lines) { try { const o = JSON.parse(l); o.timeText = fmtDateTime(o.ts); out.push(o); } catch { } }
			resolve(out.reverse());
		});
	});
}

// 独立的 console，直接写到终端，不经过下面的广播包装（供 print 的表格使用）
const rawConsole = new (require("console").Console)({ stdout: process.stdout, stderr: process.stderr });

// ── 管理日志：环形缓冲 + 向 /admin 客户端广播 console 输出 ──
const LOG_BUFFER = [];
const LOG_MAX = 200;
function broadcastLog(level, text) {
	const ts = Date.now();
	const entry = { type: "log", level, ts, time: fmtClock(ts), line: text };
	LOG_BUFFER.push(entry);
	if (LOG_BUFFER.length > LOG_MAX) LOG_BUFFER.shift();
	if (typeof EXECUE === "undefined") return;
	const data = JSON.stringify(entry);
	for (const a of EXECUE.clients) {
		if (isAdminWs(a.req) && a.readyState === 1) {
			try { a.send(data); } catch { }
		}
	}
}
for (const level of ["log", "warn", "error", "info"]) {
	const orig = console[level].bind(console);
	console[level] = (...args) => {
		orig(...args);
		try {
			broadcastLog(
				level,
				args.map((a) => (typeof a === "string" ? a : require("util").inspect(a))).join(" ")
			);
		} catch { }
	};
}

////////////////////////////////// 2024年6月 删除 !!!!
if (global.env) {
	const signal = {
		//  env: false,
		PORT: +process.env.PORT,
		auth: process.env.auth,
		one2one: process.env.one2one,
		preload: +process.env.preload,
		exeUeCoolTime: +process.env.exeUeCoolTime,
		UEVersion: +process.env.UEVersion,
		UE5: Object.entries(process.env).filter(
			(([key]) => key.startsWith("UE5_")).map(([key, value]) => value)
		),
	};
	fs.promises.writeFile("./signal.json", JSON.stringify(signal));
	Object.assign(global, signal);
	// fs.promises.rm('./.signal.js');
}
////////////////////////////////// 2024年6月 删除 !!!!

const { Server } = require("ws");

// ════════════════════════════════════════════════════════════════════════════
// Phase 5 多工程路由：urlPrefix（UE工程标识）
// 一台信令服务多个 UE 工程，玩家按 URL 首段路由到对应工程的实例池。
// 数据模型双格式共存：优先 projects[]×servers[]，无则回退旧的 UE5 字符串数组。
// 启动池条目结构：{ localCmd, ip, key, urlPrefix, cmd, lastDate }
//   key      —— 实例唯一标识（= PixelStreamingURL 路径，形如 dongliuzha/0-1），防重复启动
//   urlPrefix —— 工程路由前缀（key 的首段），玩家据此匹配
// ════════════════════════════════════════════════════════════════════════════

// 取 URL 首个路径段（剥离查询串、解码）
function firstSeg(url) {
	let u = (url || "").split("?")[0];
	try { u = decodeURIComponent(u); } catch { }
	return u.split("/").filter(Boolean)[0] || "";
}
// 玩家请求的工程前缀；空路径 / 页面文件 / admin 视为「无前缀」→ 退回共享模式
function routePrefix(url) {
	const s = firstSeg(url);
	if (!s || s === "admin" || /\.(html?|js|css|json|ico|svg|png|jpe?g|map)$/i.test(s)) return "";
	return s;
}

// 由 projects×servers + 全局渲染参数生成启动池
function buildPoolFromProjects() {
	const pool = [];
	const host = global.serverIp || global.address || "127.0.0.1";
	const port = global.PORT || 88;
	const proto = global.secure ? "wss" : "ws";
	const [rx, ry] = String(global.resolution || "1920*1080").split("*");
	const renderFlags = [
		global.unattended ? "-Unattended" : "",
		global.renderOffScreen ? "-RenderOffScreen" : "",
		global.audioMixer ? "-AudioMixer" : "",
		"-ForceRes", `-ResX=${rx}`, `-ResY=${ry || 1080}`,
		`-PixelStreamingWebRTCFps=${global.fps || 30}`,
	].filter(Boolean).join(" ");

	for (const proj of global.projects || []) {
		if (proj.enabled === false) continue;
		if (!proj.path) continue;
		const prefix = proj.urlPrefix || proj.name;
		const verb = /\.sh$/i.test(proj.path) ? "sh" : "start";
		const extra = proj.args ? " " + proj.args : "";
		// 在每台 server（= 一块 GPU）上，按显存算可承载实例数
		const servers = (global.servers || []).length ? global.servers : [{ ip: host, gpu: 0, vram: 0 }];
		servers.forEach((srv, si) => {
			const perVram = +proj.vram || 0;
			const count = perVram > 0 && +srv.vram > 0 ? Math.max(1, Math.floor(srv.vram / perVram)) : 1;
			const local = !srv.ip || srv.ip === "127.0.0.1" || srv.ip === "localhost" || srv.ip === global.address;
			for (let n = 0; n < count; n++) {
				const key = `${prefix}/${si}-${n}`;
				const psurl = `${proto}://${host}:${port}/${key}`;
				const cmd = `${verb} ${proj.path} ${renderFlags} -PixelStreamingURL=${psurl} -GraphicsAdapter=${srv.gpu || 0}${extra}`;
				pool.push({ localCmd: local, ip: local ? "" : srv.ip, key, urlPrefix: prefix, cmd, lastDate: new Date(0) });
			}
		});
	}
	return pool;
}

// 由旧版 UE5 字符串数组生成启动池（向后兼容；urlPrefix = 数组下标）
function buildPoolFromLegacy() {
	const url = require("url");
	const pool = [];
	for (const key in global.UE5 || []) {
		const value = UE5[key];
		const args = value.split(" ");
		const match = value.match(/-PixelStreamingURL=([^ ]+)/);
		if (!match) { console.error(`PixelStreamingURL not found. ${value}`); continue; }
		const parsed = url.parse(match[1]);
		parsed.pathname = key;
		const newURL = url.format(parsed);
		const modifiedArgs = args.map((a) => a.replace(/-PixelStreamingURL=.*/, `-PixelStreamingURL=${newURL}`));
		const ipAddress = args[0];
		const isIp = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.test(ipAddress);
		if (isIp) {
			modifiedArgs.shift();
			pool.push({ localCmd: false, ip: ipAddress, key: String(key), urlPrefix: String(key), cmd: modifiedArgs.join(" "), lastDate: new Date(0) });
		} else {
			pool.push({ localCmd: true, ip: "", key: String(key), urlPrefix: String(key), cmd: modifiedArgs.join(" "), lastDate: new Date(0) });
		}
	}
	return pool;
}

G_StartUe5Pool = [];
global.InitUe5Pool = function () {
	// 启动池仅来自「UE工程管理」(projects)；未配置工程则池为空——不启动任何实例，
	// 也不再回退到旧版 UE5 字符串数组，避免误启动已失效/陈旧的路径。
	G_StartUe5Pool = (global.projects && global.projects.length)
		? buildPoolFromProjects()
		: [];
};

// 找一个可启动的实例；wantPrefix 非空时优先（仅）在该工程内找
function GetFreeUe5(wantPrefix) {
	const onLineExecIp = [];
	const onLineClient = [];
	for (const exeWs of EXECUE.clients) {
		if (isAdminWs(exeWs.req)) continue; // 管理后台连接不是渲染代理
		onLineExecIp.push(getIPv4(exeWs.req.socket.remoteAddress));
		onLineClient.push(exeWs);
	}
	const coolTime = global.exeUeCoolTime || 60;
	let pool = G_StartUe5Pool;
	if (wantPrefix) {
		const pref = pool.filter((e) => e.urlPrefix === wantPrefix);
		if (pref.length) pool = pref; // 该工程有候选则只在其中找
	}
	for (const item of pool) {
		const hasStartUp = [...ENGINE.clients].some((c) => "/" + item.key === c.req.url);
		if ((Date.now() - item.lastDate) / 1000 < coolTime) continue;
		if (hasStartUp) continue;
		if (item.localCmd) { item.lastDate = new Date(); return item; }
		const index = onLineExecIp.indexOf(item.ip);
		if (index !== -1) { item.lastDate = new Date(); return { ...item, exeWs: onLineClient[index] }; }
	}
	return;
}
function getIPv4(ip) {
	const net = require("net");
	if (net.isIPv6(ip)) {
		const match = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
		if (match) {
			return match[1];
		}
	}
	return ip;
}
function StartExecUe(wantPrefix) {
	const item = GetFreeUe5(wantPrefix);
	if (!item) return;
	audit("ue_start", { project: item.urlPrefix, key: item.key, local: item.localCmd, ip: item.ip || "local" });
	if (item.localCmd) {
		//启动本地的UE（buffer 编码 + 按平台解码，避免中文控制台 GBK 乱码）
		child_process.exec(item.cmd, { cwd: __dirname, encoding: "buffer" }, (error, stdout, stderr) => {
			if (error) {
				const detail = decodeOutput(stderr).trim();
				console.error(`exec error: ${item.cmd}\n${detail || error.message}`);
			}
		});
	} else {
		//启动远端的UE
		item.exeWs.send(item.cmd);
	}
}

// 为指定渲染代理挑选一个可启动的远端实例槽位：按 IP 匹配，跳过冷却期内/已启动的
function GetFreeUe5ForAgent(agentWs) {
	const agentIp = getIPv4(agentWs.req.socket.remoteAddress);
	const coolTime = global.exeUeCoolTime || 60;
	for (const item of G_StartUe5Pool) {
		if (item.localCmd || item.ip !== agentIp) continue;     // 只挑该代理负责的远端槽位
		if ((Date.now() - item.lastDate) / 1000 < coolTime) continue;
		const hasStartUp = [...ENGINE.clients].some((c) => "/" + item.key === c.req.url);
		if (hasStartUp) continue;
		item.lastDate = new Date();
		return item;
	}
	return;
}

// 渲染代理（exec-ue.js）WS 上线后，按「预加载个数」自动调度预启动该代理的 UE 工程实例
// preload=0（默认）则不自动启动，保持原有按需启动行为
function autoScheduleForAgent(agentWs) {
	const want = +global.preload || 0;
	if (want <= 0) return;
	const agentIp = getIPv4(agentWs.req.socket.remoteAddress);
	let launched = 0;
	for (let i = 0; i < want; i++) {
		const item = GetFreeUe5ForAgent(agentWs);
		if (!item) break;                                        // 没有更多可启动的槽位
		audit("ue_start", { project: item.urlPrefix, key: item.key, ip: agentIp, auto: true });
		try { agentWs.send(item.cmd); launched++; } catch { }
	}
	if (launched) console.info(`🚀 渲染代理 ${agentIp} 上线，自动预启动 ${launched} 个 UE 实例`);
}

InitUe5Pool();

function InitExecUe() {
	//exec-ue的websocket连接管理
	global.EXECUE = new Server(
		{ noServer: true, clientTracking: true },
		() => { }
	);
	EXECUE.on("connection", (socket, req) => {
		socket.req = req;
		socket.connectedAt = Date.now();

		socket.isAlive = true;
		socket.on("pong", heartbeat);

		// 管理后台客户端：推送历史日志并接收受限的管理指令（不使用 eval）
		if (isAdminWs(req)) {
			// token 模式下，管理通道需在 URL 查询串携带有效令牌（WS 无法设置请求头）
			if (tokenMode()) {
				const tok = new URL(req.url, "http://x").searchParams.get("token");
				if (!verifyToken(tok)) {
					try { socket.send(JSON.stringify({ type: "ack", cmd: "auth", ok: false, error: "未授权" })); } catch { }
					socket.close(1008, "unauthorized");
					return;
				}
			}
			try { socket.send(JSON.stringify({ type: "logs", logs: LOG_BUFFER })); } catch { }
			socket.on("message", (raw) => handleAdminCommand(socket, raw));
		} else {
			// 渲染代理（exec-ue.js）上线：自动调度预启动该代理负责的 UE 工程实例
			autoScheduleForAgent(socket);
		}

		print();
	});

}

InitExecUe();

global.ENGINE = new Server({ noServer: true, clientTracking: true }, () => { });

ENGINE.on("connection", (ue, req) => {
	ue.req = req;
	ue.connectedAt = Date.now();
	// 工程路由前缀（UE 连接 URL 的首段），玩家据此匹配；旧共享模式下为空亦无妨
	ue.urlPrefix = routePrefix(req.url);
	audit("engine_connect", { project: ue.urlPrefix, path: req.url, port: req.socket.remotePort });

	ue.isAlive = true;
	ue.on("pong", heartbeat);

	ue.fe = new Set();
	// sent to UE5 as initial signal
	ue.send(
		JSON.stringify({
			type: "config",
			peerConnectionOptions: {
				iceServers: global.iceServers,
			},
		})
	);

	// 认领空闲的前端们
	for (const fe of PLAYER.clients) {
		if (fe.killPlayer) {
			continue
		}
		if (!fe.ue) {
			PLAYER.emit("connection", fe, fe.req);
		}
	}
	print();

	ue.onmessage = (msg) => {
		msg = JSON.parse(msg.data);

		// Convert incoming playerId to a string if it is an integer, if needed. (We support receiving it as an int or string).

		if (msg.type === "ping") {
			ue.send(JSON.stringify({ type: "pong", time: msg.time }));
			return;
		}

		// player's port as playerID
		const fe = [...ue.fe].find(
			(fe) => fe.req.socket.remotePort === +msg.playerId
		);

		if (!fe) return;

		delete msg.playerId; // no need to send it to the player
		if (["offer", "answer", "iceCandidate"].includes(msg.type)) {
			fe.send(JSON.stringify(msg));
		} else if (msg.type === "disconnectPlayer") {
			fe.close(1011, msg.reason);
		} else {
		}
	};

	ue.onclose = (e) => {
		audit("engine_disconnect", { project: ue.urlPrefix, port: req.socket.remotePort });
		ue.fe.forEach((fe) => {
			fe.ue = null;
		});
		print();
	};

	ue.onerror;
});

const path = require("path");








// token 模式开启时，校验请求是否携带有效令牌；否则抛错（由 POST 的 catch 统一处理）
function requireToken(request) {
	if (!tokenMode()) return;             // 未启用 token：放行（兼容旧版）
	const payload = verifyToken(tokenFromReq(request));
	if (!payload) throw '未授权：令牌无效或已过期，请重新登录';
}

async function POST(request, response, HTTP) {

	switch (request.url) {
		case "/login": {
			// 账号密码校验 -> 签发 HMAC 令牌（需配置 token.secret）
			const body = await readBody(request);
			let creds = {};
			try { creds = JSON.parse(body.toString() || '{}'); } catch { }
			const expected = global.auth || '';
			if (!expected) throw '服务端未配置账号（auth），无法登录';
			if (`${creds.username}:${creds.password}` !== expected) throw '用户名或密码错误';
			if (!tokenMode()) throw '服务端未配置 token.secret，无法签发令牌';
			const ttl = global.token.ttl || 86400;
			const tok = signToken({ u: creds.username, exp: Date.now() + ttl * 1000 });
			response.setHeader('Content-Type', 'application/json');
			return JSON.stringify({ token: tok, expiresIn: ttl });

			break;
		}

		case "/signal": {
			requireToken(request);
			return Signal(request, response, HTTP);

			break;
		}

		case "/eval": {
			// 任意代码执行：默认禁用，需在 signal.json 中设置 "enableEval": true 才开启
			if (!global.enableEval) throw 'eval 接口已禁用（如需开启请在 signal.json 设置 enableEval:true）';
			return eval(decodeURIComponent(request.headers['eval']))

			break;
		}

		case "/exec": {
			// 任意命令执行：默认禁用，需在 signal.json 中设置 "enableEval": true 才开启
			if (!global.enableEval) throw 'exec 接口已禁用（如需开启请在 signal.json 设置 enableEval:true）';
			return new Promise((res, rej) => {

				child_process.exec(
					decodeURIComponent(request.headers['exec']),
					(error, stdout, stderr) => {
						if (error) {
							rej(stderr)
						} else {
							res(stdout)
						}
					});
			})
			break;
		}

		case "/write": {
			requireToken(request);
			return Write(request, response, HTTP);

			break;
		}
	}
};

// 修改整体配置
async function Signal(request, response, HTTP) {

	let newSignal = JSON.parse(decodeURIComponent(request.headers['signal']))

	// 安全：enableEval 只能通过直接编辑 signal.json 设置，禁止经由网络配置接口开启
	delete newSignal.enableEval;

	//修改了端口，执行下列方法使其生效
	if (newSignal.PORT) {
		await global.serve(newSignal.PORT);

	}

	delete require.cache[require.resolve('./signal.json')]
	let signal = require('./signal.json');

	Object.assign(signal, newSignal);

	Object.assign(global, newSignal);



	// 工程/服务器/渲染参数变化都需要重建启动池
	const poolKeys = ["UE5", "projects", "servers", "resolution", "fps", "unattended", "renderOffScreen", "audioMixer", "serverIp"];
	if (poolKeys.some((k) => k in newSignal)) {
		await global.InitUe5Pool();
	}

	if (newSignal.boot !== undefined) {
		await global.Boot()
	}

	await fs.promises.writeFile(__dirname + '/signal.json', JSON.stringify(signal, null, '\t'));

	await new Promise(res => {
		response.end(JSON.stringify(newSignal), res);
	})


	if (newSignal.PORT) {
		HTTP.closeAllConnections()
		HTTP.close(() => { });
	}



}



// 仅允许覆盖这些已知的应用文件，防止路径穿越/任意文件写入
const ALLOWED_WRITE = new Set([
	"signal.html",
	"signal.js",
	"signal.css",
	"signal-ui.js",
	"peer-stream.js",
]);

async function Write(req, res, HTTP) {
	const target = decodeURIComponent(req.headers['write'] || '').replace(/^[/\\]+/, '');
	const base = path.basename(target);
	if (target !== base || !ALLOWED_WRITE.has(base)) throw '不允许写入该文件';

	const chunks = [];

	// Receive chunks of data
	req.on('data', chunk => {
		chunks.push(chunk);
	});

	const body = await new Promise(res => {
		req.on('end', () => {
			res(Buffer.concat(chunks));
		})
	})

	await fs.promises.writeFile(path.join(__dirname, base), body)

	return ('updated');



}







global.serve = async (PORT) => {
	// 配置了有效的 TLS 证书则启用 HTTPS/WSS，否则回退普通 HTTP
	let HTTP;
	if (global.tls && global.tls.cert && global.tls.key) {
		try {
			const opts = {
				cert: fs.readFileSync(global.tls.cert),
				key: fs.readFileSync(global.tls.key),
			};
			HTTP = require("https").createServer(opts);
			global.secure = true;
			console.info("🔒 已启用 HTTPS/WSS");
		} catch (e) {
			console.error(`TLS 证书读取失败，回退 HTTP：${e.message}`);
			HTTP = require("http").createServer();
			global.secure = false;
		}
	} else {
		HTTP = require("http").createServer();
		global.secure = false;
	}

	HTTP.on("request", (req, res) => {
		// websocket请求时不触发

		// IP 白名单 + 单 IP 限流（未配置则放行）
		const ip = req.socket.remoteAddress;
		if (!ipAllowed(ip)) { res.writeHead(403); res.end("Forbidden"); return; }
		if (!rateOk(ip)) { res.writeHead(429); res.end("Too Many Requests"); return; }

		// Basic Authentication
		// token 模式下由登录令牌接管鉴权（/login 等需可达），不再叠加 HTTP Basic Auth
		if (global.auth && !tokenMode()) {
			let auth = req.headers.authorization?.replace("Basic ", "");
			auth = Buffer.from(auth || "", "base64").toString("utf-8");
			if (global.auth !== auth) {
				res.writeHead(401, {
					"WWW-Authenticate": 'Basic realm="Auth required"',
				});
				res.end("Auth failed !");
				return;
			}
		}

		if (req.method === 'POST') {
			POST(req, res, HTTP)
				.then((result) => {
					if (!res.writableEnded) res.end(result);
				})
				.catch((err) => {
					// A string to be encoded as a URI component (a path, query string, fragment, etc.). Other values are converted to strings.
					res.setHeader('error', encodeURIComponent(err))
					res.writeHead(400);
					res.end('', () => { });
				});
			return
		}

		// strip query string (e.g. cache-busting "?v=123") before resolving the file
		let pathname = req.url.split("?")[0];
		if (pathname === "/") pathname = "/signal.html";
		// token 模式下 signal.json 含敏感字段（token.secret 等），需有效令牌方可读取
		if (pathname === "/signal.json" && tokenMode() && !verifyToken(tokenFromReq(req))) {
			res.writeHead(401); res.end(""); return;
		}
		// 访问审计查询（token 门控）
		if (pathname === "/audit") {
			if (tokenMode() && !verifyToken(tokenFromReq(req))) { res.writeHead(401); res.end(""); return; }
			readAudit(200).then((rows) => {
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify(rows));
			});
			return;
		}
		// serve static files
		const read = fs.createReadStream(
			path.join(__dirname, path.normalize(pathname))
		);
		const types = {
			".html": "text/html",
			".css": "text/css",
			".js": "text/javascript",
			".json": "application/json",
			".svg": "image/svg+xml",
			".ico": "image/x-icon",
		};
		const type = types[path.extname(pathname)];
		if (type) res.setHeader("Content-Type", type);
		// admin/SDK assets change during development — don't let browsers cache them
		res.setHeader("Cache-Control", "no-cache");

		read
			.on("error", async (error) => {
				res.writeHead(404);
				res.end("");
			})
			.on("ready", () => {
				read.pipe(res);
			});
	});

	HTTP.on("upgrade", (req, socket, head) => {
		// IP 白名单 + 限流同样作用于 WebSocket 握手
		const ip = req.socket.remoteAddress;
		if (!ipAllowed(ip) || !rateOk(ip)) {
			socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
			socket.destroy();
			return;
		}
		// WS子协议
		if (req.headers["sec-websocket-protocol"] === "peer-stream") {
			PLAYER.handleUpgrade(req, socket, head, (fe) => {
				audit("player_connect", { project: routePrefix(req.url), ip: getIPv4(req.socket.remoteAddress), port: req.socket.remotePort });
				PLAYER.emit("connection", fe, req);
			});
		} else if (req.headers["sec-websocket-protocol"] === "exec-ue") {
			EXECUE.handleUpgrade(req, socket, head, (fe) => {
				EXECUE.emit("connection", fe, req);
			});
		} else {
			ENGINE.handleUpgrade(req, socket, head, (fe) => {
				ENGINE.emit("connection", fe, req);
			});
		}
	});

	return new Promise((res, rej) => {
		HTTP.listen(PORT ?? 88, res);
		HTTP.once("error", (err) => {
			rej(err);
		});
	});
};

serve(PORT);

// front end
global.PLAYER = new Server({
	clientTracking: true,
	noServer: true,
});
// every player
PLAYER.on("connection", (fe, req) => {
	fe.req = req;
	fe.connectedAt = fe.connectedAt || Date.now();

	fe.isAlive = true;

	// 工程路由：玩家请求的工程前缀（空=旧共享模式，匹配所有实例）
	const want = routePrefix(req.url);
	fe.urlPrefix = want;
	let candidates = [...ENGINE.clients];
	if (want) {
		const matched = candidates.filter((ue) => ue.urlPrefix === want);
		if (matched.length) candidates = matched;          // 有该工程实例：只在其中分配
		else if (global.strictMatch) candidates = [];      // 严格匹配：无则不分配，触发按需启动
		// 非严格：回退到全部实例（任意/首个）
	}

	if (global.one2one) {
		// 选择空闲的ue
		fe.ue = candidates.find((ue) => ue.fe.size === 0);
	} else {
		// 选择人最少的ue
		fe.ue = candidates.sort((a, b) => a.fe.size - b.fe.size)[0];
	}

	fe.send(
		JSON.stringify({
			type: "seticeServers",
			iceServers: global.iceServers,
		})
	);

	if (fe.ue) {
		fe.ue.fe.add(fe);
		if (global.UEVersion && global.UEVersion === 4.27) {
			fe.send(
				JSON.stringify({
					type: "playerConnected",
					playerId: req.socket.remotePort,
					dataChannel: true,
					sfu: false,
				})
			);
		} else {
			fe.ue.send(
				JSON.stringify({
					type: "playerConnected",
					playerId: req.socket.remotePort,
					dataChannel: true,
					sfu: false,
				})
			);
		}
	} else {
		// 没找到现成的UE进程，按该玩家请求的工程启动
		StartExecUe(want);
	}

	print();

	fe.onmessage = (msg) => {
		msg = JSON.parse(msg.data);
		if (msg.type === "pong") {
			fe.isAlive = true;
			return
		}

		if (!fe.ue) {
			fe.send(`! Engine not ready`);
			return;
		}

		msg.playerId = req.socket.remotePort;
		if (["offer", "answer", "iceCandidate"].includes(msg.type)) {
			fe.ue.send(JSON.stringify(msg));
		} else {
			fe.send("? " + msg.type);
		}
	};

	fe.onclose = (e) => {
		audit("player_disconnect", { project: fe.urlPrefix, port: req.socket.remotePort });
		if (fe.ue) {
			fe.ue.send(
				JSON.stringify({
					type: "playerDisconnected",
					playerId: req.socket.remotePort,
				})
			);
			fe.ue.fe.delete(fe);
		}
		// 当用户连接数大于ue实例的时候，有用户退出意味着可以，认领空闲的前端们
		for (const fe of PLAYER.clients) {
			if (fe.killPlayer) {
				continue
			}
			if (!fe.ue) {
				PLAYER.emit("connection", fe, fe.req);
			}
		}

		print();
	};

	fe.onerror;
});

function heartbeat() {
	this.isAlive = true;
}

// keep alive
setInterval(() => {
	PLAYER.clients.forEach(function each(fe) {
		if (fe.isAlive === false) return fe.close();

		fe.send(
			JSON.stringify({
				type: "ping",
			})
		);
		fe.isAlive = false;
	});

	ENGINE.clients.forEach(function each(ue) {
		if (ue.isAlive === false) return ue.close();

		ue.isAlive = false;
		ue.ping("", false);
	});

	EXECUE.clients.forEach(function each(ws) {
		if (ws.isAlive === false) return ws.close();

		ws.isAlive = false;
		ws.ping("", false);
	});
}, 30 * 1000);



// 内网IP地址
const nets = require('os').networkInterfaces();
global.address = Object.values(nets).flat()
	.find(a => a.family === 'IPv4' && !a.internal)?.address

child_process.exec(
	`start ${global.secure ? "https" : "http"}://${address}:${PORT}/#signal.json`
);

// 打印映射关系，并向管理后台推送增强的仪表盘数据
function print() {
	const logs = [{ type: 'signal.js', address, PORT, path: __dirname, connectedAt: global.startedAt }];

	// 排队中的玩家 + 真实的 exec-ue 代理（排除管理后台自身的连接）
	const feList = [...PLAYER.clients].filter((fe) => !fe.ue)
		.concat([...EXECUE.clients].filter((a) => !isAdminWs(a.req)));
	feList.forEach((fe) => {
		logs.push({
			type: fe.req.headers["sec-websocket-protocol"],
			address: fe.req.socket.remoteAddress,
			PORT: fe.req.socket.remotePort,
			path: fe.req.url,
			connectedAt: fe.connectedAt
		})
	});

	ENGINE.clients.forEach((ue) => {
		logs.push({
			type: "Unreal Engine",
			address: ue.req.socket.remoteAddress,
			PORT: ue.req.socket.remotePort,
			path: ue.req.url,
			connectedAt: ue.connectedAt,
			players: ue.fe.size
		})
		ue.fe.forEach((fe) => {
			logs.push({
				type: fe.req.headers["sec-websocket-protocol"],
				address: fe.req.socket.remoteAddress,
				PORT: fe.req.socket.remotePort,
				path: fe.req.url,
				connectedAt: fe.connectedAt
			})
		});
	});

	const now = Date.now();
	const processes = logs.map((l) => ({
		type: l.type,
		address: l.address,
		PORT: l.PORT,
		path: l.path,
		uptime: l.connectedAt ? Math.floor((now - l.connectedAt) / 1000) : null,
		players: l.players ?? null,
	}));
	const stats = {
		uptime: Math.floor((now - global.startedAt) / 1000),
		players: PLAYER.clients.size,
		engines: ENGINE.clients.size,
		agents: [...EXECUE.clients].filter((a) => !isAdminWs(a.req)).length,
		freeUe: [...ENGINE.clients].filter((ue) => ue.fe.size === 0).length,
		queued: [...PLAYER.clients].filter((fe) => !fe.ue).length,
	};
	const payload = JSON.stringify({ type: "admin", ts: now, stats, processes });

	EXECUE.clients.forEach(a => {
		if (isAdminWs(a.req) && a.readyState === 1) a.send(payload)
	})
	rawConsole.clear();
	rawConsole.table(processes)

}

print();

let lastPreStart = new Date(0);
function Preload() {
	//只在one2one模型下载进行预加载，共享模式，加载不太频繁，不考虑
	if (!global.one2one) {
		return;
	}
	if (!global.preload) {
		return;
	}
	let ueNumber = ENGINE.clients.size;
	let playerNumber = PLAYER.clients.size;
	if (ueNumber < playerNumber + global.preload) {
		//预加载的时间间隔需要和实例的冷却时间匹配
		//https://github.com/inveta/peer-stream/issues/80
		let now = new Date();
		let difSecond = (now - lastPreStart) / 1000;
		let coolTime = 60;
		if (global.exeUeCoolTime) {
			coolTime = global.exeUeCoolTime;
		}
		if (difSecond < coolTime) {
			return;
		}
		lastPreStart = now;
		StartExecUe();
	}
}

function PreloadKeepAlive() {
	setInterval(() => {
		Preload();
	}, 5 * 1000);
}
PreloadKeepAlive();

//在one模式下，当gpu资源实例不足时，用户进行排队，并定期通知给用户当前排队进展
function PlayerQueue() {
	const fe = [...PLAYER.clients].filter((fe) => !fe.ue);
	if (!fe.length) {
		return;
	}
	let seq = 1;
	let msg = {};
	msg.type = "playerqueue";
	fe.forEach((fe) => {
		msg.seq = seq;
		seq = seq + 1;
		if (!fe.PlayerQueueSeq) {
			fe.PlayerQueueSeq = msg.seq;
			fe.send(JSON.stringify(msg));
			return;
		}
		if (fe.PlayerQueueSeq != msg.seq) {
			fe.PlayerQueueSeq = msg.seq;
			fe.send(JSON.stringify(msg));
			return;
		}
	});
}

function PlayerQueueKeepAlive() {
	if (!global.one2one) {
		return;
	}
	setInterval(() => {
		PlayerQueue();
	}, 5 * 1000);
}

PlayerQueueKeepAlive();

// command line
require("readline")
	.createInterface({
		input: process.stdin,
		output: process.stdout,
	})
	.on("line", (line) => {
		child_process.exec(
			line || ' ',
			{ encoding: "buffer" },
			(error, stdout, stderr) => {
				if (error) {
					console.error(decodeOutput(stderr))
				} else {
					console.log(decodeOutput(stdout))
				}
			});
	});

// process.title = __filename;

const signal_bat = process.env.APPDATA +
	'\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\signal.bat';

const signal_sh = "/etc/profile.d/signal.sh";

global.Boot = async function () {
	if (global.boot) {
		switch (process.platform) {
			case "win32": {
				const bat = `"${process.argv[0]}" "${__filename}"`;
				return fs.promises.writeFile(signal_bat, bat);
			}
			case "linux": {
				const sh = `nohup "${process.argv[0]}" "${__filename}" > "${__dirname}/signal.log" &`;
				await fs.promises.writeFile(signal_sh, sh);
				await fs.promises.chmod(signal_sh, 0o777)
			}
		}
	} else {
		switch (process.platform) {
			case "win32": {
				return fs.promises.rm(signal_bat, { force: true })
			}
			case "linux": {
				return fs.promises.rm(signal_sh, { force: true });
			}
		}
	}
}

Boot().catch(err => { });



// 管理后台指令处理：仅允许固定的安全操作，替代旧的 /eval 方式
async function handleAdminCommand(socket, raw) {
	let msg;
	try { msg = JSON.parse(raw.toString()); } catch { return; }
	const reply = (ok, error) => {
		try {
			socket.send(JSON.stringify({ type: "ack", cmd: msg.cmd, ok, error: error ? String(error) : undefined }));
		} catch { }
	};
	try {
		switch (msg.cmd) {
			case "killPlayer": audit("admin_cmd", { cmd: "killPlayer", port: +msg.port }); await global.killPlayer(+msg.port); reply(true); break;
			case "killUE": audit("admin_cmd", { cmd: "killUE", port: +msg.port }); await global.killUE(+msg.port); reply(true); break;
			case "startUe": audit("admin_cmd", { cmd: "startUe" }); StartExecUe(); reply(true); break;
			case "refresh": print(); reply(true); break;
			case "exit": audit("admin_cmd", { cmd: "exit" }); reply(true); setTimeout(() => process.exit(0), 100); break;
			default: reply(false, "未知指令");
		}
	} catch (e) {
		reply(false, e);
	}
}

global.killPlayer = async function (playerId) {
	const fe = [...PLAYER.clients].find(a => a.req.socket.remotePort === playerId)
	if (!fe) throw 'peer-stream not found!'
	fe.ue.send(
		JSON.stringify({
			type: "playerDisconnected",
			playerId,
		})
	)
	fe.ue.fe.delete(fe);
	fe.ue = null;
	fe.killPlayer = true
	// 当用户连接数大于ue实例的时候，有用户退出意味着可以，认领空闲的前端们
	for (const fe of PLAYER.clients) {
		if (fe.killPlayer) {
			continue
		}
		if (!fe.ue) {
			PLAYER.emit("connection", fe, fe.req);
		}
	}
	print();
}


global.killUE = async function (port) {
	let command = `netstat -ano | findstr "${port}.*:${PORT}"`
	const PID = await new Promise((res, rej) => {
		child_process.exec(command, (err, stdout, stderr) => {
			if (err) return rej(stderr)
			const PID = stdout.trim().split('\n')[0].trim().split(/\s+/).pop();
			res(PID)
		})
	})
	if (!PID) throw 'process ID not found'
	command = `taskkill /PID ${PID} /F`;
	await new Promise((res, rej) => {
		child_process.exec(command, (err, stdout, stderr) => {
			if (err)
				return rej(stderr);
			res(stdout.trim());
		});
	})
}