#!/usr/bin/env node
/**
 * Superbrain 控制台命令行驱动。
 *
 * 输出为紧凑单行/短表，专为 agent 复读设计：不打堆栈、不刷进度、超长字段截断。
 * 所有写操作都走控制台的 REST，由它转成游戏内等价鼠标命令 —— 这个脚本绝不直接碰 cmd 文件。
 *
 *   node sb.mjs status                 连接状态 + 关键指标一行
 *   node sb.mjs ui                     后端没起就拉起，然后打开浏览器
 *   node sb.mjs help                   全部子命令
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.SB_URL || "http://127.0.0.1:8712";

const argv = process.argv.slice(2);
const cmd = (argv[0] || "status").toLowerCase();
const rest = argv.slice(1);

const FLAGS = {};
const POS = [];
for (let i = 0; i < rest.length; ++i)
{
	const a = rest[i];
	if (a.startsWith("--"))
	{
		const key = a.slice(2);
		const next = rest[i + 1];
		if (next === undefined || next.startsWith("--"))
			FLAGS[key] = true;
		else
		{
			FLAGS[key] = next;
			++i;
		}
	}
	else if (a.includes("=") && !/^\{/.test(a))
	{
		const k = a.slice(0, a.indexOf("="));
		FLAGS[k] = a.slice(a.indexOf("=") + 1);
	}
	else
		POS.push(a);
}

function die(message)
{
	console.log(`ERR ${message}`);
	process.exit(1);
}

function short(text, n)
{
	text = String(text == null ? "" : text).replace(/\s+/g, " ");
	return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

async function req(path, payload, tolerate)
{
	let res;
	try
	{
		res = await fetch(BASE + path, payload === undefined ? {} : { "method": "POST", "headers": { "content-type": "application/json" }, "body": JSON.stringify(payload) });
	}
	catch (e)
	{
		die(`连不上 ${BASE}（${e.message}）—— 先跑 node superbrain/app/server.mjs`);
	}
	const text = await res.text();
	let data;
	try
	{
		data = JSON.parse(text);
	}
	catch (e)
	{
		die(`HTTP ${res.status} 非 JSON：${short(text, 160)}`);
	}
	if (!res.ok || (data.ok === false && !tolerate))
		die(`${res.ok ? "" : `HTTP ${res.status}：`}${short(data.error || JSON.stringify(data), 260)}`);
	return data;
}

/** k=v 参数解析：数字/布尔/JSON/坐标串。 */
function coerce(value)
{
	if (value === "true")
		return true;
	if (value === "false")
		return false;
	if (/^-?\d+(\.\d+)?$/.test(value))
		return +value;
	if (/^[[{]/.test(value))
	{
		try { return JSON.parse(value); } catch (e) { return value; }
	}
	if (/^-?\d+(\.\d+)?\s*[, ]\s*-?\d+(\.\d+)?$/.test(value))
	{
		const p = value.split(/[, ]+/).map(Number);
		return { "x": p[0], "z": p[1] };
	}
	if (/^\[\d+(,\d+)*\]$/.test(value))
		return value.match(/\d+/g).map(Number);
	return value;
}

const n = v => (v == null ? "—" : Math.round(+v * 100) / 100);
const mmss = s => `${Math.floor((s || 0) / 60)}:${String(Math.round((s || 0) % 60)).padStart(2, "0")}`;

function oneLine(v, st)
{
	const e = v.econ || {};
	const c = v.combat || {};
	const k = v.kernel || {};
	const cfg = v.cfg || {};
	return `run=${short((st.dir || "").split(/[\\/]/).pop(), 22)} 帧${st.seq} 龄${Math.round(st.ageMs / 1000)}s ` +
		`sim${mmss(v.simNow)} 人口${v.my.pop}/${e.popCap ?? v.my.popCap} 农${e.civilians ?? v.counts.workers}(目标${e.wantCivilians ?? "?"} 闲${e.idle || 0} 关${e.bunkered || 0}) 兵${v.counts.army} ` +
		`粮${n(v.my.resources.food)} 木${n(v.my.resources.wood)} 石${n(v.my.resources.stone)} 金${n(v.my.resources.metal)} ` +
		`军${v.autopilot ? "接管" : "手操"} 经${v.economyOn ? "接管" : "手操"} 打法${cfg.doctrine || "?"} ` +
		`敌可见${v.counts.foesSeen} 离家${e.threatDist ?? (v.homeThreat ? v.homeThreat.seen : "—")} ` +
		`杀${c.foeKills ?? "?"} 亡${c.ourLosses ?? "?"} 比${n(c.ratio)} 判定${k.fight ? (k.fight.fight ? "打" : "撤") : "—"}` +
		(v.guard ? ` 防卫${v.guard.active ? `压境(敌${v.guard.foes}/守${v.guard.ours})` : "稳"}` : "") +
		` 错${(v.diag && v.diag.errors || []).length}`;
}

const HELP = `用法 node sb.mjs <命令> [参数]   （服务地址用 --url 或 SB_URL 覆盖，默认 ${BASE}）

  status [sim|foe]        一行态势（foe 附带对手表）
  watch [秒]              连续打印，默认 30 秒
  params                  游戏内微操/经济参数真值
  groups                  军事内核编组表
  players                 所有玩家人口/资源/状态
  foes [n]                可集火的敌方实体 id
  buildings [n]           己方建筑 id（进驻/修理/交资源要用）
  nodes [n]               可采集点 id（gather 要用）

  takeover mil|eco|all on|off        接管开关
  knob aggression=.8 posture=attack economy=boom target=2 doctrine=push
  intent <名字> [k=v ...]            下发一条逻辑指令，如 intent attack-move targets=army to=foe
  intents [关键词]                    列出逻辑指令（41 条）
  chat "自然语言"                      走大模型/规则中间层下令
  brief [--ai]                        态势简报（--ai 让模型润色）

  train start [trials=4 budgetSim=900 speed=4 mode=random|hill force=true]
  train status|stop|best|apply|clear  训练模式
  sage start|stop                     大模型接管模式（战略层）
  llm set base_url=... model=... api_key=... on=true|false
  llm test                            模型连通性
  config                              后端配置（密钥已脱敏）

  runs [n]                列出 run 目录      runs pin <dir>  指定连哪个     runs auto  取消指定
  events [n]              最近事件日志
  game start [--confirm] [--force]  开一局（会占用 public.zip；训练在跑时要 --force 才插队）
  ui                        后端没起就代为拉起，然后打开控制台页面（地址不用记）
  econ-trace [n]          经济/劳力曲线（最近 n 帧采样）`;

switch (cmd)
{
case "help":
case "-h":
case "--help":
	console.log(HELP);
	break;

case "status":
case "st":
{
	const s = await req("/api/state");
	if (!s.view)
		die(`没连上对局（${s.status.dir ? "帧停更 " + Math.round(s.status.ageMs / 1000) + "s" : "没有 run 目录"}）；进一局单人对局或跑 game start`);
	console.log(oneLine(s.view, s.status));
	for (const a of s.view.alarms || [])
		console.log(`  [${a.level}] ${short(a.text, 160)}`);
	if (POS[0] === "foe")
		printPlayers(s.view);
	break;
}

case "watch":
{
	const secs = +(POS[0] || 30);
	const end = Date.now() + secs * 1000;
	while (Date.now() < end)
	{
		const s = await req("/api/state");
		console.log(s.view ? oneLine(s.view, s.status) : `等待态势帧… ${s.status.dir || ""}`);
		await sleep(2000);
	}
	break;
}

case "params":
{
	const s = await req("/api/state");
	const v = s.view || die("没有态势帧");
	console.log(`微操（游戏内真值）\n  ${flat(v.cfg)}`);
	console.log(`经济（游戏内真值）\n  ${flat(v.econCfg)}`);
	console.log(`控制台记的下发\n  微操 ${flat(s.params && s.params.micro)}\n  经济 ${flat(s.params && s.params.econ)}`);
	break;
}

case "groups":
{
	const s = await req("/api/state");
	const rows = (s.view || {}).groups || [];
	if (!rows.length)
		console.log("（内核当前无编组：战场上没有可见可控单位）");
	else
	{
		console.log("编组      角色     任务       人数 距敌 射程 动作     残血 离家 目标");
		for (const g of rows)
			console.log(`${pad(g.key, 9)} ${pad(g.role, 8)} ${pad(g.task || g.action, 10)} ${pad(g.n, 4)}${pad(g.d, 5)}${pad(g.range, 5)} ${pad(g.action, 8)} ${pad(g.wounded, 5)}${pad(g.home == null ? "—" : g.home, 5)}${g.at ? ` 质心${Math.round(g.at[0])},${Math.round(g.at[1])}` : ""}${g.dest ? ` →${Math.round(g.dest[0])},${Math.round(g.dest[1])}` : ""}`);
	}
	break;
}

case "players":
{
	const s = await req("/api/state");
	printPlayers(s.view || die("没有态势帧"));
	break;
}

case "foes":
{
	const s = await req("/api/state");
	const v = s.view || die("没有态势帧");
	const rows = (v.points.foes || []).slice(0, +(POS[0] || 20));
	console.log(rows.length ? rows.map(f => `id=${f.id} P${f.owner} ${f.b} hp=${n(f.hp)} @${Math.round(f.x)},${Math.round(f.z)}`).join("\n") : "（视野内无可见敌人）");
	break;
}

case "buildings":
{
	const s = await req("/api/state");
	const rows = ((s.view || {}).points || {}).buildings || [];
	console.log(rows.slice(0, +(POS[0] || 25)).map(b => `id=${b.id} ${short(b.t.replace(/^structures\//, ""), 40)} @${Math.round(b.x)},${Math.round(b.z)}`).join("\n") || "（无己方建筑可见）");
	break;
}

case "nodes":
{
	const v = (await req("/api/state")).view || die("没有态势帧");
	const rows = decode(v).filter(e => /^gaia\/(ore|rock|fruit|tree|fauna)/.test(e.tpl) || /field/.test(e.tpl));
	const nodes = rows.filter(e => e.seen === 2 || e.seen === 3);
	console.log(nodes.slice(0, +(POS[0] || 25)).map(e => `id=${e.id} ${short(e.tpl.replace(/^gaia\//, ""), 34)} @${Math.round(e.x)},${Math.round(e.z)}`).join("\n") || "（没解析到采集点，用 buildings/players 或看 state 帧 probe）");
	break;
}

case "takeover":
{
	const what = (POS[0] || "all").toLowerCase();
	const on = (POS[1] || "on").toLowerCase() !== "off";
	const body = what === "mil" ? { "military": on } : what === "eco" ? { "economy": on } : { "all": on };
	const out = await req("/api/takeover", body);
	console.log(`${JSON.stringify(body)} → 包 ${out.sent.seq}`);
	break;
}

case "knob":
case "knobs":
{
	const body = {};
	if (FLAGS.aggression != null)
		body.aggression = +FLAGS.aggression;
	if (FLAGS.posture)
		body.posture = FLAGS.posture;
	if (FLAGS.economy)
		body.economy = FLAGS.economy;
	if (FLAGS.target != null)
		body.target = +FLAGS.target;
	if (FLAGS.doctrine)
		body.doctrine = FLAGS.doctrine;
	if (!Object.keys(body).length)
		die("knob 需要 aggression=0..1 / posture=defend|balanced|attack / economy=boom|balanced|war / target=玩家id / doctrine=...");
	const out = await req("/api/knobs", body);
	console.log(`已下发 ${out.commands.map(c => c.op).join("+")} → 包 ${out.sent.seq}`);
	break;
}

case "intent":
{
	const name = POS[0] || die("intent 需要指令名，先跑 intents 查");
	const args = {};
	for (const key in FLAGS)
		if (key !== "url")
			args[key] = coerce(FLAGS[key]);
	const out = await req("/api/intent", { "name": name, "args": args });
	console.log(`${out.ok ? "✓" : "✗"} ${name} ${short((out.notes || []).join(" ") || out.error || "", 200)}${out.sent ? ` 包${out.sent.seq}` : ""}`);
	if (out.commands)
		console.log(`  ${short(JSON.stringify(out.commands), 300)}`);
	break;
}

case "intents":
{
	const out = await req("/api/intents");
	const q = (POS[0] || FLAGS.grep || "").toLowerCase();
	for (const i of out.intents)
	{
		if (q && !`${i.name} ${i.label} ${i.desc}`.toLowerCase().includes(q))
			continue;
		console.log(`${pad(i.name, 22)}[${i.kind}] ${i.label} — ${short(i.desc, 90)}` + (i.args.length ? `\n    ${i.args.map(a => `${a.key}:${a.type}${a.required ? "*" : ""}`).join(" ")}` : ""));
	}
	break;
}

case "chat":
{
	const text = POS.join(" ") || die('chat 需要文本，如 chat "回防"');
	const out = await req("/api/chat", { "text": text, "history": [] });
	console.log(`(${out.engine}) ${short(out.say, 400)}`);
	for (const i of out.intents || [])
		console.log(`  ${i.ok ? "✓" : "✗"} ${i.name} ${short(i.ok ? (i.notes || []).join(" ") : i.error, 160)}`);
	if (!out.sent)
		console.log("  （没有指令被下发）");
	break;
}

case "brief":
{
	if (FLAGS.ai)
	{
		const out = await req("/api/brief/ai", {});
		console.log(out.text);
	}
	else
		console.log((await req("/api/situation")).text);
	break;
}

case "train":
{
	const action = (POS[0] || "status").toLowerCase();
	if (action === "start")
	{
		const body = {};
		for (const k of ["trials", "budgetSim", "speed", "mode", "target", "aiDiff", "map", "wallLimitSec"])
			if (FLAGS[k] != null)
				body[k] = k === "mode" || k === "map" || k === "target" ? FLAGS[k] : +FLAGS[k];
		if (FLAGS.force)
			body.force = FLAGS.force === "true" || FLAGS.force === true;
		const out = await req("/api/train", body);
		console.log(`训练已启动：${out.trials} 局 × ${out.budgetSim}s 仿真，${out.speed}x，模式 ${out.mode}`);
	}
	else
	{
		const payload = action === "status" ? undefined : { "action": action };
		const out = action === "status" ? await req("/api/train") : await req("/api/train", payload);
		if (action !== "status")
			console.log(`${action} → ${out.ok === false ? out.error || "失败" : "已受理"}`);
		else
		{
			const j = out.job || {};
			console.log(`running=${!!j.running} ${j.done || 0}/${j.trials || 0} 局 ${j.finished ? "（" + j.finished + "）" : ""}` +
				`${j.mode ? " 模式 " + j.mode : ""}${j.target === "econ" ? " ·只调经济（军事不动）" : ""}`);
			for (const l of (out.log || []).slice(-8))
				console.log(`  - ${short(typeof l === "string" ? l : l.text, 180)}`);
			const rows = (out.leaderboard || {}).entries || [];
			if (rows.length)
			{
				const econRows = rows.some(r => r.ruler);
				console.log(`  分数  胜负  时长  人口 农/兵 杀/亡 比   ${econRows ? "经济标尺" : "参数"}`);
				for (const r of rows.slice(0, 10))
					console.log(`  ${pad(r.score, 6)}${pad(r.win ? "胜" : short(r.reason || "负", 6), 8)}${pad(mmss(r.simNow), 6)}${pad(r.pop, 5)}${pad(r.civilians + "/" + r.soldiers, 6)}${pad(r.kills + "/" + r.losses, 7)}${pad(r.ratio, 6)} ${econRows ? short(r.ruler, 130) : preview(r.pack)}`);
			}
			console.log(`  best=${out.best ? "有（score " + out.best.score + "）" : "无"}`);
		}
	}
	break;
}

case "sage":
{
	const action = (POS[0] || "start").toLowerCase();
	const out = await req("/api/strategist", action === "status" ? undefined : { "action": action });
	console.log(action === "status" || out.running != null
		? `running=${!!out.running} 轮次=${out.rounds || 0} 错误=${out.errors || 0} 间隔=${out.intervalSec}s`
		: `${action} → ${out.ok === false ? out.error : "已启动"}`);
	for (const h of (out.lastOrders || []).slice(-4))
		console.log(`  - ${short(h.say, 150)} [${(h.orders || []).join(",")}]`);
	break;
}

case "llm":
{
	const action = (POS[0] || "test").toLowerCase();
	if (action === "set")
	{
		const patch = { "llm": {} };
		if (FLAGS.base_url) patch.llm.baseUrl = FLAGS.base_url;
		if (FLAGS.model) patch.llm.model = FLAGS.model;
		if (FLAGS.api_key) patch.llm.apiKey = FLAGS.api_key;
		if (FLAGS.on != null) patch.llm.enabled = coerce(FLAGS.on);
		if (FLAGS.temperature != null) patch.llm.temperature = +FLAGS.temperature;
		if (FLAGS.json_mode) patch.llm.jsonMode = FLAGS.json_mode;
		const out = await req("/api/config", { "patch": patch });
		console.log(`已保存。enabled=${out.config.llm.enabled} baseUrl=${out.config.llm.baseUrl} model=${out.config.llm.model} key=${out.config.llm.keyHint || "无"}`);
	}
	else
	{
		const out = await req("/api/llm/test", {}, true);
		console.log(out.ok ? `✓ ${out.ms}ms ${out.model} → ${short(out.reply, 60)}` : `✗ ${short(out.error, 240)}`);
	}
	break;
}

case "config":
{
	const out = await req("/api/config");
	console.log(JSON.stringify(out.config, null, 1).replace(/\n\s*/g, " ").slice(0, 1600));
	break;
}

case "runs":
{
	const numeric = /^\d+$/.test(POS[0] || "");
	const sub = numeric ? "list" : (POS[0] || "list").toLowerCase();
	if (sub === "pin")
	{
		const out = await req("/api/runs/pin", { "dir": POS[1] || "" });
		console.log(`pin → ${out.pinned || "（取消）"}，当前连 ${out.dir || "无"}`);
	}
	else if (sub === "auto")
	{
		const out = await req("/api/runs/pin", { "dir": "" });
		console.log(`已取消指定，当前连 ${out.dir || "无"}`);
	}
	else if (sub === "prune")
	{
		const out = await req("/api/runs/prune", { "keep": +(FLAGS.keep || 24) });
		console.log(`清理 ${(out.removed || []).length} 个，保留 ${out.kept}`);
	}
	else
	{
		const out = await req("/api/runs");
		console.log(`当前 ${out.current || "无"} / 指定 ${out.pinned || "自动"}`);
		for (const r of out.runs.slice(0, +(FLAGS.n || (numeric ? POS[0] : 12))))
			console.log(`  ${r.name} ${r.frames}帧 ${new Date(r.mtime).toLocaleString("zh-CN", { "hour12": false })} ${r.dir === out.current ? "←已连" : ""}`);
	}
	break;
}

case "events":
{
	const s = await req("/api/state");
	for (const e of (s.events || []).slice(-(POS[0] || 15)))
		console.log(`${new Date(e.at).toLocaleTimeString("zh-CN", { "hour12": false })} ${pad(e.type, 12)} ${short(e.text, 170)}`);
	break;
}

case "game":
{
	if ((POS[0] || "start") !== "start")
		die("game 只支持 start");
	if (!FLAGS.confirm)
		die("game start 要加 --confirm：会占用 public.zip，同一时刻只能有一个引擎实例");
	const out = await req("/api/game/start", { "confirm": true, "force": FLAGS.force === true });
	console.log(out.ok ? `已启动 pid ${out.pid}` : `✗ ${out.error}`);
	break;
}

case "econ-trace":
case "trace":
{
	const s = await req("/api/state");
	const v = s.view || die("没有态势帧");
	const e = v.econ || {};
	console.log(`劳力 实际 ${robj(e.gatherers)} / 应有 ${robj(e.wantGatherers)} / 坑位 ${robj(e.slots)} / 可见点 ${robj(e.nodes)}`);
	console.log(`账本 无人认领 ${e.untracked ?? "?"}/${(e.workers ?? "?")} 农民` +
		` | 工地 ${e.buildSites ?? "?"} 处·锁 ${e.builders ?? "?"} 人·造价粮 ${e.civCost ?? "?"}` +
		` | 没开工原因 ${e.buildBlock || "这一拍没拦住"}` +
		` | 时代报价 ${JSON.stringify(e.phaseCost || {})}` +
		` | 卡点 ${JSON.stringify(e.pullBlock || {})}` +
		` | 拒地 ${(e.placeFails && Object.keys(e.placeFails).length) ? JSON.stringify(e.placeFails) : "无"}`);
	console.log(`收入 ${robj(e.income)} 钱包 ${robj(e.wallet)} 目标配比 ${robj(e.mix)}`);
	console.log(`建筑 CC${e.cc} 房${e.houses} 田${e.fields} 产兵${e.producers} | 本拍下令 ${e.issued} 累计 ${e.issuedTotal ?? "?"} 拒 ${e.rejectedTotal ?? "?"} | ops ${JSON.stringify(e.ops || [])}`);
	console.log(`日志 ${(e.log || []).join(" / ")}`);
	break;
}

case "ui":
case "open":
{
	// "正常软件"该有的样子：一条命令把后端拉起来并打开浏览器，端口不用记。
	// 真正的实现只在 superbrain/app/tools/ui.mjs 一处，这里代为转发
	const root = path.resolve(fileURLToPath(import.meta.url), "../../../../..");
	const tool = path.join(root, "superbrain", "app", "tools", "ui.mjs");
	if (!existsSync(tool))
		die(`找不到启动器：${tool}`);
	const r = spawnSync(process.execPath, [tool], { "encoding": "utf8" });
	console.log(String(r.stdout || "").trim() || `✗ ${String(r.stderr || "").trim() || "启动器没输出"}`);
	break;
}

default:
	die(`没有这个子命令：${cmd}（跑 help 看清单）`);
}

// ------------------------------------------------------------------ 小工具

function printPlayers(v)
{
	for (const p of v.players)
	{
		const r = p.resources || {};
		console.log(`  P${p.id} ${pad(short(p.name, 14), 14)} ${pad(p.civ, 6)} ${pad(p.state, 10)} 人口${pad(p.pop + "/" + p.popCap, 8)} 兵${(p.classes || {}).Soldier || 0} 技${p.techs} ${p.mine ? "我" : p.enemy ? "敌" : "中"} 粮${n(r.food)} 木${n(r.wood)} 石${n(r.stone)} 金${n(r.metal)}`);
	}
}

function decode(v)
{
	const fields = (v.raw && v.raw.fields) || [];
	const rows = (v.raw && v.raw.entities) || [];
	if (!fields.length)
		return [];
	return rows.map(row => {
		const e = {};
		for (let i = 0; i < fields.length; ++i)
			e[fields[i]] = row[i];
		e.tpl = String(e.template || "");
		return e;
	});
}

/** 数值字典打印：保留两位，别把 15 位浮点糊到屏幕上。 */
function robj(obj)
{
	if (!obj)
		return "—";
	return "{" + Object.keys(obj).map(k => `${k}=${n(obj[k])}`).join(" ") + "}";
}

function flat(obj){
	if (!obj)
		return "（读不到）";
	return Object.keys(obj).map(k => `${k}=${typeof obj[k] === "object" ? JSON.stringify(obj[k]) : obj[k]}`).join(" ");
}

function preview(pack)
{
	if (!pack)
		return "—";
	const m = pack.micro || {};
	const e = pack.econ || {};
	return `eng${m.engageRadius ?? "?"} res${m.resistBase ?? "?"} grit${m.pushGrit ?? "?"} vil${e.villagerCap ?? "?"} shr${e.armyShare ?? "?"}`;
}

function pad(text, width)
{
	text = String(text == null ? "" : text);
	let w = 0;
	for (const ch of text)
		w += ch.charCodeAt(0) > 255 ? 2 : 1;
	return text + " ".repeat(Math.max(1, width - w));
}

function sleep(ms)
{
	return new Promise(r => setTimeout(r, ms));
}
