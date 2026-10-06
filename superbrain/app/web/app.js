/**
 * 控制台前端。零框架零构建：一份 app.js 直接对着后端 REST/SSE 渲染。
 * 所有来自模型或玩家的文本一律 esc() 后再进 innerHTML。
 */

const S = {
	"view": null,
	"status": null,
	"config": null,
	"intents": [],
	"catalog": null,
	"events": [],
	"history": [],
	"tab": "ops",
	"connected": false
};

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = v => (v == null || Number.isNaN(+v) ? "—" : Math.round(+v * 100) / 100);

/**
 * 双击 index.html（file://）时相对路径会指到文件系统上，请求必然失败；
 * 那种情况下退回默认服务地址，走 http 打开时用同源，端口换了也不用改代码。
 */
const ORIGIN = location.protocol.startsWith("http") ? "" : "http://127.0.0.1:8712";

async function api(route, payload)
{
	const res = await fetch(ORIGIN + route, payload === undefined ? { "method": "GET" } : {
		"method": "POST",
		"headers": { "content-type": "application/json" },
		"body": JSON.stringify(payload)
	});
	if (!res.ok && res.status === 404)
		throw new Error(`接口不存在：${route}`);
	const data = await res.json().catch(() => ({ "ok": false, "error": `响应不是 JSON（HTTP ${res.status}）` }));
	if (data && data.ok === false && data.error)
		throw new Error(data.error);
	return data;
}

function mmss(sec)
{
	const s = Math.max(0, Math.round(sec || 0));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ SSE

function connect()
{
	const es = new EventSource(ORIGIN + "/api/events");
	es.onopen = () => { S.connected = true; };
	es.onerror = () =>
	{
		S.connected = false;
		$("#conn").className = "dot";
		$("#connText").textContent = "后端断开，正在重连";
	};
	es.onmessage = ev => {
		let msg;
		try { msg = JSON.parse(ev.data); } catch (e) { return; }
		if (msg.type === "hello")
		{
			S.view = msg.data.view;
			S.status = msg.data.status;
			S.events = msg.data.events || [];
			S.config = null;
			renderAll();
			loadConfig();
		}
		else if (msg.type === "state")
		{
			S.view = msg.data;
			renderAll();
		}
		else if (msg.type === "event")
		{
			S.events.push(msg.data);
			if (S.events.length > 120) S.events.shift();
			renderLog();
			flashStatus(msg.data);
		}
	};
}

function flashStatus(ev)
{
	if (!ev || (ev.type !== "cmd" && ev.type !== "param"))
		return;
	const el = $("#frameInfo");
	el.textContent = ev.text.slice(0, 90);
	setTimeout(() => renderHeader(), 4000);
}

// ------------------------------------------------------------------ 渲染

function renderAll()
{
	renderHeader();
	renderAlarms();
	renderStats();
	renderGroups();
	renderPlayers();
	renderMap();
	renderTargets();
	renderParams();
	renderTakeover();
	renderLog();
}

function renderHeader()
{
	const v = S.view;
	const st = S.status || {};
	$("#subline").textContent = v ? v.headline : "等待对局数据：进一局单人对局（勾选 superbrain mod）即自动连上";
	const alive = !!(st.connected);
	$("#conn").className = `dot ${alive ? "on" : (st.dir ? "warn" : "")}`;
	$("#connText").textContent = alive ? "已连接" : (st.dir ? "帧停止更新" : "未发现对局");
	$("#frameInfo").textContent = v ? `帧 ${v.seq} · ${Math.round(v.ageMs / 100) / 10}s 前 · ${st.dir ? st.dir.split(/[\\/]/).pop() : ""}` : "";
	if (v && v.ageMs > 8000)
		$("#connText").textContent = "帧停止更新（游戏被最小化会暂停主循环）";
}

function renderAlarms()
{
	const list = (S.view && S.view.alarms) || [{ "level": "info", "text": "等待态势帧" }];
	$("#alarms").innerHTML = list.map(a => `<div class="alarm ${esc(a.level)}">${esc(a.text)}</div>`).join("");
}

function renderStats()
{
	const v = S.view;
	if (!v)
	{
		$("#stats").innerHTML = `<div class="stat"><span class="k">状态</span><span class="v">—</span><span class="s">还没连上对局</span></div>`;
		return;
	}
	const e = v.econ || {};
	const c = v.combat || {};
	const r = v.my.resources || {};
	const k = v.kernel || {};
	const income = e.income || {};
	const cards = [
		{ "k": "人口", "v": `${v.my.pop}/${v.my.popCap}`, "s": `上限 ${e.popCap || v.my.popCap} · 阶段 ${v.my.phase || "?"}`, "c": v.my.pop >= (e.popCap || v.my.popCap) ? "warn" : "" },
		{ "k": "农民", "v": e.civilians != null ? e.civilians : v.counts.workers, "s": `目标 ${e.wantCivilians || "?"} · 闲 ${e.idle || 0} · 关着 ${e.bunkered || 0}`, "c": (e.bunkered || 0) > 4 ? "warn" : "good" },
		{ "k": "军队", "v": v.counts.army, "s": `配比 ${mixText(v.composition)} · 均血 ${Math.round(v.armyHp * 100)}%` },
		{ "k": "资源", "v": `${num(r.food)}粮`, "s": `木 ${num(r.wood)} 石 ${num(r.stone)} 金 ${num(r.metal)}`, "c": r.food < 20 ? "bad" : "" },
		{ "k": "收入/秒", "v": num(income.food), "s": `木 ${num(income.wood)} 石 ${num(income.stone)} 金 ${num(income.metal)}` },
		{ "k": "战损", "v": `${c.foeKills ?? "—"} / ${c.ourLosses ?? "—"}`, "s": `掉血比 ${num(c.ratio)} · 内核判定 ${k.fight ? (k.fight.fight ? "打" : "撤") : "—"}`, "c": c.ratio > 1.4 ? "good" : c.ratio && c.ratio < 0.7 ? "bad" : "" },
		{ "k": "建筑", "v": `${e.cc || 0}CC ${e.houses || 0}房`, "s": `田 ${e.fields || 0} · 产兵 ${e.producers || 0} · 实体行 ${v.counts.ownRows}` },
		{ "k": "威胁", "v": e.threatDist != null ? `${Math.round(e.threatDist)}` : (v.homeThreat && v.homeThreat.seen != null ? `${v.homeThreat.seen}` : "—"), "s": `离家格数 · 可见敌 ${v.counts.foesSeen}`, "c": (e.threatDist != null && e.threatDist < 70) ? "bad" : "" },
		{ "k": "下令", "v": `${(k.issued || 0)}/${(e.issued || 0)}`, "s": `军拒 ${k.rejected || 0} · 经拒 ${(e.rejectedTotal ?? "—")}` }
	];
	$("#stats").innerHTML = cards.map(x => `<div class="stat ${esc(x.c || "")}"><span class="k">${esc(x.k)}</span><span class="v mono">${esc(x.v)}</span><span class="s">${esc(x.s)}</span></div>`).join("");
}

function mixText(tally)
{
	if (!tally || !Object.keys(tally).length)
		return "无";
	const label = { "pikeman": "枪", "sword": "剑", "ranged": "远", "cav": "骑", "hcav": "骑射", "siege": "攻", "hero": "英", "other": "他" };
	return Object.keys(label).filter(k => tally[k]).map(k => `${label[k]}${tally[k]}`).join("/") || "无";
}

function renderGroups()
{
	const rows = (S.view && S.view.groups) || [];
	const body = $("#groups tbody");
	if (!rows.length)
	{
		body.innerHTML = `<tr><td colspan="10" class="dim">内核还没有编组（战场上没有可见可控单位）</td></tr>`;
		return;
	}
	body.innerHTML = rows.map(g => `<tr>
		<td class="mono">${esc(g.key)}</td><td>${esc(g.role)}</td><td>${esc(g.task || g.action)}</td>
		<td class="num">${g.n}</td><td class="num">${g.d}</td><td class="num">${g.range}</td>
		<td>${esc(g.action)}</td><td class="num">${g.wounded}</td>
		<td class="num ${g.task === "return" ? "bad" : ""}">${g.home == null ? "—" : g.home}</td>
		<td class="mono">${g.dest ? `${Math.round(g.dest[0])},${Math.round(g.dest[1])}` : "—"}</td></tr>`).join("");
}

function renderPlayers()
{
	const list = ((S.view && S.view.players) || []).filter(p => !p.mine && String(p.name) !== "Gaia");
	const body = $("#players tbody");
	if (!list.length)
	{
		body.innerHTML = `<tr><td colspan="6" class="dim">没有可见对手</td></tr>`;
		return;
	}
	body.innerHTML = list.map(p => {
		const r = p.resources || {};
		return `<tr><td>P${esc(p.id)} ${esc(p.name)}</td><td>${esc(p.civ || "?")}</td>
		<td class="num">${p.pop}/${p.popCap}</td>
		<td class="mono">${num(r.food)} / ${num(r.wood)} / ${num(r.stone)} / ${num(r.metal)}</td>
		<td class="num">${p.techs}</td>
		<td>${p.dead ? '<span style="color:var(--bad)">被击败</span>' : esc(p.state || "")}</td></tr>`;
	}).join("");
}

function renderTargets()
{
	const sel = $("#target");
	if (!S.view)
		return;
	const cur = sel.value;
	const foes = (S.view.players || []).filter(p => p.enemy && !p.mine && String(p.name) !== "Gaia");
	sel.innerHTML = `<option value="">（自动）</option>` + foes.map(p => `<option value="${p.id}">P${p.id} ${esc(p.name)}/${esc(p.civ || "?")} pop${p.pop}</option>`).join("");
	if (cur && foes.some(f => String(f.id) === cur))
		sel.value = cur;
}

function renderTakeover()
{
	const v = S.view || {};
	$("#btnMil").classList.toggle("on", !!v.autopilot);
	$("#btnEco").classList.toggle("on", !!v.economyOn);
	$("#btnMil").firstChild.textContent = v.autopilot ? "已接管军事" : "接管军事";
	$("#btnEco").firstChild.textContent = v.economyOn ? "已接管经济" : "接管经济";
}

function renderMap()
{
	const cv = $("#map");
	const ctx = cv.getContext("2d");
	ctx.clearRect(0, 0, cv.width, cv.height);
	ctx.fillStyle = "#0a0f14";
	ctx.fillRect(0, 0, cv.width, cv.height);
	const m = S.view && S.view.map;
	if (!m)
		return;

	let minX = 0, maxX = 200, minZ = 0, maxZ = 200;
	const all = m.own.concat(m.workers, m.structures, m.foes, m.last);
	if (all.length)
	{
		minX = Math.min(...all.map(p => p[0]));
		maxX = Math.max(...all.map(p => p[0]));
		minZ = Math.min(...all.map(p => p[1]));
		maxZ = Math.max(...all.map(p => p[1]));
	}
	const pad = 8;
	const sx = (maxX - minX) || 1, sz = (maxZ - minZ) || 1;
	const scale = Math.min((cv.width - pad * 2) / sx, (cv.height - pad * 2) / sz);
	const ox = (cv.width - sx * scale) / 2, oz = (cv.height - sz * scale) / 2;
	const px = p => ox + (p[0] - minX) * scale;
	const pz = p => oz + (p[1] - minZ) * scale;

	ctx.fillStyle = "#4a5c6e";
	m.structures.forEach(p => { ctx.fillRect(px(p) - 2, pz(p) - 2, p[2] === 2 ? 5 : 4, p[2] === 2 ? 5 : 4); });
	ctx.fillStyle = "#ffd479";
	m.workers.forEach(p => { ctx.fillRect(px(p) - 1, pz(p) - 1, 2, 2); });
	ctx.fillStyle = "#58a6ff";
	m.own.forEach(p => { ctx.fillRect(px(p) - 1.5, pz(p) - 1.5, 3, 3); });
	ctx.fillStyle = "#ff6b6b";
	m.foes.forEach(p => { ctx.beginPath(); ctx.arc(px(p), pz(p), 2, 0, 6.3); ctx.fill(); });
	ctx.fillStyle = "#7a3b3b";
	m.last.forEach(p => { ctx.fillRect(px(p) - 1, pz(p) - 1, 2, 2); });

	if (S.view.home)
	{
		ctx.strokeStyle = "#4ec9a1";
		ctx.beginPath();
		ctx.arc(px([S.view.home.x, S.view.home.z]), pz([S.view.home.x, S.view.home.z]), 5, 0, 6.3);
		ctx.stroke();
	}
	if (S.view.foeCentroid)
	{
		ctx.strokeStyle = "#e0655f";
		ctx.beginPath();
		ctx.arc(px([S.view.foeCentroid.x, S.view.foeCentroid.z]), pz([S.view.foeCentroid.x, S.view.foeCentroid.z]), 6, 0, 6.3);
		ctx.stroke();
	}
}

const PARAM_KEYS = {
	"micro": [["doctrine", "打法"], ["engageRadius", "接战半径"], ["resistBase", "接战阈值"], ["pushGrit", "韧性"], ["maxChase", "追击上限"],
		["standoff", "风筝系数"], ["retreatHp", "后撤血量"], ["maxGroups", "最大编组"], ["kite", "风筝"], ["focusPlayer", "打击对象"],
		["civilianDanger", "村民警戒"], ["attackStructures", "打建筑"]],
	"econ": [["villagerCap", "农民目标"], ["armyShare", "出兵份额"], ["armyPopShare", "兵役份额"], ["minReserve", "保底储备"],
		["buildPace", "扩建节奏"], ["farmTarget", "农田目标"], ["techShare", "科技投入"], ["unloadThreat", "放人距离"], ["maxOps", "每拍命令数"]]
};

function fmtVal(v)
{
	if (v === true)
		return "开";
	if (v === false)
		return "关";
	if (v == null)
		return "—";
	return typeof v === "number" ? Math.round(v * 100) / 100 : String(v);
}

function renderParams()
{
	const v = S.view || {};
	const m = v.cfg || {};
	const e = v.econCfg || {};
	const cell = (label, val) => `<span class="p"><i>${esc(label)}</i><b>${esc(fmtVal(val))}</b></span>`;
	$("#params").innerHTML =
		`<div class="pg"><span class="pgt">微操</span>${PARAM_KEYS.micro.map(([k, l]) => cell(l, m[k])).join("")}</div>` +
		`<div class="pg"><span class="pgt">经济</span>${PARAM_KEYS.econ.map(([k, l]) => cell(l, e[k])).join("")}</div>` +
		(Object.keys(e).length ? "" : `<div class="hint">读不到经济参数：这一局的 mod 版本还没导出 econCfg（重开一局即可，控制台显示的是游戏内真值，不拿本地副本冒充）。</div>`);
}

function renderLog()
{
	const el = $("#log");
	const items = S.events.slice(-40).reverse();
	el.innerHTML = items.map(e => `<div><b>${esc(e.type)}</b> ${new Date(e.at).toLocaleTimeString("zh-CN", { "hour12": false })} — ${esc(e.text)}</div>`).join("") ||
		`<div class="dim">（暂无事件）</div>`;
}

// ------------------------------------------------------------------ 接管与旋钮

async function post(route, payload, label)
{
	const btn = label ? $(label) : null;
	if (btn) btn.disabled = true;
	try
	{
		const out = await api(route, payload);
		return out;
	}
	catch (e)
	{
		pushLocal(`✗ ${e.message}`, "bad");
		return null;
	}
	finally
	{
		if (btn) btn.disabled = false;
	}
}

function pushLocal(text, level)
{
	S.events.push({ "at": Date.now(), "type": "ui", "text": text, "level": level });
	renderLog();
	const box = $("#alarms");
	box.insertAdjacentHTML("afterbegin", `<div class="alarm ${level}">${esc(text)}</div>`);
	setTimeout(() => renderAlarms(), 6000);
}

$("#btnAll").onclick = () => post("/api/takeover", { "all": true });
$("#btnNone").onclick = () => post("/api/takeover", { "all": false });
$("#btnMil").onclick = () => post("/api/takeover", { "military": !(S.view && S.view.autopilot) });
$("#btnEco").onclick = () => post("/api/takeover", { "economy": !(S.view && S.view.economyOn) });
$("#btnQuick").onclick = () => post("/api/intent", { "name": "defend-home" });

let aggTimer = null;
$("#agg").oninput = () => { $("#aggOut").textContent = `${$("#agg").value}%`; };
$("#agg").onchange = () =>
{
	clearTimeout(aggTimer);
	aggTimer = setTimeout(() => post("/api/knobs", { "aggression": +$("#agg").value / 100 }), 120);
};

$("#posture").onclick = ev =>
{
	const b = ev.target.closest("button");
	if (!b) return;
	$$("#posture button").forEach(x => x.classList.toggle("on", x === b));
	post("/api/knobs", { "posture": b.dataset.v });
};

$("#ecoMode").onclick = ev =>
{
	const b = ev.target.closest("button");
	if (!b) return;
	$$("#ecoMode button").forEach(x => x.classList.toggle("on", x === b));
	post("/api/knobs", { "economy": b.dataset.v });
};

$("#doctrine").onchange = () => { if ($("#doctrine").value) post("/api/knobs", { "doctrine": $("#doctrine").value }); };
$("#target").onchange = () => post("/api/knobs", { "target": $("#target").value === "" ? 0 : +$("#target").value });

$("#btnSage").onclick = async () =>
{
	const running = $("#btnSage").classList.contains("on");
	const out = await post("/api/strategist", { "action": running ? "stop" : "start" });
	if (out)
	{
		$("#btnSage").classList.toggle("on", !running);
		$("#sageHint").textContent = running ? "战略层已交还给规则内核（按钮/旋钮仍然可用）。" : "模型在按周期读态势并下高阶指令；护栏：白名单 + 最短驻留 + 每轮条数上限。";
	}
};

// ------------------------------------------------------------------ 对话

const CHIPS = ["全部接管", "回防，村民被屠了", "攻击欲望 80%", "全力进攻", "先憋经济，20 分钟后再打", "换骑射骚扰他农民", "把军队拉回家练兵", "现在局势怎么样？"];

$("#chips").innerHTML = CHIPS.map(c => `<button type="button">${esc(c)}</button>`).join("");
$("#chips").onclick = ev =>
{
	if (ev.target.tagName === "BUTTON")
	{
		$("#chatText").value = ev.target.textContent;
		$("#chatText").focus();
	}
};

$("#chatForm").onsubmit = async ev =>
{
	ev.preventDefault();
	const text = $("#chatText").value.trim();
	if (!text)
		return;
	$("#chatText").value = "";
	appendMsg("user", text);
	S.history.push({ "role": "user", "content": text });

	const btn = ev.target.querySelector("button");
	btn.disabled = true;
	$("#engineTag").textContent = "模型思考中…";
	try
	{
		const out = await api("/api/chat", { "text": text, "history": S.history.slice(-6) });
		$("#engineTag").textContent = engineLabel(out.engine);
		const done = out.intents || [];
		appendMsg("ai", out.say || "（没话说）", done);
		S.history.push({ "role": "assistant", "content": JSON.stringify({ "say": out.say, "intents": done.map(d => ({ "name": d.name, "ok": d.ok })) }) });
		if (!done.some(d => d.ok))
			pushLocal(`指令未执行：${done.filter(d => !d.ok).map(d => `${d.name}(${d.error})`).join(" ") || "模型没给指令"}`, "warn");
	}
	catch (e)
	{
		appendMsg("ai", `失败：${e.message}`, []);
	}
	finally
	{
		btn.disabled = false;
	}
};

function engineLabel(engine)
{
	return { "llm": "大模型", "llm-retry": "大模型（已自纠错）", "rule": "规则兜底", "rule-fallback": "规则兜底（模型不可用）", "rule-none": "规则未命中", "none": "" }[engine] || engine || "";
}

function appendMsg(role, text, intents)
{
	const box = $("#chat");
	const its = (intents || []).map(i => `<div class="it ${i.ok ? "ok" : "err"}">${esc(i.name)} ${i.ok ? esc((i.notes || [])[0] || "已下发") : esc(i.error || "失败")}</div>`).join("");
	box.insertAdjacentHTML("beforeend", `<div class="msg ${role}"><div class="who">${role === "user" ? "玩家" : esc($("#engineTag").textContent || "副驾")}</div><div class="body">${esc(text)}</div>${its ? `<div class="its">${its}</div>` : ""}</div>`);
	box.scrollTop = box.scrollHeight;
}

// ------------------------------------------------------------------ 指令台

async function loadIntents()
{
	const out = await api("/api/intents");
	S.intents = out.intents;
	$("#intentCount").textContent = out.count;
	renderIntents("");
}

function renderIntents(q)
{
	const needle = q.toLowerCase();
	const list = S.intents.filter(i => !needle || `${i.name} ${i.label} ${i.desc}`.toLowerCase().includes(needle));
	$("#cmdList").innerHTML = list.map(i => `
		<div class="cmd" data-name="${esc(i.name)}">
			<header>
				<span class="name">${esc(i.name)}</span>
				<span class="label">${esc(i.label)}</span>
				<span class="kind">${esc(i.kind)}</span>
				<span class="d">${esc(i.desc)}</span>
			</header>
			<div class="body">
				<div class="args">${i.args.map(argHtml).join("") || '<span class="dim">无参数</span>'}</div>
				<div class="act">
					<button class="primary sm send">下发</button>
					<span class="out"></span>
				</div>
			</div>
		</div>`).join("");
}

function argHtml(a)
{
	const id = `a-${Math.random().toString(36).slice(2, 8)}`;
	const req = a.required ? ' data-required="1"' : "";
	let field;
	if (a.type === "selector")
		field = `<select id="${id}" data-key="${esc(a.key)}" data-type="selector"${req}>${["army", "all", "workers", "idle", "wounded", "bunkered", "structures", "cc"].map(o => `<option ${o === a.default ? "selected" : ""}>${o}</option>`).join("")}</select>`;
	else if (a.type === "enum")
		field = `<select id="${id}" data-key="${esc(a.key)}" data-type="enum"${req}>${a.enum.map(o => `<option ${o === a.default ? "selected" : ""}>${o}</option>`).join("")}</select>`;
	else if (a.type === "bool")
		field = `<select id="${id}" data-key="${esc(a.key)}" data-type="bool"><option value="true" ${a.default ? "selected" : ""}>是</option><option value="false" ${a.default === false ? "selected" : ""}>否</option></select>`;
	else if (a.type === "number" || a.type === "int")
		field = `<input id="${id}" type="number" step="${a.type === "int" ? 1 : "0.01"}" value="${a.default != null ? a.default : ""}" data-key="${esc(a.key)}" data-type="${a.type}"${req} />`;
	else if (a.type === "patch")
		field = `<textarea id="${id}" rows="2" data-key="${esc(a.key)}" data-type="patch" placeholder='{"engageRadius":90}'>${a.default ? esc(JSON.stringify(a.default)) : ""}</textarea>`;
	else if (a.type === "template")
		field = `<input id="${id}" value="${a.default || ""}" data-key="${esc(a.key)}" data-type="string" placeholder="archer / 弓手 / units/kush/infantry_archer_b" list="tplList" />`;
	else if (a.type === "point")
		field = `<input id="${id}" value="${typeof a.default === "string" ? esc(a.default) : ""}" data-key="${esc(a.key)}" data-type="point" placeholder='home | foe | 40,80 | {"x":40,"z":80}' />`;
	else if (a.type === "target")
		field = `<input id="${id}" value="${typeof a.default === "string" ? esc(a.default) : ""}" data-key="${esc(a.key)}" data-type="string" placeholder="nearest | weakest | 实体id" />`;
	else
		field = `<input id="${id}" value="${a.default != null ? esc(a.default) : ""}" data-key="${esc(a.key)}" data-type="string"${req} />`;
	return `<label><span>${esc(a.key)}${a.required ? " *" : ""}</span>${field}<span class="desc">${esc(a.desc || "")}</span></label>`;
}

$("#cmdList").addEventListener("click", async ev =>
{
	const card = ev.target.closest(".cmd");
	if (!card)
		return;
	if (ev.target.classList.contains("send"))
	{
		const args = {};
		card.querySelectorAll("[data-key]").forEach(el =>
		{
			const raw = el.value.trim();
			if (!raw)
				return;
			const key = el.dataset.key, type = el.dataset.type;
			if (type === "number" || type === "int")
				args[key] = +raw;
			else if (type === "bool")
				args[key] = raw === "true";
			else if (type === "patch")
			{
				try { args[key] = JSON.parse(raw); } catch (e) { args[key] = raw; }
			}
			else if (type === "point")
				args[key] = parsePoint(raw);
			else
				args[key] = raw;
		});
		const out = card.querySelector(".out");
		out.textContent = "…";
		try
		{
			const res = await api("/api/intent", { "name": card.dataset.name, "args": args });
			out.textContent = res.ok ? `✓ ${res.notes.join(" ") || "已下发"}（包 ${res.sent && res.sent.seq}）` : `✗ ${res.error}`;
			out.style.color = res.ok ? "var(--accent)" : "var(--bad)";
		}
		catch (e)
		{
			out.textContent = `✗ ${e.message}`;
			out.style.color = "var(--bad)";
		}
		return;
	}
	if (ev.target.closest("header"))
		card.classList.toggle("open");
});

function parsePoint(raw)
{
	if (/^(home|foe|base|enemy|家|敌军重心)$/i.test(raw))
		return raw;
	const m = /^\(?\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*\)?$/.exec(raw);
	if (m)
		return { "x": +m[1], "z": +m[2] };
	return raw;
}

$("#cmdSearch").oninput = () => renderIntents($("#cmdSearch").value);

// ------------------------------------------------------------------ 训练

async function loadTrain()
{
	const out = await api("/api/train");
	renderTrain(out);
	return out;
}

function renderTrain(t)
{
	const j = t.job || {};
	$("#trStatus").innerHTML = `${j.running ? "进行中" : (j.finished ? `已结束：${esc(j.finished)}` : "空闲")} · ${j.done || 0}/${j.trials || 0} 局 · speed ${j.speed || "—"}x · 模式 ${esc(j.mode || "—")} · ${j.target === "econ" ? "只调经济（军事不动）" : "军事+经济"}` +
		`<br>${(t.log || []).slice(-6).map(l => esc(typeof l === "string" ? l : l.text)).join("<br>")}`;
	const rows = ((t.leaderboard || {}).entries || []).slice(0, 15);
	const econRun = rows.some(r => r.ruler);
	$("#board tbody").innerHTML = rows.length ? rows.map((r, i) => `<tr>
		<td class="num">${i + 1}</td><td class="num">${r.score}</td>
		<td>${r.win ? '<span style="color:var(--accent)">胜</span>' : `<span class="dim">${esc(r.reason || "负")}</span>`}</td>
		<td class="mono">${mmss(r.simNow)}</td><td class="num">${r.pop}</td><td class="num">${r.civilians}/${r.soldiers}</td>
		<td class="num">${r.kills}/${r.losses}</td>
		<td class="mono small">${esc(econRun ? r.ruler : previewPack(r.pack))}</td>
		<td><button data-i="${i}" class="sm use">下发</button></td></tr>`).join("")
		: `<tr><td colspan="9" class="dim">还没有成绩，跑一轮训练试试</td></tr>`;
	$("#board tbody").querySelectorAll(".use").forEach(b => b.onclick = () =>
	{
		const r = rows[+b.dataset.i];
		post("/api/params", { "micro": (r.pack || {}).micro, "econ": (r.pack || {}).econ }, null);
		pushLocal("已把该行参数下发当前对局", "ok");
	});
}

function previewPack(pack)
{
	if (!pack)
		return "—";
	const m = pack.micro || {};
	const e = pack.econ || {};
	const bits = [`eng${m.engageRadius ?? "?"}`, `res${m.resistBase ?? "?"}`, `grit${m.pushGrit ?? "?"}`, `vil${e.villagerCap ?? "?"}`, `shr${e.armyShare ?? "?"}`];
	return bits.join(" ");
}

$("#trStart").onclick = async () =>
{
	$("#trStart").disabled = true;
	const out = await post("/api/train", {
		"trials": +$("#trTrials").value, "budgetSim": +$("#trBudget").value, "speed": +$("#trSpeed").value,
		"mode": $("#trMode").value, "target": $("#trTarget").value, "force": $("#trForce").checked, "aiDiff": +$("#trDiff").value, "map": $("#trMap").value
	});
	$("#trStart").disabled = false;
	if (out && out.ok === false) pushLocal(out.error || "启动失败", "bad");
	else pushLocal("训练已开始（串行跑，一次一局，浏览器关掉也不会中断）", "ok");
};
$("#trStop").onclick = () => post("/api/train", { "action": "stop" });
$("#trApply").onclick = () => post("/api/train", { "action": "apply-best" });
$("#trClear").onclick = () => post("/api/train", { "action": "clear" });

// ------------------------------------------------------------------ 设置

async function loadConfig()
{
	const out = await api("/api/config");
	S.config = out.config;
	const c = out.config;
	$("#llmOn").checked = !!c.llm.enabled;
	$("#llmUrl").value = c.llm.baseUrl;
	$("#llmModel").value = c.llm.model;
	$("#llmKey").placeholder = c.llm.hasKey ? `已保存 ${c.llm.keyHint}（留空则不改）` : "本地模型可留空";
	$("#llmTemp").value = c.llm.temperature;
	$("#llmMax").value = c.llm.maxTokens;
	$("#sageInt").value = c.strategist.intervalSec;
	$("#sageMax").value = c.strategist.maxOrders;
	$("#gameRoot").value = c.game.root;
	$("#gameExe").value = c.game.exe;
	$("#ourCiv").value = c.train.ourCiv;
	$("#foeCiv").value = c.train.foeCiv;
	$("#trMapDefault").value = c.train.map;
	$("#roots").innerHTML = (out.ipcRootsExist || []).map(p => `<div>✓ ${esc(p)}</div>`).join("") || `<div class="dim">（IPC 根目录都还不存在，进一局对局后会自动创建）</div>`;
	if (c.llm.enabled)
		$("#btnSage").classList.add("on");
	loadRuns();
}

async function loadRuns()
{
	const out = await api("/api/runs");
	$("#runs").innerHTML = out.runs.slice(0, 12).map(r => `<div class="run"><span>${esc(r.name)} · ${r.frames} 帧 · ${new Date(r.mtime).toLocaleString("zh-CN", { "hour12": false })}</span>
		<span><button data-dir="${esc(r.dir)}" class="sm pin">${out.current === r.dir ? "已连接" : "连这个"}</button></span></div>`).join("") || `<div class="dim">（还没有 run 目录）</div>`;
	$("#runs").querySelectorAll(".pin").forEach(b => b.onclick = () => post("/api/runs/pin", { "dir": b.dataset.dir }).then(loadRuns));
}

$("#llmSave").onclick = async () =>
{
	const patch = {
		"llm": { "enabled": $("#llmOn").checked, "baseUrl": $("#llmUrl").value.trim(), "model": $("#llmModel").value.trim(), "apiKey": $("#llmKey").value.trim(), "temperature": +$("#llmTemp").value, "maxTokens": +$("#llmMax").value },
		"strategist": { "intervalSec": +$("#sageInt").value, "maxOrders": +$("#sageMax").value }
	};
	const out = await api("/api/config", { "patch": patch });
	$("#llmOut").textContent = "已保存";
	$("#llmKey").value = "";
	if (out.config.llm.hasKey) $("#llmKey").placeholder = `已保存 ${out.config.llm.keyHint}`;
};

$("#llmTest").onclick = async () =>
{
	$("#llmOut").textContent = "测试中…";
	try
	{
		const out = await api("/api/llm/test", {});
		$("#llmOut").textContent = out.ok ? `✓ ${out.ms}ms · ${out.model} · ${out.reply}` : `✗ ${out.error}`;
	}
	catch (e)
	{
		$("#llmOut").textContent = `✗ ${e.message}`;
	}
};

$("#gameSave").onclick = async () =>
{
	await api("/api/config", { "patch": { "game": { "root": $("#gameRoot").value.trim(), "exe": $("#gameExe").value.trim() }, "train": { "ourCiv": $("#ourCiv").value.trim(), "foeCiv": $("#foeCiv").value.trim(), "map": $("#trMapDefault").value.trim() } } });
	$("#gameOut").textContent = "已保存";
	loadConfig();
};

$("#gameStart").onclick = async () =>
{
	if (!confirm("启动游戏会占用 public.zip：同一时刻只能有一个引擎实例。若你正在玩，请先退出。继续？"))
		return;
	const out = await api("/api/game/start", { "confirm": true });
	$("#gameOut").textContent = out.ok ? `已启动 pid ${out.pid}` : `✗ ${out.error || "失败"}`;
};

$("#runsPrune").onclick = async () =>
{
	const out = await api("/api/runs/prune", { "keep": 24 });
	pushLocal(`清理了 ${(out.removed || []).length} 个旧 run 目录`, "ok");
	loadRuns();
};

// ------------------------------------------------------------------ 页签

$("#tabs").onclick = ev =>
{
	const b = ev.target.closest("button");
	if (!b)
		return;
	S.tab = b.dataset.tab;
	$$("#tabs button").forEach(x => x.classList.toggle("on", x === b));
	$$(".pane").forEach(p => p.classList.toggle("open", p.id === `pane-${S.tab}`));
	if (S.tab === "train") loadTrain();
	if (S.tab === "cmd" && !S.intents.length) loadIntents();
	if (S.tab === "set") loadConfig();
};

document.addEventListener("keydown", ev =>
{
	if (ev.key === "Escape")
	{
		const open = $(".pane.open");
		if (open)
			$('#tabs button[data-tab="ops"]').click();
	}
});

// 帧停更时最常见的两个原因：游戏重开了新的一局、或者窗口被最小化。点一下重连即可
$("#connText").title = "点击重连（跟到新开的对局目录）";
$("#connText").style.cursor = "pointer";
$("#connText").onclick = async () =>
{
	const out = await post("/api/reconnect", {});
	pushLocal(out && out.ok ? `已重连 ${out.dir ? out.dir.split(/[\\/]/).pop() : ""}` : "没找到新的对局目录", out && out.ok ? "ok" : "warn");
};

// 攻击欲望滑条跟着真实参数走（有帧就用帧里的估算值）
setInterval(() =>
{
	const a = S.view && S.view.cfg ? Math.round((S.view.cfg.engageRadius - 40) / 70 * 100) : null;
	if (a != null && document.activeElement !== $("#agg"))
	{
		$("#agg").value = Math.max(0, Math.min(100, a));
		$("#aggOut").textContent = `${$("#agg").value}%（按 engageRadius 估算）`;
	}
}, 2000);

setInterval(() => { if (S.tab === "train") loadTrain(); }, 2500);

// 面板是覆盖层，得从表头下面开始；表头高度会随窗口宽度变化，量出来交给 CSS
function measureHeader()
{
	document.documentElement.style.setProperty("--hdr", `${document.querySelector("header").offsetHeight}px`);
}
addEventListener("resize", measureHeader);

(async function boot()
{
	measureHeader();
	connect();
	await loadIntents().catch(e => pushLocal(`指令清单加载失败：${e.message}`, "bad"));
	appendMsg("ai", "我是副驾控制台。四个按钮管接管，旋钮管战略，下面的框可以直接说人话；接上大模型后随便提要求（本地 Ollama 也行）。", []);
})();
