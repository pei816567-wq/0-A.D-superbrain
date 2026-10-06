/**
 * 高级旋钮 → 内核真实参数包。
 *
 * UI 上只有「攻击欲望 0.7 / 防守 / 经济优先 / 打 brit」这种说法，
 * 落到游戏里必须是一组具体阈值；这层映射是唯一允许改内核参数的地方，
 * 这样训练模式搜索参数空间和玩家手动旋钮走的是同一条路径。
 *
 * 注意两条已踩过的坑：
 *   - 军事侧 civilianDanger 和经济侧 unloadThreat 必须留宽带，否则一个关人一个放人会来回弹；
 *     所有姿态都保持 garrisonCivilians=false（被骚扰时村民走开，不失踪）。
 *   - resistBase/winMargin 是"打得过才打"的阈值，调高不等于更强，只等于更愿意接战。
 */

export const POSTURES = ["defend", "balanced", "attack"];
export const ECON_MODES = ["boom", "balanced", "war"];
export const DOCTRINES = ["field", "hold", "push", "harass", "retreat"];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = v => Math.round(v * 100) / 100;

/** 攻击欲望 0..1：从"绝不接战"到"贴着打"。 */
export function aggressionPatch(a)
{
	const v = clamp(+a || 0, 0, 1);
	return {
		"resistBase": r2(0.75 + v * 0.5),
		"winMargin": r2(0.7 + v * 0.8),
		"pushGrit": r2(0.35 + v * 0.85),
		"edgeMargin": r2(0.98 + v * 0.28),
		"engageRadius": Math.round(40 + v * 70),
		"judgeRadius": Math.round(clamp(110, 90, 40 + v * 70 + 45)),
		"maxChase": Math.round(40 + v * 80),
		"standoff": r2(0.86 - v * 0.13),
		"retreatHp": r2(0.42 - v * 0.14),
		"attackStructures": v >= 0.7,
		"kite": v < 0.95
	};
}

export function posturePatch(name)
{
	switch (name)
	{
	case "defend":
		return {
			"doctrine": "hold",
			"micro": Object.assign(aggressionPatch(0.25), {
				"civilianDanger": 55,
				"maxGroups": 4,
				"holdStance": "standground",
				// 守家姿态下压境判定更敏感，且解除得更慢
				"homeThreatEnter": 2,
				"homeThreatExit": 1,
				"homeDwell": 20
			}),
			"econ": { "armyShare": 0.45, "armyPopShare": 0.28, "unloadThreat": 120, "unloadWait": 8 }
		};
	case "attack":
		return {
			"doctrine": "push",
			"micro": Object.assign(aggressionPatch(0.85), {
				"civilianDanger": 38,
				"maxGroups": 6,
				"attackStructures": true,
				// 全力进攻时别被三五个散兵拽回家：阈值抬高、保持时间缩短
				"homeThreatEnter": 5,
				"homeThreatExit": 2,
				"homeDwell": 10
			}),
			"econ": { "armyShare": 0.65, "armyPopShare": 0.4, "villagerCap": 55, "militaryTarget": 30 }
		};
	default:
		return {
			"doctrine": "field",
			"micro": Object.assign(aggressionPatch(0.55), { "civilianDanger": 45 }),
			"econ": { "armyShare": 0.55, "armyPopShare": 0.35 }
		};
	}
}

/** 经济模式：boom 是把人往采集上压、兵少一点；war 反过来。 */
export function economyPatch(mode)
{
	switch (mode)
	{
	case "boom":
		return {
			"villagerCap": 85,
			"armyShare": 0.32,
			"armyPopShare": 0.18,
			"minVillagers": 12,
			"minReserve": 70,
			"stockPerVillager": 8,
			"buildPace": 14,
			"farmTarget": 6,
			"techShare": 0.9,
			"militaryTarget": 0
		};
	case "war":
		return {
			"villagerCap": 45,
			"armyShare": 0.7,
			"armyPopShare": 0.45,
			"minReserve": 25,
			"stockPerVillager": 5,
			"buildPace": 22,
			"farmTarget": 5,
			"techShare": 0.8,
			"militaryTarget": 40
		};
	default:
		return {
			"villagerCap": 60,
			"armyShare": 0.55,
			"armyPopShare": 0.35,
			"minReserve": 40,
			"stockPerVillager": 6,
			"buildPace": 18,
			"techShare": 0.85
		};
	}
}

/**
 * 指定打击对象：写进内核 cfg.focusPlayer，由内核在集火/推进时优先选择该玩家。
 * 0 = 不设限（按敌对关系自动打）。
 */
export function targetPatch(playerId)
{
	const id = +playerId;
	return { "focusPlayer": Number.isFinite(id) && id > 0 ? id : 0 };
}

/** 旋钮当前值的反推（只在没有帧参数时兜底，标注为估算）。 */
export function estimateAggression(cfg)
{
	if (!cfg || cfg.engageRadius == null)
		return null;
	return r2(clamp((cfg.engageRadius - 40) / 70, 0, 1));
}

/**
 * 训练模式的参数搜索空间：只有列在这里的键才会被随机化，
 * 保证"越玩越强"搜的是有物理含义的旋钮，而不是随便抖参数。
 */
export function searchSpace()
{
	return {
		"micro": {
			"resistBase": [0.75, 1.25],
			"winMargin": [0.7, 1.5],
			"pushGrit": [0.35, 1.2],
			"engageRadius": [40, 110],
			"maxChase": [40, 120],
			"standoff": [0.7, 0.9],
			"kiteStep": [9, 16],
			"retreatHp": [0.25, 0.45],
			"clusterRadius": [30, 55],
			"maxGroups": [3, 7],
			// 回防灵敏度：几只骚扰算压境、多近算到家。搜出来的是"敢不敢救村"的胆量
			"homeThreatEnter": [1, 6],
			"homeThreatRadius": [60, 120]
		},
		"econ": {
			"villagerCap": [45, 90],
			"armyShare": [0.32, 0.7],
			"armyPopShare": [0.2, 0.45],
			"minReserve": [20, 80],
			"buildPace": [12, 24],
			"stockPerVillager": [4, 9],
			"techShare": [0.7, 0.95]
		}
	};
}

/**
 * 经济专属搜索空间：只含 g_SuperbrainEconConfig 的键，一个军事参数都不掺。
 *
 * 为什么单独拆出来：胜负里混着微操、对面骚扰和地图运气，拿它调经济权重等于隔靴搔痒。
 * 经济调参要的是"农民起量快不快、石金什么时候转正、上城几点上"这种纯运营读数，
 * 所以这套空间配的是 econ 评分（trainer 的 target=econ），不是胜负分。
 */
export function econSpace()
{
	return {
		"villagerCap": [40, 90],
		"minVillagers": [5, 16],
		"popHeadroom": [3, 9],
		"armyShare": [0.3, 0.7],
		"armyRatio": [0.4, 1.6],
		"armyPopShare": [0.18, 0.45],
		"minReserve": [15, 80],
		"stockPerVillager": [4, 9],
		"buildPace": [10, 26],
		"farmTarget": [4, 10],
		"techShare": [0.7, 0.95],
		"minerFloor": [1, 5],
		// minerFloor 是绝对值，minerShare 决定这些人头从哪儿腾出来：
		// 实测 12 农时随机到 minerFloor=5 直接把粮木抽干，所以搜索必须同时给预算
		"minerShare": [0.12, 0.34],
		"woodFloorShare": [0.18, 0.4],
		"foodFloorShare": [0.22, 0.45],
		"woodEmergency": [0.35, 0.6],
		"squeezeEta": [60, 240],
		"mineStockCap": [800, 2200],
		"maxMineWorkers": [4, 14],
		"townBuildings": [5, 8],
		// 工地占用：一栋一个builder、最多几块地、最多吃掉多少人手比例
		"buildersPerSite": [1, 2],
		"maxSites": [1, 3],
		"builderShare": [0.12, 0.35],
		"pullMin": [1, 3]
	};
}

/** 只撒经济参数：返回的包里没有 micro，下发时就只动经济副驾。 */
export function sampleEcon(space = econSpace(), rng = Math.random)
{
	const out = {};
	for (const k in space)
	{
		const [lo, hi] = space[k];
		const raw = lo + rng() * (hi - lo);
		out[k] = Number.isInteger(lo) && Number.isInteger(hi) ? Math.round(raw) : r2(raw);
	}
	return { "econ": out };
}

export function samplePack(space = searchSpace(), rng = Math.random)
{
	const jitter = obj => {
		const out = {};
		for (const k in obj)
		{
			const [lo, hi] = obj[k];
			const raw = lo + rng() * (hi - lo);
			out[k] = Number.isInteger(lo) && Number.isInteger(hi) ? Math.round(raw) : r2(raw);
		}
		return out;
	};
	return { "micro": jitter(space.micro), "econ": jitter(space.econ) };
}

/** 把两份参数包合并成下发序列（微操和经济各一条 meta 命令）。 */
export function packCommands(pack)
{
	const out = [];
	if (pack && pack.micro && Object.keys(pack.micro).length)
		out.push({ "op": "config", "patch": pack.micro });
	if (pack && pack.econ && Object.keys(pack.econ).length)
		out.push({ "op": "econ-config", "patch": pack.econ });
	if (pack && pack.doctrine)
		out.push({ "op": "doctrine", "name": pack.doctrine });
	return out;
}
