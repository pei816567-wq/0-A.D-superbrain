/**
 * 经济副驾的现场取样：读最新（或指定序号）的 state 帧，打印人口曲线、
 * 资源、副驾下令情况、桥接内部错误。批量跑对局时同一份脚本能当指标采集器。
 *
 *   node superbrain/tools/econ_trace.mjs              # 最新 run 的最新一帧
 *   node superbrain/tools/econ_trace.mjs <run目录>    # 指定对局
 *   node superbrain/tools/econ_trace.mjs <run> --watch 30   # 每 30 秒打一行
 */

import fs from "node:fs";
import path from "node:path";

const defaultRoot = path.join(
	process.env.USERPROFILE || process.env.HOME,
	"Documents", "My Games", "0ad", "saves", "campaigns", "superbrain");

const argv = process.argv.slice(2);
const watchAt = argv.indexOf("--watch");
const watch = watchAt >= 0 ? +(argv[watchAt + 1] || 30) : 0;
const arg = argv.filter((a, i) => i !== watchAt && i !== watchAt + 1)[0];

function newestRun()
{
	const subs = fs.readdirSync(defaultRoot).map(n => path.join(defaultRoot, n))
		.filter(p => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } });
	return subs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

const runDir = arg ? (path.isAbsolute(arg) ? arg : path.join(defaultRoot, arg)) : newestRun();
if (!runDir || !fs.existsSync(runDir))
{
	console.log("没有可读取的 run 目录");
	process.exit(1);
}

function latest()
{
	const files = fs.readdirSync(runDir).filter(f => /^state-\d+\.json$/.test(f)).sort();
	return files.length ? path.join(runDir, files[files.length - 1]) : null;
}

function shortNums(obj)
{
	if (!obj)
		return "-";
	return Object.keys(obj).map(k => `${k}=${Math.round(obj[k] * 10) / 10}`).join(" ");
}

function fmtRes(r)
{
	if (!r)
		return "-";
	return `粮${Math.round(r.food || 0)} 木${Math.round(r.wood || 0)} 石${Math.round(r.stone || 0)} 金${Math.round(r.metal || 0)}`;
}

function report()
{
	const file = latest();
	if (!file)
	{
		console.log("还没有 state 帧");
		return null;
	}
	const s = JSON.parse(fs.readFileSync(file, "utf8"));
	const me = String(s.me);
	const p = (s.players || {})[me] || {};
	const econ = s.econ || {};
	const kernel = s.kernel || {};
	const combat = s.combat || {};
	const c = (s.probe && s.probe.counts) || {};

	console.log(`[${path.basename(file)}] 仿真 ${Math.round(s.now || 0)}s  ` +
		`人口 ${p.pop}/${p.popCap}  农 ${econ.civilians}(自由${econ.workers}/关着${econ.bunkered}/目标${econ.wantCivilians}/闲${econ.idle})  ` +
		`兵 ${econ.soldiers}  ${fmtRes(p.resources)}`);
	console.log(`    建筑 主城${econ.cc} 房${econ.houses} 田${econ.fields} 产兵${econ.producers}  ` +
		`收入/秒 ${JSON.stringify(econ.income || {})}  本拍下令 ${econ.issued} 累计 ${econ.issuedTotal} 拒 ${econ.rejectedTotal}  ${JSON.stringify(econ.ops || [])}`);
	console.log(`    劳力 实际 ${JSON.stringify(econ.gatherers || {})} / 应有 ${shortNums(econ.wantGatherers)} / 坑位 ${shortNums(econ.slots)} / 可见点 ${shortNums(econ.nodes)}` +
		`  最近敌人 ${econ.threatDist == null ? "视野内没有" : econ.threatDist}`);
	console.log(`    视野 己方行 ${econ.ownRows} 无坐标导出 ${s.skippedPosless} 取回 ${c.returned}/请求 ${c.fetched} id 段 ${c.idTop} 驻军点名 ${c.billeted}`);
	console.log(`    军事 接管=${s.autopilot} 经济=${s.economy} 下令=${kernel.issued} 判定=${JSON.stringify((kernel.fight || {}).fight)} 战损比=${combat.ratio}`);
	if ((econ.alerts || []).length)
		console.log(`    告警 ${econ.alerts.join(" | ")}`);
	console.log(`    错误 ${(s.diag && s.diag.errors || []).slice(-3).join(" | ") || "无"}`);
	const supply = s.probe && s.probe.supplyShape;
	if (supply)
		console.log(`    resourceSupply 真实结构 ${supply}`);
	return s;
}

report();
if (!watch)
	process.exit(0);

setInterval(report, watch * 1000);
