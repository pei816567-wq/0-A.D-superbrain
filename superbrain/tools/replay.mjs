/**
 * 用真实对局落盘的 state/static 回放内核决策：
 * 输入是引擎导出的实体行 + 真实 GetTemplateData 转储，输出是内核的计划或异常栈。
 * 每次改完内核先跑这个，再花一分钟重启游戏。
 *
 *   node superbrain/tools/replay.mjs [run目录]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "mod", "gui", "session", "superbrain_kernel.js"), "utf8");
const Kernel = new Function(src + "\nreturn SuperbrainKernel;")();

const defaultRun = path.join(
	process.env.USERPROFILE || process.env.HOME,
	"Documents", "My Games", "0ad", "saves", "campaigns", "superbrain");

const arg = process.argv[2];
const runDir = arg ? (path.isAbsolute(arg) ? arg : path.join(defaultRun, arg)) : newestRun();

function newestRun()
{
	const subs = fs.readdirSync(defaultRun)
		.map(name => path.join(defaultRun, name))
		.filter(p => {
			try { return fs.statSync(p).isDirectory(); }
			catch (e) { return false; }
		});
	if (!subs.length)
		throw new Error("没有可回放的 run 目录");
	return subs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function latest(prefix)
{
	const files = fs.readdirSync(runDir).filter(f => f.startsWith(prefix + "-")).sort();
	if (!files.length)
		throw new Error(`缺少 ${prefix}-*.json`);
	return JSON.parse(fs.readFileSync(path.join(runDir, files[files.length - 1]), "utf8"));
}

const statics = JSON.parse(fs.readFileSync(path.join(runDir, fs.readdirSync(runDir).filter(f => /^static-/.test(f)).sort().pop()), "utf8"));
const states = fs.readdirSync(runDir).filter(f => /^state-/.test(f))
	.sort((a, b) => +a.slice(6, 12) - +b.slice(6, 12))
	.map(f => JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8")))
	.filter(s => s.entities && s.entities.length);

console.log("回放", path.basename(runDir), "帧数", states.length, "模板", Object.keys(statics.templates).length);

// GetTemplateData 对带前缀的临时模板（mirage| / foundation| / resource|）取不到数值，
// 桥接层原样缓存，回放也照此还原
const templates = Object.assign({}, statics.templates);
const cache = new Map();
function getTemplate(template, player)
{
	const key = template + "|" + player;
	if (cache.has(key))
		return cache.get(key);
	const data = templates[template] || {};
	cache.set(key, data);
	return data;
}

const kernel = new Kernel({ "getTemplate": getTemplate });
let configured = false;

function worldOf(state)
{
	const fields = state.fields;
	const me = state.me;
	return {
		"now": state.now / 1000,
		"me": me,
		"formations": ["line", "box"],
		"stances": ["aggressive", "standground"],
		"rally": null,
		"objective": null,
		"units": state.entities.map(row => {
			const e = Object.fromEntries(fields.map((f, i) => [f, row[i]]));
			return {
				"id": e.id,
				"t": e.template,
				"owner": e.owner,
				"x": e.x,
				"z": e.z,
				"hp": e.hp,
				"maxHp": e.maxHp,
				"seen": e.seen,
				"enemy": !!e.enemy
			};
		})
	};
}

let thrown = null;
let last = null;
const trace = [];
for (const state of states)
{
	try
	{
		if (!configured && state.cfg)
		{
			kernel.configure(state.cfg);
			configured = true;
			console.log("沿用对局当时的参数:", JSON.stringify({ doctrine: state.cfg.doctrine, retreatHp: state.cfg.retreatHp }));
		}
		last = kernel.plan(worldOf(state));
		trace.push({
			"t": +(state.now / 1000).toFixed(0),
			"own": state.entities.filter(e => e[7] === 3 && /units\//.test(e[1])).length,
			"fight": last.fight ? (last.fight.fight ? "打" : "撤") + last.fight.exchange : "-",
			"ops": last.ops.length,
			"tasks": last.summary.map(g => g.role + ":" + g.task + "/" + g.action).join(" ")
		});
	}
	catch (e)
	{
		thrown = { "seq": state.seq, "message": e.message, "stack": String(e.stack).split("\n").slice(0, 4).join("\n") };
		break;
	}
}

const step = Math.max(1, Math.floor(trace.length / 24));
console.log("\n决策轨迹（每 " + step + " 帧取样）:");
for (let i = 0; i < trace.length; i += step)
	console.log("  t=%ss 我方单位=%s 判定=%s 下令=%s  %s", trace[i].t, trace[i].own, trace[i].fight, trace[i].ops, trace[i].tasks);

const stats = kernel.stats;
const rows = [];
for (const key in stats)
{
	const s = stats[key];
	rows.push(`${key} mil=${s.military} ranged=${s.ranged} dps=${s.dps.toFixed(2)} range=${s.range} hp=${s.hp} run=${s.run} struct=${s.structure}`);
}

console.log("\n内核数值模型:");
for (const r of rows)
	console.log("  " + r);

if (thrown)
{
	console.log("\nTHROW seq=" + thrown.seq + ": " + thrown.message);
	console.log(thrown.stack);
	process.exit(1);
}

console.log("\n末帧计划:");
console.log(JSON.stringify(last, null, 1).slice(0, 2200));
