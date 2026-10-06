/**
 * Superbrain economy kernel
 *
 * 运营决策核心：输入一帧"国家快照"，输出与玩家鼠标点击等价的命令序列。
 * 和微操内核一样不碰引擎 IO（不读文件、不 PostNetworkCommand），
 * 所以同一份逻辑既能跑在 GUI 作用域（实战副驾），也能跑在 AI 作用域（批量自学习）。
 *
 * world = {
 *   now,                 仿真秒
 *   me,
 *   player: { civ, pop, popCap, phase,
 *             resources: {food,wood,stone,metal},
 *             gatherers: {food,wood,stone,metal}（也兼容 {food:{total}}）,
 *             classes: {Civilian:n, Soldier:n, Cavalry:n, ...},   // 引擎记账，比自己数准
 *             techs: [已研究科技名] },
 *   foes:  [ { id, classes: {...}, pop } ],        敌方编制，用来反制兵种配比
 *   own:   [ { id, t, x, z, hp, maxHp, idle, needsRepair, seen,
 *              holder,      // >0 = 驻军在这栋楼里：不能采集、不能作战
 *              garrison, garrisonCap,
 *              trainer: [模板名],
 *              queue: [{unitTemplate|technologyTemplate, count}],
 *              autoqueue, techs: [科技对象], foundationOf } ],
 *   nodes: [ { id, t, x, z, kind, supply, cap, used } ],   可采集点（农田也算）
 *   threatDist           最近敌人离家的距离，没有可见敌人 = null
 *   doctrine             军事内核当前打法，决定兵种配比
 * }
 * ctx = { getTemplate(t,p), getTech(t,civ), techRequirementsMet(tech),
 *         buildable(entId), canPlace(t,x,z,angle)→true|拒绝理由文字, log(msg) }
 *
 * 缺字段一律按保守处理。所有下出去的意图都会在下一拍被 verify() 核对：
 * 引擎拒绝命令时不抛异常（需求不满足、地基放不下、资源不够都是静默丢弃），
 * 只能靠状态差分发现，发现了就进冷却，免得每分钟白派一次农民。
 */

var g_SuperbrainEconConfig = {
	"enabled": true,

	// 经济不需要 10 Hz，一秒一拍足够，省下的是 GUI 线程时间
	"passEvery": 1.1,
	"maxOps": 8,

	"minReserve": 40,
	// 农民与军队的"野心值"：绝对数量，不是人口上限的比例。
	// 目标若按上限比例算，人口会永远追不上上限（比例封顶），暴兵停摆；
	// 只看绝对值又会在上限没跟上时死锁。所以：野心值定总量，上限只当物理约束。
	"villagerCap": 60,
	"armyCap": 0,
	"armyPopShare": 0.35,
	"minVillagers": 8,
	"popHeadroom": 5,
	"armyShare": 0.55,
	// 军队规模要跟着对面走：1.0 = 备到和可见敌军兵力持平。之前这个目标是纯自变量的
	// （villagerCap×0.7），实盘出现过 兵5 对 敌方合计 57 兵 —— 目标跟敌人规模完全脱钩。
	"armyRatio": 0.9,
	"techShare": 0.85,
	"militaryTarget": 0,
	"autoqueue": true,
	"tech": true,
	"farms": true,
	"repair": true,
	"buildings": true,

	// 螺旋找地基：搜索半径、尝试次数、失败冷却
	"placeRadius": 60,
	"placeTries": 16,
	// 单次 GuiInterfaceCall 校验是走 C++ 的，一拍的探测总量必须有闸：
	// 越找不到点越要往外搜，但不能因此把主线程拖成幻灯片
	"placeBudget": 36,
	"retryCooldown": 45,
	// 被引擎否过的格子在这这么久内不再浪费探测预算（树会被砍掉、领地会变，不能永久拉黑）
	"badSpotTtl": 25,
	"buildPace": 18,
	// 教程节奏：Village→Town 除了 500 粮 500 木，还要 5 栋非农田建筑；
	// 农田按"围着主城 8 块"的目标走（社区运营教程的通用数字）
	"townBuildings": 5,
	// 每栋建筑只派这么多builder：派满了盖得快，但这些人同时不采集。
	// 教程明确要求"一栋一个"，实测我们把 2 人钉在房子上、木头收入反而先崩
	"buildersPerSite": 1,
	// 同时最多开几个工地，以及地基多久没进展就重新派人（见 keepSites）
	// 2 个太保守：人手机会 crewCap 还会再收一道闸，实盘 15 分钟只落出 8 栋建筑
	"maxSites": 3,
	"siteStall": 9,
	// 工地最多吃掉这么多人手比例。实盘教训：开局只有 5 个农民时锁走 2 个去盖房+开田，
	// 采集池直接归零，粮从 100 掉到 5，房子还是没盖完
	"builderShare": 0.25,
	// 敌人离家不到这么远就先别盖了：锁在工地上的人既不能采集也来不及躲，
	// 实测被屠的那局人口从 16 掉到 5 时仍有 2 人被钉在地基上
	"siteDanger": 60,
	// 下令后地基要等实体扫描才看得见，超过这么久还没出现就当期工地作废
	"siteAdopt": 30,
	"farmTarget": 8,
	// 劳力权重里的"囤货目标"：每人每种资源囤到这么多就基本不再派人，
	// 只留 wantFloor 的保底份额（低于它就按缺口重新加权）
	"stockPerVillager": 6,
	"stockFloor": 320,
	"wantFloor": 20,
	// 石/金囤到这么多以上时，每种最多留这么多矿工，多出来的人手还给粮/木。
	// 上限必须高于"上城报价"：手册写的是 Town→City 要 1000 石 + 1000 金，
	// 旧的 600 会在半路就把矿工全部撤走，于是永远差那一口。
	"mineStockCap": 1400,
	"maxMineWorkers": 8,
	// 核对宽限：新实体的 id 要等 id 扫描走到才看得见，判"没出现地基"不能太急
	"verifyGrace": 4,
	"queueGrace": 2,

	"pullMin": 2,
	"pullMax": 2,
	"workerFloor": 0.1,
	"nodeRadius": 26,
	"assignRadius": 120,

	// 劳力底线（运营教程的硬约束，不是按缺口算出来的）：
	//   minerFloor —— 场上有矿点就必须给石/金这么多人。上城要 1000 石 + 1000 金，
	//     而按份额算的缺口长期只有 1.x 人、过不了 pullMin 的抖动门槛，实测三局石金收入全程为 0。
	//   minerShare —— 但 minerFloor 是绝对值，得有个总预算压着：实测 12 个农民时随机到
	//     minerFloor=5，石+金就要走 10 人，粮木被抽干，田、房整局 0 栋、人口卡 17 后被屠。
	//     玩家的做法是先喂饱吃饭砍树的人，剩下的名额才给矿。
	//   woodFloorShare —— 农民没起满之前伐木至少留这个比例。房、田、生产建筑、科技全吃木头，
	//     实测按"囤货缺口"派人会掉到 0.5 人，16 分钟只盖出 2 间房、人口卡死在 30。
	//   foodFloorShare —— 吃饭的底线。练农民只吃粮，粮仓贴着 0 时训练令被引擎默默丢掉；
	//     实盘一局前 430 秒粮恒为 0，人口冻在 16/30 十六分钟不动。
	//   woodEmergency —— 只差木头就盖不起下一栋房时，把这么多人手全压到伐木上。
	//     这是玩家解开"没人砍木→盖不起房→人口顶格→更没人砍木"死锁的动作，
	//     实测木头库存整段贴着 0、Town 因此拖到 11 分钟。
	"minerFloor": 2,
	"minerShare": 0.2,
	"woodFloorShare": 0.28,
	"foodFloorShare": 0.34,
	// "练农民被卡住"多久之内还算缺粮证据
	"foodPanicFor": 45,
	"woodEmergency": 0.5,

	// 卡时代的"专款"：按当前收入算，时代报价能在这么多秒内攒出来时就暂停扩人口开销
	// （教程口径的 timing up）。设得越大越 eager 憋时代，越小越偏向继续铺房子。
	"squeezeEta": 120,

	// 驻军回收：军事副驾默认不再关村民（被骚扰时是"走开"），但伤兵仍会进建筑，
	// 而且旧存档/手动关人也要能自动收拾。视野里没有敌人 = 立刻放人；
	// 敌人还看得见时，要超过 unloadThreat 并安稳 unloadWait 秒才放（和军事侧的
	// civilianDanger=45 之间留出一条宽带，避免一个塞一个放来回弹）。
	"unloadThreat": 90,
	"unloadWait": 12,
	// 引擎的拒绝原因读不到，"永久跳过"必须有保质期：
	// 实测连吃三次"人口满/暂时没资源"的拒绝就把农民训练彻底关掉，经济当场饿死
	"deadRetry": 150,
	// 每次重新搁置都把间隔翻倍，最多 15 分钟：既不会永久放弃，也不会每分钟浪费一条命令
	"deadRetryMax": 900,
	// 某种资源有人手要、却连续这么多秒一个人都没在采 → 报警
	"stallAlert": 75
};

// 打法 → 基础兵种份额，再按敌方编制修正
var g_SuperbrainShares = {
	"field": { "pikeman": 0.20, "sword": 0.18, "ranged": 0.30, "cav": 0.10, "hcav": 0.14, "siege": 0.08 },
	"hold": { "pikeman": 0.28, "sword": 0.20, "ranged": 0.34, "cav": 0.06, "hcav": 0.08, "siege": 0.04 },
	"push": { "pikeman": 0.16, "sword": 0.22, "ranged": 0.24, "cav": 0.12, "hcav": 0.10, "siege": 0.16 },
	"harass": { "pikeman": 0.06, "sword": 0.08, "ranged": 0.26, "cav": 0.20, "hcav": 0.36, "siege": 0.04 },
	"retreat": { "pikeman": 0.26, "sword": 0.22, "ranged": 0.34, "cav": 0.08, "hcav": 0.08, "siege": 0.02 }
};

var g_SuperbrainBuckets = ["pikeman", "sword", "ranged", "cav", "hcav", "siege"];
var g_SuperbrainResources = ["food", "wood", "stone", "metal"];

// 想产某类兵却找不到生产建筑时，去建造菜单里找这类建筑
var g_SuperbrainProducer = {
	"pikeman": ["Barracks"],
	"sword": ["Barracks"],
	"ranged": ["Barracks"],
	"cav": ["Stable"],
	"hcav": ["Stable"],
	"siege": ["Siege"]
};

class SuperbrainEconomy
{
	constructor(ctx)
	{
		this.ctx = ctx || {};
		this.cfg = Object.assign({}, g_SuperbrainEconConfig);
		this.tplCache = {};
		// 每拍重算：为什么该上矿的人没上（无矿点/无人手/预算截胡），断供告警会带出原因
		this.pullBlock = {};
		// 这一拍"想盖却盖不起"的那栋建筑报价，交给劳力调度决定要不要压人去砍木
		this.blockedCost = null;
		// 下一个时代的报价（{food:500, wood:500} 这种），"专款"规则用它判断该按住哪种资源
		this.phaseCost = null;
		// 引擎拒绝地基时给的理由（领地/地形/占地），每拍重算，导出到状态里
		this.placeFails = {};
		// 这一拍还剩多少次引擎地基校验（见 spotFor）
		this.placeBudget = g_SuperbrainEconConfig.placeBudget;
		// 工地保活：锁在在建地基上的人（见 keepSites）
		this.locked = {};
		this.buildSites = 0;
		this.crewCap = null;
		this.log = [];
		this.mem = {
			"lastPass": -999,
			"summary": null,
			"hist": [],
			"income": {},
			// 毛收入（采到的总量）与累计支出：净收入会被"边采边花"抹平成 0，
			// 而"多久能攒够时代报价"必须看毛收入
			"gross": {},
			"spent": {},
			"expect": [],
			"fails": {},
			// 找地基：被引擎否过的格子（按模板记）与"越找不到越往外找"的半径加量
			"badSpots": {},
			"spotGrow": {},
			// 在建地基 → 派去的builder，以及上一次看到的血量（判断有没有人真的在建）
			"siteCrew": {},
			"siteHp": {},
			// construct 已下令、地基还没可见的那段空档
			"pendingSites": {},
			// 最近一次"练农民练不动"的时刻：缺粮保底的证据
			"trainBlockedAt": 0,
			"failCount": {},
			"dead": {},
			"deadHits": {},
			"lastBuild": {},
			"assigned": {},
			// 我们亲自下令去采哪种资源：引擎不给"谁在采什么"，这条是自己的账本
			"role": {},
			"wantAQ": {},
			"safeSince": null,
			"stall": {},
			"alerts": [],
			"buildable": null
		};
	}

	configure(patch)
	{
		Object.assign(this.cfg, patch || {});
	}

	note(message)
	{
		this.log.push(message);
		if (this.log.length > 12)
			this.log.shift();
		if (this.ctx.log)
			this.ctx.log(message);
	}

	key()
	{
		return Array.prototype.join.call(arguments, "|");
	}

	// ---------------------------------------------------------------- 模板与数值

	tpl(template)
	{
		if (!this.tplCache[template])
		{
			const data = this.ctx.getTemplate ? (this.ctx.getTemplate(template) || {}) : {};
			this.tplCache[template] = {
				"cost": data.cost || {},
				"classes": data.visibleIdentityClasses || data.identityClasses || [],
				"pop": (data.cost && data.cost.population) || 0,
				"bonus": (data.population && data.population.bonus) || 0,
				"time": (data.cost && data.cost.time) || 0,
				"radius": this.footprintRadius(data),
				"drop": (data.resourceDropsite && data.resourceDropsite.types) || null
			};
		}
		return this.tplCache[template];
	}

	footprintRadius(data)
	{
		const fp = data.footprint || {};
		let r = 6;
		if (fp.square)
			r = Math.max(parseFloat(fp.square.width) || 0, parseFloat(fp.square.depth) || 0) / 2;
		else if (fp.circle)
			r = parseFloat(fp.circle.radius) || r;
		return Math.max(r, 3);
	}

	is(template, cls)
	{
		return this.tpl(template).classes.indexOf(cls) >= 0;
	}

	isStructure(template)
	{
		return String(template).indexOf("structures/") === 0 ||
			String(template).indexOf("foundation|") === 0;
	}

	/** 民兵身上同时挂着 Civilian 与 Soldier，只有不带 Soldier 的才是真农民。 */
	isCivilian(template)
	{
		return this.is(template, "Civilian") && !this.is(template, "Soldier");
	}

	bucket(template)
	{
		if (!template)
			return null;

		const c = this.tpl(template).classes;
		const name = String(template).split("/").pop();
		const mounted = c.indexOf("Cavalry") >= 0 || c.indexOf("Mounted") >= 0;
		const ranged = c.indexOf("Ranged") >= 0;

		if (c.indexOf("Siege") >= 0 || /siege|ram|catapult|ballista|onager|bolt/.test(name))
			return "siege";
		if (mounted && ranged)
			return "hcav";
		if (mounted)
			return "cav";
		if (ranged)
			return "ranged";
		if (/spear|pike|hoplite|javelin/.test(name))
			return "pikeman";
		if (c.indexOf("Melee") >= 0)
			return "sword";
		return null;
	}

	costOf(template, count)
	{
		const cost = this.tpl(template).cost;
		const out = {};
		for (const r in cost)
			if (r !== "time" && r !== "population" && cost[r] > 0)
				out[r] = cost[r] * (count || 1);
		return out;
	}

	// ---------------------------------------------------------------- 花钱闸门

	/**
	 * share 是这类开销能动用的存量比例：军费只能花经济挑剩的钱；
	 * minReserve 保证账上永远留底，不至于被一波兵抽干到连房都盖不起。
	 */
	afford(cost, share)
	{
		for (const r in cost)
		{
			const have = this.wallet[r] || 0;
			if (have - cost[r] < this.cfg.minReserve)
				return false;
			if (cost[r] > have * (share == null ? 1 : share))
				return false;
		}
		return true;
	}

	pay(cost)
	{
		for (const r in cost)
		{
			this.wallet[r] = (this.wallet[r] || 0) - cost[r];
			// 累计花了多少：库存净变化只能算出"剩下来的收入"，
			// 而"能不能很快攒够时代报价"要看毛收入（采到的总量）
			this.mem.spent[r] = (this.mem.spent[r] || 0) + cost[r];
		}
	}

	/** 整批扣钱：引擎按 count 一次结清，所以能不能下、下几个都要按整批算。 */
	affordableCount(cost, want)
	{
		let n = want;
		for (const r in cost)
		{
			const room = (this.wallet[r] || 0) - this.cfg.minReserve;
			n = Math.min(n, Math.floor(room / cost[r]));
		}
		return Math.max(n, 0);
	}

	scaled(cost, n)
	{
		const out = {};
		for (const r in cost)
			out[r] = cost[r] * n;
		return out;
	}

	blocked(key, now)
	{
		const dead = this.mem.dead[key];
		if (dead != null)
		{
			// "永久跳过"不能真的永久：引擎的拒绝理由读不到，
			// 而"这一拍没资源/人口满了"和"这个建筑确实训不了这个变体"长得一模一样。
			// 实测前者连吃三次就把农民训练永久关掉，经济当场饿死。
			// 所以搁置有保质期，并且每搁一次间隔翻倍（封顶 deadRetryMax）：
			// 真训不了的组合每分钟浪费不到一条命令，暂时卡住的组合迟早还会被再试一次。
			const hits = this.mem.deadHits[key] || 1;
			if (now - dead < Math.min(this.cfg.deadRetry * hits, this.cfg.deadRetryMax))
				return true;
			this.mem.dead[key] = null;
			this.mem.failCount[key] = 2;
		}

		const at = this.mem.fails[key];
		if (at != null && now - at < this.cfg.retryCooldown)
			return true;

		// 同类建筑之间留间隔：一次食物短缺就开五块田、一口气把镇子塞满房子，
		// 都是把木头锁死在没有产出的东西上
		const done = this.mem.lastBuild[key];
		return done != null && now - done < this.cfg.buildPace;
	}

	fail(key, now, why)
	{
		this.mem.fails[key] = now;
		// 连吃三次拒绝就先搁置（Kush 的房子 trainer 里挂着 units/kush/support_civilian_house，
		// 引擎却永远不接受这个训练令 —— 一直重试只是白扔命令预算）。
		// 搁置有保质期，见 blocked()：暂时性拒绝不该判死刑。
		this.mem.failCount[key] = (this.mem.failCount[key] || 0) + 1;
		if (this.mem.failCount[key] >= 3)
		{
			this.mem.deadHits[key] = (this.mem.deadHits[key] || 0) + 1;
			this.mem.dead[key] = now;
		}
		this.note("引擎未受理 " + key + "（" + why + "）" +
			(this.mem.dead[key] != null ? "，搁置约 " +
				Math.round(Math.min(this.cfg.deadRetry * this.mem.deadHits[key], this.cfg.deadRetryMax)) +
				" 秒" : "，冷却 " + this.cfg.retryCooldown + " 秒"));
	}

	push(op)
	{
		if (this.ops.length >= this.cfg.maxOps)
			return false;
		this.ops.push(op);
		return true;
	}

	get busy()
	{
		return this.ops.length >= this.cfg.maxOps;
	}

	dist(a, b)
	{
		const dx = a.x - b.x;
		const dz = a.z - b.z;
		return Math.sqrt(dx * dx + dz * dz);
	}

	// ---------------------------------------------------------------- 主入口

	plan(world)
	{
		if (!this.cfg.enabled || !world || !world.player)
			return { "ops": [], "summary": { "off": true } };

		if (world.now - this.mem.lastPass < this.cfg.passEvery)
			return { "ops": [], "summary": this.mem.summary, "skipped": true };

		this.mem.lastPass = world.now;
		this.world = world;
		this.ops = [];
		this.wallet = Object.assign({}, world.player.resources || {});
		this.mem.buildable = null;
		// 盖不起来的账每拍重算：capacity() 会重新写，劳力调度只看这一拍的证据
		this.blockedCost = null;
		this.placeFails = {};
		// 每拍都重记"这一拍为什么没开工"：实盘工地长期为 0 时，光看结果分不出
		// 是没钱、没点、没人还是没床位，有这个字段控制台一眼能看到主因
		this.buildBlock = null;
		this.placeBudget = this.cfg.placeBudget;

		this.index(world);
		this.measure(world);
		this.verify(world);

		// 兵种配比要在盖生产建筑之前定下来，否则缺什么都不知道
		this.armyMix = this.desiredMix(world, this.foeClasses(world));

		// 先记下下一个时代的报价：后面的"专款"规则要知道我们在攒什么
		this.fundPhase(world);
		// 工地保活要在劳力调度之前：被锁在地基上的人不能进采集池
		this.keepSites(world);

		// 顺序即优先级：先保命（放人、农民、人口、科技），再把劳力摆正，最后才谈出兵。
		// 调度排在 army 之前是实测逼出来的：过去它排最后，前面几类命令把每拍 8 条预算吃光，
		// 于是"某资源 0 人"的紧急抽调一整局都轮不到一次
		this.unbunker(world);
		this.villagers(world);
		this.capacity(world);
		if (this.cfg.tech)
			this.techs(world);
		this.assignWorkers(world);
		this.army(world);
		this.watchStall(world);
		if (this.cfg.repair)
			this.repairs(world);

		const summary = {
			"pop": world.player.pop,
			"popCap": this.popCap,
			"civilians": this.civPop,
			// 真实村民造价（粮）：复盘"人口为什么不涨"必须看它和库存的差，别再用猜的数
			"civCost": this.villagerFoodCost(),
			"wantCivilians": this.villagerTarget,
			"workers": this.workers.length,
			// 工地锁走的builder不在这个数里：人口在涨而这个数不涨，就是采集池被抽干了
			"builders": Object.keys(this.locked || {}).length,
			"buildSites": this.buildSites || 0,
			"bunkered": this.bunkered.length,
			"ownRows": world.own.length,
			"idle": this.idleWorkers.length,
			"threatDist": world.threatDist == null ? null : Math.round(world.threatDist),
			"cc": this.ccs.length,
			"houses": this.houses.length,
			"fields": this.fields.length,
			"producers": this.prod.length,
			"soldiers": this.milPop,
			// 军队目标是跟着敌方规模算出来的：这两个数并排看就知道"备多少"和"对面多少"差多远
			"armyWant": this.armyWant(),
			"foeSoldiers": this.foeSoldiers(),
			"income": this.roundIncome(),
			"gatherers": this.gathererCounts,
			"wantGatherers": this.wantGatherers,
			// 有多少农民既不在任何采集点旁边、也不在账本里：调度全靠估，这个数字越大越要警惕
			"untracked": this.untracked || 0,
			"phaseCost": this.phaseCost || null,
			// 这一拍被引擎否掉的地基长什么样：不导出的话"盖不出田"只能靠猜
			"placeFails": this.placeFails,
			"buildBlock": this.buildBlock,
			"slots": this.slots,
			"nodes": this.nodeCounts(),
			"mix": this.armyMix,
			"wallet": this.wallet,
			"alerts": this.mem.alerts.slice(),
			"ops": this.ops.map(o => o.op + (o.template ? ":" + String(o.template).split("/").pop() : "")),
			"log": this.log.slice(-4)
		};

		this.mem.summary = summary;
		return { "ops": this.ops, "summary": summary };
	}

	roundIncome()
	{
		const out = {};
		for (const r in this.mem.income)
			out[r] = Math.round(this.mem.income[r] * 100) / 100;
		return out;
	}

	index(world)
	{
		this.ccs = [];
		this.civSources = [];
		this.houses = [];
		this.fields = [];
		this.prod = [];
		this.units = [];
		this.workers = [];
		this.soldiers = [];
		this.bunkered = [];
		this.dropsites = [];
		this.structures = [];
		this.phaseBuildings = 0;
		this.repairList = [];
		this.byId = {};

		for (const e of world.own)
		{
			this.byId[e.id] = e;

			// 引擎用 "foundation|xxx" 前缀表示在建地基：它还不具备任何功能，
			// 既不能当 dropsite 也不能当生产建筑，只用于核对上一拍的建造指令
			const base = String(e.t).replace(/^foundation\|/, "");
			e.base = base;
			e.foundation = base !== e.t;

			const t = this.tpl(base);
			e.radius = t.radius;

			if (e.foundation)
				continue;

			if (t.drop)
			{
				e.dropTypes = t.drop;
				this.dropsites.push(e);
			}
			if (e.needsRepair)
				this.repairList.push(e);

			if (!this.isStructure(base))
			{
				this.units.push(e);

				// 驻军中的单位既不能采集也不能作战（军事副驾躲骚扰会把村民关进主城，
				// 关着的时候引擎不给他们 position，看不见就等于丢了整个人口）
				if (e.holder)
				{
					this.bunkered.push(e);
					continue;
				}

				if (this.isCivilian(base))
					this.workers.push(e);
				else if (this.bucket(base))
					this.soldiers.push(e);
				continue;
			}

			const civ = (e.trainer || []).find(x => this.isCivilian(x));
			e.milTemplates = (e.trainer || []).filter(x => this.bucket(x));

			// 上阶段有建筑数量要求（Village→Town 要 5 栋，农田和栅栏不算），
			// 光看资源够不够会一直卡在"钱够了但结构数不足"，实测就这么在村阶段待到终局
			this.structures.push(e);
			if (!this.is(base, "Field") && !/palis|wall|gate/.test(base))
				++this.phaseBuildings;

			// 会训平民的建筑不一定是人口建筑：实测 Kush 的房子里也挂着 trainer
			// （训练一个 house 变体的平民）。所以分类只认 CivilCentre 或 dropsite，
			// trainer 里的平民另外记给 civSources 用，两边都不误。
			if (this.is(base, "CivilCentre") || (civ && t.drop))
			{
				this.ccs.push(e);
				e.civilianTemplate = civ;
			}
			else if (this.is(base, "House"))
				this.houses.push(e);
			else if (this.is(base, "Field"))
				this.fields.push(e);

			if (civ)
			{
				e.civilianTemplate = civ;
				if (this.ccs.indexOf(e) < 0)
					this.civSources.push(e);
			}

			if (e.milTemplates.length)
				this.prod.push(e);
		}

		// classCounts 是引擎记账；读不到才按实体数
		const cls = world.player.classes || {};
		this.civPop = cls.Civilian != null ? cls.Civilian : this.workers.length;
		this.milPop = cls.Soldier != null ? cls.Soldier : this.soldiers.length;
		this.popCap = world.player.popCap || this.sumPopCap() || 20;
		this.gathererCounts = this.readGatherers(world.player.gatherers);
		this.home = this.ccs[0] || this.dropsites[0] || world.own[0] || { "x": 0, "z": 0 };
		this.idleWorkers = this.workers.filter(w => w.idle);
		this.nodesByKind = this.indexNodes(world.nodes);

		// 引擎会复用实体 id：死掉的农民的位置可能变成另一个单位。
		// 账本只认"现在确实还是个农民"的 id，否则会把陌生人算成矿工、把缺口藏起来。
		for (const id in this.mem.role)
			if (!this.workers.some(w => String(w.id) === String(id)))
				delete this.mem.role[id];
	}

	/** 引擎的 resourceGatherers 在不同版本里可能是 {food:n} 或 {food:{total:n}}。 */
	readGatherers(raw)
	{
		const out = {};
		for (const r of g_SuperbrainResources)
			out[r] = 0;
		if (!raw)
			return out;

		for (const r of g_SuperbrainResources)
		{
			const v = raw[r];
			if (typeof v === "number")
				out[r] = v;
			else if (v && typeof v.total === "number")
				out[r] = v.total;
			else if (v)
			{
				let sum = 0;
				for (const k in v)
					if (typeof v[k] === "number")
						sum += v[k];
				out[r] = sum;
			}
		}
		return out;
	}

	/** 引擎没给 popLimit 时按建筑的人口加成估（房舍与主城都带 population.bonus）。 */
	sumPopCap()
	{
		let n = 0;
		for (const e of this.ccs.concat(this.houses))
			n += this.tpl(e.base).bonus;
		return n;
	}

	indexNodes(nodes)
	{
		const out = {};
		for (const r of g_SuperbrainResources)
			out[r] = [];

		for (const n of nodes || [])
		{
			if (!out[n.kind])
				continue;
			if (n.supply != null && n.supply <= 0)
				continue;
			out[n.kind].push(n);
		}

		for (const k in out)
			out[k].sort((a, b) => this.dist(a, this.home) - this.dist(b, this.home));

		// 引擎会告诉每个资源点能同时挂几个人（maxGatherers）。
		// 把某个资源的目标人数算到坑位数以外，只会让农民来回逛街。
		this.slots = {};
		this.hasSlotData = false;
		for (const r of g_SuperbrainResources)
		{
			let cap = 0;
			for (const n of out[r])
			{
				if (n.cap != null)
				{
					cap += n.cap;
					this.hasSlotData = true;
				}
			}
			this.slots[r] = cap;
		}

		return out;
	}

	/** 这个点还有空位挂人吗。 */
	nodeOpen(n)
	{
		if (n.cap == null || n.used == null)
			return true;
		return n.used < n.cap;
	}

	/** 每种资源看得见多少个点 —— 现场判断"抽空某人种资源"是不是合理。 */
	nodeCounts()
	{
		const out = {};
		for (const r of g_SuperbrainResources)
			out[r] = (this.nodesByKind[r] || []).length;
		return out;
	}

	/** 净收入：资源差分（已扣掉我们自己的消费），够判断哪种资源真缺。 */
	measure(world)
	{
		const res = world.player.resources || {};
		const sample = { "t": world.now };
		for (const r of g_SuperbrainResources)
		{
			sample[r] = res[r] || 0;
			// 花掉的那部分要一起记：只比库存的话，一边采一边花的资源会算出"收入 0"
			sample["paid_" + r] = this.mem.spent[r] || 0;
		}

		const hist = this.mem.hist;
		hist.push(sample);
		while (hist.length > 14)
			hist.shift();

		if (hist.length >= 2)
		{
			const a = hist[0];
			const b = hist[hist.length - 1];
			const dt = Math.max(b.t - a.t, 0.1);
			const income = {};
			const gross = {};
			for (const r of g_SuperbrainResources)
			{
				// income = 库存净变化（会为了攒报价而憋着不花的那种）
				income[r] = (b[r] - a[r]) / dt;
				// gross = 采到的总量 = 净变化 + 这段时间花掉的
				gross[r] = ((b[r] - a[r]) + (b["paid_" + r] - a["paid_" + r])) / dt;
			}
			this.mem.income = income;
			this.mem.gross = gross;
		}
	}

	/** 上一拍下的意图，这一拍核对是否落地。 */
	verify(world)
	{
		const keep = [];
		const now = world.now;

		for (const e of this.mem.expect)
		{
			const grace = e.kind === "queue" ? this.cfg.queueGrace : this.cfg.verifyGrace;
			if (now - e.at < grace)
			{
				keep.push(e);
				continue;
			}

			let landed = false;

			if (e.kind === "queue")
			{
				const ent = this.byId[e.entity];
				landed = !!(ent && ent.queue && ent.queue.some(
					q => q.unitTemplate === e.template || q.technologyTemplate === e.template));
				if (!landed && ent)
				{
					this.fail(e.key, now, "队列没长大");
					// 记一笔"想练农民却没练成"：粮仓见底时这就是唯一证据
					//（引擎不告诉拒绝原因，只能从"队列没动"倒推）
					if (this.isCivilian(e.template))
						this.mem.trainBlockedAt = world.now;
				}
			}
			else if (e.kind === "construct")
			{
				// 落地必须认"**新出现**的那个实体"，不能只看"26 格内有同名建筑"：
				// 旁边早就有一块田时，老判定把旧田当成命令生效，于是每拍 clearFail 清零，
				// 45 秒冷却形同虚设 —— 实测一局里同一条放不下的建田命令刷了 389 次。
				const fresh = this.world.own.filter(o => !e.seen || e.seen.indexOf(String(o.id)) < 0);
				landed = fresh.some(o => (o.base || o.t) === e.template && this.dist(o, e) < 26);
				if (!landed)
					this.fail(e.key, now, "没出现地基");
			}
			else if (e.kind === "unload")
			{
				// 一个都没出来才算失败：引擎是逐拍往外丢人的，先出来几个也算落地
				const still = e.ids.filter(id => this.byId[id] && this.byId[id].holder).length;
				landed = still < e.ids.length;
				if (!landed)
					this.fail(e.key, now, "驻军没放出来");
			}

			// 落地了就清零：搁置间隔只对"一直在失败"的键翻倍，不继承历史包袱
			if (landed)
				this.clearFail(e.key);
		}

		this.mem.expect = keep;
	}

	clearFail(key)
	{
		delete this.mem.fails[key];
		this.mem.failCount[key] = 0;
		this.mem.deadHits[key] = 0;
		this.mem.dead[key] = null;
	}

	expect(kind, key, fields, now)
	{
		this.mem.expect.push(Object.assign({ "kind": kind, "key": key, "at": now }, fields));
	}

	// ---------------------------------------------------------------- 驻军回收

	/**
	 * 把关在建筑里的人放出来。
	 * 军事副驾只负责往主城里塞人躲骚扰（它没有"什么时候算安全"的判断），
	 * 而驻军中的村民既不采粮也不伐木：实测 18 个村民被关之后经济只剩 1 个劳力，
	 * 木头断供 → 盖不起房 → 人口上限卡在 30 → 出不了兵 → 二十分钟后被 AI 平推。
	 * 所以"什么时候回去干活"归经济管，并与塞人之间留迟滞，免得来回弹。
	 */
	unbunker(world)
	{
		if (!this.bunkered.length)
		{
			this.mem.safeSince = null;
			return;
		}

		const threat = world.threatDist;
		if (threat != null && threat < this.cfg.unloadThreat)
		{
			this.mem.safeSince = null;
			return;
		}

		// 视野里一个敌人都没有：立刻放人，一秒都不多关（关着的农民不产任何东西）
		const urgent = threat == null;

		if (!urgent)
		{
			if (this.mem.safeSince == null)
				this.mem.safeSince = world.now;
			if (world.now - this.mem.safeSince < this.cfg.unloadWait)
				return;
		}
		this.mem.safeSince = null;

		const byHolder = {};
		for (const u of this.bunkered)
			(byHolder[u.holder] = byHolder[u.holder] || []).push(u.id);

		for (const h in byHolder)
		{
			const key = this.key("unload", h);
			if (this.blocked(key, world.now))
				continue;

			if (!this.push({ "op": "unload", "holder": +h, "entities": byHolder[h] }))
				break;

			this.expect("unload", key, { "holder": +h, "ids": byHolder[h] }, world.now);
			delete this.mem.fails[key];
		}

		// 放完一批重新计时：引擎逐拍把人往外丢，没必要每拍都往同一个门口下命令
		this.mem.safeSince = world.now;
	}

	/**
	 * 资源断供预警：某种资源明明排了人手，却长时间一个人都没在采。
	 * 外部大脑靠这个字段报警，比靠人盯 HUD 靠谱。
	 */
	watchStall(world)
	{
		const now = world.now;
		for (const r of g_SuperbrainResources)
		{
			const want = (this.wantGatherers && this.wantGatherers[r]) || 0;
			const have = (this.gathererCounts && this.gathererCounts[r]) || 0;
			const stuck = want >= 1 && have < want * 0.5 && (this.nodeCounts()[r] || 0) > 0;

			if (!stuck)
			{
				this.mem.stall[r] = null;
				continue;
			}
			if (this.mem.stall[r] == null)
				this.mem.stall[r] = now;
			else if (now - this.mem.stall[r] > this.cfg.stallAlert)
			{
				// 带上"为什么没抽到人"：没矿点、没人手、还是预算被截胡，处置完全不同
				const why = this.pullBlock && (this.pullBlock[r] || (this.pullBlock.busy ? "本拍命令预算用尽" : null));
				const msg = r + " 断供 " + Math.round(now - this.mem.stall[r]) +
					" 秒（应有 " + want.toFixed(1) + " 人，实际 " + have + " 人" + (why ? "；卡点：" + why : "") + "）";
				if (this.mem.alerts.indexOf(msg) < 0)
				{
					this.mem.alerts.push(msg);
					while (this.mem.alerts.length > 4)
						this.mem.alerts.shift();
					this.note(msg);
				}
			}
		}
	}

	// ---------------------------------------------------------------- 卡时代
	/**
	 * 记住下一个时代的报价，交给"专款"规则用（见 hoardBlocks）。
	 * 时代科技挂在主城，报价卡住后面所有兵种与建筑，晚一分钟上城就晚一分钟出重装。
	 */	fundPhase(world)
	{
		this.phaseCost = null;
		// 关掉科技就没什么时代报价可攒（科技总开关是 tech，没有单独的 phase 键）
		if (!this.cfg.tech)
			return;

		// 这里只看"下一个时代要多少钱"，不看它现在能不能研究：
		// 面板要凑够建筑栋数才让点（techRequirementsMet=false），
		// 若按可研究性过滤，栋数没满时报价恒为 null，"攒时代专款"整局都不会触发。
		let rank = 0;
		for (const e of world.own)
		{
			for (const raw of (e.techs || []))
			{
				if (!raw)
					continue;
				for (const tech of (raw.pair ? [raw.bottom, raw.top] : [raw]))
				{
					const name = typeof tech === "string" ? tech : (tech && tech.template);
					if (!name || !/^phase_/.test(name) || this.hasTech(name))
						continue;
					const r = /empire/.test(name) ? 3 : /city/.test(name) ? 2 : 1;
					const cost = this.techCost(tech);
					if (!cost)
						continue;
					// 只认最近的下一时代（等级号更小的那个），已经上过的时代不再当目标
					if (!rank || r < rank)
					{
						rank = r;
						this.phaseCost = cost;
					}
				}
			}
		}
	}

	/**
	 * 工地保活：地基没人建就永远建不完，而引擎不会替我们留住builder。
	 * 实盘证据（Alpine Lakes）：三块田的地基分别建到 61/250、91/250、36/250 之后血量
	 * 再没动过 —— 劳力调度每十几秒就把人从工地上抽回去采集，结果 20 分钟一栋没盖完。
	 * 玩家的做法是"一栋盖完再开下一栋"，所以这里同时限制开工数量（maxSites）。
	 * 续建走 repair：引擎里点已有地基就是这个命令（unit_actions.js 的 repair，
	 * 音效都是 order_build）。
	 */
	keepSites(world)
	{
		const live = world.own.filter(e => e.foundation);
		const alive = {};
		for (const s of live)
			alive[s.id] = s;

		// 地基建完或被拆：人立刻回到采集池
		for (const k in this.mem.siteCrew)
		{
			if (alive[k])
				continue;
			delete this.mem.siteCrew[k];
			delete this.mem.siteHp[k];
		}

		// construct 下令到地基可见之间有一拍空档：那批人由 pendingSites 代管，
		// 空档里也必须算"在工地上"，否则同一拍就被采集调度抽走（实盘的弃建就是这么来的）
		for (const k in this.mem.pendingSites)
		{
			const p = this.mem.pendingSites[k];
			if (world.now - p.at > this.cfg.siteAdopt)
			{
				delete this.mem.pendingSites[k];
				continue;
			}
			for (const s of live)
			{
				if (this.mem.siteCrew[s.id] || s.base !== p.template || this.dist(s, p) > 6)
					continue;
				this.mem.siteCrew[s.id] = this.freeCrew(p.crew);
				this.mem.siteHp[s.id] = { "hp": s.hp, "at": world.now };
				delete this.mem.pendingSites[k];
				break;
			}
		}

		// 兵临城下先放人：锁在工地上的人既不能采集也来不及躲，
		// 实测人口从 16 掉到 5 的那一分钟里还有 2 人被钉在地基上。
		// 地基本身不会消失，安全之后同一套逻辑会回去续建。
		const danger = world.threatDist != null && world.threatDist < this.cfg.siteDanger;
		if (danger)
		{
			this.mem.siteCrew = {};
			this.mem.pendingSites = {};
		}

		this.locked = {};
		const lockAll = ids =>
		{
			for (const id of ids)
				if (this.byId[id] && !this.byId[id].holder)
					this.locked[id] = true;
		};
		for (const k in this.mem.siteCrew)
			lockAll(this.mem.siteCrew[k]);
		for (const k in this.mem.pendingSites)
			lockAll(this.mem.pendingSites[k].crew);

		// 工地最多吃掉这么多人手比例：没有这道闸，开局 5 个农民会被锁走 2 个
		// 去盖房+开田，采集池直接归零、粮从 100 掉到 5，房子还是没盖完
		const perSite = Math.max(1, this.cfg.buildersPerSite);
		const pool = this.workers.length + Object.keys(this.locked).length;
		let crewCap = danger ? 0 : Math.floor(pool * this.cfg.builderShare / perSite);
		if (!danger && pool >= 3 && crewCap < 1)
			crewCap = 1;
		// build() 要按同一个上限决定"还开不开新工地"
		this.crewCap = crewCap;

		this.dropLocked();

		// 先把最接近完工的盖完：四块工地同时开工等于四块都建不完
		live.sort((a, b) => (b.hp / (b.maxHp || 1)) - (a.hp / (a.maxHp || 1)));

		// 只有"真的有人在建"的工地才算数：一个都派不出人时不能把所有建造都锁死
		let staffed = 0;
		for (const s of live)
			if (this.freeCrew(this.mem.siteCrew[s.id] || []).length)
				++staffed;
		this.buildSites = staffed + Object.keys(this.mem.pendingSites).length;

		let onDuty = Object.keys(this.locked).length;
		for (const s of live.slice(0, Math.min(this.cfg.maxSites, crewCap)))
		{
			let crew = this.freeCrew(this.mem.siteCrew[s.id] || []);
			const at = this.mem.siteHp[s.id];
			// 血量多少秒没涨 = 没人在建，重新派（人可能被别的命令截走了）
			const stalled = !crew.length || (at && at.hp === s.hp && world.now - at.at > this.cfg.siteStall);
			if (!stalled)
				continue;

			const need = Math.min(perSite, crewCap * perSite - onDuty);
			if (need > 0 && crew.length < need)
				crew = crew.concat(this.takeBuilders(s, need - crew.length));
			if (!crew.length)
				continue;

			if (this.push({ "op": "repair", "entities": crew, "target": s.id }))
			{
				onDuty += crew.length;
				for (const id of crew)
				{
					this.locked[id] = true;
					this.mem.assigned[id] = world.now;
					// 工地上的人不采任何资源，账本要先销掉，否则缺口被假人数藏住
					delete this.mem.role[id];
				}
				this.mem.siteCrew[s.id] = crew;
				this.dropLocked();
			}
			this.mem.siteHp[s.id] = { "hp": s.hp, "at": world.now };
		}
	}

	/** 只认还能干活的：驻军/阵亡的 id 不能继续当builder派令目标 */
	freeCrew(ids)
	{
		return (ids || []).filter(id => this.byId[id] && !this.byId[id].holder);
	}

	/** 把锁在工地上的人从采集池里摘掉（每拍重算，index() 会重新填满池子）。 */
	dropLocked()
	{
		if (!this.locked)
			this.locked = {};
		this.workers = (this.workers || []).filter(w => !this.locked[w.id]);
		this.idleWorkers = (this.idleWorkers || []).filter(w => !this.locked[w.id]);
	}

	/** 从池子里取 n 个人去工地：离地基近的优先，取走的同时就锁住。 */
	takeBuilders(site, n)
	{
		const out = [];
		const pool = this.workers
			.filter(w => !this.locked[w.id])
			.sort((a, b) => this.dist(a, site) - this.dist(b, site));

		for (const w of pool)
		{
			if (out.length >= n)
				break;
			out.push(w.id);
			this.locked[w.id] = true;
		}
		return out;
	}

	/**
	 * 只差粮就能上时代时，先停止练农民。
	 * 农民的单价正是时代报价里的那笔粮：实盘两局 20 分钟都是"木头/石头早达标、
	 * 粮永远 100 出头"，因为农民目标一路加，粮一进账就被当场吃掉，时代按钮永远点不下去。
	 * 只在"别的资源都齐了、只剩粮，且按毛收入 squeezeEta 秒内攒得出"时收口 ——
	 * 无条件停练兵会把发展一起掐死（离线实测上城从 787 秒退到 867 秒）。
	 */
	phaseWaitsForFood()
	{
		const q = this.phaseCost;
		if (!q || this.phaseBuildings < this.cfg.townBuildings)
			return false;

		for (const r in q)
		{
			if (r === "food" || !q[r])
				continue;
			if ((this.wallet[r] || 0) < q[r])
				return false;
		}

		const gap = q.food - (this.wallet.food || 0);
		if (gap <= 0)
			return false;
		const rate = (this.mem.gross || {}).food || 0;
		return rate > 0.01 && gap / rate <= this.cfg.squeezeEta;
	}

	/**
	 * 教程口径的 timing up：时代报价按当前收入能在 squeezeEta 秒内攒出来时，
	 * 就把这笔钱当专款，不再花去扩人口（盖房/开田）。
	 * 实测收入 10 木/秒、报价 500 木，但木头一过 100 就被一间房吃掉，
	 * 11 分钟才凑齐上城报价 —— 玩家的做法是"这段时间不盖房"，而不是继续把钱花光。
	 * 用"多久能攒够"当触发条件而不是"已经攒够多少"：库存永远被花光时，
	 * 按比例（旧写法要 65% 才生效）根本不会触发，规则等于没写。
	 * 阶段要求的建筑栋数没满时不设限：那几栋本身就是上城的条件。
	 */
	hoardBlocks(cost)
	{
		const quote = this.phaseCost;
		if (!quote || this.phaseBuildings < this.cfg.townBuildings)
			return false;

		let eta = 0;
		let kinds = 0;
		for (const r in quote)
		{
			const need = quote[r];
			if (!need)
				continue;
			++kinds;
			const gap = need - (this.wallet[r] || 0);
			if (gap <= 0)
				continue;
			const rate = (this.mem.gross || {})[r] || 0;
			// 收入读不出来或为零：按"最坏情况"处理，别为了一个攒不出的目标停掉发展
			if (rate <= 0.01)
				return false;
			eta = Math.max(eta, gap / rate);
		}
		if (!kinds)
			return false;

		// 攒得越慢越不值得憋：只有"很快就能上时代"时才暂停扩张
		if (eta > this.cfg.squeezeEta)
			return false;

		for (const r in cost)
		{
			const need = quote[r];
			// 花完这一笔就越过了报价线 —— 这一笔就是上时代的钱
			if (need && cost[r] && (this.wallet[r] || 0) < need)
				return true;
		}
		return false;
	}

	// ---------------------------------------------------------------- 农民

	villagers(world)
	{
		// 要多少农民由野心值定，人口上限只是物理约束；
		// 但上限里要给军队留出兵役位，否则农民把每一格都吃干，兵要到十分钟之后才出得来
		const room = Math.max(
			this.popCap - this.armyReserve(),
			Math.min(this.cfg.minVillagers, this.popCap));
		this.villagerTarget = Math.min(this.cfg.villagerCap, room);

		if (!this.villagerSources().length)
			return;

		const queued = this.countQueued(t => this.isCivilian(t));
		const need = this.villagerTarget - this.civPop - queued;

		if (need <= 0)
		{
			// 到量就把挂机补农民关掉：引擎的 autoqueue 只认人口上限，
			// 不认我们要多少农民，任它跑下去就是把兵役位吃干
			for (const cc of this.villagerSources())
				this.setAutoqueue(cc, false);
			return;
		}

		for (const cc of this.villagerSources())
			this.setAutoqueue(cc, this.cfg.autoqueue);

		for (const cc of this.villagerSources())
		{
			if (this.busy)
				return;

			const template = cc.civilianTemplate;
			if (!template)
				continue;

			const key = this.key("train", cc.id, template);
			if (this.blocked(key, world.now))
				continue;

			const head = cc.queue && cc.queue[0];
			if (head && this.isCivilian(head.unitTemplate))
				continue;

			const cost = this.costOf(template, 1);
			// 只差粮就能上时代：先把这笔粮留住，农民等上完城再补
			if (this.phaseWaitsForFood())
			{
				this.setAutoqueue(cc, false);
				continue;
			}
			const batch = this.affordableCount(cost, Math.min(need, 4));
			if (!batch)
			{
				// 训不起农民本身就是"扩人口被挡住"的第一手证据，必须记下来：
				// 旧写法只在"令下出去却没落地"时才记，而买不起时命令根本不会下发，
				// 缺粮急救（assignWorkers 的 foodFloorShare）于是永远不触发 ——
				// 实盘粮恒 71（低于 造价+留底）、农 15 人九分钟只多出 3 个，最后全村被推平。
				this.mem.trainBlockedAt = world.now;
				return;
			}

			if (this.push({ "op": "train", "entity": cc.id, "template": template, "count": batch }))
			{
				this.pay(this.scaled(cost, batch));
				this.expect("queue", key, { "entity": cc.id, "template": template }, world.now);
				delete this.mem.fails[key];
			}
			return;
		}
	}

	/** 别对同一座建筑反复发同一条 autoqueue：状态没变就不占命令预算。 */
	setAutoqueue(cc, on)
	{
		const want = on ? 1 : 0;
		if (cc.autoqueue === on || this.mem.wantAQ[cc.id] === want)
		{
			this.mem.wantAQ[cc.id] = want;
			return;
		}
		if (this.push({ "op": on ? "autoqueue-on" : "autoqueue-off", "entities": [cc.id] }))
		{
			this.mem.wantAQ[cc.id] = want;
			cc.autoqueue = on;
		}
	}

	/**
	 * 能训平民的建筑。实测：Kush 房子的 trainer 里挂着 support_civilian_house，
	 * 但引擎永远不接受这个训练令 —— 把房子当农民来源只会白扔命令预算。
	 * 所以只认主城，civSources 留给"主城被打光/Mod 文明用别的建筑当人口建筑"兜底。
	 */
	villagerSources()
	{
		return this.ccs.length ? this.ccs : this.civSources;
	}

	/** 下一个农民的粮价（真实模板造价，不是猜的常量）—— 缺粮急救的门槛就用这把尺子。 */
	villagerFoodCost()
	{
		const cc = this.villagerSources()[0];
		if (!cc || !cc.civilianTemplate)
			return 0;
		return this.costOf(cc.civilianTemplate, 1).food || 0;
	}

	countQueued(test)
	{
		let n = 0;
		for (const e of this.villagerSources().concat(this.prod))
			for (const q of e.queue || [])
				if (q.unitTemplate && test(q.unitTemplate))
					n += q.count || 1;
		return n;
	}

	queuedPop()
	{
		let n = 0;
		for (const e of this.villagerSources().concat(this.prod))
			for (const q of e.queue || [])
				if (q.unitTemplate)
					n += this.tpl(q.unitTemplate).pop * (q.count || 1);
		return n;
	}

	// ---------------------------------------------------------------- 人口上限与建筑

	capacity(world)
	{
		if (this.busy)
			return;

		const free = this.popCap - world.player.pop - this.queuedPop();

		// 盖房是为了装下"农民野心 + 军队野心"，不是为了让农民比例好看。
		// 两种触发都要认：① 剩余格子不够（正常推进时的提前量）；
		// ② 农民已经练满目标 —— 兵役预留会把农民目标压到上限以下，
		// 只看剩余格子的话永远等不到盖房的条件（实测人口卡死在 13/20，木头全烂在仓库里）。
		// 已经超上限时也别盖 —— 那说明上限口径和实际兵力不符（Mod 兵、升级、实验台作弊码）。
		const atTarget = this.civPop >= this.villagerTarget;
		// 上阶段的结构数量要求（Town 要 5 栋非农田建筑）是另一种"卡口"：
		// 钱早就够了却上不去，实测就是这么在村阶段挂到终局。房子是最便宜的可计栋数建筑。
		const shortStructures = this.phaseBuildings < this.cfg.townBuildings;
		// 真没床位 / 栋数不够时，房子优先于时代专款：实测石头金块囤到 340/310 花不掉，
		// 而木料被"攒 500 上城"扣着不盖房，床位冻死 → 农民练不出 → 收入不涨 → 报价更慢。
		const urgent = free <= this.cfg.popHeadroom || shortStructures;
		// 试过"先开田再盖房"（田 100 木/块、永久产粮，看着比 10 个人口格子值）：
		// 实测把木头抽干，房子/生产建筑/科技全卡住，人口 @300 秒从 19 掉到 14、
		// 上城从 714 秒退到 884 秒 —— 顺序保持"房 → 主城 → 田"。
		if ((urgent || atTarget) &&
			this.popCap < this.popAmbition() && world.player.pop <= this.popCap)
			this.build(world, ["House"], this.cfg.buildersPerSite, 1, null, null, urgent ? false : undefined);

		// 人口顶格、还想继续扩、木头石头也囤着没地方花，才值得再落一座主城
		// （+20 上限，顺带多个 dropsite）。地基必须离老主城 200 以上，
		// 所以往"远处还没人采的资源群"方向找点，而不是在家门口乱转。
		if (world.player.pop >= this.popCap - 1 && this.ccs.length < 6 &&
			this.popCap < this.popAmbition() && this.popCap >= 60)
		{
			const anchor = this.newTownAnchor();
			if (anchor)
				this.build(world, ["CivilCentre"], 4, 0.9, anchor, 60);
		}

		this.maybeFarms(world);

		if (this.cfg.buildings && !this.busy)
			this.missingProducers(world);
	}

	/** 远处资源最密的一团 = 新城市选址；一团都没有就沿最远的资源方向开。 */
	newTownAnchor()
	{
		let best = null;
		let bestCount = 0;

		for (const kind of ["wood", "stone", "metal"])
			for (const n of this.nodesByKind[kind] || [])
			{
				const d = this.dist(n, this.home);
				if (d < 110 || d > 260)
					continue;
				const count = (this.nodesByKind[kind] || [])
					.filter(o => this.dist(o, n) < 26).length;
				if (count > bestCount)
				{
					bestCount = count;
					best = n;
				}
			}

		if (best)
			return best;

		const far = (this.nodesByKind.wood || [])[0];
		return far && this.dist(far, this.home) > 110 ? far : null;
	}

	maybeFarms(world)
	{
		if (!this.cfg.farms || this.busy)
			return;

		const inc = this.mem.income.food || 0;
		const stock = (world.player.resources || {}).food || 0;

		// 只在"真的吃不上了"才动土：收入转正、库存也不浅时开田，等于把木头埋进地里
		if (inc > 0.6 && stock > this.cfg.minReserve * 3)
			return;

		// 已经有人在采田就够了，别一口气开一片（田要等人采得动才有意义）
		const farms = (this.nodesByKind.food || []).filter(n => String(n.t).indexOf("field") >= 0);
		if (farms.length >= this.cfg.farmTarget)
			return;

		// 田要贴着能收食物的 dropsite 放，少跑冤枉路
		const anchor = this.dropsites.find(d => (d.dropTypes || []).indexOf("food") >= 0) || this.home;
		this.build(world, ["Field"], this.cfg.buildersPerSite, 1, anchor, 34);
	}

	/**
	 * 从引擎的建造菜单里按类别挑当前该盖的建筑，不硬编码模板名 ——
	 * 换文明、换版本、换 Mod 都不用动这里。
	 */
	findBuildable(classes)
	{
		if (!this.ctx.buildable)
			return null;
		if (!this.workers.length)
		{
			// 全村死光/还没人时别说"菜单里没这个建筑"，那是两回事
			this.buildBlock = "没人能去盖（一个可用农民都没有）";
			return null;
		}

		// 菜单要定期重问引擎：一次性缓存 = 科技解锁的建筑（以及刚建好的第二座主城）
		// 整局都进不来；实测 Kush 的田就是这么被永久卡在"菜单里没有"的
		const now = (this.world && this.world.now) || 0;
		if (!this.mem.buildable || now - (this.mem.buildableAt || -1e9) > 10)
		{
			this.mem.buildable = this.ctx.buildable(this.workers[0].id) || [];
			this.mem.buildableAt = now;
		}

		// 这里只管"本文明能不能盖这一类"；在不在失败回避期里由 build() 自己判并说清楚，
		// 否则"上次找点失败"会被误报成"菜单里没这个建筑"，排查方向整个错掉
		for (const cls of classes)
		{
			const hit = this.mem.buildable.find(t => this.is(t, cls));
			if (hit)
				return hit;
		}
		return null;
	}

	/** 盖一类建筑：算钱、找地基、派劳力。crew 是玩家会随手圈的那几个人。 */
	build(world, classes, crew, share, anchor, radius, guard)
	{
		if (this.busy)
			return null;

		const template = this.findBuildable(classes);
		if (!template)
		{
			this.buildBlock = classes[0] + " 的模板在本文明建造菜单里找不到";
			return null;
		}

		const cost = this.costOf(template, 1);
		// guard === false 的开销不吃时代专款：生产建筑不能因为攒上城的钱而不出兵营，
		// 没床位的房子也不能——冻住床位就练不了农民，采集人数不涨，报价反而更攒不出来
		const hoard = guard !== false && this.hoardBlocks(cost);
		if (!this.afford(cost, share == null ? 1 : share) || hoard)
		{
			// 把"想盖却盖不起"的报价留给劳力调度：库存贴着 0 时按份额算缺口永远只给 1~2 人，
			// 而玩家在这种局面是直接把大半农民压去砍树，先凑够下一栋房
			this.blockedCost = cost;
			this.buildBlock = classes[0] + (hoard ? " 在为时代报价存钱" :
				" 买不起（要 " + JSON.stringify(cost) + "）");
			return null;
		}

		// 手头的地基没盖完就先别开新工地：开四个等于四个都建不完，
		// 还把木头全压在"没有产出的半成品"上。能开几个由 keepSites 按人手比例算（crewCap）
		const siteCap = Math.min(this.cfg.maxSites, this.crewCap == null ? this.cfg.maxSites : this.crewCap);
		if (this.buildSites >= siteCap)
		{
			this.buildBlock = classes[0] + " 工地已满 " + this.buildSites + "/" + siteCap +
				"（crewCap " + this.crewCap + "）";
			return null;
		}

		const key = this.key("build", template);
		if (this.blocked(key, world.now))
		{
			this.buildBlock = classes[0] + " 在失败回避里（连拒 " + (this.mem.failCount[key] || 0) +
				" 次 · " + (this.mem.dead[key] != null ? "已搁置" : "退让中") + "）";
			return null;
		}
		const grow = (this.mem.spotGrow || {})[key] || 0;
		let spot = this.spotFor(template, anchor || this.home, (radius || this.cfg.placeRadius) + grow);
		// 贴着 dropsite 找不到位置时回退到主城周围再找一次：山地/湖开局里 dropsite 周边
		// 经常一块平地都没有
		if (!spot && anchor && anchor !== this.home)
			spot = this.spotFor(template, this.home, this.cfg.placeRadius + grow);
		if (!spot)
		{
			// 这是我们没找出点，不是引擎拒绝。走 fail() 会三次就把这类建筑搁置 5~15 分钟，
			// 实测农田因此整局只有 2 块。这里只按 retryCooldown 退让一拍，
			// 同时把下一次的搜索半径加大，越找不到越往外找。
			this.mem.spotGrow = this.mem.spotGrow || {};
			this.mem.spotGrow[key] = Math.min(grow + 14, 46);
			this.mem.fails[key] = world.now;
			this.buildBlock = classes[0] + " 找不到合法地基（" +
				(this.topPlaceFail() || "没有试得出来的候选点") + "）";
			this.note(this.buildBlock);
			return null;
		}
		if (grow)
			this.mem.spotGrow[key] = 0;

		const ids = this.pickWorkers(spot, crew || 2);
		if (!ids.length)
		{
			this.buildBlock = classes[0] + " 抽不出builder（采集池 " + this.workers.length +
				" 人，锁 " + Object.keys(this.locked || {}).length + " 人）";
			return null;
		}

		if (this.push({ "op": "construct", "entities": ids, "template": template, "x": spot.x, "z": spot.z, "angle": spot.angle }))
		{
			this.pay(cost);
			this.mem.lastBuild[key] = world.now;
			// 从下令这一拍起这批人就归工地管，等地基出现后由 keepSites 接管：
			// 空档里不锁住的话，同一拍的采集调度就把人抽走了（实盘整局弃建的成因）
			this.mem.pendingSites[template + "@" + spot.x + "," + spot.z] = {
				"template": template, "x": spot.x, "z": spot.z,
				"crew": ids.slice(), "at": world.now
			};
			// 当场就要计数：否则同一拍里第二、第三个 build() 看到的还是 0 个工地，
			// 开局 5 个农民直接被锁走 2 个（实测粮仓整段贴 0、人口冻在 16）
			this.buildSites = (this.buildSites || 0) + 1;
			for (const id of ids)
			{
				this.locked[id] = true;
				delete this.mem.role[id];
			}
			this.dropLocked();
			// 下单时已有的实体 id 一起存进核对表：见 verify() 的 construct 分支
			this.expect("construct", key, {
				"template": template, "x": spot.x, "z": spot.z,
				"seen": Object.keys(this.byId)
			}, world.now);
			return template;
		}
		return null;
	}

	pickWorkers(at, count)
	{
		const now = this.world.now;
		const near = list => list
			.filter(w => !this.recentlyAssigned(w.id))
			.sort((a, b) => this.dist(a, at) - this.dist(b, at));

		const out = [];
		for (const w of near(this.idleWorkers).concat(near(this.workers)))
		{
			if (out.length >= count)
				break;
			if (out.indexOf(w.id) < 0)
				out.push(w.id);
		}

		for (const id of out)
		{
			this.mem.assigned[id] = now;
			// 被叫去盖房/修墙的人这段时间不采任何资源，账本要先销掉，
			// 否则他会被算成"还在采石头"，把真实缺口藏起来
			delete this.mem.role[id];
			const i = this.idleWorkers.indexOf(this.byId[id]);
			if (i >= 0)
				this.idleWorkers.splice(i, 1);
		}
		return out;
	}

	recentlyAssigned(id)
	{
		const at = this.mem.assigned[id];
		return at != null && this.world.now - at < 12;
	}

	/**
	 * 螺旋找点。canPlace 走的是玩家拖建筑时那条 GuiInterface 校验，
	 * 通过即等于绿框，不会让农民白跑一趟。
	 */
	spotFor(template, anchor, radius)
	{
		const r = this.tpl(template).radius;
		const bad = this.badSpots(template);
		const now = this.world.now;
		// 一拍的引擎探测预算：单个模板最多 placeTries 次，全局最多 placeBudget 次
		let tries = Math.min(this.cfg.placeTries, this.placeBudget);
		const phase = (now % 6) / 6 * Math.PI;

		// 起始环只要越过"锚点占地 + 新建筑占地"，不再人为加间隙：引擎对每栋建筑都要求
		// 落在自己领地内（template_structure.xml 的 BuildRestrictions/Territory=own），
		// 多出来的间隙把第一环推到领地边缘外，每一环都在圈外 → 实测一整局只盖出 2 块田。
		let ring = r + this.anchorClear(anchor) + 1;
		const step = Math.max(5, Math.round(r * 0.6));

		while (ring <= radius + r && tries > 0)
		{
			for (let i = 0; i < 16; ++i)
			{
				// 一拍的引擎探测预算在环内也要收口，否则一整环 16 个点会一起把预算打穿
				if (tries <= 0)
					break;
				const a = phase + (i / 16) * Math.PI * 2;
				const at = { "x": anchor.x + Math.cos(a) * ring, "z": anchor.z + Math.sin(a) * ring };
				const cell = this.cellOf(at);
				if (bad[cell] > now)
					continue;

				// 自家几何检查很便宜，不占探测预算；占预算的是引擎校验
				if (!this.clearOfNeighbours(at, r))
					continue;
				--tries;
				--this.placeBudget;
				const ok = this.ctx.canPlace ? this.ctx.canPlace(template, at.x, at.z, 0) : true;
				if (ok !== true)
				{
					bad[cell] = now + this.cfg.badSpotTtl;
					this.notePlaceFail(ok);
					continue;
				}

				return { "x": Math.round(at.x * 10) / 10, "z": Math.round(at.z * 10) / 10, "angle": 0 };
			}
			ring += step;
		}
		return null;
	}

	/** 6 米一格：被否过的格子短期内不再浪费探测预算。 */
	cellOf(at)
	{
		return Math.round(at.x / 6) + "|" + Math.round(at.z / 6);
	}

	badSpots(template)
	{
		if (!this.mem.badSpots)
			this.mem.badSpots = {};
		if (!this.mem.badSpots[template])
			this.mem.badSpots[template] = {};
		const map = this.mem.badSpots[template];
		const now = this.world.now;
		let n = 0;
		for (const k in map)
			++n;
		if (n > 400)
		{
			for (const k in map)
				if (map[k] <= now)
					delete map[k];
		}
		return map;
	}

	/** 引擎把拒绝理由写在 result.message 里，丢掉它就只能靠猜，所以统计出来导出。 */
	notePlaceFail(reason)
	{
		const k = String(reason || "unknown").slice(0, 48);
		this.placeFails[k] = (this.placeFails[k] || 0) + 1;
	}

	topPlaceFail()
	{
		let best = null;
		for (const k in this.placeFails)
			if (!best || this.placeFails[k] > this.placeFails[best])
				best = k;
		return best;
	}

	/** 锚点周围多大一圈是不能压的（主城占地 32，田占地 15，差别很大）。 */
	anchorClear(anchor)
	{
		if (!anchor || !anchor.t)
			return 6;
		const base = String(anchor.t).replace(/^foundation\|/, "");
		return this.tpl(base).radius;
	}

	clearOfNeighbours(at, r)
	{
		// 同一拍里刚下令、还没出现在实体表里的地基也要避开：
		// 引擎校验看到的是"上一拍的世界上"的两个点，各自都合法，落到 sim 里却重叠被拒
		for (const k in this.mem.pendingSites)
		{
			const p = this.mem.pendingSites[k];
			if (this.dist(p, at) < r + this.tpl(p.template).radius + 3)
				return false;
		}

		for (const e of this.world.own)
		{
			if (!this.isStructure(e.t) || e.id === at.id)
				continue;
			if (this.dist(e, at) < r + (e.radius || this.tpl(e.t).radius) + 3)
				return false;
		}
		return true;
	}

	// ---------------------------------------------------------------- 科技

	techs(world)
	{
		// 每拍只买一项，但要在**所有**能研究的建筑里挑最高分，而不是"扫到第一个能买的就买"：
		// 时代科技挂在主城，而实体顺序里兵营/仓库经常排在主城前面，那些便宜科技每拍都能
		// 抢走唯一的研究位，实测 Town 因此被压到 11 分钟（教程口径 8–10 分钟，
		// 而时代卡住后面所有兵种和建筑）。
		let best = null;
		for (const e of world.own)
		{
			if (!e.techs || !e.techs.length || (e.queue && e.queue.length))
				continue;

			// 时代科技不吃 techShare 折扣：那笔钱就是 squeezeEta 专门攒出来的，
			// 再扣一层缓冲会让"已就绪"到"真下单"白白多等一分多钟（实测 88 秒）
			const t = this.pickTech(e, world, x =>
				!this.blocked(this.key("research", e.id, x.template), world.now) &&
				this.afford(x.cost, /^phase_/.test(x.template || "") ? 1 : this.cfg.techShare));
			if (t && (!best || t.score > best.score))
				best = { "entity": e.id, "t": t };
		}
		if (!best)
			return;

		const key = this.key("research", best.entity, best.t.template);
		if (this.push({ "op": "research", "entity": best.entity, "template": best.t.template }))
		{
			this.pay(best.t.cost);
			this.expect("queue", key, { "entity": best.entity, "template": best.t.template }, world.now);
		}
	}

	/** GUI 作用域的 researchedTechs 是 {科技名: 时间} 表，AI 作用域是数组：两边都要能判。 */
	hasTech(name)
	{
		const techs = (this.world || {}).player ? this.world.player.techs : null;
		if (!techs)
			return false;
		// 科技名可能带文明后缀（Kush 报的是 phase_town_generic），精确匹配会漏
		const hit = k => k === name || String(k).indexOf(name + "_") === 0;
		if (Array.isArray(techs))
			return techs.some(hit);
		for (const k in techs)
			if (hit(k))
				return true;
		return false;
	}

	/**
	 * 从某栋建筑的科技里挑"现在买得起的最优先项"。
	 * 只取最高分那一个然后"买不起就拉倒"是错的：实测攒 City 的 1000 石 1000 金 期间，
	 * 一整段便宜的人力/攻防科技全被顶在前头没买，兵和农民同时吃亏。
	 * @param viable  可选性过滤（按预算筛），返回 false 的候选直接跳过继续找下一个
	 */
	pickTech(ent, world, viable)
	{
		let best = null;
		let bestScore = 0;

		for (const raw of ent.techs)
		{
			// 引擎会在这里留空洞，还会塞进"上下二选一"的成对科技容器：
			// 容器自己没有 template，真正的科技在 bottom/top 上（官方面板也是这么展开的）
			if (!raw)
				continue;

			for (const tech of (raw.pair ? [raw.bottom, raw.top] : [raw]))
			{
				const picked = this.scoreTech(tech, world, best, bestScore);
				if (!picked)
					continue;
				if (viable && !viable(picked.best))
					continue;

				best = picked.best;
				bestScore = picked.score;
			}
		}
		if (!best)
			return null;
		// 带上分数：调用方要能跨建筑比较（时代科技必须由主城那一项胜出，而不是靠扫描顺序）
		return Object.assign({ "score": bestScore }, best);
	}

	scoreTech(tech, world, best, bestScore)
	{
		if (!tech)
			return null;

		const name = typeof tech === "string" ? tech : tech.template;
		if (!name)
			return null;
		if (this.hasTech(name))
			return null;
		if (this.blocked(this.key("techreq", name), world.now))
			return null;

		if (this.ctx.techRequirementsMet && !this.ctx.techRequirementsMet(tech))
		{
			this.mem.fails[this.key("techreq", name)] = world.now;
			return null;
		}

		const cost = this.techCost(tech);
		const phase = /^phase_/.test(name);

		// 时代科技优先：它卡住后面所有兵和建筑
		let score = phase ? 100 : 12;
		if (/resource|worker|food|farm|town|civic|support|health/.test(name))
			score += 8;
		if (!phase && this.needsTech(name))
			score += 22;
		score -= this.costWeight(cost) / 40;

		if (score <= bestScore)
			return null;

		return { "best": { "template": name, "cost": cost, "phase": phase }, "score": score };
	}

	techCost(tech)
	{
		if (tech.cost)
			return tech.cost;

		const name = typeof tech === "string" ? tech : tech.template;
		if (this.ctx.getTech && name)
		{
			const data = this.ctx.getTech(name, this.world.player.civ) || {};
			return data.cost || {};
		}
		// 不知道价格就按通用价估一个，宁可少花也别卡住队列
		return { "food": 100, "wood": 100 };
	}

	costWeight(cost)
	{
		let sum = 0;
		for (const r in cost)
			if (r !== "time")
				sum += cost[r];
		return sum;
	}

	/** 已经在产某类兵，就该买它的攻防科技。 */
	needsTech(name)
	{
		if (!this.armyMix)
			return false;

		const buckets = g_SuperbrainBuckets.filter(b => this.armyMix[b] > 0.12);
		if (!buckets.length)
			return false;
		if (!/attack|armour|armor|shield|hack|crush|pierce|range|accuracy|masonry|mire/.test(name))
			return false;
		if (/cavalry|horse|mounted|rider/.test(name))
			return buckets.indexOf("cav") >= 0 || buckets.indexOf("hcav") >= 0;
		if (/infantry|spear|sword|hoplite/.test(name))
			return buckets.indexOf("sword") >= 0 || buckets.indexOf("pikeman") >= 0;
		if (/archer|sling|javelin|mangonel|siege|bolt/.test(name))
			return buckets.indexOf("ranged") >= 0 || buckets.indexOf("siege") >= 0;
		return true;
	}

	// ---------------------------------------------------------------- 军队生产

	/** 这一桶兵到底造不造得出来：已有产兵建筑覆盖，或建造菜单里已经解锁对应的厂。 */
	canProduce(bucketName)
	{
		if (this.prod.some(e => (e.milTemplates || []).some(t => this.bucket(t) === bucketName)))
			return true;
		const classes = g_SuperbrainProducer[bucketName];
		return !!(classes && this.findBuildable(classes));
	}

	foeClasses(world)
	{
		const foe = {};
		for (const f of world.foes || [])
			for (const k in (f.classes || {}))
				foe[k] = (foe[k] || 0) + f.classes[k];
		return foe;
	}

	army(world)
	{
		const budget = this.armyBudget(world);
		if (budget <= 0 || !this.prod.length || this.busy)
			return;

		const popFree = this.popCap - world.player.pop - this.queuedPop() - this.countQueued(t => this.isCivilian(t));
		if (popFree <= 0)
			return;

		// 军费只能吃经济挑剩的存量：先把预算按份额锁死，
		// 否则一波兵下去账上见底，连房和科技都停摆
		this.milBudget = {};
		this.milSpent = {};
		for (const r of g_SuperbrainResources)
			this.milBudget[r] = Math.max(0, (this.wallet[r] || 0) - this.cfg.minReserve) * this.cfg.armyShare;

		const have = this.currentMix();
		// 配比是"整支军队"的目标构成，不是"还差的那点兵"的构成：
		// 拿剩余名额去乘比例会算出一支小得多的军队，然后提前收手
		const ambition = this.armyWant();
		const order = g_SuperbrainBuckets
			.map(b => ({ "b": b, "gap": this.armyMix[b] * ambition - (have[b] || 0) }))
			// 这一桶压根没有落脚点（没厂、菜单里也还没解锁）时不要排队：
			// 实测攻城桶整局占着队首，每拍空转一遍还刷"造不出生产建筑"
			.filter(x => x.gap > 0.5 && this.canProduce(x.b))
			.sort((a, b) => b.gap - a.gap);

		for (const ent of this.prod)
		{
			if (this.busy)
				break;

			const head = ent.queue && ent.queue[0];
			if (head && head.unitTemplate && this.bucket(head.unitTemplate))
				continue;

			for (const item of order)
			{
				const template = (ent.milTemplates || []).find(t => this.bucket(t) === item.b);
				if (!template)
					continue;

				const key = this.key("train", ent.id, template);
				if (this.blocked(key, world.now))
					continue;

				const cost = this.costOf(template, 1);
				if (!this.affordMil(cost))
					continue;

				if (this.push({ "op": "train", "entity": ent.id, "template": template, "count": 1 }))
				{
					this.payMil(cost);
					this.expect("queue", key, { "entity": ent.id, "template": template }, world.now);
				}
				break;
			}
		}
	}

	affordMil(cost)
	{
		for (const r in cost)
		{
			if (cost[r] > (this.milBudget[r] || 0) - (this.milSpent[r] || 0))
				return false;
			if ((this.wallet[r] || 0) - cost[r] < this.cfg.minReserve)
				return false;
		}
		return true;
	}

	payMil(cost)
	{
		for (const r in cost)
		{
			this.wallet[r] = (this.wallet[r] || 0) - cost[r];
			this.milSpent[r] = (this.milSpent[r] || 0) + cost[r];
		}
	}

	/**
	 * 看得见的敌方当兵数量（引擎按身份类别给的 Soldier 计数）。
	 * 这是"备多少兵"的唯一外部依据 —— 视野外的兵看不见，所以它天然偏保守。
	 */
	foeSoldiers()
	{
		let n = 0;
		for (const f of (this.world && this.world.foes) || [])
			n += (f.classes && f.classes.Soldier) || 0;
		return n;
	}

	/** 军队想要的兵役人口：外部大脑给死数字就用数字，否则跟着敌方规模走。 */
	armyWant()
	{
		if (this.cfg.militaryTarget > 0)
			return this.cfg.militaryTarget;
		if (this.cfg.armyCap > 0)
			return this.cfg.armyCap;
		const base = Math.round(this.cfg.villagerCap * 0.7);
		return Math.max(base, Math.ceil(this.foeSoldiers() * this.cfg.armyRatio));
	}

	popAmbition()
	{
		return this.cfg.villagerCap + this.armyWant();
	}

	/** 兵役位随上限一起涨，但不会超过军队真的想要的数量。 */
	armyReserve()
	{
		// 还没有任何军事生产建筑时不预留：空着的兵役位只能被农民吃掉，
		// 等兵营落地了再按份额留，前期农民起量更快
		if (!this.prod.length)
			return 0;
		return Math.min(this.armyWant(), Math.floor(this.popCap * this.cfg.armyPopShare));
	}

	armyBudget(world)
	{
		const queued = this.countQueued(t => !!this.bucket(t));
		return Math.max(0, this.armyWant() - this.milPop - queued);
	}

	desiredMix(world, foe)
	{
		const doctrine = g_SuperbrainShares[world.doctrine] ? world.doctrine : "field";
		const out = Object.assign({}, g_SuperbrainShares[doctrine]);

		const foeUnits = (foe.Soldier || 0) + (foe.CitizenSoldier || 0);
		if (foeUnits > 0)
		{
			const share = k => (foe[k] || 0) / Math.max(foeUnits, 1);
			const cav = share("Cavalry");
			const melee = Math.max(share("Melee") - cav, 0);
			const ranged = share("Ranged");

			// 长枪克骑、远程克近战、骑射克射手、攻城只在对面有硬货时才值
			out.pikeman *= 1 + cav * 1.6;
			out.ranged *= 1 + melee * 0.9;
			out.hcav *= 1 + ranged * 1.2;
			out.cav *= 1 + ranged * 0.9;
			out.sword *= 1 + cav * 0.4;
			out.siege *= 1 + (foe.Structure || 0) / 6;
		}

		let sum = 0;
		for (const b of g_SuperbrainBuckets)
			sum += out[b] || 0;
		for (const b of g_SuperbrainBuckets)
			out[b] = (out[b] || 0) / Math.max(sum, 0.001);
		return out;
	}

	currentMix()
	{
		const out = {};
		for (const s of this.soldiers)
		{
			const b = this.bucket(s.t);
			if (b)
				out[b] = (out[b] || 0) + 1;
		}
		for (const e of this.prod)
			for (const q of e.queue || [])
			{
				const b = q.unitTemplate ? this.bucket(q.unitTemplate) : null;
				if (b)
					out[b] = (out[b] || 0) + (q.count || 1);
			}
		return out;
	}

	/** 想产的兵种没有对应生产建筑就盖一个 —— 用户点名要"多兵种"。 */
	missingProducers(world)
	{
		for (const b of g_SuperbrainBuckets)
		{
			if (!this.armyMix || this.armyMix[b] < 0.12)
				continue;

			const classes = g_SuperbrainProducer[b];
			if (!classes)
				continue;

			const covered = this.prod.some(e => (e.milTemplates || []).some(t => this.bucket(t) === b));
			if (!covered)
			{
				// 菜单里根本没有这类建筑时不能闷着不吭声：
				// 实测整局只有一座兵营、马厩/攻城厂一次都没建出来，
				// 从摘要上只看"产兵 1"，看不出是缺木头还是缺前置科技
				if (!this.findBuildable(classes))
				{
					const nk = this.key("note", "producer", b);
					if (!this.blocked(nk, world.now))
					{
						this.note(b + " 造不出生产建筑：建造菜单里没有 " + classes.join("/") + "（多半缺前置科技/地标）");
						this.mem.fails[nk] = world.now;
					}
					continue;
				}
				this.build(world, classes, 3, 0.8, null, null, false);
				return;
			}
		}
	}

	// ---------------------------------------------------------------- 劳力分配

	/**
	 * 该有多少人在采什么：按"接下来一段时间要付的账"加权。
	 * 农民本身就是最大的食料买家，所以食料永远留底。
	 */
	resourceWeights(world)
	{
		const pending = {};
		for (const r of g_SuperbrainResources)
			pending[r] = 0;

		const civCost = this.costOf((this.ccs[0] || {}).civilianTemplate || "", 10);
		for (const r in civCost)
			pending[r] += civCost[r];

		for (const item of this.ops)
		{
			if (!item.template || (item.op !== "train" && item.op !== "construct" && item.op !== "research"))
				continue;
			const cost = this.costOf(item.template, item.count || 1);
			for (const r in cost)
				pending[r] = (pending[r] || 0) + cost[r];
		}

		const stock = world.player.resources || {};
		const horizon = 40;
		const w = {};
		let sum = 0;

		// "还差多少才够囤"要进权重：只看下一笔账的话，囤满的资源照样吃掉一大把人。
		// 实测石头金属各囤到 1300+ 时，副驾还按人均份额派 11 个人去挖金属，
		// 而真正卡脖子的木头只有 1 个人采 —— 于是房子、田、马厩全都盖不出来。
		const target = Math.max(this.cfg.stockFloor, this.cfg.stockPerVillager * this.civPop);

		for (const r of g_SuperbrainResources)
		{
			const inc = this.mem.income[r] || 0;
			const shortfall = (pending[r] || 0) + 60 - (stock[r] || 0) - inc * horizon;
			const restock = Math.max(this.cfg.wantFloor, target - (stock[r] || 0));
			w[r] = Math.max(shortfall, 0) + restock;
			if (r === "food")
				w[r] *= 1.25;
			sum += w[r];
		}
		for (const r in w)
			w[r] /= sum;

		// 每种资源保底一点人手：只按"下一笔账缺什么"分配的话，
		// 缺粮的那几拍会把伐木与采矿抽空，接下来连房和田都盖不出来
		const floor = this.cfg.workerFloor;
		let lifted = 0;
		for (const r of g_SuperbrainResources)
		{
			if (w[r] < floor && (this.slots[r] == null || this.slots[r] > 0))
			{
				lifted += floor - w[r];
				w[r] = floor;
			}
		}
		if (lifted > 0)
		{
			const donors = g_SuperbrainResources.filter(r => w[r] > floor);
			const each = lifted / Math.max(donors.length, 1);
			for (const r of donors)
				w[r] = Math.max(floor, w[r] - each);
		}
		return w;
	}

	/**
	 * 想盖的那栋建筑是不是只差木头（粮/石/金都够付）。
	 * 只有"差的就是木头"才值得压人手：别的资源缺口要靠时间攒，或者根本不该现在花。
	 */
	isWoodShort(stock)
	{
		const cost = this.blockedCost || {};
		if (!(cost.wood > 0) || (stock.wood || 0) >= cost.wood)
			return false;
		for (const r of g_SuperbrainResources)
			if (r !== "wood" && (cost[r] || 0) > (stock[r] || 0))
				return false;
		return true;
	}

	assignWorkers(world)
	{
		const total = this.workers.length;
		if (!total)
			return;

		const w = this.resourceWeights(world);
		const want = {};
		for (const r of g_SuperbrainResources)
			want[r] = w[r] * total;

		// 想把人堆到坑位放不下的资源上，只会让人来回逛街：按可挂坑位封顶，
		// 多出来的份额按比例摊给还有空位的资源
		if (this.hasSlotData)
		{
			let overflow = 0;
			const roomy = [];
			for (const r of g_SuperbrainResources)
			{
				const room = this.slots[r] || 0;
				if (want[r] > room)
				{
					overflow += want[r] - room;
					want[r] = room;
				}
				roomy.push(r);
			}
			if (overflow > 0 && roomy.length)
			{
				const each = overflow / roomy.length;
				for (const r of roomy)
					want[r] += each;
			}
		}
		// 石头/金属囤够了就别再派人挖：这两样只花在科技、升级和要塞上，需求是有顶的。
		// 实测人口 90 时石头金属各吃掉 14 人、粮食只剩 11 人，仓库里堆着 1100+ 的
		// 石金没人要，而兵营在等人 —— 把这部分劳力还给粮/木才是玩家的做法。
		const stock = world.player.resources || {};
		let freed = 0;
		for (const r of ["stone", "metal"])
		{
			if ((stock[r] || 0) > this.cfg.mineStockCap && want[r] > this.cfg.maxMineWorkers)
			{
				freed += want[r] - this.cfg.maxMineWorkers;
				want[r] = this.cfg.maxMineWorkers;
			}
		}
		if (freed > 0)
		{
			const takers = g_SuperbrainResources.filter(r =>
				["stone", "metal"].indexOf(r) < 0 && (this.slots[r] == null || want[r] < this.slots[r]));
			const each = freed / Math.max(takers.length, 1);
			for (const r of takers)
				want[r] += each;
		}

		// 底线覆盖缺口计算：份额加出来的缺口过不了 pullMin，等于"要 1.5 个人但永远不给"
		const floors = { "food": 0, "wood": 0, "stone": 0, "metal": 0 };
		const minerSlots = Math.max(2, Math.round(total * this.cfg.minerShare));
		for (const r of ["stone", "metal"])
		{
			const roomy = (this.slots[r] == null || this.slots[r] > 0) && (this.nodesByKind[r] || []).length;
			if (roomy && (stock[r] || 0) < this.cfg.mineStockCap)
				floors[r] = Math.min(this.cfg.minerFloor, Math.ceil(minerSlots / 2));
		}
		const mine = floors.stone + floors.metal;
		if (mine > minerSlots)
		{
			floors.stone *= minerSlots / mine;
			floors.metal *= minerSlots / mine;
		}
		// 吃饭的底线只在"有证据说缺粮挡住了扩人口"时生效：练农民的令被引擎默默丢掉
		//（粮不够），而粮仓又见底 —— 实盘一局 0~430 秒粮恒为 0、人口冻在 16/30 十六分钟。
		// 恒定留 1/3 人力采粮在离线模拟里会把木头抽干（上城 714s→810s），所以不能无条件开。
		// 见底线试过按真实村民造价算：离线 729s→751s 更慢（把木头抽走了），故留在 minReserve×2。
		const hungry = world.now - (this.mem.trainBlockedAt || -1e9) < this.cfg.foodPanicFor &&
			(stock.food || 0) < this.cfg.minReserve * 2;
		if (this.civPop < this.cfg.villagerCap && hungry)
			floors.food = total * this.cfg.foodFloorShare;
		// 农民没起满之前木头是唯一硬通货：先保证有人砍，再去谈囤够不够
		if (this.civPop < this.cfg.villagerCap)
			floors.wood = total * this.cfg.woodFloorShare;
		// 只差木头就盖不起下一栋房：把这么多人手压到伐木上。
		// 玩家在这种局面是"先砍够一栋房再说话"，而按份额算缺口时木头永远贴着 0
		// ——盖不起房 → 人口顶格 → 练不了兵 → 上时代也遥遥无期。
		if (this.blockedCost && this.isWoodShort(stock) &&
			(this.slots.wood == null || this.slots.wood > want.wood))
			floors.wood = Math.max(floors.wood, total * this.cfg.woodEmergency);

		for (const r of g_SuperbrainResources)
			want[r] = Math.max(want[r], floors[r]);

		// want 是人头分配，不是愿望清单：总和超过人手时调度永远追不上目标，
		// 每一拍都在重排同一批人 → 全村逛街、收入整段归 0（实测 540~820 秒粮木双 0）。
		// 收回的顺序是矿 → 木 → 粮，吃饭的人最后才动。
		let sum = 0;
		for (const r of g_SuperbrainResources)
			sum += want[r];
		let over = sum - total;
		for (const r of ["stone", "metal", "wood", "food"])
		{
			if (over <= 0)
				break;
			const cut = Math.min(over, Math.max(0, want[r] - floors[r]));
			want[r] -= cut;
			over -= cut;
		}
		if (over > 0)
			for (const r of g_SuperbrainResources)
				want[r] *= total / sum;

		this.wantGatherers = want;

		const have = this.estimateAllocation();

		// 闲着的先上岗
		for (const r of g_SuperbrainResources)
		{
			while (this.idleWorkers.length && !this.busy && have[r] < want[r] + 0.5)
			{
				const worker = this.idleWorkers[0];
				const node = this.nodeFor(r, worker);
				if (!node)
					break;
				if (this.push({ "op": "gather", "entities": [worker.id], "target": node.id }))
				{
					this.idleWorkers.shift();
					this.mem.assigned[worker.id] = world.now;
					this.mem.role[worker.id] = r;
					have[r] += 1;
				}
			}
		}

		if (this.busy)
		{
			// 前面的补农民/盖房/科技把这一拍的 8 条预算吃光了：
			// 不记这一笔，"木头 0 人挖了五分钟"看起来就像权重错，其实是根本没轮到手
			this.pullBlock = { "busy": true };
			return;
		}
		// 全花在调人上就没钱盖房练兵了。
		// 为什么没抽到人必须能被看见：断供告警只说"该有 2 人实际 0 人"，
		// 是没人可抽、没有可达矿点、还是预算被前面截胡，处置完全不同。
		this.pullBlock = {};
		for (let round = 0; round < 2 && !this.busy; ++round)
		{
			const rows = list => g_SuperbrainResources
				.map(r => ({ "r": r, "d": list(r) }))
				.sort((a, b) => b.d - a.d);
			const donor = rows(r => have[r] - want[r])[0];
			const need = rows(r => want[r] - have[r])[0];
			// 没有短缺就别动；有短缺但"没有人在富余资源上"时，只要还有一批
			// 定位不到的人（untracked），也值得动一人 —— 玩家看到矿区空着也是随手拉人。
			if (need.d <= 0)
				break;
			if (donor.d <= 0 && (this.untracked || 0) < 1)
			{
				this.pullBlock[need.r] = "没有富余的人手可抽";
				break;
			}

			// 某资源一个人都没有、却有采集点和坑位 = 紧急状况，绕过抖动门槛直接抽人。
			// 石/金就是靠这条活过来的：份额算出来的缺口只有 1.x，永远过不了 pullMin，实测整局 0 收入。
			// 判"0 人"要两条证据：账本位置会随人往返而漂移，引擎的 gatherer 计数更是常年滞后
			// ——实测粮整段 0 产出时两边都说"还有 1.6 个人"，于是 113 秒没人被抽去采粮。
			// 毛收入 = 净变化 + 这段时间花掉的，它才真正回答"这条线有人干活吗"。
			const roomy = (this.slots[need.r] == null || this.slots[need.r] > 0) &&
				(this.nodesByKind[need.r] || []).length;
			const earning = ((this.mem.gross || {})[need.r] || 0) > 0.2 ||
				((this.mem.income || {})[need.r] || 0) > 0.2;
			const urgent = roomy && (have[need.r] === 0 || !earning);
			// 抖动门槛比对的是"能动多少人"，不是"账面富余多少"：
			// 没有富余资源、只有一批定位不到的人时，可动人数就是那批人。
			const spare = donor.d > 0 ? donor.d : Math.max(0, this.untracked || 0);
			if (!urgent && (need.d < this.cfg.pullMin || spare < this.cfg.pullMin))
			{
				this.pullBlock[need.r] = "缺口低于 pullMin（抖动门槛）";
				break;
			}

			const to = this.nodeFor(need.r, this.home);
			if (!to)
			{
				this.pullBlock[need.r] = `${this.cfg.assignRadius} 格内没有可挂的采集点`;
				break;
			}

			const free = x => !x.idle && !this.recentlyAssigned(x.id);
			const byTo = (a, b) => this.dist(a, to) - this.dist(b, to);
			const size = Math.max(1, Math.min(this.cfg.pullMax,
				urgent || donor.d <= 0 ? 1 : Math.floor(donor.d) - 1, Math.ceil(need.d)));
			// 抽人只从"确认在采 donor 那种资源"的人里抽：账本（我们下过的令）或脚下就是那种点，
			// 二者有一条成立才算。凭猜测抽走别人正在采的人，等于按下葫芦浮起瓢。
			// 没有富余资源时改用"没定位到的人" —— 他们本来就没在账上任何资源里。
			const pool = donor.d > 0
				? (x => this.mem.role[x.id] === donor.r || this.nearAny(x, this.nodesByKind[donor.r]))
				: (x => !this.mem.role[x.id] && !this.nearestNodeKind(x));
			let crew = this.workers.filter(x => free(x) && pool(x)).sort(byTo).slice(0, size);
			// 矿区在地图另一头、且该资源一个人都没有时，就近拉人救急
			if (!crew.length && urgent)
				crew = this.workers.filter(x => free(x) && !this.mem.role[x.id]).sort(byTo).slice(0, size);
			if (!crew.length && urgent)
				crew = this.workers.filter(free).sort(byTo).slice(0, size);
			if (!crew.length)
			{
				this.pullBlock[need.r] = "可抽的人手都在冷却里";
				break;
			}

			for (const x of crew)
			{
				if (this.busy)
					break;
				if (this.push({ "op": "gather", "entities": [x.id], "target": to.id }))
				{
					this.mem.assigned[x.id] = world.now;
					// 扣减要按"这个人原本记在哪个资源上"，而不是笼统扣 donor：
					// 从定位不到的池子里抽人时根本不该扣任何资源，否则账面会变成负的
					const from = this.nearestNodeKind(x) || this.mem.role[x.id];
					if (from)
						have[from] -= 1;
					else if (this.untracked > 0)
						--this.untracked;
					this.mem.role[x.id] = need.r;
					have[need.r] += 1;
				}
			}
		}
		if (this.busy)
			this.pullBlock.busy = true;
	}

	nearAny(unit, nodes)
	{
		for (const n of nodes || [])
			if (this.dist(unit, n) < this.cfg.nodeRadius)
				return true;
		return false;
	}

	/**
	 * "谁在采什么"的账。引擎不给这份数据，而采集是"资源点↔仓库"的往返，
	 * 所以人在路上时脚下什么都没有 —— 只按位置估会把大半劳动力算成无人认领。
	 */
	estimateAllocation()
	{
		const out = {};
		for (const r of g_SuperbrainResources)
			out[r] = 0;
		this.untracked = 0;

		// 引擎不给"谁在采什么"：resourceGatherers 常年滞后或报 0，资源点的
		// numGatherers 只算当下挂在点上的那个人。所以认两条证据：
		//   1) 人就站在某个采集点旁边 —— 位置说话，顺便刷新记忆；
		//   2) 没有位置证据时认自己下过的那条 gather 令 —— 采集是"点↔仓库"往返，
		//      人在路上时脚下什么都没有，但这不等于他没在采。
		// 两条都没有的人只能记成"不知道"，绝不能按引擎总数平摊给四种资源：
		// 实测 39 个农民只有 4 个能按位置定位，剩下 35 人被平摊成"石/金各有一堆人在采"，
		// 缺口永远算不出来，于是 minerFloor 明明写了 2，石金还是整局 0 收入。
		for (const w of this.workers)
		{
			if (w.idle)
				continue;

			const seen = this.nearestNodeKind(w);
			if (seen)
			{
				out[seen] += 1;
				this.mem.role[w.id] = seen;
				continue;
			}
			const role = this.mem.role[w.id];
			if (role)
				out[role] += 1;
			else
				++this.untracked;
		}
		// 定位不到的人（既不在点旁、也没有我们的下令记录）按"已有证据的比例"记账，
		// 总数对得上。关键是绝不摊给没有任何证据的资源 —— 一个从没派过人的矿点被摊出
		// "有 6 个人在挖"，等于把缺口藏起来，实测石金整局 0 收入就是这么来的。
		const known = g_SuperbrainResources.reduce((n, r) => n + out[r], 0);
		if (this.untracked > 0 && known > 0)
			for (const r of g_SuperbrainResources)
				out[r] += this.untracked * out[r] / known;
		return out;
	}

	/** 人脚下（nodeRadius 内）是哪个采集点；没有则 null。 */
	nearestNodeKind(w)
	{
		let best = null;
		let bestD = this.cfg.nodeRadius;
		for (const kind in this.nodesByKind)
			for (const n of this.nodesByKind[kind])
			{
				const d = this.dist(w, n);
				if (d < bestD)
				{
					bestD = d;
					best = kind;
				}
			}
		return best;
	}

	nodeFor(kind, near)
	{
		const list = this.nodesByKind[kind] || [];
		if (!list.length)
			return null;

		let best = null;
		let bestScore = Infinity;
		let fallback = null;

		for (const n of list.slice(0, 60))
		{
			if (this.dist(n, near) > this.cfg.assignRadius)
				continue;
			const score = this.dist(n, near) + this.dropPenalty(n, kind);
			const cand = { "n": n, "score": score };
			if (!fallback || score < fallback.score)
				fallback = cand;
			// 满员的点挂不进人，只在所有点都满了才用它
			if (this.nodeOpen(n) && (!best || score < best.score))
				best = cand;
		}
		return (best || fallback || {}).n || null;
	}

	/** 采完要送回 dropsite，路程也计入成本。 */
	dropPenalty(node, kind)
	{
		let min = Infinity;
		for (const d of this.dropsites)
			if ((d.dropTypes || []).indexOf(kind) >= 0)
				min = Math.min(min, this.dist(d, node));
		return min === Infinity ? 0 : min * 0.6;
	}

	// ---------------------------------------------------------------- 维修

	repairs(world)
	{
		for (const e of this.repairList)
		{
			if (this.busy)
				break;

			const ids = this.pickWorkers(e, 2);
			if (!ids.length)
				return;

			this.push({ "op": "repair", "entities": ids, "target": e.id });
		}
	}
}
