/**
 * 桥接层集成测试：用假引擎跑真代码（superbrain_bridge.js + superbrain_kernel.js + superbrain_economy.js）。
 * 覆盖 node --check 查不出来的问题：方法名写错、参数对不上、
 * 把 fogged 目标喂给攻击命令、给非己方单位下令、payload 缺字段等。
 *
 *   node superbrain/tools/bridge_test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "..", "mod", "gui", "session");

const TEMPLATES = {
	"units/kush/infantry_archer_b": {
		health: 50, speed: { walk: 10.3, run: 17.2 },
		resistance: { Damage: { Crush: 10, Hack: 1, Pierce: 1 } },
		visibleIdentityClasses: ["Soldier", "Infantry", "Ranged", "Archer"],
		attack: { Ranged: { maxRange: 60, repeatTime: 1250, Damage: { Pierce: 7.2 } } }
	},
	"units/kush/infantry_spearman_b": {
		health: 100, speed: { walk: 9.5, run: 15.86 },
		resistance: { Damage: { Crush: 15, Hack: 3, Pierce: 3 } },
		visibleIdentityClasses: ["Soldier", "Infantry", "Melee", "Spearman"],
		attack: { Melee: { maxRange: 4, repeatTime: 1000, Damage: { Hack: 4.5, Pierce: 4 } } }
	},
	"units/kush/cavalry_javelineer_b": {
		health: 100, speed: { walk: 16.2, run: 22.68 },
		resistance: { Damage: { Crush: 15, Hack: 2, Pierce: 1 } },
		visibleIdentityClasses: ["Soldier", "Cavalry", "Ranged", "Javelineer"],
		attack: { Ranged: { maxRange: 30, repeatTime: 1500, Damage: { Pierce: 18 } } }
	},
	"units/kush/support_healer_b": {
		health: 85, speed: { walk: 9, run: 15 },
		resistance: { Damage: { Crush: 1, Hack: 1, Pierce: 1 } },
		visibleIdentityClasses: ["Support", "Healer"],
		heal: { health: 5, range: 12, interval: 2000 }
	},
	"units/brit/infantry_spearman_b": {
		health: 100, speed: { walk: 9.5, run: 15.86 },
		resistance: { Damage: { Crush: 12, Hack: 2, Pierce: 2 } },
		visibleIdentityClasses: ["Soldier", "Infantry", "Melee", "Spearman"],
		attack: { Melee: { maxRange: 4, repeatTime: 1000, Damage: { Hack: 4, Pierce: 3.5 } } }
	},
	"structures/kush/civil_centre": {
		health: 3000, speed: {},
		resistance: { Damage: { Crush: 20, Hack: 20, Pierce: 20 } },
		visibleIdentityClasses: ["Civic", "Defensive", "CivilCentre"],
		attack: { Ranged: { maxRange: 60, repeatTime: 4000, Damage: { Pierce: 8 } } },
		garrisonHolder: { Capacity: [{ Unit: 10, Civic: 0, Defence: 0 }] },
		cost: { food: 0, wood: 300, stone: 300, metal: 250, population: 0, time: 500 },
		population: { bonus: 20 },
		resourceDropsite: { types: ["food", "wood", "stone", "metal"] },
		footprint: { square: { width: 32, depth: 32 } }
	},
	// 经济副驾要用的模板：农民、房、田、兵营，以及一棵可采的树
	"units/kush/support_civilian": {
		health: 25, speed: { walk: 9, run: 9 },
		visibleIdentityClasses: ["Civilian", "Support", "Worker"],
		cost: { food: 50, population: 1, time: 8 },
		resourceGatherRates: { "food.fruit": 1, "wood.tree": 0.7, "stone.rock": 0.35, "metal.ore": 0.35 }
	},
	"structures/kush/house": {
		health: 600, speed: {},
		visibleIdentityClasses: ["Civic", "Village", "House"],
		cost: { wood: 150, population: 0, time: 50 },
		population: { bonus: 10 },
		footprint: { square: { width: 12, depth: 12 } }
	},
	"structures/kush/field": {
		health: 400, speed: {},
		visibleIdentityClasses: ["Resource", "Field"],
		cost: { wood: 100, population: 0, time: 50 },
		footprint: { square: { width: 15, depth: 15 } }
	},
	"structures/kush/barracks": {
		health: 1000, speed: {},
		visibleIdentityClasses: ["Military", "Village", "Barracks"],
		cost: { wood: 300, population: 0, time: 120 },
		footprint: { square: { width: 20, depth: 20 } }
	},
	"gaia/tree/pine": {
		health: null, speed: {},
		visibleIdentityClasses: [],
		footprint: { circle: { radius: 2.5 } }
	},
	"gaia/fruit/berry_01": {
		health: null, speed: {},
		visibleIdentityClasses: [],
		footprint: { circle: { radius: 4 } }
	},
	"gaia/rock/aegean_large": {
		health: null, speed: {},
		visibleIdentityClasses: [],
		footprint: { circle: { radius: 5 } }
	}
};

class Harness
{
	constructor()
	{
		this.entities = new Map();
		this.nextEnt = 1200;
		this.written = [];
		this.commands = [];
		this.cmdFiles = [];
		this.now = 0;
		this.totalCommands = 0;
		this.warns = [];
		this.errors = [];
	}

	add(state)
	{
		this.entities.set(state.id, state);
		return state;
	}

	/**
	 * 假引擎也要真的改变状态，否则测不出"下命令 → 核对 → 冷却"这条回路：
	 * 引擎静默拒绝时队列不会变长、地基不会出现，副驾会把它当成失败一直冷却。
	 */
	apply(p)
	{
		const ent = id => this.entities.get(id);

		switch (p.type)
		{
		case "train":
		{
			const e = ent((p.entities || [])[0]);
			if (e)
			{
				e.queue = e.queue || [];
				e.queue.push({ "unitTemplate": p.template, "count": p.count || 1 });
			}
			break;
		}
		case "research":
		{
			const e = ent(p.entity);
			if (e)
			{
				e.queue = e.queue || [];
				e.queue.push({ "technologyTemplate": p.template });
			}
			break;
		}
		case "autoqueue-on":
		case "autoqueue-off":
			for (const id of p.entities || [])
			{
				const e = ent(id);
				if (e)
					e.autoqueue = p.type === "autoqueue-on";
			}
			break;
		case "construct":
			this.add({
				id: ++this.nextEnt,
				t: "foundation|" + p.template,
				owner: 1,
				x: p.x, z: p.z,
				hp: 1, maxHp: 640,
				seen: 3, vis: "visible",
				foundation: p.template
			});
			break;
		case "gather":
		case "back-to-work":
			for (const id of p.entities || [])
			{
				const e = ent(id);
				if (e)
					e.moving = true;
			}
			break;
		// 驻军：进了建筑就没坐标（引擎只在 IsInWorld() 时才写 position），
		// 容量不够就塞不进去 —— 这两条都是真机行为，测"放人回来"必须有
		case "garrison":
		{
			const host = ent(p.target);
			if (!host || !String(host.t).startsWith("structures/"))
				break;
			host.garrison = host.garrison || [];
			for (const uid of p.entities || [])
			{
				const u = ent(uid);
				if (!u || host.garrison.length >= (host.garrisonCap || 10))
					continue;
				host.garrison.push(uid);
				u.holder = host.id;
			}
			break;
		}
		case "unload":
		{
			const host = ent(p.garrisonHolder);
			if (!host || !host.garrison)
				break;
			const keep = [];
			for (const gid of host.garrison)
			{
				if ((p.entities || []).indexOf(gid) >= 0)
				{
					const u = ent(gid);
					if (u)
						u.holder = 0;
				}
				else
					keep.push(gid);
			}
			host.garrison = keep;
			break;
		}
		default:
			break;
		}
	}

	engine()
	{
		const h = this;
		return {
			GetPlayerID: () => 1,
			GetSimRate: () => 1,
			GetSessionID: () => 1,
			GetAtlas: () => [],
			GetViewedAreas: () => [],
			WriteJSONFile(file, data) { h.written.push({ file, data }); },
			ReadJSONFile(file)
			{
				const found = h.cmdFiles.find(c => c.file === file);
				return found ? found.data : null;
			},
			ListDirectoryFiles(where, pattern) {
				const re = new RegExp("^" + pattern.replace(/[.*+?^${}()|[]\]/g, m => "\\" + m).replace(/\*/g, ".*") + "$");
				return h.cmdFiles.filter(c => c.file.startsWith(where) && re.test(path.basename(c.file))).map(c => c.file);
			},
			PostNetworkCommand(payload) { h.commands.push(payload); ++h.totalCommands; h.apply(payload); },
			GuiInterfaceCall(name, args)
			{
				if (name === "GetAllBuildableEntities")
					return ["structures/kush/house", "structures/kush/field", "structures/kush/barracks", "structures/kush/storehouse"];
				if (name === "SetBuildingPlacementPreview")
					return args && args.template ? { "success": true } : { "success": false };
				if (name === "CheckTechnologyRequirements")
					return true;
				return null;
			},
			ConfigDB_GetValue: () => "",
			HasGuiPage: () => true,
			SwitchGuiPage: () => {},
			GetPlayerColor: () => "",
			GetPlayerName: () => ""
		};
	}

	globals()
	{
		const h = this;
		return {
			Engine: h.engine(),
			GetSimState: () => ({
				// 引擎的 timeElapsed 是毫秒，桥接层负责换算成秒
				timeElapsed: h.now * 1000,
				mapSize: 200,
				circularMap: false,
				players: {
					0: { name: "Gaia", civ: "gaia", state: "active", isEnemy: false },
					1: {
						name: "You", civ: "kush", state: "active", isEnemy: false, isMutualAlly: false,
						resourceCounts: { food: 500, wood: 400, stone: 200, metal: 150 },
						popCount: 20, popLimit: 25,
						classCounts: { Soldier: 18, Support: 2, Civilian: 6, Structure: 2 },
						entityCounts: {},
						resourceGatherers: { food: 3, wood: 3, stone: 0, metal: 0 },
						// 真机里没有 p.phase 这个字段，时代只存在于 researchedTechs 里
						// （GUI 作用域是 {科技名: 时间} 的表）。以前这里直接写 phase:"town"，
						// 于是"时代永远是空串"这个 bug 在离线测试里根本看不见。
						researchedTechs: { "phase_town": 120 }, researchQueued: []
					},
					2: {
						name: "Brit", civ: "brit", state: "active", isEnemy: true, isMutualAlly: false,
						resourceCounts: { food: 400, wood: 300, stone: 100, metal: 100 },
						popCount: 16, popLimit: 20,
						classCounts: { Soldier: 12, Melee: 8, Ranged: 4, Cavalry: 2, Structure: 1 },
						researchedTechs: {}
					}
				},
				state: { duration: h.now }
			}),
			GetMultipleEntityStates: ids => ids.filter(id => h.entities.has(id))
				.map(id => ({ "entId": id, "state": h.snapshot(h.entities.get(id)) })),
			GetEntityState: id => h.entities.has(id) ? h.snapshot(h.entities.get(id)) : undefined,
			GetTemplateData: (template, player) => TEMPLATES[template] ?
				Object.assign({ "player": player }, TEMPLATES[template]) : undefined,
			GetTechnologyData: template => ({ "template": template, "cost": { food: 100, wood: 100 } }),
			registerSimulationUpdateHandler: fn => { h.update = fn; },
			warn: m => h.warns.push(String(m)),
			error: m => h.errors.push(String(m)),
			uneval: v => JSON.stringify(v),
			translate: s => s,
			g_IsReplay: false,
			g_PlayerAssignments: { "local": { player: 1 } },
			g_Selection: { toList: () => [] },
			g_AutoFormation: { getDefault: () => null }
		};
	}

	snapshot(e)
	{
		const tpl = TEMPLATES[e.t] || {};
		// 驻军单位在引擎里就是"没有 position"，这一点必须还原，
		// 否则假引擎会把真机上最容易踩的坑（把人看成不存在）测掉
		const bunkered = e.holder && e.holder > 0;
		return {
			id: e.id,
			player: e.owner,
			template: e.t,
			position: bunkered ? undefined : { x: e.x, z: e.z },
			hitpoints: e.hp,
			maxHitpoints: e.maxHp,
			visibility: e.seen === 3 ? "visible" : e.vis,
			unitAI: e.t.startsWith("units/") ? {
				isIdle: !e.moving,
				formation: "line",
				formations: e.owner === 1 ? ["line", "box", "wedge", "column"] : [],
				selectableStances: ["aggressive", "defensive", "standground"],
				maxRange: (tpl.attack && (tpl.attack.Ranged || tpl.attack.Melee) || {}).maxRange
			} : undefined,
			identity: { classes: [e.t.startsWith("structures/") ? "Structure" : "Unit"] },
			attack: tpl.attack,
			resistance: tpl.resistance,
			needsRepair: e.needsRepair || false,
			// 经济副驾靠这几个 IGUI 组件看生产队列、可训清单和研究清单
			trainer: e.trainer ? { entities: e.trainer } : undefined,
			production: e.owner === 1 && e.t.startsWith("structures/") ?
				{ queue: e.queue || [], autoqueue: !!e.autoqueue } : undefined,
			researcher: e.techs ? { technologies: e.techs } : undefined,
			garrisonable: e.holder ? { holder: e.holder, size: 1 } : undefined,
			garrisonHolder: e.t.startsWith("structures/") ?
				{
					entities: e.garrison || [],
					capacity: e.garrisonCap || 10,
					occupiedSlots: (e.garrison || []).length,
					allowedClasses: ["Civic", "Defence"],
					buffHeal: 2
				} : undefined,
			resourceSupply: e.supply != null ? {
				isInfinite: false,
				max: e.supply,
				amount: e.supply,
				type: { generic: String(e.supplyKind || "wood.tree").split(".")[0], specific: e.supplyKind },
				killBeforeGather: false,
				maxGatherers: 8,
				numGatherers: e.used || 0
			} : undefined,
			foundation: e.foundation ? { template: e.foundation } : undefined
		};
	}
}

function loadBridge(globals)
{
	const names = Object.keys(globals);
	const body = fs.readFileSync(path.join(dir, "superbrain_kernel.js"), "utf8") + "\n" +
		fs.readFileSync(path.join(dir, "superbrain_economy.js"), "utf8") + "\n" +
		fs.readFileSync(path.join(dir, "superbrain_bridge.js"), "utf8");

	const fn = new Function(...names, body + "\nreturn g_SuperbrainBridge;");
	fn(...names.map(n => globals[n]));
	return fn;
}

const h = new Harness();
let id = 1000;

// 己方：10 弓 + 3 枪 + 2 投矛骑 + 1 医生 + 1 主城
const ours = [];
const spawn = (t, owner, x, z, vis, count) => {
	const list = [];
	for (let i = 0; i < count; ++i) {
		const tpl = TEMPLATES[t];
		list.push(h.add({
			id: ++id, t, owner, x: x + (i % 5) * 4, z: z + Math.floor(i / 5) * 4,
			hp: tpl.health, maxHp: tpl.health, seen: owner === 1 ? 3 : 2, vis
		}));
	}
	return list;
};

ours.push(...spawn("units/kush/infantry_archer_b", 1, 40, 60, "visible", 10));
ours.push(...spawn("units/kush/infantry_spearman_b", 1, 60, 60, "visible", 3));
ours.push(...spawn("units/kush/cavalry_javelineer_b", 1, 30, 40, "visible", 2));
ours.push(...spawn("units/kush/support_healer_b", 1, 36, 68, "visible", 1));
ours.push(...spawn("structures/kush/civil_centre", 1, 20, 76, "visible", 1));

// 经济侧的实体：能训农民的主城、一座兵营、几个农民、两处可采资源
const cc = ours.find(e => e.t === "structures/kush/civil_centre");
cc.trainer = ["units/kush/support_civilian", "units/kush/infantry_spearman_b"];
cc.techs = [
	{ "template": "phase_city" },
	null,
	{
		pair: { bottom: { "template": "support_health_2" }, top: { "template": "support_health_3" } },
		bottom: { "template": "support_health_2" },
		top: { "template": "support_health_3" }
	}
];
cc.queue = [];

const barracks = h.add({
	id: ++id, t: "structures/kush/barracks", owner: 1, x: 34, z: 70,
	hp: 1000, maxHp: 1000, seen: 3, vis: "visible",
	trainer: ["units/kush/infantry_spearman_b", "units/kush/infantry_archer_b"],
	queue: [], autoqueue: false
});

const civilians = spawn("units/kush/support_civilian", 1, 24, 66, "visible", 6);
civilians.forEach((c, i) => { c.moving = i % 2 === 0; });
ours.push(...civilians, barracks);

// 实测 Kush 的房子里也挂着 trainer（训一种 house 变体平民）。
// 它必须算房子不算人口建筑，否则人口/上限会计全错。
h.add({
	id: ++id, t: "structures/kush/house", owner: 1, x: 30, z: 82,
	hp: 1200, maxHp: 1200, seen: 3, vis: "visible",
	trainer: ["units/kush/support_civilian"], queue: [], autoqueue: false
});

const trees = [];
for (let i = 0; i < 4; ++i)
	trees.push(h.add({
		id: ++id, t: "gaia/tree/pine", owner: 0, x: 8 + i * 3, z: 58,
		hp: null, maxHp: null, seen: 2, vis: "visible",
		supply: 120 - i * 10, supplyKind: "wood.tree"
	}));
trees.push(h.add({
	id: ++id, t: "gaia/fruit/berry_01", owner: 0, x: 12, z: 88,
	hp: null, maxHp: null, seen: 2, vis: "visible",
	supply: 90, supplyKind: "food.fruit"
}));

const foes = spawn("units/brit/infantry_spearman_b", 2, 120, 60, "visible", 12);
// 一支只有"最后已知位置"的敌人：绝不能成为集火目标
const stale = spawn("units/brit/infantry_spearman_b", 2, 150, 66, "fogged", 3);

const globals = h.globals();
loadBridge(globals);

if (!h.update)
	throw new Error("桥接没有挂钩 registerSimulationUpdateHandler");

// 桥接现在按对局实例建 run-xxxx/ 子目录，命令文件要写进它自己挑的那个目录
const bootDir = h.written.length && h.written[0].data.dir ? h.written[0].data.dir : "saves/campaigns/superbrain/";
console.log("桥接 IPC 目录:", bootDir);

const seen = new Set();
const problems = [];

// 驻军回归用例（真机上踩过：村民一进主城就从视野里蒸发，经济只剩 1 个劳力）
const penned = [];
let unloadedAt = 0;
let bunkeredFrames = 0;
let rowsWhileBunkered = 0;

for (let tick = 0; tick < 400; ++tick)
{
	h.now += 0.1;
	for (const e of ours.concat(foes, stale))
	{
		if (e.hp <= 0)
			continue;
		// 敌方缓慢推进，制造接触
		if (e.owner === 2 && e.vis === "visible" && tick % 10 === 0)
			e.x -= 1.2;
	}

	// 敌人来骚扰 → 军事副驾把 4 个村民关进主城，然后敌人被赶走。
	// 关着的单位在引擎里没有 position，桥接层必须照样导出（带 holder），
	// 经济则要在确认安全之后发 unload 把人放回去干活。
	if (tick === 130 && !penned.length)
	{
		penned.push(...civilians.slice(0, 4).map(c => c.id));
		h.apply({ "type": "garrison", "entities": penned, "target": cc.id });
		for (const f of foes)
			f.x += 400;
	}

	// 造一点血量变化，验证战损统计是从相邻两拍差分里来的
	if (tick === 120)
	{
		foes[0].hp -= 25;
		ours[0].hp -= 12;
	}

	// 中途交还操控权：之后不该再有内核命令
	if (tick === 200)
		h.cmdFiles.push({
			file: bootDir + "cmd-000001.json",
			data: { "seq": 1, "commands": [{ "op": "takeover", "on": false }] }
		});

	h.commands.length = 0;
	h.update();

	// 驻军期间：这些单位必须仍然出现在导出里（holder 列 > 0），
	// 而且除了 unload 之外不该有人给他们下地图指令
	const pennedActive = penned.length && !unloadedAt;
	if (pennedActive)
	{
		const f = h.written.length ? h.written[h.written.length - 1].data : null;
		if (f && f.econ && f.econ.bunkered)
		{
			++bunkeredFrames;
			rowsWhileBunkered = Math.max(rowsWhileBunkered, f.entities.filter(r => r[10] > 0).length);
		}
		for (const cmd of h.commands)
		{
			if (cmd.type === "unload")
				unloadedAt = tick;
			else if (cmd.entities)
				for (const e of cmd.entities)
					if (penned.indexOf(e) >= 0)
						problems.push(`驻军中的单位 ${e} 被下了 ${cmd.type}`);
		}
		if (f && f.econ && f.econ.workers != null && f.econ.civilians != null &&
			f.econ.workers > f.econ.civilians)
			problems.push(`自由劳力 ${f.econ.workers} 不可能多于平民总数 ${f.econ.civilians}`);
	}
	else if (!unloadedAt)
	{
		for (const cmd of h.commands)
			if (cmd.type === "unload")
				unloadedAt = tick;
	}

	// 交还的是"军队操控权"，经济副驾是另一个开关：之后只该停掉军事类命令
	if (tick > 205)
		for (const cmd of h.commands)
			if (["attack", "attack-walk", "walk", "stance", "formation", "patrol", "focus", "guard"].includes(cmd.type))
				problems.push("交还操控权后仍在下令: " + cmd.type);

	for (const cmd of h.commands)
	{
		seen.add(cmd.type);
		if (!cmd.type)
			problems.push("payload 缺 type: " + JSON.stringify(cmd).slice(0, 120));
		if (cmd.entities)
			for (const e of cmd.entities)
			{
				const ent = h.entities.get(e);
				if (!ent || ent.owner !== 1)
					problems.push(`给非己方单位 ${e} 下令（${cmd.type}）`);
			}
		if (cmd.target != null && ["attack", "garrison", "heal", "guard"].includes(cmd.type))
		{
			const t = h.entities.get(cmd.target);
			if (!t)
				problems.push(`目标 ${cmd.target} 不存在`);
			else if (t.vis === "fogged")
				problems.push(`把 fogged 的 ${cmd.target} 当成了 ${cmd.type} 目标`);
		}
		if ((cmd.type === "walk" || cmd.type === "attack-walk") &&
			(!isFinite(cmd.x) || !isFinite(cmd.z)))
			problems.push(`移动目标不是数字 ${cmd.x},${cmd.z}`);
		if (cmd.type === "stance" && !["aggressive", "defensive", "standground"].includes(cmd.name))
			problems.push(`姿态名不在可选列表里: ${cmd.name}`);
	}
}

const stateFiles = h.written.filter(w => /state-/.test(w.file));
const last = stateFiles.length ? stateFiles[stateFiles.length - 1].data : null;

console.log("状态文件写入  ", stateFiles.length, "份");
console.log("引擎命令类型  ", [...seen].sort().join(", ") || "(无)");
console.log("引擎命令总数  ", h.totalCommands);
console.log("autopilot     ", last && last.autopilot);
console.log("内核计划      ", JSON.stringify(last && last.kernel && last.kernel.groups));
console.log("战损统计      ", JSON.stringify(last && last.combat));
console.log("seen 分布     ", JSON.stringify(last && last.probe && last.probe.seen));
console.log("错误          ", JSON.stringify((last && last.diag && last.diag.errors || []).slice(0, 6)));

if (!stateFiles.length)
	problems.push("没有写出任何 state 文件");
if (!last || !last.entities || !last.entities.length)
	problems.push("state 里没有实体");
if (!seen.has("walk") && !seen.has("attack") && !seen.has("attack-walk"))
	problems.push("一场战斗里内核一道命令都没下");
if (h.errors.length)
	problems.push("引擎报错: " + h.errors.slice(0, 3).join(" | "));

const ownCodes = last ? last.entities.filter(e => e[7] === 3).length : 0;
const foggedRows = last ? last.entities.filter(e => e[7] === 1).length : 0;
console.log("己方行/最后已知行  ", ownCodes, "/", foggedRows);
if (foggedRows !== stale.length)
	problems.push(`fogged 实体应导出 ${stale.length} 行，实际 ${foggedRows}`);

const combat = last && last.combat || {};
if (combat.foeHpLost < 25 || combat.ourHpLost < 12)
	problems.push(`战损统计没拿到人工造成的血量变化: ${JSON.stringify(combat)}`);
if (last && last.autopilot !== false)
	problems.push("takeover off 没生效");

// 经济副驾：必须真的产出命令，而且只能在己方实体上下令（上面的 owner 检查已经覆盖）
const econ = last && last.econ;
console.log("经济开关      ", last && last.economy);
console.log("经济摘要      ", econ ? JSON.stringify({
	pop: econ.pop, civilians: econ.civilians, workers: econ.workers, want: econ.wantCivilians,
	idle: econ.idle, bunkered: econ.bunkered, threat: econ.threatDist,
	cc: econ.cc, producers: econ.producers, issued: econ.issued, ops: econ.ops, alerts: econ.alerts
}) : "无");
const econOps = ["train", "research", "construct", "gather", "autoqueue-on", "autoqueue-off", "repair", "back-to-work"];
console.log("经济类命令    ", [...seen].filter(t => econOps.includes(t)).join(", ") || "(无)");

if (!(last && last.economy === true))
	problems.push("state 里没导出 economy 开关");
if (!econ)
	problems.push("state 里没有经济摘要");
else if (econ.cc !== 1 || econ.houses < 1)
	problems.push(`人口建筑分类错了：主城应 1、房子应 ≥1，实际 ${econ.cc}/${econ.houses}`);
else if (!(econ.issuedTotal > 0))
	problems.push("经济副驾整场一道命令都没下: " + JSON.stringify(econ));
else
	console.log("经济累计下令  ", econ.issuedTotal, " 被拒 ", econ.rejectedTotal || 0);
if (![...seen].some(t => econOps.includes(t)))
	problems.push("没有任何经济类命令发出");
// 时代必须从 researchedTechs 推出来：真机的 player 对象没有 phase 字段，
// 空串会让外部大脑的"几分钟上城"这条标尺永远是"未"（经济评分也跟着失明）
if (last && last.players && last.players["1"] && last.players["1"].phase !== "town")
	problems.push(`自己这边的时代应导出 town，实际 "${last.players["1"].phase}"`);
if (last && last.players && last.players["2"] && last.players["2"].phase !== "village")
	problems.push(`对手没研究时代时应导出 village，实际 "${last.players["2"].phase}"`);
if (last && last.diag && last.diag.errors && last.diag.errors.length)
	problems.push("桥接内部报错: " + last.diag.errors.slice(0, 3).join(" | "));

// 驻军回归：关起来的村民要看得见（带 holder）、要报进 econ 摘要、
// 安全之后必须发 unload，而且发完人真的回到场上（有坐标）
console.log("驻军快照      ", bunkeredFrames, "拍含驻军，驻军行最多", rowsWhileBunkered, "条，第", unloadedAt, "拍发出 unload");
if (!bunkeredFrames)
	problems.push("驻军期间经济摘要里从没出现 bunkered —— 村民被当成不存在（回归）");
if (rowsWhileBunkered < penned.length)
	problems.push(`驻军单位没被导出：应 ≥${penned.length} 行带 holder，实际 ${rowsWhileBunkered}`);
if (!unloadedAt)
	problems.push("敌人被赶走之后经济没有发 unload，村民会一直关在主城里不干活");
if (!seen.has("unload"))
	problems.push("引擎命令里没有 unload（经济放人这条路没走通）");
for (const c of penned)
{
	const e = h.entities.get(c);
	if (e.holder)
		problems.push(`第 ${unloadedAt} 拍下了 unload，单位 ${c} 还关着`);
}

if (problems.length)
{
	console.log("\nFAIL:");
	for (const p of [...new Set(problems)].slice(0, 20))
		console.log("  - " + p);
	process.exit(1);
}

console.log("\nOK: 桥接+内核在 400 拍里行为合规");
