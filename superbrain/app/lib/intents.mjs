/**
 * 逻辑指令注册表：把纯操作 AI 的命令面收成一份带类型/枚举/必填的清单。
 *
 * 三个消费方共用它：
 *   - UI 指令台（渲染成可点表单）
 *   - 大模型（schemaText / toolSpec 直接进 prompt）
 *   - 战略循环（白名单过滤，防止模型乱调 cheat/speed）
 *
 * 每条指令只负责把"逻辑参数"翻译成桥接层认识的 cmd（见 superbrain_bridge.js 的
 * buildPayload/handleMeta）。单位一律用选择器表达（army/workers/wounded…），
 * 由 lib/select.mjs 解析成真实实体 id —— 大模型不该数 id。
 */

import { pickPoint, pickTarget, pickUnits, selectorHint } from "./select.mjs";
import { DOCTRINES, ECON_MODES, POSTURES, aggressionPatch, economyPatch, packCommands, posturePatch, targetPatch } from "./presets.mjs";

const UNITS = { "type": "selector", "desc": `单位选择器：${selectorHint()}（默认 army=全军）`, "default": "army" };
const POINT = { "type": "point", "desc": "目标点：{x,z} / [x,z] / \"home\" / \"foe\"" };
const FOE = { "type": "target", "desc": `敌方目标：nearest | weakest | ranged | cavalry | siege | <实体id>（默认 nearest）`, "default": "nearest" };
const BUILDING = { "type": "target", "desc": "己方建筑：cc | house | field | fort | <实体id>" };

export const INTENTS = [
	// ---------------------------------------------------------------- 战术
	unit("move", "移动", "tactical", "选中单位走到目标点，途中不打架", { targets: UNITS, to: POINT, formation: str("box | line | column | wedge | special") },
		(a, ctx) => tactical(a, ctx, { "op": "walk", "formation": a.formation || null })),
	unit("attack-move", "攻击移动", "tactical", "一边向目标点推进一边打沿途敌人（等价于玩家右键按住拖）", { targets: UNITS, to: POINT },
		(a, ctx) => tactical(a, ctx, { "op": "attack-walk" })),
	unit("attack", "集火", "tactical", "全军点杀指定敌人", { targets: UNITS, target: FOE },
		(a, ctx) => {
			const t = pickTarget(a.target, ctx.view, { "kind": "foe" });
			if (t.error)
				return { "error": t.error };
			return tactical(a, ctx, { "op": "attack", "target": t.id });
		}),
	unit("stop", "停止", "tactical", "立刻停手，清队列", { targets: UNITS },
		(a, ctx) => tactical(a, ctx, { "op": "stop" })),
	unit("patrol", "巡逻", "tactical", "在目标点一带来回巡防", { targets: UNITS, to: POINT },
		(a, ctx) => tactical(a, ctx, { "op": "patrol" })),
	unit("guard", "护卫", "tactical", "跟着某支部队/建筑走", { targets: UNITS, target: BUILDING },
		(a, ctx) => {
			const t = pickTarget(a.target, ctx.view, { "kind": "own" });
			return t.error ? { "error": t.error } : tactical(a, ctx, { "op": "guard", "target": t.id });
		}),
	unit("unguard", "解除护卫", "tactical", "结束跟随关系", { targets: UNITS },
		(a, ctx) => tactical(a, ctx, { "op": "remove-guard" })),
	unit("garrison", "进驻", "tactical", "把单位关进建筑（村民被关后不产资源，慎用）", { targets: UNITS, target: BUILDING },
		(a, ctx) => {
			const t = pickTarget(a.target, ctx.view, { "kind": "own" });
			return t.error ? { "error": t.error } : tactical(a, ctx, { "op": "garrison", "target": t.id });
		}),
	unit("unload", "撤出驻军", "tactical", "从建筑里放出单位（默认放所有关着的人）", { holder: { "type": "id", "desc": "关着人的建筑 id，省略=全部驻军" } },
		(a, ctx) => {
			const held = (ctx.view.points.bunkered || []).filter(u => u.holder > 0);
			if (!held.length)
				return { "error": "现在没有单位被关在建筑里" };
			const want = +a.holder;
			const groups = {};
			for (const u of held)
			{
				if (want && u.holder !== want)
					continue;
				(groups[u.holder] = groups[u.holder] || []).push(u.id);
			}
			const keys = Object.keys(groups);
			if (!keys.length)
				return { "error": `建筑 ${want} 里没有可放出的单位` };
			return {
				"commands": keys.map(h => ({ "op": "unload", "holder": +h, "entities": groups[h] })),
				"notes": `放出 ${keys.length} 栋建筑里的 ${held.length} 个单位`
			};
		}),
	unit("heal", "治疗", "tactical", "让医生治疗指定单位/建筑", { targets: { ...UNITS, "default": "workers" }, target: FOE },
		(a, ctx) => {
			const t = pickTarget(a.target, ctx.view, { "kind": "own" });
			return t.error ? { "error": t.error } : tactical(a, ctx, { "op": "heal", "target": t.id });
		}),
	unit("repair", "修理", "tactical", "修指定建筑/单位", { targets: { ...UNITS, "default": "idle" }, target: BUILDING },
		(a, ctx) => {
			const t = pickTarget(a.target, ctx.view, { "kind": "own" });
			return t.error ? { "error": t.error } : tactical(a, ctx, { "op": "repair", "target": t.id });
		}),
	unit("promote", "晋升", "tactical", "Veteran 单位晋升经验加成", { targets: UNITS },
		(a, ctx) => tactical(a, ctx, { "op": "promote" })),
	unit("set-formation", "变阵", "tactical", "全线换阵形", { targets: UNITS, name: { "type": "enum", "enum": ["special", "box", "column", "line", "wedge"] } },
		(a, ctx) => tactical(a, ctx, { "op": "formation", "name": a.name })),
	unit("set-stance", "战斗姿态", "tactical", "aggressive 主动出击 / defensive 还手 / standground 不动 / noattack 挨打不还手",
		{ targets: UNITS, name: { "type": "enum", "enum": ["aggressive", "defensive", "standground", "noattack"] } },
		(a, ctx) => tactical(a, ctx, { "op": "stance", "name": a.name })),

	// ---------------------------------------------------------------- 经济与生产
	unit("gather", "采集", "production", "派村民去采集某个资源点", { targets: { ...UNITS, "default": "workers" }, target: { "type": "id", "desc": "资源点实体 id（田/矿/树/浆果）" } },
		(a, ctx) => {
			const t = pickTarget(a.target, ctx.view, { "kind": "own" });
			if (t.error)
				return { "error": "采集需要资源点 id" };
			return tactical(a, ctx, { "op": "gather", "target": t.id });
		}),
	unit("return-resources", "交资源", "production", "把手上的资源送进仓库/主城", { targets: { ...UNITS, "default": "workers" }, target: BUILDING },
		(a, ctx) => {
			const t = pickTarget(a.target, ctx.view, { "kind": "own" });
			return t.error ? { "error": t.error } : tactical(a, ctx, { "op": "returnresource", "target": t.id });
		}),
	unit("back-to-work", "回去干活", "production", "打断当前动作，回工作岗位", { targets: { ...UNITS, "default": "workers" } },
		(a, ctx) => tactical(a, ctx, { "op": "back-to-work" })),
	unit("train", "训练单位", "production", "在某个生产建筑里训练单位", {
		entity: { "type": "id", "desc": "生产建筑 id（兵营/马厩/主城）" },
		template: { "type": "template", "desc": "单位模板名，可写中文类别（弓手/枪兵/骑兵/骑射/剑兵/攻城）" },
		count: { "type": "int", "min": 1, "max": 40, "default": 5 }
	}, (a, ctx) => {
		const tpl = resolveTemplate(a.template, ctx);
		if (tpl.error)
			return tpl;
		const entity = +a.entity || pickProducer(ctx, tpl.bucket);
		if (!entity)
			return { "error": "找不到能训练该兵种的建筑（本局还没观察到生产菜单）" };
		return { "commands": [{ "op": "train", "entity": entity, "template": tpl.template, "count": clampInt(a.count, 1, 40, 5) }], "notes": `训练 ${tpl.template} ×${clampInt(a.count, 1, 40, 5)}（建筑 ${entity}）` };
	}),
	unit("build", "建造", "production", "派村民在某点建造建筑", {
		targets: { ...UNITS, "default": "idle" },
		template: { "type": "template", "desc": "建筑模板名，可写中文（房屋/农田/兵营/马厩/靶场/攻城厂/塔）" },
		to: POINT
	}, (a, ctx) => {
		const tpl = resolveTemplate(a.template, ctx, "structure");
		if (tpl.error)
			return tpl;
		const got = pickUnits(a.targets, ctx.view);
		const p = point({ "x": a.to && a.to.x, "z": a.to && a.to.z }, ctx) || ctx.view.home || null;
		if (!p || p.x == null)
			return { "error": "建造需要落点坐标" };
		// 没有 builder 就别下这条命令：引擎会静默丢弃空 entities 的 construct，
		// 上层只看到"指令已下发"，什么也不会发生
		if (!got.ids.length)
			return { "error": `没有可派去建造的村民（选择器「${a.targets}」在这局里选空了），可改 targets=all 或先腾出人` };
		return { "commands": [{ "op": "construct", "entities": got.ids, "template": tpl.template, "x": Math.round(p.x), "z": Math.round(p.z), "angle": 0 }], "notes": `在 ${Math.round(p.x)},${Math.round(p.z)} 建 ${tpl.template}` };
	}),
	unit("research", "研究科技", "production", "在主城/兵营研究科技或升级", {
		entity: { "type": "id", "desc": "可研究的建筑 id（省略=主城）" },
		template: { "type": "template", "desc": "科技模板名" }
	}, (a, ctx) => {
		const entity = +a.entity || (ctx.view.ids.cc || [])[0];
		if (!entity)
			return { "error": "找不到可研究的建筑" };
		return { "commands": [{ "op": "research", "entity": entity, "template": String(a.template) }], "notes": `研究 ${a.template}` };
	}),
	unit("upgrade", "单位升级", "production", "把场上单位升级为高级兵种", { targets: UNITS, template: { "type": "template", "desc": "目标兵种模板名" } },
		(a, ctx) => {
			const got = pickUnits(a.targets, ctx.view);
			return { "commands": [{ "op": "upgrade", "entities": got.ids, "template": String(a.template) }] };
		}),
	unit("autoqueue", "自动续队列", "production", "打开/关闭建筑的 autoqueue（按人口上限挂机补单位）", { entity: { "type": "id" }, on: { "type": "bool", "default": true } },
		(a, ctx) => {
			const entity = +a.entity || (ctx.view.ids.cc || [])[0];
			if (!entity)
				return { "error": "找不到建筑" };
			return { "commands": [{ "op": a.on === false ? "autoqueue-off" : "autoqueue-on", "entities": [entity] }] };
		}),
	unit("stop-production", "取消生产", "production", "撤掉队列里的一项", { entity: { "type": "id" }, id: { "type": "int", "desc": "队列项序号" } },
		(a, ctx) => {
			const entity = +a.entity || (ctx.view.ids.cc || [])[0];
			return { "commands": [{ "op": "stop-production", "entity": entity, "id": clampInt(a.id, 0, 40, 0) }] };
		}),

	// ---------------------------------------------------------------- 接管与控制
	unit("set-military-takeover", "军事接管", "control", "开/关军事副驾（关掉就是把军队交还玩家手操）", { on: { "type": "bool", "required": true } },
		a => ({ "commands": [{ "op": "takeover", "on": !!a.on }], "notes": a.on ? "军事已接管" : "军队交还手操" })),
	unit("set-economy-takeover", "经济接管", "control", "开/关经济副驾", { on: { "type": "bool", "required": true } },
		a => ({ "commands": [{ "op": "econ", "on": !!a.on }], "notes": a.on ? "经济已接管" : "经济交还手操" })),
	unit("take-over-all", "全部接管", "control", "军事 + 经济同时接管", {},
		() => ({ "commands": [{ "op": "takeover", "on": true }, { "op": "econ", "on": true }] })),
	unit("release-all", "全部取消", "control", "军事 + 经济全部交还玩家", {},
		() => ({ "commands": [{ "op": "takeover", "on": false }, { "op": "econ", "on": false }] })),
	unit("set-doctrine", "打法", "control", DOCTRINES.join(" | ") + "：field 会战 / hold 守家 / push 压进 / harass 骚扰 / retreat 撤退",
		{ name: { "type": "enum", "enum": DOCTRINES } },
		a => ({ "commands": [{ "op": "doctrine", "name": a.name }] })),
	unit("set-objective", "战略目标点", "control", "告诉内核往哪推（省略坐标=清除）", { to: POINT },
		(a, ctx) => {
			const p = point(a.to, ctx);
			if (!p)
				return { "error": "找不到该语义点，请给 x,z" };
			return { "commands": [{ "op": "objective", "x": Math.round(p.x), "z": Math.round(p.z) }] };
		}),
	unit("set-rally-point", "集结点", "control", "新生产单位自动去哪里（省略=清除手动集结点）", { to: POINT },
		(a, ctx) => {
			const p = point(a.to, ctx);
			if (!p)
				return { "commands": [{ "op": "rally" }] };
			return { "commands": [{ "op": "rally", "x": Math.round(p.x), "z": Math.round(p.z) }] };
		}),
	unit("set-micro-param", "微操参数", "control", "直接改内核阈值：resistBase/engageRadius/maxChase/standoff/kiteStep/retreatHp/maxGroups/…",
		{ patch: { "type": "patch", "required": true } },
		a => ({ "commands": [{ "op": "config", "patch": clean(a.patch, MICRO_KEYS) }], "notes": "微操参数已下发" })),
	unit("set-econ-param", "经济参数", "control", "直接改经济副驾阈值：villagerCap/armyShare/minReserve/buildPace/techShare/farmTarget/…",
		{ patch: { "type": "patch", "required": true } },
		a => ({ "commands": [{ "op": "econ-config", "patch": clean(a.patch, ECON_KEYS) }] })),
	unit("set-speed", "仿真速度", "control", "引擎速度倍率（训练/实验台用，1~8）", { value: { "type": "number", "min": 0.25, "max": 8, "required": true } },
		a => ({ "commands": [{ "op": "speed", "value": +a.value }] })),

	// ---------------------------------------------------------------- 战略旋钮（大模型最爱用）
	unit("set-aggression", "攻击欲望", "preset", "0=绝不打，1=见人就上。内部展开成一整套交战阈值",
		{ value: { "type": "number", "min": 0, "max": 1, "required": true } },
		a => packCommandsResult({ "micro": aggressionPatch(a.value) })),
	unit("set-posture", "攻防模式", "preset", `defend 守家 | balanced 均势 | attack 全力进攻；一次改完打法+交战阈值+经济倾斜`,
		{ name: { "type": "enum", "enum": POSTURES } },
		a => packCommandsResult(posturePatch(a.name))),
	unit("set-economy-mode", "经济模式", "preset", "boom 憋经济 | balanced 均衡 | war 极限暴兵；决定农民数、兵役份额与 reserve",
		{ name: { "type": "enum", "enum": ECON_MODES } },
		a => packCommandsResult({ "econ": economyPatch(a.name) })),
	unit("set-war-target", "打击对象", "preset", "指定优先打击的玩家 id（0=按敌对关系自动）",
		{ player: { "type": "int", "required": true } },
		a => packCommandsResult({ "micro": targetPatch(a.player) })),

	// ---------------------------------------------------------------- 组合宏
	unit("defend-home", "回防", "macro", "全军撤回主城并切守护姿态（屠村救援一键）", {},
		(a, ctx) => {
			if (!ctx.view || !ctx.view.home)
				return { "error": "看不到主城" };
			const got = pickUnits("army", ctx.view);
			return {
				"commands": [
					{ "op": "doctrine", "name": "hold" },
					{ "op": "attack-walk", "entities": got.ids, "x": Math.round(ctx.view.home.x), "z": Math.round(ctx.view.home.z), "formation": "line" },
					// 顺手把自动回防拧到"有一只骚扰就回家"，并让它待着不走：
					// 玩家按这钮就是来救村的，别再被一个骑兵勾回外线
					{ "op": "config", "patch": { "engageRadius": 60, "maxChase": 45, "homeGuard": true, "homeThreatEnter": 1, "homeThreatExit": 0 } }
				],
				"notes": `回防 ${Math.round(ctx.view.home.x)},${Math.round(ctx.view.home.z)}`
			};
		}),
	unit("retreat-all", "全军撤退", "macro", "脱离接触，向主城/集结点收缩", { to: POINT },
		(a, ctx) => {
			const got = pickUnits("army", ctx.view);
			const p = point(a.to, ctx) || ctx.view.home;
			if (!p)
				return { "error": "没有撤退落点" };
			return { "commands": [{ "op": "doctrine", "name": "retreat" }, { "op": "walk", "entities": got.ids, "x": Math.round(p.x), "z": Math.round(p.z), "formation": "column" }] };
		}),
	unit("push-foe", "压向敌人", "macro", "全军攻击移动到敌军重心", {},
		(a, ctx) => {
			const got = pickUnits("army", ctx.view);
			if (!ctx.view.foeCentroid)
				return { "error": "视野里没有敌人" };
			return { "commands": [{ "op": "doctrine", "name": "push" }, { "op": "attack-walk", "entities": got.ids, "x": Math.round(ctx.view.foeCentroid.x), "z": Math.round(ctx.view.foeCentroid.z) }] };
		}),
	unit("cheat-units", "实验台造兵", "lab", "在己方主城旁直接生成 N 个单位（官方作弊码，只在单人对局生效，用来摆会战测战损比）",
		{ count: { "type": "int", "min": 1, "max": 500, "required": true } },
		(a, ctx) => {
			const entity = (ctx.view.ids.cc || [])[0];
			const civ = ctx.view.my && ctx.view.my.civ;
			if (!entity || !civ)
				return { "error": "找不到主城或文明" };
			return {
				"commands": [{
					"op": "cheat", "action": "createunits", "parameter": clampInt(a.count, 1, 500, 20), "entities": [entity],
					"templates": [`units/${civ}/infantry_archer_b`, `units/${civ}/infantry_spearman_b`, `units/${civ}/cavalry_javelineer_b`]
				}],
				"notes": `主城旁造 ${a.count} 个兵`
			};
		})
];

// 内核/经济可改键白名单：写错键名不会静默污染参数表
const MICRO_KEYS = ["mode", "doctrine", "kite", "resistBase", "clusterRadius", "maxGroups", "standoff", "kiteStep",
	"closeRange", "standMargin", "moveCooldown", "moveEpsilon", "retargetCooldown", "maxOpsPerTick", "retreatHp",
	"garrisonWounded", "garrisonCivilians", "civilianDanger", "civilianFlee", "civilianCalm", "maxChase", "judgeRadius",
	"engageRadius", "winMargin", "pushGrit", "edgeMargin", "rangeEdgeCap", "attackStructures", "stance", "holdStance",
	"formation", "focusPlayer", "homeGuard", "homeThreatRadius", "homeThreatEnter", "homeThreatExit", "homeArriveRadius",
	"homeDwell"];
const ECON_KEYS = ["enabled", "passEvery", "maxOps", "minReserve", "villagerCap", "armyCap", "armyPopShare", "minVillagers",
	"popHeadroom", "armyShare", "armyRatio", "techShare", "militaryTarget", "autoqueue", "tech", "farms", "repair", "buildings",
	"placeRadius", "placeTries", "retryCooldown", "buildPace", "farmTarget", "stockPerVillager", "stockFloor", "wantFloor",
	"mineStockCap", "maxMineWorkers", "verifyGrace", "queueGrace", "pullMin", "pullMax", "workerFloor", "nodeRadius",
	"assignRadius", "unloadThreat", "unloadWait", "deadRetry", "deadRetryMax", "stallAlert",
	// 劳力底线与结构数量要求（运营教程节奏，见 econ 头部注释）
	"minerFloor", "minerShare", "woodFloorShare", "foodFloorShare", "woodEmergency", "squeezeEta", "townBuildings",
	"buildersPerSite", "maxSites", "builderShare"];

export const DOCTRINE_LIST = DOCTRINES;

function unit(name, label, kind, desc, args, build)
{
	return { "name": name, label, kind, desc, args: args || {}, build };
}

function str(desc)
{
	return { "type": "string", "desc": desc, "default": null };
}

export function intentByName(name)
{
	return INTENTS.find(i => i.name === String(name)) || null;
}

/**
 * 校验 + 编译一条逻辑指令 → 桥接层命令包。
 * 未登记的参数只丢弃不报错：本地小模型几乎一定会多写几个字段。
 */
export function compile(raw, ctx)
{
	if (!raw || !raw.name)
		return { "ok": false, "error": "指令缺少 name" };
	const intent = intentByName(raw.name);
	if (!intent)
		return { "ok": false, "error": `未知指令「${raw.name}」，可用：${INTENTS.map(i => i.name).join(", ")}` };

	const args = {};
	const dropped = [];
	for (const key in raw.args || {})
	{
		if (intent.args[key])
			args[key] = raw.args[key];
		else
			dropped.push(key);
	}

	for (const key in intent.args)
	{
		const spec = intent.args[key];
		if (args[key] === undefined)
		{
			if (spec.required)
				return { "ok": false, "error": `指令 ${intent.name} 缺少参数 ${key}` };
			if (spec.default !== undefined)
				args[key] = spec.default;
			continue;
		}
		const bad = checkType(spec, args[key], key);
		if (bad)
			return { "ok": false, "error": bad };
	}

	let built;
	try
	{
		built = intent.build(args, ctx);
	}
	catch (e)
	{
		return { "ok": false, "error": `指令 ${intent.name} 编译失败：${e.message}` };
	}
	if (!built)
		return { "ok": false, "error": `指令 ${intent.name} 无输出` };
	if (built.error)
		return { "ok": false, "error": built.error };

	return {
		"ok": true,
		"name": intent.name,
		"label": intent.label,
		"commands": built.commands || [],
		"notes": [built.notes].concat(dropped.length ? [`忽略未登记参数 ${dropped.join(",")}`] : []).filter(Boolean)
	};
}

function checkType(spec, value, key)
{
	if (spec.enum && spec.enum.indexOf(value) < 0)
		return `参数 ${key} 只能是 ${spec.enum.join(" | ")}，收到「${value}」`;
	if (spec.type === "int" || spec.type === "number")
	{
		const n = Number(value);
		if (!Number.isFinite(n))
			return `参数 ${key} 需要数字`;
		if (spec.min != null && n < spec.min)
			return `参数 ${key} 不能小于 ${spec.min}`;
		if (spec.max != null && n > spec.max)
			return `参数 ${key} 不能大于 ${spec.max}`;
	}
	if (spec.type === "patch" && typeof value !== "object")
		return `参数 ${key} 需要对象`;
	return null;
}

function tactical(a, ctx, cmd)
{
	const got = pickUnits(a.targets, ctx.view);
	if (!got.ids.length)
		return { "error": `没有匹配到单位（${got.note || ""}）` };
	const p = a.to ? point(a.to, ctx) : null;
	if (a.to && !p)
		return { "error": "解析不到目标点，请给 x,z" };

	const out = Object.assign({ "entities": got.ids }, cmd);
	if (p)
	{
		out.x = Math.round(p.x);
		out.z = Math.round(p.z);
	}
	return { "commands": [out], "notes": `${got.note} → ${p ? `(${out.x},${out.z})` : cmd.op}` };
}

/**
 * 找不到生产建筑时的兜底：按兵种桶猜一栋楼。
 * 真正该由谁训练是游戏内经济内核的权威判断，这里只为"玩家明确点兵"提供一个落点。
 */
const PRODUCER_RE = {
	"pikeman": /barracks|forge|civil_centre|civic_center/,
	"sword": /barracks|forge|civil_centre|civic_center/,
	"ranged": /barracks|archery|civil_centre|civic_center/,
	"cav": /stable|civil_centre|civic_center/,
	"hcav": /stable/,
	"siege": /siege/,
	"workers": /civil_centre|civic_center/,
	"other": /civil_centre|civic_center/
};

function pickProducer(ctx, bucket)
{
	const buildings = (ctx.view && ctx.view.points && ctx.view.points.buildings) || [];
	const re = PRODUCER_RE[bucket] || PRODUCER_RE.other;
	const hit = buildings.find(b => re.test(String(b.t)));
	return hit ? hit.id : 0;
}

function point(sel, ctx)
{
	const p = pickPoint(sel, ctx.view);
	return p && p.x != null ? p : null;
}

function packCommandsResult(pack)
{
	const commands = packCommands(pack);
	if (!commands.length)
		return { "error": "空参数包" };
	const n = Object.keys(pack.micro || {}).length + Object.keys(pack.econ || {}).length;
	return { "commands": commands, "notes": `展开成 ${commands.length} 组参数、${n} 个阈值${pack.doctrine ? `，打法 ${pack.doctrine}` : ""}` };
}

function clean(patch, allowed)
{
	const out = {};
	for (const k in patch || {})
		if (allowed.indexOf(k) >= 0)
			out[k] = patch[k];
	return out;
}

function clampInt(v, lo, hi, dflt)
{
	const n = Math.round(Number(v));
	if (!Number.isFinite(n))
		return dflt;
	return Math.min(hi, Math.max(lo, n));
}

const ZH_BUCKET = [
	["ranged", /弓|archer|远程|射手|sliger|sling|标枪|javelin/],
	["pikeman", /枪|spear|pike|前排/],
	["sword", /剑|sword|mace|锤/],
	["hcav", /骑射|马弓|horse_archer|camel|骑.*弓/],
	["cav", /骑|cavalry|camel|战象|elephant/],
	["siege", /攻城|siege|catapult|ballista|冲车|ram/],
	["workers", /村民|农民|worker|villager|civilian/],
	["structures", /建筑|structure/]
];

/**
 * 把"弓手/枪兵/archer"这类说法换成本局真实存在的模板名。
 * 只信观察到的数据（帧内实体 + static 模板表），不猜引擎里没出现过的名字 ——
 * 猜错的模板名会被引擎静默丢弃，比报错更难查。
 */
export function resolveTemplate(text, ctx, kind)
{
	const raw = String(text == null ? "" : text).trim();
	if (/^units\//.test(raw) || /^structures\//.test(raw))
		return { "template": raw, "bucket": bucketOfName(raw) };

	const pool = templatePool(ctx);
	const wantKind = kind === "structure" ? /^structures\// : /^units\//;
	let candidates = pool.filter(t => wantKind.test(t));
	if (!candidates.length)
		return { "error": "本局还没观察到任何模板，先让对局跑起来再下单" };

	// 中文说法走类别表，英文说法走名字子串；两条都没命中就当不认识，
	// 绝不能"随便挑一个单位"—— 静默下错兵比报错难查十倍
	const hit = ZH_BUCKET.find(re => re[1].test(raw));
	const bucket = hit ? hit[0] : null;
	const needle = raw.toLowerCase().replace(/[^a-z0-9_]/g, "");

	if (needle.length >= 3)
	{
		const named = candidates.filter(t => t.toLowerCase().indexOf(needle) >= 0);
		if (named.length)
			return { "template": named.sort((a, b) => a.length - b.length)[0], "bucket": bucketOfName(named[0]) };
	}
	if (bucket)
	{
		const byBucket = candidates.filter(t => bucketOfName(t) === bucket);
		if (byBucket.length)
		{
			const civ = ctx.view && ctx.view.my && ctx.view.my.civ;
			const ours = byBucket.filter(t => !civ || t.indexOf(`/${civ}/`) >= 0);
			const chosen = (ours.length ? ours : byBucket).sort((a, b) => a.length - b.length)[0];
			return { "template": chosen, "bucket": bucket };
		}
		return { "error": `本局观察到的模板里没有「${raw}」这一类（${bucket}），请给我看到过的兵种名` };
	}

	return { "error": `认不出「${raw}」是什么兵种/建筑，可写 archer、spearman、field 或完整模板名` };
}

function bucketOfName(t)
{
	const s = String(t).toLowerCase();
	if (/siege|catapult|ballista|ram|tower/.test(s))
		return "siege";
	if (/cavalry_(archer|javelineer)|horse_archer|camel_(archer|javelin)/.test(s))
		return "hcav";
	if (/cavalry|camel|chariot|elephant/.test(s))
		return "cav";
	if (/archer|javelin|slinger|bow/.test(s))
		return "ranged";
	if (/spearman|pikeman|pike/.test(s))
		return "pikeman";
	if (/sword|mace/.test(s))
		return "sword";
	if (/civil_centre|civic_center|fort|house|field|storehouse/.test(s))
		return "structures";
	return "other";
}

/** 本局可见模板名池：帧内出现过的 + static 导出过的。 */
function templatePool(ctx)
{
	const set = new Set(ctx.templates || []);
	const view = ctx.view;
	if (view && view.raw && view.raw.entities)
	{
		const fields = view.raw.fields || [];
		const ti = fields.indexOf("template");
		for (const row of view.raw.entities)
			if (ti >= 0 && row[ti])
				set.add(row[ti]);
	}
	return Array.from(set);
}

/** 给大模型的说明书：紧凑、逐行、带真实可选值。 */
export function schemaText(only)
{
	const allow = only && only.length ? only : null;
	return INTENTS.filter(i => !allow || allow.indexOf(i.name) >= 0).map(i => {
		const args = Object.keys(i.args).map(k => {
			const s = i.args[k];
			const flag = s.required ? "必填" : `默认${JSON.stringify(s.default === undefined ? null : s.default)}`;
			return `${k}${s.type ? `:${s.type}` : ""}(${s.enum ? s.enum.join("/") : flag})`;
		}).join(", ");
		return `- ${i.name} 「${i.label}」[${i.kind}] ${i.desc}${args ? ` 参数: {${args}}` : " 无参数"}`;
	}).join("\n");
}

/** OpenAI tools 格式（部分模型用函数调用比 JSON 直出更稳）。 */
export function toolSpec()
{
	return INTENTS.filter(i => i.kind !== "lab").map(i => ({
		"type": "function",
		"function": {
			"name": i.name,
			"description": `${i.label}：${i.desc}`,
			"parameters": {
				"type": "object",
				"properties": Object.keys(i.args).reduce((acc, k) => {
					const s = i.args[k];
					acc[k] = {
						"type": s.type === "patch" ? "object" : s.type === "int" ? "integer" : s.type === "bool" ? "boolean" :
							s.type === "point" || s.type === "selector" ? "string" : "string",
						"description": s.desc || k
					};
					if (s.enum)
						acc[k].enum = s.enum;
					return acc;
				}, {}),
				"required": Object.keys(i.args).filter(k => i.args[k].required)
			}
		}
	}));
}

/** UI 渲染用。 */
export function uiSchema()
{
	return INTENTS.map(i => ({
		"name": i.name,
		"label": i.label,
		"kind": i.kind,
		"desc": i.desc,
		"args": Object.keys(i.args).map(k => ({
			"key": k,
			"type": i.args[k].type || "any",
			"desc": i.args[k].desc || "",
			"enum": i.args[k].enum || null,
			"required": !!i.args[k].required,
			"default": i.args[k].default === undefined ? null : i.args[k].default
		}))
	}));
}
