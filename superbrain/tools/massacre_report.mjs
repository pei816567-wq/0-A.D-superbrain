/**
 * 回防效果复盘（任务 #7 的验收尺子）。
 *
 * 只看两件事：
 *   1. 成片损失 —— 任意 100 仿真秒窗口里我方阵亡数的最大跳增。
 *      历史败因就是这一项爆表（军队在外线推人，对面分兵屠村）。
 *   2. 内核到底做没做什么 —— 回防判定翻了几次、每次压境几只火力、
 *      有多少拍真的有部队领"return"任务，以及有没有来回抖。
 *
 *   node superbrain/tools/massacre_report.mjs [run目录|全部]
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const IPC = path.join(os.homedir(), "Documents", "My Games", "0ad", "saves", "campaigns", "superbrain");
const arg = process.argv[2];

function runs()
{
	if (arg && arg !== "all")
		return [path.isAbsolute(arg) ? arg : path.join(IPC, arg)];
	return fs.readdirSync(IPC).filter(d => /^run-/.test(d)).sort().map(d => path.join(IPC, d));
}

/** 容忍写一半的帧：桥接是 wtruncate+写，读侧随时可能撞上截断。 */
function readFrame(file)
{
	try
	{
		return JSON.parse(fs.readFileSync(file, "utf8"));
	}
	catch (e)
	{
		return null;
	}
}

function frames(dir)
{
	return fs.readdirSync(dir).filter(f => /^state-\d+\.json$/.test(f)).sort()
		.map(f => readFrame(path.join(dir, f))).filter(Boolean);
}

/** 滑窗：任意 spanN 秒内的最大阵亡跳增。 */
function worstWindow(list, spanSec)
{
	let worst = { "jump": 0, "from": 0, "to": 0 };
	for (let i = 0; i < list.length; ++i)
	{
		let j = i;
		while (j + 1 < list.length && list[j + 1].now - list[i].now <= spanSec)
			++j;
		const jump = list[j].losses - list[i].losses;
		if (jump > worst.jump)
			worst = { "jump": jump, "from": Math.round(list[i].now), "to": Math.round(list[j].now) };
	}
	return worst;
}

const rows = [];
for (const dir of runs())
{
	if (!fs.existsSync(dir))
		continue;
	const list = [];
	for (const f of frames(dir))
	{
		const k = f.kernel || {};
		const g = k.guard || null;
		list.push({
			"now": f.now,
			"autopilot": !!f.autopilot,
			"losses": (f.combat || {}).ourLosses || 0,
			"kills": (f.combat || {}).foeKills || 0,
			// 村民数是屠村的直接读数：跳增阵亡往往就伴随着它往下掉
			"civilians": (f.econ || {}).civilians != null ? (f.econ || {}).civilians : (f.fields || {}).civilians,
			"active": !!(g && g.active),
			"returning": (k.groups || []).filter(r => r.task === "return").length,
			"groups": (k.groups || []).length,
			"hasGuard": !!g
		});
	}
	if (!list.length)
		continue;

	const mass = worstWindow(list, 100);
	const flips = list.reduce((n, r, i) => n + (i && r.active !== list[i - 1].active ? 1 : 0), 0);
	const onTicks = list.filter(r => r.active).length;
	const marchTicks = list.filter(r => r.returning > 0).length;
	// 判定说压境却一支部队都没掉头：要么兵都在家里，要么优先级被别的任务抢了
	const idleAlerts = list.filter(r => r.active && r.groups > 0 && r.returning === 0).length;
	const civs = list.map(r => r.civilians).filter(v => typeof v === "number");

	rows.push({
		"run": path.basename(dir),
		"frames": list.length,
		"simSec": Math.round(list[list.length - 1].now),
		"losses": list[list.length - 1].losses,
		"kills": list[list.length - 1].kills,
		"civMin": civs.length ? Math.min.apply(null, civs) : null,
		"civEnd": civs.length ? civs[civs.length - 1] : null,
		"jump100": mass.jump,
		"jumpAt": `${mass.from}-${mass.to}s`,
		"guardTicks": onTicks,
		"flips": flips,
		"marchTicks": marchTicks,
		"idleAlerts": idleAlerts,
		"noGuardField": list.some(r => r.autopilot && !r.hasGuard)
	});
}

for (const r of rows)
{
	console.log(`\n${r.run}  ${r.frames} 帧 / 仿真 ${r.simSec}s`);
	console.log(`  战果        杀 ${r.kills} 亡 ${r.losses}  村民 最少 ${r.civMin} → 终局 ${r.civEnd}`);
	console.log(`  100s 成片损失  最大跳增 ${r.jump100} 人（${r.jumpAt}）${r.jump100 >= 40 ? "  ← 不合格" : "  ← 合格"}`);
	console.log(`  回防判定      ${r.guardTicks} 拍为压境，翻转 ${r.flips} 次`);
	console.log(`  真的掉头      ${r.marchTicks} 拍有部队领 return 令，${r.idleAlerts} 拍判定压境却无人可调`);
	if (r.noGuardField)
		console.log("  注意          接管中的帧却没有 guard 字段：游戏目录里的 mod 是旧副本，没重新同步");
}

const bad = rows.filter(r => r.jump100 >= 40);
console.log(`\n合计 ${rows.length} 局，100 秒内阵亡跳增 ≥40 的：${bad.length} 局` +
	(bad.length ? ` ← ${bad.map(b => b.run).join(", ")}` : "（无成片屠杀）"));
