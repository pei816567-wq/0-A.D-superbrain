/**
 * 态势简报：把一帧视图压成几行中文。
 *
 * 这份文本有两个读者 —— UI 的状态栏和大模型的 context。
 * 给模型的版本必须短、带数字、带上"内核现在怎么想"，否则模型只能瞎猜。
 */

import { estimateAggression } from "./presets.mjs";

const RES_LABEL = { "food": "粮", "wood": "木", "stone": "石", "metal": "金" };
const BUCKET_LABEL = { "pikeman": "枪", "sword": "剑", "ranged": "远程", "cav": "骑", "hcav": "骑射", "siege": "攻城", "hero": "英雄", "other": "其它" };

export function fmtRes(res)
{
	if (!res)
		return "无数据";
	return Object.keys(RES_LABEL).map(k => `${RES_LABEL[k]}${Math.round(res[k] || 0)}`).join(" ");
}

export function fmtMix(tally)
{
	const parts = [];
	for (const k in BUCKET_LABEL)
		if (tally && tally[k])
			parts.push(`${BUCKET_LABEL[k]}${tally[k]}`);
	return parts.length ? parts.join("/") : "无";
}

export function mmss(sec)
{
	const s = Math.max(0, Math.round(sec || 0));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 一行 headline，用于 UI 顶栏和日志。 */
export function headline(view)
{
	if (!view)
		return "等待对局数据";
	const e = view.econ || {};
	return `${mmss(view.simNow)} 人口 ${view.my.pop}/${view.my.popCap} · 农${e.civilians ?? view.counts.workers} 兵${view.counts.army} · ` +
		`${fmtRes(view.my.resources)} · 军${view.autopilot ? "接管" : "手操"} 经${view.economyOn ? "接管" : "手操"}`;
}

/** 多行简报，喂模型。 */
export function situationText(view, { verbose = false } = {})
{
	if (!view)
		return "还没有态势帧：请确认已进入单人对局并启用 superbrain mod。";

	const e = view.econ || {};
	const k = view.kernel || {};
	const c = view.combat || {};
	const lines = [];

	lines.push(`仿真 ${mmss(view.simNow)}（${view.my.name || "?"}/${view.my.civ || "?"}），数据年龄 ${Math.round(view.ageMs)}ms，帧序号 ${view.seq}`);
	lines.push(`人口 ${view.my.pop}/${view.my.popCap}（上限${e.popCap || "?"}） 阶段 ${view.my.phase || "?"} 科技 ${view.my.techs || 0}`);
	lines.push(`资源 ${fmtRes(view.my.resources)} 收入/秒 ${e.income ? Object.keys(e.income).map(r => `${RES_LABEL[r] || r}${e.income[r]}`).join(" ") : "-"}`);
	lines.push(`劳力 农民 ${e.civilians ?? view.counts.workers}（目标 ${e.wantCivilians || "?"} 闲 ${e.idle || 0} 关着 ${e.bunkered || 0}） 兵 ${view.counts.army}（配比 ${fmtMix(view.composition)} 平均血量 ${Math.round(view.armyHp * 100)}%）`);
	lines.push(`建筑 主城 ${e.cc || 0} 房 ${e.houses || 0} 田 ${e.fields || 0} 产兵 ${e.producers || 0} 己方实体行 ${view.counts.ownRows}`);

	const threat = e.threatDist != null ? `${e.threatDist} 格` : (view.homeThreat && view.homeThreat.seen != null ? `${view.homeThreat.seen} 格` : "看不见");
	lines.push(`威胁 最近敌人离家 ${threat}，可见敌 ${view.counts.foesSeen}，过期位置 ${view.counts.lastKnown}，敌军重心 ${view.foeCentroid ? `(${Math.round(view.foeCentroid.x)},${Math.round(view.foeCentroid.z)})` : "无"}，我军离家 ${view.armyToHome != null ? Math.round(view.armyToHome) : "?"}`);
	lines.push(`军事内核 ${k.doctrine || (view.cfg && view.cfg.doctrine) || "field"} 判定 ${k.fight ? (k.fight.fight ? "打" : "撤") : "-"} 交换比 ${k.fight ? k.fight.exchange : "-"} 下令 ${k.issued || 0} 拒 ${k.rejected || 0} 攻击欲望≈${estimateAggression(view.cfg) ?? "-"}`);
	// 让模型知道内核自己已经在回防了 —— 否则它会一轮一轮地重复下 defend-home
	if (view.guard)
		lines.push(`基地防卫 ${view.guard.active ?
			`压境！家门口火力 ${view.guard.foes} 对守军 ${view.guard.ours}，全军已在回防路上（不要再重复下令回防）` :
			`安全（门口 ${view.guard.foes} 股火力、守军 ${view.guard.ours}，无需回防）`}`);
	lines.push(`战损 我方阵亡 ${c.ourLosses ?? "?"} 击杀 ${c.foeKills ?? "?"} 掉血比 ${c.ratio ?? "?"}`);

	const foes = (view.foes || []).map(p => `P${p.id} ${p.name}/${p.civ} 人口${p.pop} 兵${(p.classes || {}).Soldier || 0}`).join("；");
	lines.push(`对手 ${foes || "无可见敌对玩家"}`);

	if (e.alerts && e.alerts.length)
		lines.push(`经济告警 ${e.alerts.join(" / ")}`);
	if (e.log && e.log.length)
		lines.push(`经济日志 ${e.log.slice(-2).join(" / ")}`);
	if (view.diag && view.diag.errors && view.diag.errors.length)
		lines.push(`桥接错误 ${view.diag.errors.slice(-2).join(" / ")}`);

	if (verbose && (view.groups || []).length)
		lines.push(`编组 ${view.groups.map(g => `${g.key}:${g.task || g.action}(n${g.n},距${g.d}${g.home != null ? `,离家${g.home}` : ""})`).join(" ")}`);

	return lines.join("\n");
}

/** UI 右侧的告警灯。 */
export function alarms(view)
{
	if (!view)
		return [{ "level": "info", "text": "等待态势帧" }];
	const out = [];
	const e = view.econ || {};
	const threat = e.threatDist != null ? e.threatDist : (view.homeThreat ? view.homeThreat.seen : null);

	if (view.ageMs > 6000)
		out.push({ "level": "bad", "text": `数据断了 ${Math.round(view.ageMs / 1000)} 秒：游戏可能退出或失焦最小化` });
	// 内核自己判定压境时不再喊"建议回防"——它已经在往家走了，要说的是它在做什么
	if (view.guard && view.guard.active)
		out.push({
			"level": "bad",
			"text": `基地被压境：家门口 ${view.guard.foes} 股敌方火力、守军 ${view.guard.ours}，全军回防中`
		});
	else if (threat != null && threat < 60)
		out.push({ "level": "bad", "text": `敌人距家 ${Math.round(threat)} 格，建议回防` });
	if ((view.combat || {}).ratio != null && view.combat.ratio > 0 && view.combat.ratio < 0.7)
		out.push({ "level": "warn", "text": `战损比 ${view.combat.ratio}（掉血更快）` });
	if ((e.civilians ?? view.counts.workers) < 8 && view.simNow > 180)
		out.push({ "level": "warn", "text": `农民只有 ${e.civilians ?? view.counts.workers}，经济起不来` });
	if ((e.bunkered || 0) > 4)
		out.push({ "level": "warn", "text": `${e.bunkered} 人关在建筑里不产资源` });
	// 劳力去向不明 = 副驾在按猜测派人。它不会报错，只会安静地把资源采歪，所以单独立一条灯
	if ((e.untracked || 0) >= 4 && e.workers && e.untracked >= e.workers * 0.5)
		out.push({
			"level": "warn",
			"text": `劳力去向不明 ${e.untracked}/${e.workers} 人：位置证据和下令记录都对不上，` +
				`调度是按份额猜的（跑 econ-trace 看卡点）`
		});
	for (const a of (e.alerts || []).slice(-3))
		out.push({ "level": "warn", "text": a });
	if ((view.my.resources || {}).food < 20 && view.my.pop > 12)
		out.push({ "level": "bad", "text": "粮食快见底" });
	if (!out.length)
		out.push({ "level": "ok", "text": "运营正常" });
	return out;
}
