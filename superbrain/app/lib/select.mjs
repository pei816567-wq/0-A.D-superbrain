/**
 * 实体选择器：把「army / workers / 残兵 / 第 3 军团」这类说法解析成真实实体 id。
 *
 * 大模型不该数实体 id（一帧上千行，还会写错），只该说"全军""自由村民"；
 * 换算在这里做，解析不出就退回最保守的池子并说明原因。
 */

const UNIT_POOLS = ["army", "all", "workers", "idle", "wounded", "bunkered", "structures", "cc"];

export function selectorHint()
{
	return UNIT_POOLS.join(" | ") + " | group:<编组key> | [<id>,<id>] | <id>";
}

export function pickUnits(sel, view)
{
	if (!view)
		return { "ids": [], "note": "还没有态势帧，无法解析单位" };

	const ids = view.ids || {};
	if (Array.isArray(sel))
		return { "ids": sel.map(Number).filter(n => n > 0), "note": `指定 ${sel.length} 个单位` };
	if (typeof sel === "number")
		return { "ids": [sel], "note": `指定单位 ${sel}` };

	const key = String(sel == null || sel === "" ? "army" : sel).toLowerCase();

	if (key.startsWith("group:"))
		return byGroup(key.slice(6), view);

	switch (key)
	{
	case "army":
	case "auto":
	case "military":
	case "军队":
	case "全军":
		return pool(ids.army, "全军");
	case "all":
	case "everything":
		return pool(ids.own, "己方全部可控单位");
	case "workers":
	case "villagers":
	case "村民":
		return pool(ids.workers, "村民");
	case "idle":
		return pool(ids.idleWorkers, "空闲单位");
	case "wounded":
	case "残兵":
		return pool(ids.wounded, "血量低于一半的兵");
	case "bunkered":
	case "garrisoned":
		return pool(ids.bunkered, "驻军中的单位");
	case "structures":
	case "buildings":
		return pool(ids.structures, "己方建筑");
	case "cc":
	case "civic":
		return pool(ids.cc, "主城");
	default:
		if (/^\d+$/.test(key))
			return { "ids": [+key], "note": `指定单位 ${key}` };
		return { "ids": ids.army || [], "note": `选择器「${key}」不认识，按全军处理` };
	}
}

function pool(ids, label)
{
	return { "ids": (ids || []).slice(), "note": `${label} ×${(ids || []).length}` };
}

/**
 * 编组解析：内核导出 groups 时如果带了质心就按距离认领，
 * 没带就退化成全军 —— 宁可下一条粗一点的命令，也不要因为认领不到就拒掉整条指令。
 */
function byGroup(key, view)
{
	const g = (view.groups || []).find(x => String(x.key) === key || String(x.key).endsWith(key));
	if (!g)
		return { "ids": view.ids.army, "note": `找不到编组 ${key}，按全军处理` };

	const at = g.at || g.dest;
	if (!at)
		return { "ids": (view.points.army || []).filter(u => true).slice(0, g.n || 999).map(u => u.id), "note": `编组 ${key} 没导出坐标，取前 ${g.n} 个单位` };

	const radius = (g.range || 42) + 20;
	const near = (view.points.army || []).filter(u => Math.hypot(u.x - at[0], u.z - at[1]) < radius);
	return { "ids": near.map(u => u.id), "note": `编组 ${key} ×${near.length}` };
}

/**
 * 目标实体：敌方用 nearest/weakest/ranged/siege 之类的说法，
 * 己方建筑用 cc/house/field 或裸 id。
 */
export function pickTarget(sel, view, { kind = "foe", from } = {})
{
	if (!view)
		return { "error": "还没有态势帧" };

	if (typeof sel === "number")
		return { "id": sel };
	if (Array.isArray(sel) && sel.length)
		return { "id": Number(sel[0]) };

	const key = String(sel == null ? "nearest" : sel).toLowerCase();
	const origin = from || view.armyCentroid || view.home;
	const foes = view.points.foes || [];

	if (kind === "foe")
	{
		if (!foes.length)
			return { "error": "视野里没有可见敌人" };
		const byDist = list => list.slice().sort((a, b) =>
			Math.hypot(a.x - (origin ? origin.x : 0), a.z - (origin ? origin.z : 0)) -
			Math.hypot(b.x - (origin ? origin.x : 0), b.z - (origin ? origin.z : 0)));

		switch (key)
		{
		case "nearest":
		case "最近":
			return { "id": byDist(foes)[0].id };
		case "weakest":
		{
			const sorted = foes.slice().sort((a, b) => (a.hp || 0) - (b.hp || 0));
			return { "id": sorted[0].id };
		}
		case "ranged":
		case "射手":
			return one(foes.filter(f => f.b === "ranged" || f.b === "hcav" || f.b === "siege"), byDist, "远程");
		case "siege":
		case "攻城":
			return one(foes.filter(f => f.b === "siege"), byDist, "攻城");
		case "cavalry":
		case "骑兵":
			return one(foes.filter(f => f.b === "cav" || f.b === "hcav"), byDist, "骑兵");
		default:
			if (/^\d+$/.test(key))
				return { "id": +key };
			return { "error": `不认识的目标「${key}」` };
		}
	}

	// 己方目标（进驻 / 护卫 / 治疗 / 修理 / 交资源）：建筑优先，也允许点自己的兵
	const buildings = view.points.buildings || [];
	const own = (view.points.army || []).concat(view.points.workers || []);
	if (!buildings.length && !own.length)
		return { "error": "视野里没有己方单位或建筑" };
	if (/^\d+$/.test(key))
		return { "id": +key };
	const re = key === "cc" || key === "home" ? /civil_centre|civic_center|fort_maincenter/ :
		key === "house" ? /house/ :
		key === "field" ? /field/ :
		key === "fort" ? /fort|arsenal|stables|barracks|forge/ :
		null;
	const pool = re ? buildings.filter(b => re.test(String(b.t))) : buildings.concat(own.map(u => ({ "id": u.id, "x": u.x, "z": u.z, "t": "unit" })));
	if (!pool.length)
		return { "error": `找不到「${key}」对应的己方目标` };
	const sorted = origin ? pool.slice().sort((a, b) => Math.hypot(a.x - origin.x, a.z - origin.z) - Math.hypot(b.x - origin.x, b.z - origin.z)) : pool;
	return { "id": sorted[0].id };
}

function one(rows, byDist, label)
{
	if (!rows.length)
		return { "error": `可见敌人里没有${label}` };
	return { "id": byDist(rows)[0].id };
}

/** 目标点：既接受 x/z，也接受 "home" / "foe" / "nearest-foe" 这类语义点。 */
export function pickPoint(sel, view, fallback)
{
	if (sel && typeof sel === "object" && sel.x != null)
		return { "x": +sel.x, "z": +sel.z };
	if (Array.isArray(sel) && sel.length >= 2)
		return { "x": +sel[0], "z": +sel[1] };

	const key = String(sel == null ? "" : sel).toLowerCase();
	switch (key)
	{
	case "home":
	case "base":
	case "家":
		return view.home ? { "x": view.home.x, "z": view.home.z, "label": "主城" } : null;
	case "foe":
	case "enemy":
	case "foe-centroid":
		return view.foeCentroid ? { "x": view.foeCentroid.x, "z": view.foeCentroid.z, "label": "敌军重心" } : null;
	case "foe-home":
	{
		const b = (view.points.buildings || []);
		return b.length ? null : (view.foeCentroid ? { "x": view.foeCentroid.x, "z": view.foeCentroid.z, "label": "敌军重心" } : null);
	}
	default:
		if (fallback)
			return fallback;
		if (/^-?\d+([., ]+-?\d+)$/.test(key))
		{
			const parts = key.split(/[., ]+/).map(Number);
			return { "x": parts[0], "z": parts[1] };
		}
		return null;
	}
}
