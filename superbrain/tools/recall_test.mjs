/**
 * 基地压境 → 全军回防（任务 #7）的离线验证。
 *
 * 实测败因：军队在外线推别人基地，对面分兵回家屠村，等回去只剩村民尸体。
 * 这里盯三件事：
 *   1. 该回才回 —— 家里有火力能扛住（塔/主城）就别把全军拽回来；
 *   2. 回了就别抖 —— 进出用两套阈值 + 最短保持时间，边界上来回切比不回还糟；
 *   3. 优先级最高 —— 外线这一仗算不过来时也要掉头，不能撤向集结点继续送。
 *
 *   node superbrain/tools/recall_test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "mod", "gui", "session", "superbrain_kernel.js"), "utf8");
const Kernel = new Function(src + "\nreturn SuperbrainKernel;")();

const TEMPLATES = {
	"units/kush/infantry_archer_b": {
		health: 50, speed: { walk: 10.3, run: 17.2 },
		resistance: { Damage: { Crush: 10, Hack: 1, Pierce: 1 } },
		visibleIdentityClasses: ["Soldier", "Infantry", "Ranged", "Archer"],
		attack: { Ranged: { maxRange: 60, repeatTime: 1250, Damage: { Pierce: 7.2 } } }
	},
	"units/brit/infantry_spearman_b": {
		health: 100, speed: { walk: 9.5, run: 15.86 },
		resistance: { Damage: { Crush: 15, Hack: 3, Pierce: 3 } },
		visibleIdentityClasses: ["Soldier", "Infantry", "Melee", "Spearman"],
		attack: { Melee: { maxRange: 4, repeatTime: 1000, Damage: { Hack: 4.5 } } }
	},
	// 骚扰屠村的主力：跑得快、血厚、贴脸输出
	"units/brit/cavalry_chooser": {
		health: 200, speed: { walk: 12, run: 19 },
		resistance: { Damage: { Crush: 10, Hack: 2, Pierce: 2 } },
		visibleIdentityClasses: ["Soldier", "Cavalry", "Melee", "Mounted"],
		attack: { Melee: { maxRange: 6, repeatTime: 1000, Damage: { Hack: 9 } } }
	},
	"units/kush/worker_female": {
		health: 60, speed: { walk: 7, run: 10 },
		resistance: { Damage: { Crush: 0, Hack: 0, Pierce: 0 } },
		visibleIdentityClasses: ["Civilian", "Worker", "Female"]
	},
	// 主城自己会射箭：家里有它时，三五个骚扰的不该惊动全军
	"structures/kush/civil_centre": {
		health: 3000, speed: {},
		resistance: { Damage: { Crush: 10, Hack: 5, Pierce: 5 } },
		visibleIdentityClasses: ["Structure", "Civic"],
		attack: { Ranged: { maxRange: 40, repeatTime: 1000, Damage: { Pierce: 12 } } }
	},
	// 不会还手的房子：只用来证明"基地锚点"取的是建筑，而不是必须有个防御塔
	"structures/kush/house": {
		health: 300, speed: {},
		resistance: { Damage: { Crush: 6, Hack: 2, Pierce: 2 } },
		visibleIdentityClasses: ["Structure", "House"]
	}
};

const ctx = { "getTemplate": t => TEMPLATES[t], "log": () => {} };
const HOME = { "x": 40, "z": 60 };

function unit(template, owner, x, z)
{
	const tpl = TEMPLATES[template];
	return {
		"id": ++unit.next, "t": template, "owner": owner, "x": x, "z": z,
		"hp": tpl.health, "maxHp": tpl.health, "seen": owner === 1 ? 3 : 2,
		"enemy": owner !== 1, "idle": false, "holder": 0
	};
}
unit.next = 100;

function scatter(template, owner, count, baseX, baseZ)
{
	const out = [];
	for (let i = 0; i < count; ++i)
		out.push(unit(template, owner, baseX + (i % 5) * 3, baseZ + Math.floor(i / 5) * 3));
	return out;
}

/**
 * 外线会战 + 家门口挨屠的通用战场。
 *   raiders  : 家里可见的敌方骑兵数量
 *   ccHere   : 基地里有没有主城（能还手的火力）
 *   guardHere: 家里有没有己方守军
 *   now      : 仿真秒（滞回按它算）
 */
function world(opts)
{
	const { raiders = 0, ccHere = true, guardHere = 0, now = 0, rally = null, raiderDist = 17, armyX = 170 } = opts;
	const units = [];

	// 基地锚点：两间民房永远在（回防要有个"家"），主城按用例开关
	units.push(unit("structures/kush/house", 1, HOME.x, HOME.z));
	units.push(unit("structures/kush/house", 1, HOME.x + 10, HOME.z));
	units.push(...scatter("units/kush/worker_female", 1, 8, HOME.x + 6, HOME.z + 6));
	if (ccHere)
		units.push(unit("structures/kush/civil_centre", 1, HOME.x, HOME.z));
	if (guardHere)
		units.push(...scatter("units/kush/infantry_archer_b", 1, guardHere, HOME.x + 10, HOME.z));

	// 外线我军（10 弓）与对面主力（24 枪）：这一仗按 winMargin 是算不过来的
	units.push(...scatter("units/kush/infantry_archer_b", 1, 10, armyX, 60));
	units.push(...scatter("units/brit/infantry_spearman_b", 2, 24, armyX + 26, 60));

	// 家门口的骚扰队（默认贴着基地，宽度用例里会把它们推到判定窗之外）
	if (raiders)
		units.push(...scatter("units/brit/cavalry_chooser", 2, raiders, HOME.x + raiderDist, HOME.z));

	return { "now": now, "me": 1, "units": units, "formations": ["line", "box"], "rally": rally, "objective": null };
}

/** 跑一拍，把内核状态 + 命令一起收回来看。 */
function probe(k, opts)
{
	const out = k.plan(world(opts));
	const groups = (out.summary || []).map(g => ({
		"key": g.key, "task": g.task, "home": g.home, "n": g.n, "at": g.at, "dest": g.dest
	}));
	const marches = (out.ops || []).filter(op =>
		op.op === "walk" || op.op === "attack-walk").map(op => ({ "op": op.op, "x": op.x, "z": op.z, "n": op.entities.length }));
	return { "guard": out.guard, "groups": groups, "marches": marches, "fight": out.fight };
}

const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** 每个回防组的目的地都必须比它现在的位置更靠近基地。 */
function headingHome(res)
{
	const home = res.guard.home;
	const rows = res.groups.filter(g => g.task === "return" && g.dest);
	return rows.length > 0 && rows.every(g => d2(g.dest, home) < d2(g.at, home) - 1);
}

const problems = [];
function check(name, cond, detail)
{
	if (!cond)
		problems.push(`${name}${detail ? " —— " + JSON.stringify(detail) : ""}`);
	console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${cond ? "" : " " + JSON.stringify(detail || {})}`);
}

const k = new Kernel(ctx);
k.configure({ "maxOpsPerTick": 40, "engageRadius": 90, "judgeRadius": 140 });

// ---------------------------------------------------------------- 1. 该回才回

const calm = probe(k, { "raiders": 0 });
check("家里没事 → 不回防", calm.guard && calm.guard.active === false, calm.guard);
check("家里没事 → 没有组领回防令", calm.groups.every(g => g.task !== "return"), calm.groups);

const fresh = new Kernel(ctx);
fresh.configure({ "maxOpsPerTick": 40, "engageRadius": 90, "judgeRadius": 140 });
const nuisance = probe(fresh, { "raiders": 5, "ccHere": true });
check("有主城守着，5 骑骚扰不惊动全军", nuisance.guard.active === false, nuisance.guard);

const naked = probe(fresh, { "raiders": 5, "ccHere": false, "now": 60 });
check("只有一群村民 → 判定压境", naked.guard.active === true, naked.guard);
check("压境时外线组全部掉头", naked.groups.length > 0 && naked.groups.every(g => g.task === "return"), naked.groups);
check("掉头走 attack-walk（沿途被拦能打）", naked.marches.some(m => m.op === "attack-walk" && m.n >= 5), naked.marches);
// 目的地必须比出发点更接近基地，否则是在往外线钻
check("回防方向朝基地（不是继续往前推）", headingHome(naked), naked.groups);

// 集结点在前线时，"回家"必须回主城，不是往 rally 上凑
const forward = probe(fresh, { "raiders": 5, "ccHere": false, "rally": { "x": 170, "z": 60 } });
check("rally 在前线时回防锚点仍是基地", forward.guard.active &&
	Math.hypot(forward.guard.home[0] - HOME.x, forward.guard.home[1] - HOME.z) < 8, forward.guard);

// ------------------------------------------------------------------ 2. 滞回

const osc = new Kernel(ctx);
osc.configure({ "maxOpsPerTick": 40, "engageRadius": 90, "judgeRadius": 140, "ccHere": false });
let step1 = probe(osc, { "raiders": 5, "ccHere": false, "now": 100 });
check("5 骑压境 → 进入回防", step1.guard.active === true, step1.guard);
// 掉到 2 骑（exit=1 与 enter=3 之间）：不能一解除就前功尽弃
let step2 = probe(osc, { "raiders": 2, "ccHere": false, "now": 102 });
check("剩 2 骑（低于进入阈值）仍保持回防", step2.guard.active === true, step2.guard);
// 家里彻底安全了，但没到 homeDwell，也不该立刻放人
let step3 = probe(osc, { "raiders": 0, "ccHere": false, "now": 105 });
check("刚安全就解除 = 抖动，应当撑到 dwell", step3.guard.active === true, step3.guard);
// 超过 15 秒才解除
let step4 = probe(osc, { "raiders": 0, "ccHere": false, "now": 130 });
check("保持满 homeDwell 后解除", step4.guard.active === false, step4.guard);
check("解除后不再领回防令", step4.groups.every(g => g.task !== "return"), step4.groups);

// ------------------------------------------------- 3. 优先级 & 到位的组不乱动

const inside = new Kernel(ctx);
inside.configure({ "maxOpsPerTick": 40, "engageRadius": 90, "judgeRadius": 140 });
// 家里放 2 个守军：打不过 12 骑（仍算压境），但它们自己已在防线上
const siege = probe(inside, { "raiders": 12, "ccHere": false, "guardHere": 2, "now": 200 });
check("大部队压境 → 判定回防", siege.guard.active === true, siege.guard);
check("已到防线的组不领回防令（留在原地打）", siege.groups.some(g => g.task !== "return" && g.home <= 26), siege.groups);
check("外线的组领回防令", siege.groups.some(g => g.task === "return" && g.home > 26), siege.groups);

// 外线这一仗本来就算不过来（10 弓 vs 24 枪），回防必须盖过"往集结点撤"
check("外线判定打不动（用例前提成立）", siege.fight.fight === false, siege.fight);
check("算不过来时依然优先回防", siege.groups.filter(g => g.home > 26).every(g => g.task === "return"), siege.groups);

// ---------------------------------------------------- 判定窗与压境窗的宽度关系

// 真机踩过的坑：homeThreatRadius 抬到比 judgeRadius 大时，压境数看得见、
// 交换比却按空场算（exchange=0），回防被静默关掉。训练搜索空间能把半径采样到 120，随时会撞上
const wide = new Kernel(ctx);
wide.configure({ "maxOpsPerTick": 40, "engageRadius": 90, "judgeRadius": 110, "homeThreatRadius": 150 });
// 军队在 290 格外，家里只有 2 个守军，4 骑压在 132 格（判定窗 110 之外、压境窗 150 之内）
const beyond = probe(wide, { "raiders": 4, "ccHere": false, "guardHere": 2, "raiderDist": 132, "armyX": 330, "now": 400 });
check("敌人压在判定窗之外、压境窗之内时仍然回防",
	beyond.guard.active === true && beyond.guard.foes === 4 && beyond.guard.exchange > 0, beyond.guard);
check("这种场合也确实掉头", beyond.groups.some(g => g.task === "return" && g.home > 200), beyond.groups);

// ------------------------------------------------------------------- 4. 开关

const off = new Kernel(ctx);
off.configure({ "maxOpsPerTick": 40, "engageRadius": 90, "judgeRadius": 140, "homeGuard": false });
const offRun = probe(off, { "raiders": 12, "ccHere": false, "now": 300 });
check("homeGuard=false 时完全不回防", offRun.guard.active === false &&
	offRun.groups.every(g => g.task !== "return"), offRun.guard);

// 兵全死光的拍也要照常导出判定：控制台靠它区分"没人可派"和"家里没事"
const dead = new Kernel(ctx);
dead.configure({ "maxOpsPerTick": 40, "engageRadius": 90, "judgeRadius": 140 });
const w0 = world({ "raiders": 8, "ccHere": false, "now": 700 });
w0.units = w0.units.filter(u => u.owner !== 1 || !TEMPLATES[u.t].attack);   // 去掉己方全部武装
const deadRun = dead.plan(w0);
check("没有军事单位时仍然带回防判定", !!deadRun.guard && deadRun.note === "no military" && deadRun.guard.active === true,
	{ "note": deadRun.note, "guard": deadRun.guard });

if (problems.length)
{
	console.error(`\nFAIL: ${problems.length} 项`);
	process.exit(1);
}
console.log("\nOK: 回防判定、滞回、优先级与开关全部成立");
