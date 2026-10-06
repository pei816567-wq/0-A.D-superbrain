/**
 * 状态帧 → 视图模型。
 *
 * 桥接层为了省盘把实体表压成了「fields + 定长数组」，这里解回来并按用途分池。
 * 兵种分桶是显示用的近似（真正影响配比的是 mod 内经济内核的 g_SuperbrainShares），
 * 两边口径不同是有意的：这里只回答"我场上现在有什么"。
 */

export const CIVILIAN_HINTS = ["villager", "worker", "civilian", "support", "merchant", "fishing", "craftsman", "trader"];
export const MILITARY_HINTS = ["infantry", "cavalry", "archer", "spearman", "swordman", "pikeman", "javelin",
	"camel", "chariot", "hero", "warship", "trireme", "bireme", "siege", "catapult", "ballista", "ram", "tower",
	"monreme", "dromon", "slinger", "horse_archer", "war_dog", "elephant"];

const BUCKET_RULES = [
	["siege", /siege|catapult|ballista|ram|tower/],
	["hcav", /cavalry_(archer|javelineer|horse)|horse_archer|camel_(archer|javelin)|mounted_archer/],
	["cav", /cavalry|camel|chariot|elephant/],
	["ranged", /archer|javelin|slinger|bow|slingshot/],
	["pikeman", /spearman|pikeman|pike/],
	["sword", /sword|mace/],
	["hero", /hero/]
];

export function isStructure(template)
{
	return typeof template === "string" && template.indexOf("structures/") >= 0;
}

export function isMilitary(template)
{
	const t = String(template || "").toLowerCase();
	if (!t || isStructure(t))
		return false;
	if (CIVILIAN_HINTS.some(h => t.indexOf(h) >= 0))
		return false;
	return MILITARY_HINTS.some(h => t.indexOf(h) >= 0);
}

export function bucketOf(template)
{
	const t = String(template || "").toLowerCase();
	for (const [name, re] of BUCKET_RULES)
		if (re.test(t))
			return name;
	return "other";
}

export function decodeEntities(frame)
{
	const fields = frame.fields || [];
	const out = [];
	for (const row of frame.entities || [])
	{
		const e = {};
		for (let i = 0; i < fields.length; ++i)
			e[fields[i]] = row[i];
		e.tpl = String(e.template || "");
		e.structure = isStructure(e.tpl);
		e.military = isMilitary(e.tpl);
		e.bucket = bucketOf(e.tpl);
		out.push(e);
	}
	return out;
}

function centroid(rows)
{
	if (!rows.length)
		return null;
	let x = 0;
	let z = 0;
	for (const r of rows)
	{
		x += r.x;
		z += r.z;
	}
	return { "x": x / rows.length, "z": z / rows.length };
}

function dist(a, b)
{
	return a && b ? Math.hypot(a.x - b.x, a.z - b.z) : null;
}

function tally(rows, key)
{
	const out = {};
	for (const r of rows)
	{
		const k = typeof key === "function" ? key(r) : r[key];
		out[k] = (out[k] || 0) + 1;
	}
	return out;
}

const RES_KEYS = ["food", "wood", "stone", "metal"];

/**
 * 一帧 → 一份能同时喂给 UI、简报和大模型的视图。
 * 只保留决策要用的量，几百 KB 的实体表压到几百个点。
 */
export function viewOf(frame, { mapPoints = 500 } = {})
{
	if (!frame)
		return null;

	const ents = decodeEntities(frame);
	const me = String(frame.me);
	const own = ents.filter(e => e.seen === 3);
	const structures = own.filter(e => e.structure);
	const units = own.filter(e => !e.structure);
	const army = units.filter(u => u.military && !u.holder);
	const bunkered = units.filter(u => u.military && u.holder);
	const workers = units.filter(u => !u.military && !u.holder);
	const cagedWorkers = units.filter(u => !u.military && u.holder);
	const foesSeen = ents.filter(e => e.seen === 2 && e.enemy && !e.structure);
	const foeStructures = ents.filter(e => e.seen === 2 && e.enemy && e.structure);
	const lastKnown = ents.filter(e => e.seen === 1 && e.enemy);

	const cc = structures.find(s => /civil_centre|civic_center|fort_maincenter/.test(s.tpl)) || structures[0];
	const home = cc ? { "x": cc.x, "z": cc.z } : centroid(structures);
	const armyC = centroid(army);
	const foeC = centroid(foesSeen);
	const wounded = army.filter(u => u.maxHp > 0 && u.hp / u.maxHp < 0.5);
	const idleWorkers = workers.filter(u => u.idle);

	const players = [];
	for (const idStr in frame.players || {})
	{
		const p = frame.players[idStr];
		if (!p)
			continue;
		const res = {};
		for (const r of RES_KEYS)
			res[r] = Math.round((p.resources || {})[r] || 0);
		players.push({
			"id": +idStr === +idStr ? +idStr : idStr,
			"key": idStr,
			"mine": idStr === me,
			"name": p.name || `P${idStr}`,
			"civ": p.civ,
			"color": p.color,
			"state": p.state,
			"dead": String(p.state).toLowerCase().indexOf("defeat") >= 0,
			"pop": p.pop || 0,
			"popCap": p.popCap || 0,
			"phase": p.phase,
			"resources": res,
			"classes": p.classes || {},
			"techs": (p.techs || []).length,
			"enemy": !!p.enemy,
			"ally": !!p.ally
		});
	}

	const foes = players.filter(p => p.enemy && !p.dead && String(p.name) !== "Gaia");
	const myPlayer = players.find(p => p.mine) || players[0] || {};

	return {
		"seq": frame.seq,
		"wall": frame.wall,
		"ageMs": Math.max(0, Date.now() - (frame.wall || 0)),
		"simNow": frame.now || 0,
		"simRate": frame.simRate,
		"me": frame.me,
		"autopilot": !!frame.autopilot,
		"economyOn": !!frame.economy,
		"dir": frame.dir || null,

		"my": {
			"name": myPlayer.name,
			"civ": myPlayer.civ,
			"pop": myPlayer.pop || 0,
			"popCap": myPlayer.popCap || 0,
			"phase": myPlayer.phase,
			"resources": (myPlayer.resources) || {},
			"techs": myPlayer.techs || 0,
			"classes": myPlayer.classes || {},
			"state": myPlayer.state
		},

		"counts": {
			"ownRows": own.length,
			"army": army.length,
			"workers": workers.length,
			"idleWorkers": idleWorkers.length,
			"bunkered": bunkered.length + cagedWorkers.length,
			"structures": structures.length,
			"foesSeen": foesSeen.length,
			"foeStructures": foeStructures.length,
			"lastKnown": lastKnown.length
		},

		"composition": tally(army, "bucket"),
		"foeComposition": tally(foesSeen, "bucket"),
		"armyHp": army.length ? Math.round(army.reduce((s, u) => s + (u.maxHp > 0 ? u.hp / u.maxHp : 1), 0) / army.length * 100) / 100 : 1,

		"home": home,
		"armyCentroid": armyC,
		"foeCentroid": foeC,
		"homeThreat": home ? {
			"seen": minDist(home, foesSeen),
			"last": minDist(home, lastKnown)
		} : null,
		// 内核的"基地压境"判定（active = 全军已在回防路上），见 superbrain_kernel.js homeGuard
		"guard": (frame.kernel && frame.kernel.guard) || null,
		"armyToHome": dist(armyC, home),
		"armyToFoe": dist(armyC, foeC),

		// 选择器（army/workers/…）解析成实体 id 用的池子，见 lib/select.mjs
		"ids": {
			"army": army.map(u => u.id),
			"wounded": wounded.map(u => u.id),
			"bunkered": bunkered.concat(cagedWorkers).map(u => u.id),
			"workers": workers.map(u => u.id),
			"idleWorkers": idleWorkers.map(u => u.id),
			"own": own.map(u => u.id),
			"structures": structures.map(u => u.id),
			"cc": cc ? [cc.id] : [],
			"foes": foesSeen.map(u => u.id),
			"lastKnown": lastKnown.map(u => u.id)
		},

		// 需要按距离挑目标时用的带坐标样本（不要把上千行实体表塞进浏览器）
		"points": {
			"army": sample(army, 300).map(u => ({ "id": u.id, "x": u.x, "z": u.z, "hp": u.hp, "maxHp": u.maxHp, "b": u.bucket })),
			"foes": sample(foesSeen, 300).map(u => ({ "id": u.id, "x": u.x, "z": u.z, "hp": u.hp, "owner": u.owner, "b": u.bucket })),
			"buildings": structures.map(s => ({ "id": s.id, "x": s.x, "z": s.z, "t": s.tpl, "owner": s.owner })),
			"workers": sample(workers, 200).map(u => ({ "id": u.id, "x": u.x, "z": u.z, "idle": !!u.idle })),
			"bunkered": bunkered.concat(cagedWorkers).map(u => ({ "id": u.id, "holder": u.holder }))
		},

		"groups": (frame.kernel && frame.kernel.groups) || [],
		"fight": (frame.kernel && frame.kernel.fight) || null,
		"kernel": frame.kernel || null,
		"econ": frame.econ || null,
		"combat": frame.combat || null,
		"cfg": frame.cfg || null,
		"econCfg": frame.econCfg || null,
		"applied": frame.applied || null,
		"players": players,
		"foes": foes,
		"diag": frame.diag || null,
		"probe": frame.probe || null,

		"map": {
			"own": sample(army, mapPoints / 2).map(u => [Math.round(u.x), Math.round(u.z), u.bucket === "cav" || u.bucket === "hcav" ? 1 : 0]),
			"workers": sample(workers, 120).map(u => [Math.round(u.x), Math.round(u.z)]),
			"structures": structures.map(s => [Math.round(s.x), Math.round(s.z), /civil_centre|civic_center/.test(s.tpl) ? 2 : 1]),
			"foes": sample(foesSeen, mapPoints / 3).map(u => [Math.round(u.x), Math.round(u.z)]),
			"last": sample(lastKnown, 120).map(u => [Math.round(u.x), Math.round(u.z)]),
			"objective": frame.kernel && frame.kernel.objective ? [frame.kernel.objective.x, frame.kernel.objective.z] : null
		},

		"raw": frame
	};
}

function minDist(from, rows)
{
	let best = null;
	for (const r of rows)
	{
		const d = Math.hypot(from.x - r.x, from.z - r.z);
		if (best === null || d < best)
			best = d;
	}
	return best === null ? null : Math.round(best);
}

function sample(rows, n)
{
	if (rows.length <= n)
		return rows;
	const stride = rows.length / n;
	const out = [];
	for (let i = 0; i < n; ++i)
		out.push(rows[Math.floor(i * stride)]);
	return out;
}

/** 训练模式判胜负：我方被判定 = 负，可见敌人全灭 = 胜。 */
export function outcome(view)
{
	if (!view)
		return { "over": false };
	const me = view.players.find(p => p.mine);
	if (me && me.dead)
		return { "over": true, "win": false, "reason": "我方被击败" };
	const foes = view.foes.filter(f => f.pop > 0 || f.classes.Soldier > 0);
	if (foes.length && foes.every(f => f.dead))
		return { "over": true, "win": true, "reason": "敌方全灭" };
	if (view.my.pop === 0 && (view.counts.army || 0) === 0 && view.simNow > 60)
		return { "over": true, "win": false, "reason": "全军无人（判负）" };
	return { "over": false };
}
