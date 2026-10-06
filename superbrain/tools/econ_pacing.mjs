/**
 * 经济节奏复盘：把一局帧序列里的运营曲线压成一张表。
 *
 * 只看经济，不看微操 —— 调经济权重时要的是"农民起量慢在哪、城/up 上在哪、
 * 石金是不是一直不够、房子是不是卡口"，把这些和军事战果混在一个指标里就分不清是谁的锅。
 *
 *   node superbrain/tools/econ_pacing.mjs <run目录|all>
 *
 * 教程基准（用于对照，来源见 references/econ-tutorial.md）：
 *   Village→Town  500 粮 + 500 木，另需 5 栋非农田建筑；社区节奏 8–10 分钟
 *   Town→City     1000 石 + 1000 金，另需 4 栋 Town 级建筑
 *   农田目标 8 块；每栋建筑只派 1 个builder；第二座主城约 12 分钟
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const IPC = path.join(os.homedir(), "Documents", "My Games", "0ad", "saves", "campaigns", "superbrain");
const arg = process.argv[2] || "all";

const mmss = s => `${Math.floor((s || 0) / 60)}:${String(Math.round((s || 0) % 60)).padStart(2, "0")}`;

function dirs()
{
	if (arg !== "all")
		return [path.isAbsolute(arg) ? arg : path.join(IPC, arg)];
	return fs.readdirSync(IPC).filter(d => /^run-/.test(d)).sort().map(d => path.join(IPC, d));
}

function frames(dir)
{
	const out = [];
	for (const f of fs.readdirSync(dir).filter(n => /^state-\d+\.json$/.test(n)).sort())
	{
		try
		{
			out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
		}
		catch (e)
		{
			// 半帧直接跳过：桥接是截断写，读侧随时可能撞上
		}
	}
	return out;
}

/** 阶段变化时刻 + 各资源首次到货 + 人口/农民里程碑。 */
function milestones(list)
{
	const rise = {};
	const first = {};
	const peak = { pop: 0, civ: 0, cap: 0, sol: 0, fields: 0, houses: 0, cc: 0, prod: 0 };
	const last = {};
	const stalls = [];

	for (const f of list)
	{
		const e = f.econ || {};
		const res = ((f.players || {})[String(f.me)] || {}).resources || (f.fields || {}).resources || {};
		const me = (f.players || {})[String(f.me)] || {};
		const now = f.now || 0;

		if (me.phase && rise[me.phase] == null)
			rise[me.phase] = now;
		for (const r of ["food", "wood", "stone", "metal"])
			if (first[r] == null && (res[r] || 0) >= 500)
				first[r] = now;

		peak.pop = Math.max(peak.pop, me.pop || 0);
		peak.cap = Math.max(peak.cap, e.popCap || 0);
		peak.civ = Math.max(peak.civ, e.civilians || 0);
		peak.sol = Math.max(peak.sol, e.soldiers || 0);
		peak.fields = Math.max(peak.fields, e.fields || 0);
		peak.houses = Math.max(peak.houses, e.houses || 0);
		peak.cc = Math.max(peak.cc, e.cc || 0);
		peak.prod = Math.max(peak.prod, e.producers || 0);

		// 人口贴顶且没在盖房 = 卡口
		if (e.popCap && me.pop >= e.popCap - 1 && (e.idle || 0) === 0 && (e.civilians || 0) < (e.wantCivilians || 0))
			stalls.push({ now, pop: me.pop, cap: e.popCap, civ: e.civilians, want: e.wantCivilians });

		last.row = { now, pop: me.pop, cap: e.popCap, civ: e.civilians, want: e.wantCivilians, sol: e.soldiers, res, phase: me.phase };
		last.econ = e;
	}
	return { rise, first, peak, stalls, last };
}

for (const dir of dirs())
{
	if (!fs.existsSync(dir))
		continue;
	const list = frames(dir);
	if (!list.length)
		continue;

	const m = milestones(list);
	const e = m.last.econ || {};
	const name = path.basename(dir);
	const sim = Math.round(m.last.row.now || 0);

	console.log(`\n=== ${name}  ${list.length} 帧 / 仿真 ${mmss(sim)}`);
	console.log(`  阶段 ${Object.keys(m.rise).length ? Object.entries(m.rise).map(([p, t]) => `${p}@${mmss(t)}`).join(" → ") : "始终 Village"}`
		+ `（教程 Town 目标 8–10 分钟）`);
	console.log(`  首达 500 库存  ${Object.entries(m.first).map(([r, t]) => `${r}@${mmss(t)}`).join("  ") || "无"}`);
	console.log(`  峰值 人口${m.peak.pop}/上限${m.peak.cap} 农民${m.peak.civ} 兵${m.peak.sol} 房${m.peak.houses} 田${m.peak.fields} 主城${m.peak.cc} 产兵${m.peak.prod}`);
	console.log(`  终局 人口${m.last.row.pop}/${m.last.row.cap} 农民${m.last.row.civ}(目标${m.last.row.want}) 兵${m.last.row.sol} ` +
		`粮${Math.round(m.last.row.res.food || 0)} 木${Math.round(m.last.row.res.wood || 0)} 石${Math.round(m.last.row.res.stone || 0)} 金${Math.round(m.last.row.res.metal || 0)}`);
	console.log(`  收入/秒 ${Object.entries(e.income || {}).map(([r, v]) => `${r}${v}`).join(" ") || "-"}`);
	console.log(`  劳力 实际 ${JSON.stringify(e.gatherers || {})} 应有 ${JSON.stringify(e.wantGatherers || {})}`);
	console.log(`  坑位 ${JSON.stringify(e.slots || {})} 采集点 ${JSON.stringify(e.nodes || {})}`);
	console.log(`  兵种配比目标 ${JSON.stringify(e.mix || {})}  下令 ${e.issuedTotal || e.issued || 0} 被拒 ${e.rejectedTotal || 0}`);
	if (m.stalls.length)
		console.log(`  卡口 ${m.stalls.length} 拍：首次 ${mmss(m.stalls[0].now)}（人口${m.stalls[0].pop}/${m.stalls[0].cap} 农民${m.stalls[0].civ}/目标${m.stalls[0].want}）`);
	if ((e.alerts || []).length)
		console.log(`  告警 ${e.alerts.slice(-3).join(" / ")}`);
}
