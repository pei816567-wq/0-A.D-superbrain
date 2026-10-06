/**
 * 控制台离线自测：不启动游戏也能验的三层契约。
 *
 *   node superbrain/app/test/console_test.mjs
 *
 * 覆盖：
 *   A 桥接层 op 名对账（改错了名字当场就红）
 *   B 状态帧解码 + 选择器（用真实 run 目录里的最后一帧，没有就合成一帧）
 *   C 每条逻辑指令都能编译成命令包
 *   D 旋钮与参数白名单 + 驻军防抖宽带不变量
 *   E 无大模型时的中文口令兜底
 *   F 真起一个 server 进程，走 HTTP 打端到端 + SSE + cmd 文件落盘内容
 *
 * 全程在临时目录里跑，配置与状态都通过环境变量隔离，不碰玩家真实存档。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const repoRoot = path.resolve(appRoot, "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-console-"));
const runDir = path.join(tmp, "run-test-0001");
fs.mkdirSync(runDir, { "recursive": true });

process.env.SUPERBRAIN_CONFIG = path.join(tmp, "config.json");
process.env.SUPERBRAIN_STATE = path.join(tmp, "state");
fs.mkdirSync(process.env.SUPERBRAIN_STATE, { "recursive": true });

let pass = 0;
const failures = [];

function ok(name, condition, detail)
{
	if (condition)
		++pass;
	else
	{
		failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

function eq(name, got, want)
{
	ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

// ---------------------------------------------------------------- 造一帧真数据

const realRoot = path.join(os.homedir(), "Documents", "My Games", "0ad", "saves", "campaigns", "superbrain");
let source = null;
try
{
	const runs = fs.readdirSync(realRoot).map(n => path.join(realRoot, n))
		.filter(p => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } })
		.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

	// 挑一帧"仗还在打"的：己方有兵、外面有敌人。终局帧（pop 0）会让断言随机变红。
	for (const r of runs)
	{
		const files = fs.readdirSync(r).filter(f => /^state-\d+\.json$/.test(f)).sort().reverse();
		for (const f of files.slice(0, 10))
		{
			let candidate;
			try { candidate = JSON.parse(fs.readFileSync(path.join(r, f), "utf8")); } catch (e) { continue; }
			const ents = decodeEntitiesRaw(candidate);
			const army = ents.filter(e => e.seen === 3 && e.military && !e.holder).length;
			const foes = ents.filter(e => e.seen === 2 && e.enemy && !e.structure).length;
			if (army >= 4 && foes >= 1)
			{
				source = { "dir": r, "file": path.join(r, f), "frame": candidate, "army": army, "foes": foes };
				break;
			}
		}
		if (source)
			break;
	}
}
catch (e) { /* 全新机器没有存档，走合成帧 */ }

function decodeEntitiesRaw(f)
{
	const fields = f.fields || [];
	return (f.entities || []).map(row => {
		const e = {};
		for (let i = 0; i < fields.length; ++i)
			e[fields[i]] = row[i];
		const t = String(e.template || "").toLowerCase();
		e.structure = t.indexOf("structures/") >= 0;
		e.military = !e.structure && /(infantry|cavalry|archer|spear|sword|pikeman|camel|chariot|hero|siege|catapult|ballista|javelin|slinger)/.test(t);
		return e;
	});
}

const frame = source ? source.frame : synth();
if (source)
	console.log(`用真实帧做样本：${path.basename(source.dir)}/${path.basename(source.file)}（我军 ${source.army} 可见敌 ${source.foes}）`);
else
	console.log("没有合适的真实帧，使用合成帧");

frame.wall = Date.now();
frame.seq = 2;
fs.writeFileSync(path.join(runDir, "state-000002.json"), JSON.stringify(frame), "utf8");
fs.writeFileSync(path.join(runDir, "boot.json"), JSON.stringify({ "probe": 1 }), "utf8");

// 模板池：保底一套固定模板（保证"弓手/field"这类说法永远能解析），
// 再用真实帧同目录的 static 覆盖 —— 只认 static 会让测试取决于"上一局有没有盖过田"，
// 实盘跑到第 2 分钟时 static 里就没有 field，测试会假报红。
const fallbackStatic = {
	"rev": 1,
	"templates": {
		"units/kush/infantry_archer_b": { "cost": { "food": 40, "wood": 30 }, "health": { "Hitpoints": 60 }, "attack": { "Ranged": { "maxRange": 60, "Damage": { "Pierce": 7 }, "repeatTime": 1250 } }, "visibleIdentityClasses": ["Unit", "Ranged"] },
		"units/kush/infantry_spearman_b": { "cost": { "food": 50, "wood": 50 }, "health": { "Hitpoints": 110 }, "visibleIdentityClasses": ["Unit", "Melee"] },
		"units/kush/cavalry_javelineer_b": { "cost": { "food": 80, "wood": 60 }, "health": { "Hitpoints": 100 }, "visibleIdentityClasses": ["Unit", "Ranged", "Cavalry"] },
		"units/kush/support_civilian": { "cost": { "food": 50 }, "health": { "Hitpoints": 50 }, "visibleIdentityClasses": ["Unit", "Citizen"] },
		"structures/kush/civil_centre": { "cost": { "food": 0, "wood": 300 }, "health": { "Hitpoints": 600 }, "visibleIdentityClasses": ["Structure", "CivilCentre"] },
		"structures/kush/field": { "cost": { "food": 0, "wood": 50 }, "health": { "Hitpoints": 50 }, "visibleIdentityClasses": ["Structure", "Farm"] }
	},
	"availableFormations": ["line", "box"],
	"availableStances": ["aggressive", "standground"]
};

let staticFrame = null;
if (source)
{
	const statics = fs.readdirSync(source.dir).filter(f => /^static-\d+\.json$/.test(f)).sort();
	if (statics.length)
	{
		try { staticFrame = JSON.parse(fs.readFileSync(path.join(source.dir, statics[statics.length - 1]), "utf8")); } catch (e) { staticFrame = null; }
	}
}
if (staticFrame && staticFrame.templates)
{
	staticFrame = Object.assign({}, staticFrame, {
		"templates": Object.assign({}, fallbackStatic.templates, staticFrame.templates)
	});
}
else
	staticFrame = fallbackStatic;
fs.writeFileSync(path.join(runDir, "static-000002.json"), JSON.stringify(staticFrame), "utf8");

function synth()
{
	const fields = ["id", "template", "owner", "x", "z", "hp", "maxHp", "seen", "idle", "enemy", "holder"];
	const rows = [
		[11, "structures/kush/civil_centre", 1, 100, 100, 600, 600, 3, 0, 0, 0],
		[12, "units/kush/support_civilian", 1, 105, 98, 50, 50, 3, 0, 0, 0],
		[13, "units/kush/support_civilian", 1, 110, 95, 50, 50, 3, 1, 0, 0],
		[14, "units/kush/infantry_spearman_b", 1, 120, 110, 100, 100, 3, 0, 0, 0],
		[15, "units/kush/infantry_archer_b", 1, 122, 112, 60, 60, 3, 0, 0, 0],
		[16, "units/kush/infantry_archer_b", 1, 160, 170, 20, 60, 3, 0, 0, 0],
		[17, "units/brit/infantry_swordman_b", 2, 150, 160, 110, 120, 2, 0, 1, 0],
		[18, "units/brit/chariot_archer_a", 2, 200, 210, 60, 90, 1, 0, 1, 0]
	];
	return {
		"seq": 2, "wall": Date.now(), "me": 1, "now": 420, "duration": 420, "simRate": 1,
		"players": {
			"1": { "name": "Player", "civ": "kush", "color": 3, "state": "Active", "popCount": 6, "popLimit": 25, "phase": "village", "resourceCounts": { "food": 300, "wood": 250, "stone": 80, "metal": 60 }, "classCounts": { "Civilian": 2, "Soldier": 3 }, "researchedTechs": { "support_civ_bank": 1 }, "isEnemy": false },
			"2": { "name": "Brit", "civ": "brit", "color": 1, "state": "Active", "popCount": 12, "popLimit": 40, "phase": "town", "resourceCounts": { "food": 500, "wood": 400, "stone": 100, "metal": 100 }, "classCounts": { "Soldier": 6 }, "researchedTechs": {}, "isEnemy": true },
			"0": { "name": "Gaia", "civ": "gaia", "state": "Gaia", "popCount": 0, "resourceCounts": {}, "classCounts": {}, "isEnemy": false }
		},
		"fields": fields, "entities": rows,
		"autopilot": true, "economy": true,
		"kernel": { "issued": 12, "rejected": 0, "doctrine": "field", "guard": { "active": true, "foes": 6, "ours": 0, "home": [100, 100] }, "fight": { "fight": true, "exchange": 1.3, "edge": true }, "groups": [{ "key": "g1", "n": 2, "role": "ranged", "task": "return", "home": 88, "action": "kite", "range": 60, "d": 42, "wounded": 1, "dest": [120, 110] }] },
		"econ": { "pop": 6, "popCap": 25, "civilians": 2, "wantCivilians": 8, "workers": 2, "bunkered": 0, "ownRows": 6, "idle": 1, "threatDist": 87, "cc": 1, "houses": 0, "fields": 0, "producers": 0, "soldiers": 3, "income": { "food": 1.2, "wood": 0.9 }, "mix": { "ranged": 0.5 }, "alerts": ["粮 断供 80 秒"], "log": ["补农民 2"] },
		"combat": { "ourHpLost": 120, "foeHpLost": 300, "ratio": 2.5, "ourLosses": 0, "foeKills": 1 },
		"cfg": { "doctrine": "field", "engageRadius": 70, "resistBase": 0.9, "kite": true, "maxGroups": 6 },
		"applied": { "cmdSeq": 1, "ok": 1, "rejected": 0 },
		"diag": { "errors": [] },
		"probe": { "counts": { "live": 6, "returned": 8 } }
	};
}

const cfg = {
	"host": "127.0.0.1",
	"port": 8799,
	"game": { "root": "G:\\0 A.D. Empires Ascendant", "exe": "binaries\\system\\pyrogenesis.exe", "ipcRoots": [tmp], "pinRun": runDir },
	"llm": { "enabled": false, "baseUrl": "", "apiKey": "", "model": "", "temperature": 0.1, "maxTokens": 400, "timeoutMs": 8000 },
	"strategist": { "enabled": false, "intervalSec": 20, "maxOrders": 3, "sayEvery": 2 },
	"train": { "map": "random/alpine_lakes", "mapSize": 112, "players": 2, "ourCiv": "kush", "foeCiv": "brit", "foeAi": "petra", "aiDiff": 5, "speed": 2, "visibility": "revealed", "budgetSec": 600, "rounds": 2, "seed": -1 },
	"ui": { "language": "zh" }
};
fs.writeFileSync(process.env.SUPERBRAIN_CONFIG, JSON.stringify(cfg, null, "\t"), "utf8");

// ---------------------------------------------------------------- 模块
const { GameLink, listRuns, readJson } = await import("../lib/ipc.mjs");
const { viewOf, outcome, isMilitary, bucketOf, decodeEntities } = await import("../lib/frames.mjs");
const { pickUnits, pickTarget, pickPoint } = await import("../lib/select.mjs");
const { INTENTS, compile, uiSchema, schemaText, resolveTemplate } = await import("../lib/intents.mjs");
const { aggressionPatch, economyPatch, posturePatch, targetPatch, packCommands, searchSpace, samplePack } = await import("../lib/presets.mjs");
const { ruleInterpret, flatten, interpret } = await import("../lib/interpreter.mjs");
const { extractJson, Llm } = await import("../lib/llm.mjs");
const { situationText, alarms, headline } = await import("../lib/brief.mjs");
const { load } = await import("../lib/config.mjs");
const { Catalog } = await import("../lib/catalog.mjs");

const cfgLoaded = load();
ok("config 从环境变量指定的文件读取", cfgLoaded.game.pinRun === runDir);
ok("config 默认值补齐（llm.jsonMode）", cfgLoaded.llm.jsonMode === "prompt");

const link = new GameLink(cfgLoaded);
const discovered = link.discover();
ok("discover 找到 pinRun 目录", discovered === runDir, discovered);
const fresh = link.poll();
ok("poll 读到帧", !!fresh && fresh.seq === 2);
eq("status.connected 判定", link.status().connected, true);

// 中途接上别人开好的对局：旧 cmd 文件已被回收，但桥接层的 lastCmdSeq 停在 124，
// 序号不向 applied.cmdSeq 看齐的话，新命令会被引擎静默丢掉
{
	const dir2 = path.join(tmp, "run-midjoin");
	fs.mkdirSync(dir2, { "recursive": true });
	const borrowed = JSON.parse(JSON.stringify(frame));
	borrowed.applied = { "cmdSeq": 124 };
	fs.writeFileSync(path.join(dir2, "state-000700.json"), JSON.stringify(borrowed), "utf8");
	const late = new GameLink({ "game": { "ipcRoots": [tmp], "pinRun": dir2 } });
	late.attach(dir2);
	late.poll();
	const receipt = late.send([{ "op": "takeover", "on": true }]);
	ok("中途接局后命令序号跳过桥接层已消费的 124", receipt.seq > 124, `拿到 ${receipt.seq}`);
	ok("命令文件按 6 位命名落在对局目录", fs.existsSync(path.join(dir2, `cmd-${String(receipt.seq).padStart(6, "0")}.json`)));
}

const view = viewOf(fresh);
const synthView = viewOf(synth());
const ctx = { "view": view, "templates": Object.keys(staticFrame.templates) };

// 每条逻辑指令一组能过的示例参数 —— 也就是 UI 表单和模型输出的"标准答案"
const SAMPLE = {
	"move": { "targets": "army", "to": { "x": 40, "z": 60 } },
	"attack-move": { "targets": "army", "to": "foe" },
	"attack": { "target": "nearest" },
	"stop": { "targets": "army" },
	"patrol": { "to": { "x": 30, "z": 30 } },
	"guard": { "target": "cc" },
	"unguard": {},
	"garrison": { "targets": "workers", "target": "cc" },
	"unload": {},
	"heal": { "target": "cc" },
	"repair": { "target": "cc" },
	"promote": {},
	"set-formation": { "name": "line" },
	"set-stance": { "name": "aggressive" },
	"gather": { "target": 12 },
	"return-resources": { "target": "cc" },
	"back-to-work": {},
	"train": { "template": "archer", "count": 5 },
	"build": { "template": "field", "to": "home" },
	"research": { "template": "support_civ_bank" },
	"upgrade": { "template": "units/kush/infantry_spearman_b" },
	"autoqueue": { "on": true },
	"stop-production": { "id": 0 },
	"set-military-takeover": { "on": true },
	"set-economy-takeover": { "on": false },
	"take-over-all": {},
	"release-all": {},
	"set-doctrine": { "name": "harass" },
	"set-objective": { "to": "foe" },
	"set-rally-point": { "to": "home" },
	"set-micro-param": { "patch": { "engageRadius": 90, "bogusKey": 1 } },
	"set-econ-param": { "patch": { "villagerCap": 70, "nope": 1 } },
	"set-speed": { "value": 4 },
	"set-aggression": { "value": 0.8 },
	"set-posture": { "name": "defend" },
	"set-economy-mode": { "name": "boom" },
	"set-war-target": { "player": 2 },
	"defend-home": {},
	"retreat-all": {},
	"push-foe": {},
	"cheat-units": { "count": 20 }
};

// ---------------------------------------------------------------- A 桥接 op 名对账
const bridgeSrc = fs.readFileSync(path.join(repoRoot, "mod/gui/session/superbrain_bridge.js"), "utf8");
const ops = new Set(Array.from(bridgeSrc.matchAll(/case "([a-z-]+)":/g), m => m[1]));
const usedOps = new Set();
for (const i of INTENTS)
{
	const built = safeBuild(i, ctx);
	for (const c of built)
		usedOps.add(c.op);
}
const missing = Array.from(usedOps).filter(op => !ops.has(op));
ok(`逻辑指令用到的 ${usedOps.size} 个 op 全部存在于桥接层`, missing.length === 0, `缺失 ${missing.join(",")}`);
ok("桥接层 meta op 覆盖 takeover/econ/config/econ-config/doctrine/objective/speed",
	["takeover", "econ", "config", "econ-config", "doctrine", "objective", "speed"].every(o => ops.has(o)));

// 内核默认参数是唯一真源：白名单从内核源码里取，手抄一份迟早各自漂移
const kernelSrc = fs.readFileSync(path.join(repoRoot, "mod/gui/session/superbrain_kernel.js"), "utf8");
const MICRO_DEFAULTS = new Function(kernelSrc + "\nreturn g_SuperbrainConfig;")();
const MICRO_ALLOWED = new Set(Object.keys(MICRO_DEFAULTS));
ok("指令层白名单不漏内核任何一个参数", (() => {
	const out = compile({ "name": "set-micro-param", "args": { "patch": Object.assign({}, MICRO_DEFAULTS) } }, ctx);
	const sent = out.ok ? out.commands[0].patch : {};
	const dropped = Object.keys(MICRO_DEFAULTS).filter(k => !(k in sent));
	if (dropped.length)
		console.error("被静默丢掉的键:", dropped.join(","));
	return dropped.length === 0;
})());
ok("内核回防参数已进白名单（homeGuard/enter/exit/dwell）",
	["homeGuard", "homeThreatEnter", "homeThreatExit", "homeDwell", "homeThreatRadius", "homeArriveRadius"].every(k => MICRO_ALLOWED.has(k)));

function safeBuild(intent, context)
{
	const out = compile({ "name": intent.name, "args": SAMPLE[intent.name] || {} }, context);
	return out.ok ? out.commands : [];
}

// ---------------------------------------------------------------- B 视图与选择器
const ents = decodeEntities(fresh);
const ownRows = ents.filter(e => e.seen === 3);
ok("ownRows 解出己方实体", view.counts.ownRows === ownRows.length, `${view.counts.ownRows}/${ownRows.length}`);
ok("army 池只收军事且排除驻军单位", view.ids.army.every(id => {
	const e = ents.find(x => x.id === id);
	return e && e.military && !e.holder;
}));
ok("workers 池排除建筑与军事", view.ids.workers.every(id => {
	const e = ents.find(x => x.id === id);
	return e && !e.military && !e.structure && !e.holder;
}));
ok("wounded 只含低于半血", view.ids.wounded.every(id => {
	const e = ents.find(x => x.id === id);
	return e && e.maxHp > 0 && e.hp / e.maxHp < 0.5;
}));
ok("foes 只含当前可见敌人", view.ids.foes.every(id => {
	const e = ents.find(x => x.id === id);
	return e && e.seen === 2 && e.enemy;
}));
ok("isMilitary 不把建筑算成兵", !isMilitary("structures/kush/civil_centre") && isMilitary("units/kush/infantry_archer_b"));
eq("bucketOf 分类", [bucketOf("units/kush/infantry_archer_b"), bucketOf("units/kush/infantry_spearman_b"), bucketOf("units/kush/cavalry_javelineer_b"), bucketOf("structures/kush/civil_centre")], ["ranged", "pikeman", "hcav", "other"]);
ok("players 里有对手且 Gaia 未被当敌人", view.players.some(p => p.enemy && p.civ === "brit") && !view.foes.some(p => p.name === "Gaia"));
ok("econ/kernel/combat 直通", !!view.econ && !!view.kernel && !!view.combat);
ok("outcome 对我方存活帧判未结束", outcome(view).over === false);
ok("合成帧 home 落在主城上", synthView.home && Math.abs(synthView.home.x - 100) < 40, JSON.stringify(synthView.home));
ok("合成帧把内核回防判定带出来", synthView.guard && synthView.guard.active === true && synthView.guard.foes === 6, JSON.stringify(synthView.guard));
ok("回防中时告警说的是\"正在回防\"而不是\"建议回防\"",
	alarms(synthView).some(a => /回防中/.test(a.text)) && !alarms(synthView).some(a => /建议回防/.test(a.text)));
ok("有己方建筑时 home 一定解析出来", !view.map.structures.length || !!view.home);
ok("map 点集非空", view.map.own.length + view.map.foes.length > 0);

const sel = pickUnits("army", view);
ok("pickUnits army 与视图一致", sel.ids.length === view.ids.army.length);
ok("pickUnits 未知选择器退回全军并说明", pickUnits("飞刀队", view).ids.length === view.ids.army.length && /不认识/.test(pickUnits("飞刀队", view).note));
ok("pickUnits 裸 id", pickUnits([14, 15], view).ids.length === 2);
const tgt = pickTarget("nearest", view, { "kind": "foe" });
ok("pickTarget nearest 命中可见敌人", view.ids.foes.includes(tgt.id), JSON.stringify(tgt));
ok("pickTarget 无敌可见时报错而不是瞎猜", (() => {
	const empty = viewOf(Object.assign({}, frame, { "entities": [] }));
	return !!pickTarget("nearest", empty, { "kind": "foe" }).error;
})());
ok("pickPoint home/foe 解析", !!pickPoint("home", view) && !!pickPoint("foe", view));
ok("pickPoint 数字串解析", JSON.stringify(pickPoint("40,80", view)) === JSON.stringify({ "x": 40, "z": 80 }));

// ---------------------------------------------------------------- C 每条指令都能编译
let compiled = 0;
const compileErrors = [];
for (const i of INTENTS)
{
	const out = compile({ "name": i.name, "args": SAMPLE[i.name] || {} }, ctx);
	if (!out.ok)
		compileErrors.push(`${i.name}: ${out.error}`);
	else
		++compiled;
}
// 快照里没有对应数据（没人被关着、没观察到该模板）时，指令必须给"可读的数据不足说明"，
// 而不是抛异常或假装成功
const DATA_LIMITED = /没有|找不到|看不到|还没|不可见|无数据/;
const hard = compileErrors.filter(e => !DATA_LIMITED.test(e));
ok(`${INTENTS.length} 条指令编译要么成功、要么是数据不足类说明`, hard.length === 0, `硬失败：${hard.join(" | ")}`);
ok("当前快照下至少 34 条能直接编译", compiled >= 34, `${compiled}/${INTENTS.length}；跳过：${compileErrors.join(" | ")}`);
ok(`逻辑指令数量达到几十个的量级`, INTENTS.length >= 35, `${INTENTS.length}`);
// 带 targets 参数的指令必须真的把实体数组带出去 —— 漏掉 entities 的命令会被引擎静默丢弃
const lostEntities = [];
for (const i of INTENTS)
{
	if (!i.args.targets)
		continue;
	const out = compile({ "name": i.name, "args": SAMPLE[i.name] || {} }, ctx);
	if (!out.ok)
		continue;
	for (const c of out.commands)
		if (!Array.isArray(c.entities) || !c.entities.length)
			lostEntities.push(`${i.name}→${c.op}`);
}
ok("所有带 targets 的指令都带上非空 entities", lostEntities.length === 0, lostEntities.join(","));
ok("未知指令被拒绝并列出可用清单", /未知指令/.test(compile({ "name": "nuke" }, ctx).error || ""));
ok("缺少必填参数被拒绝", !!compile({ "name": "set-military-takeover", "args": {} }, ctx).ok === false);
ok("未登记参数只丢弃不报错", (() => {
	const out = compile({ "name": "stop", "args": { "targets": "army", "力度": 9 } }, ctx);
	return out.ok && out.notes.some(n => /忽略未登记/.test(n));
})());
ok("枚举值越界被拒绝", !!compile({ "name": "set-doctrine", "args": { "name": "rush" } }, ctx).error);
ok("数值范围被校验", !!compile({ "name": "set-aggression", "args": { "value": 7 } }, ctx).error);
ok("微操参数白名单过滤未知键", (() => {
	const out = compile({ "name": "set-micro-param", "args": { "patch": { "engageRadius": 90, "bad": 1 } } }, ctx);
	return out.ok && "engageRadius" in out.commands[0].patch && !("bad" in out.commands[0].patch);
})());
ok("批量单位按 120 上限分片", (() => {
	const big = Object.assign({}, view, { "ids": Object.assign({}, view.ids, { "army": Array.from({ "length": 300 }, (_, k) => k + 1) }) });
	const out = compile({ "name": "attack-move", "args": { "targets": "army", "to": "home" } }, { "view": big, "templates": ctx.templates });
	const cmds = out.ok ? flatten([{ "ok": true, "commands": out.commands }]) : [];
	return cmds.length === 3 && cmds.every(c => c.entities.length <= 120);
})());
ok("模板名解析：中文说法 → 真实模板", (() => {
	const r = resolveTemplate("弓手", ctx);
	return !r.error && /archer/.test(r.template);
})());
ok("模板名解析：没见过的名字明确报错", !!resolveTemplate("隐形轰炸机", ctx).error);
ok("schemaText 覆盖所有指令", INTENTS.every(i => schemaText().includes(i.name)));
ok("uiSchema 带 args 元数据", uiSchema().every(i => Array.isArray(i.args)));

// 组合宏真的展开成多条命令
ok("defend-home 展开为 doctrine+attack-walk+config", (() => {
	const out = compile({ "name": "defend-home", "args": {} }, ctx);
	return out.ok && out.commands.length === 3 && out.commands.map(c => c.op).join(",") === "doctrine,attack-walk,config";
})());
ok("defend-home 的回防参数合法且更敏感", (() => {
	const cfg = compile({ "name": "defend-home", "args": {} }, ctx).commands[2].patch;
	return Object.keys(cfg).every(k => MICRO_ALLOWED.has(k)) && cfg.homeGuard === true &&
		cfg.homeThreatEnter <= MICRO_DEFAULTS.homeThreatEnter && cfg.homeThreatExit < cfg.homeThreatEnter;
})());
ok("take-over-all 同时打开两块", (() => {
	const out = compile({ "name": "take-over-all", "args": {} }, ctx);
	return out.commands.some(c => c.op === "takeover" && c.on) && out.commands.some(c => c.op === "econ" && c.on);
})());

// ---------------------------------------------------------------- D 旋钮
const ECON_ALLOWED = new Set(Object.keys(economyPatch("balanced")).concat(["unloadThreat", "unloadWait", "minVillagers", "farmTarget", "militaryTarget", "stockPerVillager", "techShare", "armyShare", "armyPopShare", "villagerCap", "minReserve"]));

ok("攻击欲望只改合法键", Object.keys(aggressionPatch(0.5)).every(k => MICRO_ALLOWED.has(k)));
ok("攻击欲望随数值单调更激进", aggressionPatch(0.9).engageRadius > aggressionPatch(0.1).engageRadius && aggressionPatch(0.9).maxChase > aggressionPatch(0.1).maxChase);
eq("攻击欲望边界钳位", [aggressionPatch(-1).engageRadius, aggressionPatch(5).engageRadius], [40, 110]);
for (const p of ["defend", "balanced", "attack"])
{
	const pack = posturePatch(p);
	ok(`姿态 ${p} 键合法`, Object.keys(pack.micro).every(k => MICRO_ALLOWED.has(k)) && Object.keys(pack.econ).every(k => ECON_ALLOWED.has(k)));
	ok(`姿态 ${p} 保留驻军防抖宽带（civilianDanger*2 <= unloadThreat）`, pack.micro.civilianDanger * 2 <= (pack.econ.unloadThreat != null ? pack.econ.unloadThreat : 90), JSON.stringify(pack));
	ok(`姿态 ${p} 不关村民进驻（避免一个塞一个放）`, pack.micro.garrisonCivilians !== true);
	ok(`姿态 ${p} 的回防阈值有序（exit < enter，滞回才有带宽）`,
		pack.micro.homeThreatEnter == null || pack.micro.homeThreatExit < pack.micro.homeThreatEnter, JSON.stringify(pack.micro));
	ok(`姿态 ${p} 生成 2~3 条 meta 命令`, packCommands(pack).length >= 2);
}
ok("守家姿态比全力进攻更容易回防", posturePatch("defend").micro.homeThreatEnter < posturePatch("attack").micro.homeThreatEnter);
ok("回防灵敏度在训练搜索空间里（可以越练越会救村）",
	"homeThreatEnter" in searchSpace().micro && "homeThreatRadius" in searchSpace().micro);
for (const m of ["boom", "balanced", "war"])
	ok(`经济模式 ${m} 键合法`, Object.keys(economyPatch(m)).every(k => ECON_ALLOWED.has(k)));
ok("暴兵比憋经济的兵役份额高", economyPatch("war").armyShare > economyPatch("boom").armyShare);
ok("憋经济比暴兵的农民目标高", economyPatch("boom").villagerCap > economyPatch("war").villagerCap);
eq("目标国家补丁", targetPatch(3), { "focusPlayer": 3 });
eq("目标国家清零", targetPatch("0"), { "focusPlayer": 0 });
const pack = samplePack(searchSpace());
ok("采样包落在搜索空间内", Object.keys(pack.micro).every(k => {
	const [lo, hi] = searchSpace().micro[k];
	return pack.micro[k] >= lo && pack.micro[k] <= hi;
}));
ok("采样包含微操与经济两块", Object.keys(pack.micro).length >= 8 && Object.keys(pack.econ).length >= 5);
// 经济要能单独微调：它有自己的搜索空间与评分（trainer 的 target=econ），军事参数一个都不碰
const econSrc = fs.readFileSync(path.join(repoRoot, "mod/gui/session/superbrain_economy.js"), "utf8");
const ECON_DEFAULTS = new Function(econSrc + "\nreturn g_SuperbrainEconConfig;")();
const { econSpace, sampleEcon } = await import("../lib/presets.mjs");
eq("经济搜索空间与内核默认参数对账（两边不能各写各的）",
	Object.keys(econSpace()).filter(k => !(k in ECON_DEFAULTS)), []);
eq("混合搜索空间的 econ 侧也在经济默认参数里",
	Object.keys(searchSpace().econ).filter(k => !(k in ECON_DEFAULTS)), []);
const econSample = sampleEcon();
ok("经济专项采样只动经济，不掺军事参数",
	econSample.micro == null && Object.keys(econSample.econ).length >= 10 &&
	packCommands(econSample).length === 1 && packCommands(econSample)[0].op === "econ-config",
	JSON.stringify(packCommands(econSample).map(c => c.op)));
ok("经济采样值都落在空间范围内", Object.keys(econSample.econ).every(k =>
	econSample.econ[k] >= econSpace()[k][0] && econSample.econ[k] <= econSpace()[k][1]));
ok("新加的劳力底线参数能被 set-econ-param 下发（没被白名单吃掉）", (() => {
	const out = compile({ "name": "set-econ-param", "args": { "patch": { "minerFloor": 3, "woodFloorShare": 0.35, "townBuildings": 6, "buildersPerSite": 2 } } }, ctx);
	const sent = out.ok ? out.commands[0].patch : {};
	return ["minerFloor", "woodFloorShare", "townBuildings", "buildersPerSite"].every(k => k in sent);
})());
// 回归基线靠"什么都不下发"跑出厂默认值：空包必须真的展开成 0 条命令
eq("空参数包不产生任何命令（训练 baseline 模式的依据）", packCommands({}), []);

// ---------------------------------------------------------------- E 兜底解释器
const PHRASES = [
	["全部接管", "take-over-all"],
	["全部取消", "release-all"],
	["接管军事", "set-military-takeover"],
	["经济我自己来", "set-economy-takeover"],
	["回防，村民被屠了", "defend-home"],
	["全力进攻", "set-posture"],
	["攻击欲望 80%", "set-aggression"],
	["激进一点", "set-aggression"],
	["先憋经济", "set-economy-mode"],
	["暴兵", "set-economy-mode"],
	["打第 2 家", "set-war-target"],
	["集火", "attack"],
	["停止", "stop"],
	["放人", "unload"],
	["骚扰他农民", "set-doctrine"]
];
for (const [phrase, expectName] of PHRASES)
{
	const out = ruleInterpret(phrase, view, ctx);
	const names = (out.intents || []).map(i => i.name);
	ok(`口令「${phrase}」→ ${expectName}`, names.includes(expectName) || names.some(n => n.startsWith(expectName)), `得到 ${names.join(",") || "无"} / ${out.say}`);
	ok(`口令「${phrase}」参数合法`, (out.intents || []).every(i => i.ok || /没有|找不到|看不到/.test(i.error || "")), (out.intents || []).map(i => `${i.name}:${i.error}`).join(" "));
}
ok("听不懂时不假装有动作", (() => {
	const out = ruleInterpret("今天天气不错", view, ctx);
	return out.engine === "rule-none" && out.intents.length === 0 && /没接住/.test(out.say);
})());

// 没配大模型时，interpret 必须自动走规则而不是抛异常
const offline = await interpret("全部接管", { "llm": new Llm(cfg.llm), "view": view, "ctx": ctx });
ok("interpret 无模型时走规则兜底", offline.engine === "rule" && offline.intents.length > 0, offline.engine);

// JSON 抽取要扛住本地模型的脏输出
ok("extractJson 容忍代码块", extractJson('```json\n{"say":"好"}\n```').say === "好");
ok("extractJson 容忍前后废话", extractJson('行：{"intents":[{"name":"stop"}]} 完毕').intents[0].name === "stop");
ok("extractJson 垃圾输入返回 null", extractJson("完全不是 json") === null);
ok("Llm 未启用时 enabled=false", new Llm(cfg.llm).enabled === false);
eq("Ollama 地址补全", new Llm({ "enabled": true, "baseUrl": "http://127.0.0.1:11434/v1", "model": "x" }).url(), "http://127.0.0.1:11434/v1/chat/completions");
eq("根地址补全", new Llm({ "enabled": true, "baseUrl": "https://api.deepseek.com", "model": "x" }).url(), "https://api.deepseek.com/v1/chat/completions");

// ---------------------------------------------------------------- 简报
const text = situationText(view);
ok("简报含人口与资源", /人口/.test(text) && /粮/.test(text));
ok("简报含接管状态与威胁", /威胁/.test(text) && /军事内核/.test(text));
const stext = situationText(synthView);
ok("简报把经济告警带出来", /粮 断供/.test(stext), stext);
ok("headline 一行", headline(view).split("\n").length === 1 && headline(synthView).length > 10);
ok("合成帧告警里能看见屠村提醒", alarms(synthView).some(a => a.level === "bad" || a.level === "warn"));
ok("空视图简报不崩", /还没有态势帧/.test(situationText(null)));

// ---------------------------------------------------------------- F 服务端端到端
const PORT = 8799;
const serverProc = spawn(process.execPath, [path.join(appRoot, "server.mjs"), "--port", String(PORT)], {
	"env": Object.assign({}, process.env, { "SUPERBRAIN_CONFIG": process.env.SUPERBRAIN_CONFIG, "SUPERBRAIN_STATE": process.env.SUPERBRAIN_STATE }),
	"stdio": ["ignore", "pipe", "pipe"]
});
let serverErr = "";
serverProc.stderr.on("data", d => { serverErr += d; process.stderr.write(`[server] ${d}`); });
serverProc.stdout.on("data", d => process.stdout.write(`[server] ${d}`));
const base = `http://127.0.0.1:${PORT}`;

// 心跳帧：模拟桥接层每拍写新 state，否则 connected 判定会因为帧变老而失败
let hbSeq = 2;
let ackSeqValue = 0;
function ackSeq() { return ackSeqValue; }
const heartbeat = setInterval(() => {
	hbSeq += 1;
	const f = JSON.parse(JSON.stringify(frame));
	f.seq = hbSeq;
	f.now = (f.now || 0) + 1;
	f.wall = Date.now();
	f.applied = { "cmdSeq": ackSeqValue, "ok": 1, "rejected": 0 };
	fs.writeFileSync(path.join(runDir, `state-${String(hbSeq).padStart(6, "0")}.json`), JSON.stringify(f), "utf8");
	const old = fs.readdirSync(runDir).filter(x => /^state-\d+\.json$/.test(x)).sort();
	for (const d of old.slice(0, Math.max(0, old.length - 6)))
		fs.unlinkSync(path.join(runDir, d));
}, 800);

async function waitUp()
{
	for (let i = 0; i < 60; ++i)
	{
		try
		{
			const r = await fetch(`${base}/api/health`);
			if (r.ok)
				return true;
		}
		catch (e) { /* 还没起 */ }
		await new Promise(r => setTimeout(r, 250));
	}
	return false;
}

const up = await waitUp();
ok("server 起来并响应 /api/health", up, serverErr.slice(0, 400));

if (up)
{
	const get = async route => (await fetch(base + route)).json();
	const post = async (route, payload) => (await fetch(base + route, { "method": "POST", "headers": { "content-type": "application/json" }, "body": JSON.stringify(payload) })).json();

	const st = await get("/api/state");
	ok("/api/state 带回视图与连接状态", !!st.view && st.status.connected === true);
	ok("/api/state 里攻击欲望被估算", typeof st.aggression === "number");
	ok("/api/state 里训练器与战略层状态存在", !!st.trainer && !!st.strategist);

	const list = await get("/api/intents");
	ok("/api/intents 返回清单", list.intents.length >= 35 && list.count === INTENTS.length);
	const cat = await get("/api/catalog");
	ok("/api/catalog 读到 static 模板", cat.stats.total >= 2 || cat.units.length >= 1);

	// 四个按钮
	await post("/api/takeover", { "all": true });
	let cmds = cmdsOnDisk();
	ok("全部接管落下一个 cmd 包", cmds.length === 1);
	let msg = JSON.parse(fs.readFileSync(cmds[0], "utf8"));
	ok("cmd 包内同时有 takeover 与 econ", msg.commands.some(c => c.op === "takeover" && c.on) && msg.commands.some(c => c.op === "econ" && c.on));
	await post("/api/takeover", { "all": false });
	cmds = cmdsOnDisk();
	msg = JSON.parse(fs.readFileSync(cmds[cmds.length - 1], "utf8"));
	ok("全部取消写的是新序号（不复用旧名）", msg.seq > 1 && cmds.length === 2, `${msg.seq}`);

	// 旋钮
	await post("/api/knobs", { "aggression": 0.8, "posture": "attack", "economy": "war", "target": 2 });
	const knob = JSON.parse(fs.readFileSync(cmdsOnDisk().slice(-1)[0], "utf8"));
	ok("旋钮一次下发 config+econ-config(+doctrine)", knob.commands.some(c => c.op === "config") && knob.commands.some(c => c.op === "econ-config"));
	ok("旋钮里的攻击欲望进了 engageRadius", knob.commands.find(c => c.op === "config").patch.engageRadius === 96, JSON.stringify(knob.commands));
	ok("旋钮里的 focusPlayer 进去了", knob.commands.find(c => c.op === "config").patch.focusPlayer === 2);

	// 逻辑指令
	const intent = await post("/api/intent", { "name": "attack-move", "args": { "targets": "army", "to": "foe" } });
	ok("/api/intent 正常指令返回 sent", intent.ok === true && !!intent.sent, JSON.stringify(intent));
	const badIntent = await post("/api/intent", { "name": "不存在", "args": {} });
	ok("/api/intent 未知指令返回错误而不是崩", badIntent.ok === false && /未知指令/.test(badIntent.error || ""));

	// 自然语言（无模型 → 规则）
	const chat = await post("/api/chat", { "text": "回防，攻击欲望 70%", "history": [] });
	ok("/api/chat 规则兜底有话说", !!chat.say && chat.intents.length > 0, JSON.stringify(chat).slice(0, 200));
	ok("/api/chat 下发的命令写进了 cmd 包", cmdsOnDisk().length >= 4);
	const log = await get("/api/chat/log");
	ok("聊天记录落盘", log.log.length >= 2);

	// 战略层未启用模型时应拒绝启动而不是崩
	const sage = await post("/api/strategist", { "action": "start" });
	ok("战略层在没有模型时拒绝启动", sage.ok === false && /未启用/.test(sage.error || ""), JSON.stringify(sage));

	// 训练：不许在游戏在跑时抢 zip（本测试里有新鲜帧 → 应被拦下）
	const train = await post("/api/train", { "trials": 1 });
	ok("训练模式发现对局在跑就拒绝", train.ok === false && /同一时刻/.test(train.error || ""), JSON.stringify(train).slice(0, 160));
	const t2 = await get("/api/train");
	ok("/api/train GET 返回排行榜结构", Array.isArray(t2.leaderboard.entries) && !!t2.space.micro);

	// 未知名 404 而不是 500
	const nf = await fetch(`${base}/api/nope`);
	ok("未知接口 404", nf.status === 404);

	// SSE
	const ac = new AbortController();
	const sse = await fetch(`${base}/api/events`, { "signal": ac.signal });
	const reader = sse.body.getReader();
	const chunk = await reader.read();
	const payload = Buffer.from(chunk.value).toString("utf8");
	ok("SSE hello 带 snapshot", /"type":"hello"/.test(payload));
	await reader.cancel();
	ac.abort();

	// 前端静态资源
	const html = await (await fetch(`${base}/`)).text();
	ok("GET / 返回前端页面", /Superbrain 控制台/.test(html));
	const js = await fetch(`${base}/app.js`);
	ok("GET /app.js 命中静态文件", js.ok && /text\/javascript/.test(js.headers.get("content-type") || ""));
	const trav = await fetch(`${base}/../package.json`);
	ok("路径穿越被挡", trav.status === 404 || trav.status === 400, String(trav.status));

	// ---- G 大模型链路：用假的 OpenAI 兼容端点验接口契约（不是验模型智商）
	let mockBody = null;
	let mockMode = "json";
	let mockReply = () => ({ "say": "转进攻并压上", "intents": [{ "name": "set-posture", "args": { "name": "attack" } }, { "name": "attack-move", "args": { "targets": "army", "to": "foe" } }] });
	const mock = http.createServer((req, res) => {
		let raw = "";
		req.on("data", c => { raw += c; });
		req.on("end", () => {
			mockBody = raw ? JSON.parse(raw) : null;
			if (mockMode === "junk")
			{
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ "choices": [{ "message": { "role": "assistant", "content": "我觉得应该进攻！！！" } }] }));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ "choices": [{ "message": { "role": "assistant", "content": JSON.stringify(mockReply()) } }], "model": "mock-1", "usage": { "total_tokens": 42 } }));
		});
	});
	await new Promise(r => mock.listen(8802, "127.0.0.1", r));

	const savedCfg = await post("/api/config", { "patch": { "llm": { "enabled": true, "baseUrl": "http://127.0.0.1:8802/v1", "model": "mock-1", "apiKey": "sk-test-1234567890" } } });
	ok("apiKey 保存后对外只留指纹", savedCfg.config.llm.apiKey === "" && savedCfg.config.llm.hasKey === true && /7890/.test(savedCfg.config.llm.keyHint), JSON.stringify(savedCfg.config.llm));

	const beforeLlm = cmdsOnDisk().length;
	const chatLlm = await post("/api/chat", { "text": "转进攻压上", "history": [] });
	ok("自然语言走大模型链路", chatLlm.engine === "llm", `${chatLlm.engine} / ${chatLlm.say}`);
	ok("模型话术回传玩家", /转进攻/.test(chatLlm.say));
	ok("模型指令编译后真的下发", chatLlm.intents.every(i => i.ok) && cmdsOnDisk().length > beforeLlm);
	ok("prompt 带逻辑指令清单", /set-posture/.test(mockBody.messages[0].content) && /defend-home/.test(mockBody.messages[0].content));
	ok("prompt 带当前态势", /人口/.test(mockBody.messages[mockBody.messages.length - 1].content));
	ok("prompt 禁止作弊类指令进模型", /只做单机战略调整/.test(mockBody.messages[0].content));
	ok("请求带温度与 max_tokens", mockBody.max_tokens > 0 && typeof mockBody.temperature === "number");

	mockMode = "junk";
	const junk = await post("/api/chat", { "text": "随便说点什么", "history": [] });
	ok("模型输出不可解析时不假成功", junk.engine.indexOf("llm") === 0 && junk.intents.length === 0, `${junk.engine} / ${junk.say}`);
	mockMode = "json";

	await post("/api/config", { "patch": { "llm": { "baseUrl": "http://127.0.0.1:1/v1" } } });
	const down = await post("/api/chat", { "text": "全部接管", "history": [] });
	ok("模型连不上时自动退回规则", /rule/.test(down.engine) && down.intents.length > 0, down.engine);
	await post("/api/config", { "patch": { "llm": { "baseUrl": "http://127.0.0.1:8802/v1" } } });

	// 大模型接管模式的护栏：模型不许把自己关出去，也不许作弊
	await post("/api/config", { "patch": { "strategist": { "intervalSec": 8, "maxOrders": 4 } } });
	mockReply = () => ({ "say": "我把军队还给你", "orders": [{ "name": "release-all" }, { "name": "cheat-units", "args": { "count": 500 } }, { "name": "set-doctrine", "args": { "name": "harass" } }] });
	const started = await post("/api/strategist", { "action": "start" });
	ok("接上模型后战略层可启动", started.ok !== false, JSON.stringify(started));
	await new Promise(r => setTimeout(r, 11000));
	const sageLive = (await get("/api/state")).strategist;
	const evs = (await get("/api/state")).events.map(e => e.text).join(" | ");
	ok("战略层按周期跑了轮次", sageLive.running && sageLive.rounds >= 1, JSON.stringify(sageLive).slice(0, 160));
	ok("模型想关掉接管会被拦", /release-all/.test(evs) && /白名单|禁止/.test(evs), evs.slice(-260));
	ok("模型想作弊会被拦", /cheat-units/.test(evs));
	const sentOps = cmdsOnDisk().flatMap(f => JSON.parse(fs.readFileSync(f, "utf8")).commands.map(c => c.op));
	ok("白名单内的指令照常执行", sentOps.includes("doctrine"), sentOps.join(","));
	await post("/api/strategist", { "action": "stop" });
	mock.close();

	// ack 回收：把 applied 提到已下发的最大序号，心跳帧带着它，服务端就该把对应 cmd 文件删掉
	const sentMax = Math.max(...cmdsOnDisk().map(f => JSON.parse(fs.readFileSync(f, "utf8")).seq));
	ackSeqValue = sentMax;
	await new Promise(r => setTimeout(r, 2800));
	const left = cmdsOnDisk().map(f => JSON.parse(fs.readFileSync(f, "utf8")).seq);
	ok("applied 之后 cmd 文件被回收", left.every(s => s > sentMax), `残留 ${left.join(",")}`);
}

function cmdsOnDisk()
{
	return fs.readdirSync(runDir).filter(f => /^cmd-\d+\.json$/.test(f)).sort().map(f => path.join(runDir, f));
}

clearInterval(heartbeat);
serverProc.kill();
fs.rmSync(tmp, { "recursive": true, "force": true });

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length)
{
	console.log(failures.map(f => `  ✗ ${f}`).join("\n"));
	process.exit(1);
}
console.log(`指令面：${INTENTS.length} 条逻辑指令 → ${usedOps.size} 个桥接 op；样本帧：${source ? path.basename(source.dir) : "合成"}`);
