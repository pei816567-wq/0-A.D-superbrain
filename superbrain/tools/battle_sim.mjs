/**
 * 微操内核离线对拍：同一批兵，一套由内核指挥，一套按"扑 nearest、站桩换血"的
 * 朴素打法指挥（Petra 在会战里基本就是这个水平）。比的是战损比，不是主观感受。
 *
 * 数值取自实机 GetTemplateData 导出（static-000004.json），伤害模型 0.9^护甲。
 *
 *   node superbrain/tools/battle_sim.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "mod", "gui", "session", "superbrain_kernel.js"), "utf8");

const Kernel = new Function(src + "\nreturn SuperbrainKernel;")();

const TEMPLATES = {
	"units/kush/infantry_archer_b": {
		health: 50,
		speed: { walk: 10.3, run: 17.2 },
		resistance: { Damage: { Crush: 10, Hack: 1, Pierce: 1 } },
		visibleIdentityClasses: ["Soldier", "Infantry", "Ranged", "Archer"],
		attack: { Ranged: { maxRange: 60, repeatTime: 1250, Damage: { Pierce: 7.2 } } }
	},
	"units/kush/infantry_spearman_b": {
		health: 100,
		speed: { walk: 9.5, run: 15.86 },
		resistance: { Damage: { Crush: 15, Hack: 3, Pierce: 3 } },
		visibleIdentityClasses: ["Soldier", "Infantry", "Melee", "Spearman"],
		attack: { Melee: { maxRange: 4, repeatTime: 1000, Damage: { Hack: 4.5, Pierce: 4 } } }
	},
	"units/kush/cavalry_javelineer_b": {
		health: 100,
		speed: { walk: 16.2, run: 22.68 },
		resistance: { Damage: { Crush: 15, Hack: 2, Pierce: 1 } },
		visibleIdentityClasses: ["Soldier", "Cavalry", "Ranged", "Javelineer"],
		attack: { Ranged: { maxRange: 30, repeatTime: 1500, Damage: { Pierce: 18 } } }
	},
	"units/brit/infantry_spearman_b": {
		health: 100,
		speed: { walk: 9.5, run: 15.86 },
		resistance: { Damage: { Crush: 12, Hack: 2, Pierce: 2 } },
		visibleIdentityClasses: ["Soldier", "Infantry", "Melee", "Spearman"],
		attack: { Melee: { maxRange: 4, repeatTime: 1000, Damage: { Hack: 4, Pierce: 3.5 } } }
	},
	"units/brit/infantry_archer_b": {
		health: 50,
		speed: { walk: 10.3, run: 17.2 },
		resistance: { Damage: { Crush: 10, Hack: 1, Pierce: 1 } },
		visibleIdentityClasses: ["Soldier", "Infantry", "Ranged", "Archer"],
		attack: { Ranged: { maxRange: 50, repeatTime: 1500, Damage: { Pierce: 6 } } }
	}
};

const ctx = { getTemplate: t => TEMPLATES[t] };

function makeUnit(template, owner, x, z, id)
{
	const t = TEMPLATES[template];
	const atk = t.attack.Ranged || t.attack.Melee;
	return {
		id,
		t: template,
		owner,
		x,
		z,
		hp: t.health,
		maxHp: t.health,
		seen: owner === 1 ? 3 : 2,
		enemy: owner !== 1,
		range: atk.maxRange,
		cd: atk.repeatTime / 1000,
		damage: atk.Damage,
		armor: t.resistance.Damage,
		speed: t.speed.run,
		ranged: atk.maxRange >= 10,
		cool: 0,
		target: null,
		dest: null
	};
}

/** 与内核同一套伤害公式，但这里是"引擎"，内核看不到它。 */
function damageOf(attacker, target)
{
	let sum = 0;
	for (const kind in attacker.damage)
		sum += attacker.damage[kind] * Math.pow(0.9, target.armor[kind] || 0);
	return sum;
}

function step(units, dt)
{
	for (const u of units)
	{
		if (u.hp <= 0)
			continue;

		if (u.dest)
		{
			const dx = u.dest.x - u.x;
			const dz = u.dest.z - u.z;
			const d = Math.hypot(dx, dz);
			const go = u.speed * dt;
			if (d <= go)
			{
				u.x = u.dest.x;
				u.z = u.dest.z;
				u.dest = null;
			}
			else
			{
				u.x += (dx / d) * go;
				u.z += (dz / d) * go;
			}
		}

		u.cool -= dt;
		if (u.cool > 0)
			continue;

		const alive = units.filter(e => e.hp > 0 && e.owner !== u.owner);
		let target = alive.find(e => e.id === u.target);
		if (!target || Math.hypot(target.x - u.x, target.z - u.z) > u.range + 2)
		{
			// 没有有效目标时自动就近开火（相当于 aggressive 姿态）
			target = alive
				.map(e => ({ e, d: Math.hypot(e.x - u.x, e.z - u.z) }))
				.filter(o => o.d <= u.range + 2)
				.sort((a, b) => a.d - b.d)[0];
			target = target && target.e;
			u.target = target && target.id;
		}

		if (target)
		{
			target.hp -= damageOf(u, target);
			u.cool = u.cd;
			if (target.hp <= 0)
				u.target = null;
		}
		else
			u.cool = 0.2;
	}
}

function snapshotWorld(units, now)
{
	return {
		now,
		me: 1,
		formations: ["line", "box", "wedge", "column"],
		units: units.filter(u => u.hp > 0).map(u => ({
			id: u.id, t: u.t, owner: u.owner, x: round(u.x), z: round(u.z),
			hp: round(u.hp, 1), maxHp: u.maxHp, seen: u.seen, enemy: u.enemy
		}))
	};
}

const round = (v, n = 1) => +(v).toFixed(n);

/** 朴素打法：全军 attack-move 敌方质心，到位就站桩互砍（不风筝、不集火）。 */
function naiveControl(units)
{
	for (const u of units.filter(e => e.owner === 1 && e.hp > 0))
	{
		const foes = units.filter(e => e.owner !== 1 && e.hp > 0);
		if (!foes.length)
			return;
		const nearest = foes
			.map(e => ({ e, d: Math.hypot(e.x - u.x, e.z - u.z) }))
			.sort((a, b) => a.d - b.d)[0];
		if (nearest.d > u.range)
			u.dest = { x: nearest.e.x, z: nearest.e.z };
		else
		{
			u.dest = null;
			u.target = nearest.e.id;
		}
	}
}

/** 敌方按 Petra 的路子打：整体朝我方质心推，够着了就打，不风筝也不转火。 */
function enemyAdvance(units)
{
	const ours = units.filter(u => u.owner === 1 && u.hp > 0);
	if (!ours.length)
		return;
	let cx = 0;
	let cz = 0;
	for (const u of ours)
	{
		cx += u.x;
		cz += u.z;
	}
	cx /= ours.length;
	cz /= ours.length;

	for (const e of units.filter(u => u.owner === 2 && u.hp > 0))
	{
		let near = null;
		let bestD = 1e9;
		for (const u of ours)
		{
			const d = Math.hypot(u.x - e.x, u.z - e.z);
			if (d < bestD)
			{
				bestD = d;
				near = u;
			}
		}
		if (bestD > e.range)
			e.dest = { x: cx, z: cz };
		else
		{
			e.dest = null;
			e.target = near.id;
		}
	}
}

function army(spec, baseX, owner, idStart)
{
	let id = idStart;
	const out = [];
	for (const [template, count] of spec)
		for (let i = 0; i < count; ++i)
		{
			const col = i % 6;
			const row = Math.floor(i / 6);
			out.push(makeUnit(template, owner, baseX + col * 4, 60 + row * 4 + (owner === 2 ? 60 : 0), id++));
		}
	return out;
}

/** 风筝质量统计：远程单位贴脸（<50% 射程）的时间占比越低越好。 */
function trackKiting(units, stats)
{
	const ranged = units.filter(u => u.owner === 1 && u.hp > 0 && u.ranged);
	const foes = units.filter(u => u.owner === 2 && u.hp > 0);
	if (!ranged.length || !foes.length)
		return;

	for (const u of ranged)
	{
		let d = 1e9;
		for (const f of foes)
			d = Math.min(d, Math.hypot(f.x - u.x, f.z - u.z));
		if (d > 120)
			continue;
		++stats.ticks;
		if (d < stats.minD)
			stats.minD = d;
		if (d < u.range * 0.5)
			++stats.stuck;
	}
}

export function run(scenario, { ticks = 4000, dt = 0.1, brain = true, cfg = {} } = {})
{
	const ours = army(scenario.ours, 20, 1, 100)
		// 分兵场景：第二队放在 70 格外（>clusterRadius），才会真的裂成两个军团
		.concat(scenario.ours2 ? army(scenario.ours2, 90, 1, 400) : []);
	const foes = army(scenario.foes, 170, 2, 900);
	const units = ours.concat(foes);
	const ourHp0 = ours.reduce((a, u) => a + u.maxHp, 0);
	const foeHp0 = foes.reduce((a, u) => a + u.maxHp, 0);

	const kernel = brain ? new Kernel(ctx) : null;
	if (kernel)
	{
		kernel.configure(Object.assign({ moveCooldown: 0.6, retargetCooldown: 0.7 }, cfg));
		kernel.lastIssue = -99;
	}

	let lastFight = null;
	let now = 0;
	const stats = { ticks: 0, stuck: 0, minD: 1e9, dupKeys: 0, maxGroups: 0 };
	for (let i = 0; i < ticks; ++i)
	{
		now += dt;

		if (kernel)
		{
			const world = snapshotWorld(units, now);
			const res = kernel.plan(world);
			if (!lastFight || !lastFight.foes) lastFight = res.fight;
			// 编组 key 必须每帧内唯一：撞了就说明两组在共用同一份移动/姿态记忆
			// （plan 的 summary 就是编组行数组，桥接层把它原样导出成 kernel.groups）
			const keys = (Array.isArray(res.summary) ? res.summary : []).map(g => g.key);
			stats.maxGroups = Math.max(stats.maxGroups, keys.length);
			if (new Set(keys).size !== keys.length)
				++stats.dupKeys;
			for (const op of res.ops)
			{
				if (op.op === "walk" || op.op === "attack-walk")
				{
					for (const id of op.entities)
					{
						const u = units.find(e => e.id === id);
						if (u)
							u.dest = { x: op.x, z: op.z };
					}
				}
				else if (op.op === "attack")
				{
					for (const id of op.entities)
					{
						const u = units.find(e => e.id === id);
						if (u)
							u.target = op.target;
					}
				}
			}
		}
		else
			naiveControl(units);

		enemyAdvance(units);
		trackKiting(units, stats);
		step(units, dt);

		const aliveOurs = units.filter(u => u.owner === 1 && u.hp > 0).length;
		const aliveFoes = units.filter(u => u.owner === 2 && u.hp > 0).length;
		if (!aliveOurs || !aliveFoes)
			break;
	}

	const hurt = owner => units.filter(u => u.owner === owner)
		.reduce((a, u) => a + Math.max(0, u.maxHp - Math.max(0, u.hp)), 0);
	const alive = owner => units.filter(u => u.owner === owner && u.hp > 0).length;
	const lost = owner => units.filter(u => u.owner === owner).length - alive(owner);

	const oursLostHp = hurt(1);
	const foesLostHp = hurt(2);

	return {
		seconds: +now.toFixed(1),
		aliveOurs: alive(1),
		lostFoes: lost(2),
		exchange: +(foesLostHp / Math.max(oursLostHp, 1)).toFixed(2),
		// 净战果 = 打掉对面多少血 - 自己掉了多少血（都按初始血量归一）。
		// 只看交换比会奖励"缩在城里不出手"，这个指标同时惩罚送兵和逃跑。
		net: +((foesLostHp / foeHp0 - oursLostHp / ourHp0) * 100).toFixed(1),
		stuckPct: stats.ticks ? +(100 * stats.stuck / stats.ticks).toFixed(1) : 0,
		minDist: stats.ticks ? +stats.minD.toFixed(1) : null,
		dupKeys: stats.dupKeys,
		maxGroups: stats.maxGroups,
		fight: lastFight,
		won: alive(2) === 0 && alive(1) > 0
	};
}

const scenarios = {
	"远程对近战（12 弓 + 4 枪 + 2 投矛骑 vs 20 枪）": {
		ours: [["units/kush/infantry_archer_b", 12], ["units/kush/infantry_spearman_b", 4], ["units/kush/cavalry_javelineer_b", 2]],
		foes: [["units/brit/infantry_spearman_b", 20]]
	},
	"对等弓兵遭遇（12 vs 12）": {
		ours: [["units/kush/infantry_archer_b", 12]],
		foes: [["units/brit/infantry_archer_b", 12]]
	},
	"劣势兵力（8 弓 vs 16 枪）": {
		ours: [["units/kush/infantry_archer_b", 8]],
		foes: [["units/brit/infantry_spearman_b", 16]]
	},
	"纯近战（16 枪 vs 16 枪）": {
		ours: [["units/kush/infantry_spearman_b", 16]],
		foes: [["units/brit/infantry_spearman_b", 16]]
	},
	// 两支分兵：唯一能验证"编组身份不串"的场景
	"分兵两路（12 弓 + 8 枪隔 70 格 vs 14 枪）": {
		ours: [["units/kush/infantry_archer_b", 12]],
		ours2: [["units/kush/infantry_spearman_b", 8]],
		foes: [["units/brit/infantry_spearman_b", 14]]
	}
};

let failures = 0;
let sawMultiGroup = false;
for (const [name, scenario] of Object.entries(scenarios))
{
	const ai = run(scenario, { brain: true });
	const dumb = run(scenario, { brain: false });
	const delta = ai.net - dumb.net;
	if (delta <= 0)
		++failures;
	if (ai.dupKeys)
	{
		++failures;
		console.log(`  FAIL 编组 key 撞车 ${ai.dupKeys} 帧（两组共用一份移动记忆）`);
	}
	if (ai.maxGroups >= 2)
		sawMultiGroup = true;

	const line = r => `剩 ${r.aliveOurs}  杀 ${r.lostFoes}  净战果 ${r.net}%  战损比 ${r.exchange}  贴脸 ${r.stuckPct}%  最近 ${r.minDist}${r.fight ? '  判定=' + (r.fight.fight ? '打' : '撤') + '(交换' + r.fight.exchange + '/射程' + r.fight.rangeEdge + ')' : ''}  ${r.seconds}s 胜=${r.won}`;
	console.log(`\n${name}`);
	console.log(`  内核   ${line(ai)}`);
	console.log(`  朴素   ${line(dumb)}`);
	console.log(`  净战果提升   ${(delta >= 0 ? "+" : "") + delta.toFixed(1)} 个百分点`);
}

if (!sawMultiGroup)
{
	++failures;
	console.log("\nFAIL: 没有任何场景出现过多军团，编组 key 唯一性断言是空跑的");
}
console.log(failures ? `\nFAIL: ${failures} 个场景里内核没有打过朴素打法，或编组唯一性不成立` : "\nOK: 全部场景内核优于朴素打法，且编组 key 每帧唯一");
process.exit(failures ? 1 : 0);
