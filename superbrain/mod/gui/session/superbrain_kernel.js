/**
 * Superbrain micro kernel
 *
 * 战斗微操决策核心：输入一帧战场快照，输出与玩家鼠标点击等价的命令序列。
 * 这里不碰引擎 IO（不读文件、不 PostNetworkCommand），只做计算，
 * 因此同一份逻辑既能跑在 GUI 作用域（实战副驾），也能跑在 AI 作用域（批量自学习）。
 *
 * world = {
 *   now,            仿真秒
 *   me,             本玩家 id
 *   units: [{ id, t, owner, x, z, hp, maxHp, seen, enemy }],
 *             seen: 3=己方可控 2=当前可见 1=仅最后已知位置
 *   formations,     本玩家可用阵形名（无则不下阵形令）
 *   rally,          {x,z} 玩家集结点
 *   objective,      {x,z} 外部大脑给的目标点
 * }
 * ctx = { getTemplate(template, player), log(msg) }
 */

var g_SuperbrainConfig = {
	"mode": "auto",
	"doctrine": "field",
	"kite": true,

	"resistBase": 0.9,
	"clusterRadius": 42,
	"maxGroups": 6,

	"standoff": 0.8,
	"kiteStep": 12,
	"closeRange": 0.92,
	"standMargin": 1.1,

	"moveCooldown": 0.6,
	"moveEpsilon": 4,
	"retargetCooldown": 0.7,
	"maxOpsPerTick": 14,

	"retreatHp": 0.34,
	"garrisonWounded": true,
	// 村民被骚扰时怎么处理：false = 走开（默认，人还在场上也还能被经济重新派活），
	// true = 关进最近的建筑（只有真被压在家门口才划算，关着的人不产资源）
	"garrisonCivilians": false,
	"civilianDanger": 45,
	"civilianFlee": 30,
	"civilianCalm": 12,
	// 基地压境就全军回防。进/出阈值分开并要求最短保持时间，
	// 否则会在边界上一帧回防一帧继续推，军队来回抖、两边都不打
	"homeGuard": true,
	"homeThreatRadius": 90,
	"homeThreatEnter": 3,
	"homeThreatExit": 1,
	"homeArriveRadius": 26,
	"homeDwell": 15,
	"maxChase": 80,
	"judgeRadius": 110,
	"engageRadius": 70,
	"winMargin": 1,
	"pushGrit": 0.75,
	"edgeMargin": 1.08,
	"rangeEdgeCap": 2.2,
	"attackStructures": false,
	// 指定优先打击的玩家 id（0=按敌对关系自动）。只影响优先级，不影响威胁判定
	"focusPlayer": 0,
	"stance": "aggressive",
	"holdStance": "standground",
	"formation": "line"
};

function round1(v)
{
	return Math.round(v * 10) / 10;
}

class SuperbrainKernel
{
	constructor(ctx)
	{
		this.ctx = ctx || {};
		this.cfg = Object.assign({}, g_SuperbrainConfig);
		this.stats = {};
		this.groups = [];
		this.unitMem = {};
		this.civMem = {};
		this.fight = { "fight": true, "edge": false, "exchange": 0, "foes": 0 };
		// 回防是有记忆的开关：压境/解除各用一套阈值，中间靠 homeDwell 撑住
		this.recall = { "active": false, "since": 0 };
		this.guard = { "active": false, "foes": 0, "ours": 0, "home": null };
		this.log = [];
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

	// ------------------------------------------------------------ 数值模型

	/**
	 * 从 GetTemplateData（已含玩家科技修正）里抽战斗模型。
	 * 伤害按 resistBase^护甲 衰减，默认 0.9：护甲每点减 10% 同类伤害。
	 */
	stat(template, player)
	{
		const key = template + "|" + player;
		if (this.stats[key])
			return this.stats[key];

		const data = this.ctx.getTemplate ? (this.ctx.getTemplate(template, player) || {}) : {};
		const classes = data.visibleIdentityClasses || data.identityClasses || [];
		const speed = data.speed || {};

		const out = {
			"template": template,
			"classes": classes,
			"hp": data.health || 0,
			"walk": speed.walk || 0,
			"run": speed.run || speed.walk || 0,
			"armor": (data.resistance && data.resistance.Damage) || {},
			"structure": template.indexOf("structures/") === 0,
			"ranged": false,
			"cavalry": classes.indexOf("Cavalry") >= 0 || classes.indexOf("Mounted") >= 0,
			// 民兵（citizen-soldier）身上同时挂着 Worker/Citizen 标签，
			// 拿 Worker 判平民会把整支军队都当成农民；只有 Civilian 才是真农民
			"civilian": classes.indexOf("Civilian") >= 0,
			"soldier": classes.indexOf("Soldier") >= 0 || classes.indexOf("Defensive") >= 0,
			"worker": false,
			"support": classes.indexOf("Support") >= 0,
			"healer": false,
			"healRange": data.heal ? data.heal.range : 0,
			"range": 0,
			"cd": 1,
			"damage": {},
			"dps": 0,
			"name": template.split("/").pop()
		};

		out.worker = (out.civilian || classes.indexOf("Worker") >= 0) && !out.soldier;
		out.healer = !!data.heal || classes.indexOf("Healer") >= 0;

		if (data.attack)
		{
			let best = null;
			let bestDps = -1;
			for (const kind in data.attack)
			{
				if (kind === "Capture" || kind === "Slaughter")
					continue;

				const a = data.attack[kind];
				if (!a || a.maxRange == null)
					continue;

				const damage = a.Damage || {};
				let total = 0;
				for (const t in damage)
					total += damage[t];

				const dps = total / Math.max(a.repeatTime || 1000, 1) * 1000;
				if (dps > bestDps)
				{
					bestDps = dps;
					best = a;
					best._damage = damage;
				}
			}

			if (best)
			{
				out.range = best.maxRange || 0;
				out.minRange = best.minRange || 0;
				out.cd = Math.max((best.repeatTime || 1000) / 1000, 0.1);
				out.damage = best._damage || {};
				out.dps = bestDps;
				out.ranged = out.range >= 10;
			}
		}

		out.military = out.dps > 0 && !out.worker && !out.healer;

		this.stats[key] = out;
		return out;
	}

	/** 单次攻击打在某护甲上的伤害。 */
	hitVs(s, armor)
	{
		let sum = 0;
		for (const kind in s.damage)
			sum += s.damage[kind] * Math.pow(this.cfg.resistBase, (armor && armor[kind]) || 0);
		return sum;
	}

	/** 稳定 DPS。target 可以传单位、模型或纯护甲表。 */
	dpsVs(s, target)
	{
		if (!s.dps)
			return 0;
		const armor = target.armor || (target.stat && target.stat.armor) || target;
		return this.hitVs(s, armor) / s.cd;
	}

	// ------------------------------------------------------------ 战场解析

	normalize(world)
	{
		const own = [];
		const foe = [];
		let billeted = 0;

		for (const raw of world.units)
		{
			const u = {
				"id": raw.id,
				"owner": raw.owner,
				"x": raw.x,
				"z": raw.z,
				"hp": raw.hp,
				"maxHp": raw.maxHp,
				"seen": raw.seen,
				"holder": raw.holder || 0,
				"stat": this.stat(raw.t, raw.owner)
			};

			// seen=1 只是"最后已知位置"，绝不进目标候选——拿过期坐标集火等于自欺欺人
			if (u.seen === 3)
			{
				// 驻军中的单位收不到地图指令（它们在建筑里，玩家鼠标也点不到他们），
				// 什么时候放出来归经济判断，这里只管跳过，别浪费命令预算
				if (u.holder)
					++billeted;
				else
					own.push(u);
			}
			else if (u.seen === 2 && raw.enemy)
				foe.push(u);
		}

		return { "own": own, "foe": foe, "billeted": billeted };
	}

	dist(a, b)
	{
		return Math.hypot(a.x - b.x, a.z - b.z);
	}

	/**
	 * 推/扰的目标要跟着敌人走：实测发现只往"敌方建筑质心"推的部队，
	 * 会站在人家基地里被远程白白射死——目标得换成最近的敌军。
	 */
	pressTarget(g, battle)
	{
		// 指定了打击对象就先只朝那家走；本局看不见他们时退回全体，绝不空转
		const focus = this.cfg.focusPlayer || 0;
		let pool = battle;
		if (focus)
		{
			const picked = battle.filter(f => f.owner === focus);
			if (picked.length)
				pool = picked;
		}

		let near = null;
		let nearD = 1e9;
		for (const f of pool)
		{
			const d = Math.hypot(f.x - g.cx, f.z - g.cz);
			if (d < nearD)
			{
				nearD = d;
				near = f;
			}
		}

		const goal = g.objective;
		if (!near)
			return goal;
		if (this.cfg.doctrine === "raid" && nearD > this.cfg.engageRadius)
			return goal;
		return !goal || nearD < Math.hypot(goal.x - g.cx, goal.z - g.cz) ?
			{ "x": near.x, "z": near.z } : goal;
	}

	centroidOf(units)
	{
		if (!units || !units.length)
			return null;
		let x = 0;
		let z = 0;
		for (const u of units)
		{
			x += u.x;
			z += u.z;
		}
		return { "x": x / units.length, "z": z / units.length };
	}

	doStep(from, to, step)
	{
		const fx = from.cx != null ? from.cx : from.x;
		const fz = from.cz != null ? from.cz : from.z;
		const dx = to.x - fx;
		const dz = to.z - fz;
		const len = Math.hypot(dx, dz);
		if (len < 0.5)
			return null;
		const go = Math.min(len, step);
		return { "x": fx + (dx / len) * go, "z": fz + (dz / len) * go };
	}

	clampToAnchor(dest, anchor, limit)
	{
		const dx = dest.x - anchor.x;
		const dz = dest.z - anchor.z;
		const len = Math.hypot(dx, dz);
		return len <= limit ? dest : { "x": anchor.x + (dx / len) * limit, "z": anchor.z + (dz / len) * limit };
	}

	/** 按空间邻近把己方战斗单位切成若干军团。 */
	cluster(units, radius, maxGroups)
	{
		const groups = [];
		for (const u of units)
		{
			let best = null;
			let bestD = radius;
			for (const g of groups)
			{
				const d = Math.hypot(u.x - g.sumX / g.n, u.z - g.sumZ / g.n);
				if (d < bestD)
				{
					bestD = d;
					best = g;
				}
			}
			if (!best)
			{
				best = { "sumX": 0, "sumZ": 0, "n": 0, "units": [] };
				groups.push(best);
			}
			best.sumX += u.x;
			best.sumZ += u.z;
			best.n++;
			best.units.push(u);
		}

		// 超出名额就把最小那组并进离它最近的一组。绝不整组丢弃：
		// 1~2 个单位的小队被丢掉就等于这几个人没人管，实测会白掉血
		while (groups.length > maxGroups)
		{
			let small = 0;
			for (let i = 1; i < groups.length; ++i)
				if (groups[i].n < groups[small].n)
					small = i;

			const stray = groups.splice(small, 1)[0];
			let host = groups[0];
			let hostD = 1e9;
			for (const g of groups)
			{
				const d = Math.hypot(g.sumX / g.n - stray.sumX / stray.n,
					g.sumZ / g.n - stray.sumZ / stray.n);
				if (d < hostD)
				{
					hostD = d;
					host = g;
				}
			}

			host.sumX += stray.sumX;
			host.sumZ += stray.sumZ;
			host.n += stray.n;
			host.units = host.units.concat(stray.units);
		}

		return groups.map(g => ({
			"units": g.units,
			"cx": g.sumX / g.n,
			"cz": g.sumZ / g.n,
			"n": g.n
		}));
	}

	/**
	 * 先按兵种分堆再按空间分组：弓兵和枪兵的速度/射程差一个量级，
	 * 混在一组里只会让整组被最慢的那个单位带着走。分开之后才能各打各的方向。
	 */
	groupArmies(combat, cfg)
	{
		const buckets = { "cavalry": [], "ranged": [], "melee": [] };
		for (const u of combat)
			buckets[u.stat.cavalry ? "cavalry" : u.stat.ranged ? "ranged" : "melee"].push(u);

		const total = combat.length;
		let left = cfg.maxGroups;
		const out = [];

		for (const role of ["cavalry", "ranged", "melee"])
		{
			const units = buckets[role];
			if (!units.length || left <= 0)
				continue;

			const share = Math.min(left, Math.max(1, Math.round(cfg.maxGroups * units.length / total)));
			const groups = this.cluster(units, cfg.clusterRadius, share);
			for (const g of groups)
				g.role = role;

			out.push.apply(out, groups);
			left -= groups.length;
		}

		return out;
	}

	/** 组的兵种构成。射程取第 25 百分位，避免一个短腿把整组拖走。 */
	profile(group)
	{
		const p = {
			"ranged": [],
			"melee": [],
			"cavalry": [],
			"ranges": [],
			"range": 0,
			"meleeReach": 4,
			"speed": 99
		};

		for (const u of group.units)
		{
			const s = u.stat;
			if (!s.military)
				continue;

			(s.ranged ? p.ranged : p.melee).push(u);
			if (s.cavalry)
				p.cavalry.push(u);
			if (s.ranged)
				p.ranges.push(s.range);
			else
				p.meleeReach = Math.max(p.meleeReach, s.range);
		}

		if (p.ranges.length)
		{
			p.ranges.sort((a, b) => a - b);
			p.range = p.ranges[Math.floor((p.ranges.length - 1) * 0.25)];
		}

		// 走得快的那类兵种决定本组能不能风筝——别让 3 个枪兵拖住 10 个弓兵
		const movers = p.ranged.length >= p.melee.length ? p.ranged : p.melee;
		for (const u of movers)
			p.speed = Math.min(p.speed, u.stat.run);
		if (p.speed === 99)
			p.speed = 0;

		return p;
	}

	/** 一组人的平均护甲，当作"敌人打我们"的代表靶子。 */
	groupArmor(group)
	{
		const sum = { "Hack": 0, "Pierce": 0, "Crush": 0 };
		let n = 0;
		for (const u of group.units)
		{
			const a = u.stat.armor;
			if (!a || !u.stat.hp)
				continue;
			++n;
			for (const k in sum)
				sum[k] += a[k] || 0;
		}
		if (n)
			for (const k in sum)
				sum[k] /= n;
		return sum;
	}

	// ------------------------------------------------------------ 目标分配

	/**
	 * 集火：逐个把射手分配到"每秒能消掉多少敌方输出"最高的目标。
	 * 只对已在射程内的敌人下攻击令——否则远程单位会为了追一个目标跑出阵线。
	 */
	assign(group, units, foes, armor)
	{
		const cfg = this.cfg;
		let reach = 12;
		for (const u of units)
			reach = Math.max(reach, u.stat.range);

		const window = f =>
			Math.hypot(group.cx - f.x, group.cz - f.z) <= reach * 1.3 + 20;

		// 只还手打得到我们的东西；主动进攻时才把建筑/平民也列进候选
		let near = foes.filter(f => this.isThreat(f) && window(f));
		if (!near.length &&
			(cfg.attackStructures || cfg.doctrine === "push" || cfg.doctrine === "harass"))
			near = foes.filter(f => !f.stat.healer && window(f));

		if (!near.length)
			return [];

		const live = near.map(f => ({
			"u": f,
			"hp": f.hp,
			"threat": this.threatOf(f, armor)
		}));

		// 指定打击对象：只改优先级，不把别的敌人从威胁判定里删掉 ——
		// 别国军队正好在家门口时，忽略它等于放任屠村
		const focus = cfg.focusPlayer || 0;

		const buckets = {};
		for (const s of units)
		{
			if (!s.stat.dps)
				continue;

			let best = null;
			let bestScore = 0;

			for (const c of live)
			{
				if (c.hp <= 0)
					continue;

				const d = Math.hypot(s.x - c.u.x, s.z - c.u.z);
				if (d > s.stat.range * 1.1 + 5)
					continue;

				const dps = this.dpsVs(s.stat, c.u.stat);
				if (dps <= 0)
					continue;

				// 击杀紧迫度：这一轮打完就能秒掉的目标优先；指定国家的目标再加一层优先级
				const score = dps * c.threat * (1 + (dps / c.hp) * 40) *
					(focus && c.u.owner === focus ? 1.8 : 1);
				if (score > bestScore)
				{
					bestScore = score;
					best = c;
				}
			}

			if (!best)
				continue;

			best.hp -= this.dpsVs(s.stat, best.u.stat) * this.cfg.retargetCooldown;

			const key = best.u.id;
			if (!buckets[key])
				buckets[key] = { "target": best.u, "units": [] };
			buckets[key].units.push(s.id);
		}

		return Object.keys(buckets).map(k => buckets[k]);
	}

	/** 敌人威胁：打在我们这组平均护甲上的 DPS，再按脆皮/建筑加权。 */
	threatOf(foe, armor)
	{
		const s = foe.stat;
		if (!s.dps)
			return 0.2;

		const squishy = s.ranged || s.support || s.civilian ? 1.5 : 1;
		const structure = s.structure ? 0.35 : 1;
		return this.dpsVs(s, armor) * squishy * structure + 0.01;
	}

	/**
	 * 会打我们的东西都算威胁，包括能射箭的塔和主城。
	 * 实测推对面基地时，我们的兵是被建筑射死的，而只看"移动兵种"的判定
	 * 一直以为没有敌人，站在人家火力圈里白白流干了 24 个单位。
	 */
	isThreat(f)
	{
		return f.stat.dps > 0 && !f.stat.healer;
	}

	// ------------------------------------------------------------ 会战判定

	/**
	 * 打不打是全军一算，不是每组各猜：aimed-fire 兰彻斯特，
	 * 交换比 = 我方(血量×DPS) / 敌方(血量×DPS)。
	 * 算不过来又跑不掉，就整支有秩序地撤回防线，而不是让近战单独扑上去送。
	 * `radius` 可覆盖判定窗口：基地防卫的窗口必须不比压境计数小，
	 * 否则 homeThreatRadius 一旦超过 judgeRadius，压境数看得见、交换比算的是空场，回防被静默关掉。
	 */
	judge(combat, foes, at, radius)
	{
		const cfg = this.cfg;
		const window = radius || cfg.judgeRadius;
		const enemy = [];
		for (const f of foes)
			if (this.isThreat(f) && Math.hypot(f.x - at.x, f.z - at.z) < window)
				enemy.push(f);

		if (!enemy.length)
			return { "fight": true, "edge": false, "exchange": 0, "foes": 0 };

		const ourArmor = this.armorOf(combat);
		const foeArmor = this.armorOf(enemy);

		let ourHp = 0;
		let ourDps = 0;
		let ourSpeed = 0;
		for (const u of combat)
		{
			ourHp += u.hp;
			ourSpeed += u.stat.run;
			let best = 0;
			for (const f of enemy)
				best = Math.max(best, this.dpsVs(u.stat, f.stat));
			ourDps += best;
		}

		let foeHp = 0;
		let foeDps = 0;
		let foeSpeed = 0;
		for (const f of enemy)
		{
			foeHp += f.hp;
			foeSpeed += f.stat.run;
			let best = 0;
			for (const u of combat)
				best = Math.max(best, this.dpsVs(f.stat, u.stat));
			foeDps += best;
		}

		// 射程差本身就是兵力：能打得到他、他摸不到我们，兰彻斯特式交换比要按这个修正
		const edge = Math.min(Math.max(
			this.rangeWeighted(combat, enemy) / Math.max(this.rangeWeighted(enemy, combat), 1),
			1 / cfg.rangeEdgeCap), cfg.rangeEdgeCap);

		const exchange = foeDps > 0 ? (ourHp * ourDps * edge) / (foeHp * foeDps) : 99;
		const faster = ourSpeed / combat.length > foeSpeed / enemy.length * cfg.edgeMargin;

		// 主动推进/骚扰时容许换血略亏：建筑的伤是用得掉的，白送的兵是不该死的
		const grit = cfg.doctrine === "push" || cfg.doctrine === "harass" ? cfg.pushGrit : 1;

		return {
			"fight": exchange >= cfg.winMargin * grit,
			"edge": faster,
			"rangeEdge": Math.round(edge * 100) / 100,
			"exchange": Math.round(exchange * 100) / 100,
			"foes": enemy.length
		};
	}

	/** DPS 加权平均射程：谁的火头主要来自多远，按输出占比算。 */
	rangeWeighted(side, other)
	{
		let dps = 0;
		let weighted = 0;
		for (const u of side)
		{
			let best = 0;
			for (const f of other)
				best = Math.max(best, this.dpsVs(u.stat, f.stat));
			dps += best;
			weighted += best * u.stat.range;
		}
		return dps > 0 ? weighted / dps : 0;
	}

	armorOf(units)
	{
		const sum = { "Hack": 0, "Pierce": 0, "Crush": 0 };
		for (const u of units)
		{
			const a = u.stat.armor;
			for (const k in sum)
				sum[k] += a[k] || 0;
		}
		for (const k in sum)
			sum[k] /= Math.max(units.length, 1);
		return sum;
	}

	// ------------------------------------------------------------ 走位

	/**
	 * 远程站位三态：
	 *  hold   能在敌人贴脸前清掉这波 → 站桩输出，DPS 最高
	 *  kite   清不完但我更快 → 拉开到 standoff 距离放风筝
	 *  pull   清不完又跑不掉 → 有秩序地撤向己方防线，不白给
	 */
	position(group, profile, foes, anchor, screen)
	{
		const cfg = this.cfg;
		const shooters = profile.ranged.concat(profile.melee);
		let nearest = null;
		let nearestD = 1e9;
		let fast = 0;
		let foeRange = 0;
		let cx = 0;
		let cz = 0;
		let cn = 0;

		for (const f of foes)
		{
			const s = f.stat;
			if (!s.military || s.structure)
				continue;

			const d = Math.hypot(group.cx - f.x, group.cz - f.z);
			if (d < nearestD)
			{
				nearestD = d;
				nearest = f;
			}
			if (d < 80)
			{
				fast = Math.max(fast, s.run);
				foeRange = Math.max(foeRange, s.range);
				cx += f.x;
				cz += f.z;
				++cn;
			}
		}

		if (!nearest)
			return { "action": "hold", "nearestD": -1 };

		const range = profile.range || 8;
		// 站位距离：不吃对方射程的亏——能压着打就贴着对方射程外站
		const standoff = Math.min(
			Math.max(range * cfg.standoff, foeRange + 5),
			range * 0.95);
		const ex = cn ? cx / cn : nearest.x;
		const ez = cn ? cz / cn : nearest.z;

		// 站桩能不能在敌人贴脸前清场：dpsPool 按"每个射手只算它最好的一口"，不重复计数
		let foeHp = 0;
		let dpsPool = 0;
		const window = range * 1.6 + 12;
		for (const f of foes)
		{
			if (!f.stat.military || Math.hypot(group.cx - f.x, group.cz - f.z) > window)
				continue;
			foeHp += f.hp;
			let best = 0;
			for (const u of shooters)
				best = Math.max(best, this.dpsVs(u.stat, f.stat));
			dpsPool += best;
		}

		const ttk = dpsPool > 0 ? foeHp / dpsPool : 1e9;
		const reach = fast > 0 ? Math.max(nearestD - 6, 0) / fast : 1e9;
		const speedEdge = profile.speed > fast * 1.12;

		// 己方近战已经贴在那波敌人身上：前排吸伤害，后排就该站桩射，不要自己退开让前排送
		const screened = (screen || []).some(s =>
			Math.hypot(s.x - nearest.x, s.z - nearest.z) < nearestD - 4);

		let action = "hold";
		if (!this.fight.fight)
			action = this.fight.edge && cfg.kite ? "kite" : "pull";
		else if (ttk > reach * cfg.standMargin && nearestD < standoff && !screened)
			action = speedEdge && cfg.kite ? "kite" : "pull";

		const awayX = group.cx - ex;
		const awayZ = group.cz - ez;
		const len = Math.hypot(awayX, awayZ) || 1;

		let dest = null;
		if (action === "kite" || action === "pull")
		{
			const step = cfg.kiteStep * (action === "pull" ? 1.8 : 1);
			if (action === "pull" && anchor)
				dest = this.doStep(group, anchor, step);
			else
				dest = { "x": group.cx + (awayX / len) * step, "z": group.cz + (awayZ / len) * step };
		}
		else if (action === "hold" && nearestD > range * cfg.closeRange)
		{
			// 站桩但够不着：压上到 standoff
			const toward = Math.max(nearestD - standoff, 0);
			if (toward > cfg.moveEpsilon)
				dest = { "x": group.cx - (awayX / len) * toward, "z": group.cz - (awayZ / len) * toward };
		}

		return {
			"action": action,
			"dest": dest,
			"nearestD": nearestD,
			"standoff": standoff,
			"enemySpeed": fast,
			"ttk": ttk,
			"reach": reach
		};
	}

	/** 多方向变换：按组序号给每支骑兵分配左右包夹方位。 */
	flankTarget(group, swing, foes)
	{
		const battle = foes.filter(f => f.stat.military && !f.stat.structure);
		if (!battle.length)
			return null;

		// 高价值目标：远程/攻城/支援，优先于前排
		const juicy = battle.filter(f => f.stat.ranged || f.stat.support || f.stat.classes.indexOf("Siege") >= 0);
		const pool = juicy.length ? juicy : battle;
		let prize = pool[0];
		for (const f of pool)
			if (f.hp / (f.maxHp || 1) < prize.hp / (prize.maxHp || 1))
				prize = f;

		const c = this.centroidOf(battle);
		const dx = group.cx - c.x;
		const dz = group.cz - c.z;
		const len = Math.hypot(dx, dz) || 1;

		// 左右交替绕行，绕到敌方质心侧后方
		const side = swing % 2 ? 1 : -1;
		const angle = (0.7 + 0.2 * Math.floor(swing / 2)) * side;
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		const rx = (dx / len) * cos - (dz / len) * sin;
		const rz = (dx / len) * sin + (dz / len) * cos;
		const approach = Math.max(len - 12, 8);

		return { "x": c.x + rx * approach, "z": c.z + rz * approach, "prize": prize };
	}

	// ------------------------------------------------------------ 主循环

	plan(world)
	{
		const cfg = this.cfg;
		const ops = [];
		const summary = [];

		if (cfg.mode === "off")
			return { "ops": ops, "summary": summary, "note": "off" };

		const now = world.now || 0;
		const prevGroups = this.groups;
		this.groups = [];

		const field = this.normalize(world);
		const combat = field.own.filter(u => u.stat.military && !u.stat.structure);
		const anchor = this.anchorOf(world, field);
		const foes = field.foe;

		// 先问家里安不安全：没有兵的时候也要更新，否则回防状态会冻在上一局
		this.guard = this.homeGuard(field, this.homeOf(field), now);

		if (!combat.length)
			return { "ops": ops, "summary": summary, "note": "no military", "foes": foes.length, "guard": this.guard };

		const clusters = this.groupArmies(combat, cfg);
		const groups = [];		// 认领必须是排他的：实测三个军团同时认领上一帧同一组，key 全撞成一个，
		// 结果移动/姿态记忆串组、外部按 group:key 根本点不到具体那一队
		const claimed = {};
		const taken = {};
		for (const g of prevGroups)
			taken[g.key] = true;
		clusters.forEach((c, i) => groups.push(this.makeGroup(c, i, prevGroups, claimed, taken)));

		this.fight = this.judge(combat, foes, this.centroidOf(combat) || { "x": 0, "z": 0 });
		// 既算不过又跑不掉，还没有可退的防线，那"撤退"就是原地白挨打 —— 不如就地还手
		if (!this.fight.fight && !this.fight.edge && !anchor)
			this.fight = Object.assign({}, this.fight, { "fight": true, "held": true });
		this.assignRoles(groups, foes, anchor, world);

		// 前排 = 己方所有够不到射程的单位，用来判断远程有没有人挡着
		const screen = combat.filter(u => !u.stat.ranged);

		for (const g of groups)
		{
			const order = this.orderFor(g, foes, anchor, world, screen);
			this.emit(g, order, foes, ops, summary, world, now);
		}

		this.treatWounded(groups, field, anchor, ops);
		this.keepHealers(field, combat, ops, now);
		this.shelterCivilians(field, foes, ops, now);

		this.groups = groups;

		return {
			"ops": ops,
			"summary": summary,
			"foes": foes.length,
			"groups": groups.length,
			"fight": this.fight,
			"guard": this.guard,
			"doctrine": cfg.doctrine
		};
	}

	makeGroup(cluster, index, prevGroups, claimed, taken)
	{
		const profile = this.profile(cluster);
		const mem = this.matchMem(cluster, prevGroups, claimed, taken);
		const rangedShare = profile.ranged.length / Math.max(cluster.n, 1);
		const cavShare = profile.cavalry.length / Math.max(cluster.n, 1);
		const role = cluster.role ||
			(rangedShare >= 0.5 ? "ranged" : cavShare >= 0.5 ? "cavalry" : "melee");

		return {
			"key": mem.key,
			"index": index,
			"units": cluster.units,
			"cx": cluster.cx,
			"cz": cluster.cz,
			"n": cluster.n,
			"profile": profile,
			"armor": this.groupArmor(cluster),
			"role": role,
			"lastMove": mem.lastMove,
			"lastMoveAt": mem.lastMoveAt,
			"lastStance": mem.lastStance,
			"task": "hold",
			"objective": null
		};
	}

	/**
	 * 教条 → 每组的战术分工。多军团多方向就体现在这里：
	 * 同一种兵在不同组里任务不同，骑兵组按序号左右分边。
	 */
	assignRoles(groups, foes, anchor, world)
	{
		const battle = foes.filter(f => f.stat.military && !f.stat.structure);
		const prey = foes.filter(f => f.stat.structure || f.stat.civilian || !f.stat.military);
		const herd = this.centroidOf(prey);

		for (const g of groups)
		{
			g.task = "hold";
			g.objective = world.objective || herd;
		}

		switch (this.cfg.doctrine)
		{
		case "retreat":
			for (const g of groups)
				g.task = "withdraw";
			break;

		case "hold":
			for (const g of groups)
				g.task = g.role === "ranged" ? "defend" : "anchor";
			break;

		case "push":
			for (const g of groups)
				g.task = "push";
			break;

		case "harass":
			for (const g of groups)
			{
				// 敌方主力靠近就撤，不跟他们换家
				const hot = battle.some(f =>
					Math.hypot(f.x - g.cx, f.z - g.cz) < 60 && f.stat.run >= g.profile.speed);
				g.task = hot ? "withdraw" :
					(g.role === "ranged" || g.role === "cavalry") && g.objective ? "raid" : "hold";
			}
			break;

		default:
		{
			// field（会战）：近战吸前排，远程站桩/风筝，骑兵绕侧后
			let swing = 0;
			for (const g of groups)
			{
				if (g.role === "cavalry" && battle.length)
				{
					g.task = "flank";
					g.swing = swing++;
				}
				else
					g.task = g.role === "ranged" ? "defend" : battle.length ? "anchor" : "push";
			}
			break;
		}
		}

		// 任何教条下，本地这一仗算不过来就得脱离。实测推基地推到一半
		// 被对面远程白射死 24 个兵，缺的就是这条断线机制
		if (!this.fight.fight && this.cfg.doctrine !== "retreat")
			for (const g of groups)
				g.task = g.role === "ranged" ? "defend" : "withdraw";

		// 家里被压境：在外线的组一律掉头回防，优先级最高（排在断线机制之后，
		// 免得"算不过来"把回防改成往集结点撤）。已经到位的组留在原地正常打
		if (this.guard.active && this.guard.home)
		{
			const home = { "x": this.guard.home[0], "z": this.guard.home[1] };
			for (const g of groups)
			{
				g.homeDist = Math.round(Math.hypot(g.cx - home.x, g.cz - home.z));
				if (g.homeDist > this.cfg.homeArriveRadius)
					g.task = "return";
			}
		}
	}

	/** 给一组算出这一拍的移动/姿态意图。 */
	orderFor(g, foes, anchor, world, screen)
	{
		const cfg = this.cfg;
		const battle = foes.filter(f => f.stat.military && !f.stat.structure);
		const order = { "dest": null, "stance": null, "engage": true, "push": null };

		switch (g.task)
		{
		case "withdraw":
			// 边撤边打：只有贴脸的近战才真的还不了手。
			// 之前给它 standground + 撤退令，结果是"不许还手地往后跑"，实测白挨了 57 点血
			order.engage = g.role === "ranged" || g.profile.ranged.length > 0;
			order.stance = order.engage ? cfg.stance : cfg.holdStance;
			order.dest = anchor ? this.doStep(g, anchor, cfg.kiteStep * 2) : null;
			break;

		case "push":
		case "raid":
			order.push = this.pressTarget(g, battle);
			order.stance = cfg.stance;
			break;

		case "return":
		{
			// 掉头回家走 attack-walk：路上真被拦住就打，不绕路。
			// 这里不发集火令——旧目标在外线，会把人又拽回去
			const home = this.guard.home ? { "x": this.guard.home[0], "z": this.guard.home[1] } : anchor;
			order.push = home;
			order.engage = false;
			order.stance = cfg.stance;
			break;
		}

		case "flank":
		{
			const f = this.flankTarget(g, g.swing || 0, battle);
			order.dest = f;
			order.stance = cfg.stance;
			if (f && f.prize)
				order.forceTarget = f.prize.id;
			break;
		}

		case "anchor":
		{
			// 近战要贴上去吸伤害：停在够得着敌人的地方，不是停在敌方质心前十几格外面
			let target = null;
			let bestD = 1e9;
			for (const f of battle)
			{
				const d = Math.hypot(g.cx - f.x, g.cz - f.z);
				if (d < bestD)
				{
					bestD = d;
					target = f;
				}
			}
			const contact = g.profile.meleeReach;
			if (target && bestD > contact + 1)
				order.dest = this.doStep(g, target, Math.min(bestD - contact, cfg.kiteStep * 1.5));
			order.stance = cfg.stance;
			break;
		}

		default:
		{
			const pos = this.position(g, g.profile, foes, anchor, screen);
			g.pos = pos;
			order.dest = pos.dest;
			order.stance = pos.action === "hold" && g.profile.ranged.length ? cfg.holdStance : cfg.stance;
			if (this.cfg.doctrine === "hold" && anchor && order.dest)
				order.dest = this.clampToAnchor(order.dest, anchor, cfg.maxChase * 0.5);
			break;
		}
		}

		// 不许为了追一个残兵跑出整条战线
		if (order.dest && anchor)
		{
			const chase = Math.hypot(order.dest.x - anchor.x, order.dest.z - anchor.z);
			const home = Math.hypot(g.cx - anchor.x, g.cz - anchor.z);
			if (chase > cfg.maxChase && chase > home)
				order.dest = this.doStep(g, anchor, cfg.kiteStep);
		}

		return order;
	}

	/** 把意图翻译成命令：带节流，别每拍刷屏把命令队列挤爆。 */
	emit(g, order, foes, ops, summary, world, now)
	{
		const cfg = this.cfg;
		const threats = foes.filter(f => this.isThreat(f));
		const fit = [];
		const wounded = [];

		for (const u of g.units)
		{
			const ratio = u.maxHp > 0 ? u.hp / u.maxHp : 1;
			// 远程掉到三成就该退，近战是肉盾，退早了等于自己拆阵线
			const limit = u.stat.ranged ? cfg.retreatHp : cfg.retreatHp * 0.5;
			// 只有真的被够到才退：没被打到就撤等于白扔 DPS
			const threatened = threats.some(f => this.dist(u, f) <= f.stat.range + 10);
			if (u.hp <= 0)
				continue;
			if (ratio < limit && threatened && cfg.retreatHp > 0)
				wounded.push(u);
			else
				fit.push(u);
		}

		g.woundedList = wounded;
		g.wounded = wounded.length;
		if (!fit.length)
			return;

		const ids = fit.map(u => u.id);

		if (order.engage)
		{
			const buckets = this.assign(g, fit, foes, g.armor);
			for (const b of buckets)
			{
				if (ops.length >= cfg.maxOpsPerTick)
					break;
				const fresh = b.units.filter(id =>
					!this.unitMem[id] || now - this.unitMem[id].at > cfg.retargetCooldown);
				if (!fresh.length)
					continue;
				ops.push({ "op": "attack", "entities": fresh, "target": b.target.id });
				for (const id of fresh)
					this.unitMem[id] = { "at": now, "target": b.target.id };
			}
		}

		if (order.push)
		{
			const p = { "x": order.push.x, "z": order.push.z };
			if (this.shouldMove(g, p, now))
			{
				ops.push({
					"op": "attack-walk",
					"entities": ids,
					"x": round1(p.x),
					"z": round1(p.z),
					"formation": this.pickFormation(world, cfg.formation)
				});
				this.rememberMove(g, p, now);
			}
		}
		else if (order.dest && this.shouldMove(g, order.dest, now))
		{
			ops.push({
				"op": "walk",
				"entities": ids,
				"x": round1(order.dest.x),
				"z": round1(order.dest.z),
				"formation": this.pickFormation(world, cfg.formation)
			});
			this.rememberMove(g, order.dest, now);
		}

		if (order.stance && g.lastStance !== order.stance && ops.length < cfg.maxOpsPerTick)
		{
			ops.push({ "op": "stance", "entities": ids, "name": order.stance });
			g.lastStance = order.stance;
		}

		const pos = g.pos || {};
		const dest = order.dest || order.push;
		summary.push({
			"key": g.key,
			"n": g.n,
			"role": g.role,
			"task": g.task,
			"home": g.homeDist == null ? null : g.homeDist,
			"action": pos.action || g.task,
			// 质心导出给外部控制台：没有它，"第 2 军团"这种说法无法还原成实体
			"at": [round1(g.cx), round1(g.cz)],
			"range": round1(g.profile.range),
			"d": Math.round(pos.nearestD == null ? -1 : pos.nearestD),
			"standoff": Math.round(pos.standoff || 0),
			"ttk": Math.round(pos.ttk || 0),
			"reach": Math.round(pos.reach || 0),
			"wounded": wounded.length,
			"dest": dest ? [round1(dest.x), round1(dest.z)] : null
		});
	}

	rememberMove(g, dest, now)
	{
		g.lastMove = dest;
		g.lastMoveAt = now;
	}

	shouldMove(g, dest, now)
	{
		if (now - (g.lastMoveAt == null ? -99 : g.lastMoveAt) < this.cfg.moveCooldown)
			return false;
		if (!g.lastMove)
			return true;
		return Math.hypot(dest.x - g.lastMove.x, dest.z - g.lastMove.z) > this.cfg.moveEpsilon;
	}

	/** 用上帧质心认领分组，保留移动/姿态记忆，避免每拍重复下令。认领过一组就不再给别人。 */
	matchMem(cluster, prevGroups, claimed, taken)
	{
		let best = null;
		let bestD = 70;
		for (const g of prevGroups)
		{
			if (claimed[g.key])
				continue;

			const d = Math.hypot(g.cx - cluster.cx, g.cz - cluster.cz);
			if (d < bestD)
			{
				bestD = d;
				best = g;
			}
		}

		if (best)
		{
			claimed[best.key] = true;
			return {
				"key": best.key,
				"lastMove": best.lastMove,
				"lastMoveAt": best.lastMoveAt,
				"lastStance": best.lastStance
			};
		}

		let n = 1;
		while (taken["g" + n])
			++n;
		taken["g" + n] = true;
		return {
			"key": "g" + n,
			"lastMove": null,
			"lastMoveAt": -99,
			"lastStance": null
		};
	}

	/** 残血处置：能进建筑就进，否则撤到锚点/医生身边。名单由 emit 判定，不重复决定一遍。 */
	treatWounded(groups, field, anchor, ops)
	{
		const cfg = this.cfg;
		const healers = field.own.filter(u => u.stat.healer);

		for (const g of groups)
		{
			const wounded = g.woundedList || [];
			if (!wounded.length || ops.length >= cfg.maxOpsPerTick)
				continue;

			const shelter = cfg.garrisonWounded ? this.nearestShelter(field, wounded[0]) : null;
			const to = shelter || (healers.length ? this.centroidOf(healers) : anchor);
			if (!to)
				continue;

			const ids = wounded.map(u => u.id);
			if (shelter && this.dist(wounded[0], shelter) < 16)
				ops.push({ "op": "garrison", "entities": ids, "target": shelter.id });
			else
				ops.push({ "op": "walk", "entities": ids, "x": round1(to.x), "z": round1(to.z), "formation": null });
		}
	}

	keepHealers(field, combat, ops, now)
	{
		const patients = combat.filter(u => u.maxHp > 0 && u.hp / u.maxHp < 0.8)
			.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp);
		if (!patients.length)
			return;

		for (const h of field.own.filter(u => u.stat.healer))
		{
			if (ops.length >= this.cfg.maxOpsPerTick)
				return;

			const patient = patients[0];
			const mem = this.unitMem[h.id];
			if (this.dist(h, patient) <= h.stat.healRange)
				ops.push({ "op": "heal", "entities": [h.id], "target": patient.id });
			else if (!mem || now - mem.at > 2)
			{
				ops.push({
					"op": "walk",
					"entities": [h.id],
					"x": round1(patient.x),
					"z": round1(patient.z),
					"formation": null
				});
				this.unitMem[h.id] = { "at": now };
			}
		}
	}

	/**
	 * 村民遇到骚扰：默认"走开"，不是"关进主城"。
	 * 实测关人的代价远超收益：关着的村民不采集（木头当场断供 → 盖不起房 → 人口卡死），
	 * 而军事副驾与经济对"什么时候算安全"的口径不一样（一个看人离敌人多远、一个看家离敌人多远），
	 * 一个塞一个放，整局在阈值附近来回弹，人口从 18 掉到 10。
	 * 走开之后他们变成空闲，经济下一拍自己把人重新派去采集 —— 不需要第二个模块决定"什么时候放人"。
	 */
	shelterCivilians(field, foes, ops, now)
	{
		const cfg = this.cfg;
		const civilians = field.own.filter(u => u.stat.civilian &&
			(!this.civMem[u.id] || now - this.civMem[u.id] >= cfg.civilianCalm));
		if (!civilians.length || ops.length >= cfg.maxOpsPerTick)
			return;

		const intruder = foes.find(f => this.isThreat(f) &&
			this.dist(f, civilians[0]) < cfg.civilianDanger);
		if (!intruder)
			return;

		const shelter = this.nearestShelter(field, civilians[0]);
		const ids = civilians.slice(0, 40).map(u => u.id);

		if (cfg.garrisonCivilians && shelter && this.dist(civilians[0], shelter) < 16)
		{
			ops.push({ "op": "garrison", "entities": ids, "target": shelter.id });
			for (const id of ids)
				this.civMem[id] = now;
			return;
		}

		// 背离骚扰者走一段：人还在场上、还看得见，骚扰一走经济立刻把他们捡回来
		const dx = civilians[0].x - intruder.x;
		const dz = civilians[0].z - intruder.z;
		const len = Math.max(Math.hypot(dx, dz), 1);
		ops.push({
			"op": "walk",
			"entities": ids,
			"x": round1(civilians[0].x + dx / len * cfg.civilianFlee),
			"z": round1(civilians[0].z + dz / len * cfg.civilianFlee),
			"formation": null
		});
		for (const id of ids)
			this.civMem[id] = now;
	}

	// ------------------------------------------------------------ 环境查询

	/**
	 * 回防锚点 = 基地本身（多主城取质心），不是集结点。
	 * 玩家把 rally 设到前线时，"回家"要是跟着 rally 走就等于继续往前送。
	 */
	homeOf(field)
	{
		const buildings = field.own.filter(u => u.stat.structure && u.maxHp > 0);
		if (!buildings.length)
			return null;

		const civic = buildings.filter(b => b.stat.template.indexOf("civil_centre") >= 0 ||
			b.stat.template.indexOf("civic_center") >= 0);
		return this.centroidOf(civic.length ? civic : buildings);
	}

	/**
	 * 家里是否被压境：够得着基地的敌方火力 vs 家里真能还手的人。
	 * 判定复用会战那套兰彻斯特交换比，只是战场换成基地。
	 * 实测败因就是军队在外推别人基地、对面分兵屠村，回去只剩村民尸体。
	 */
	homeGuard(field, home, now)
	{
		const cfg = this.cfg;
		const st = this.recall;
		const out = {
			"active": false,
			"foes": 0,
			"ours": 0,
			"home": home ? [round1(home.x), round1(home.z)] : null,
			"exchange": 0
		};

		if (!cfg.homeGuard || !home)
		{
			st.active = false;
			st.since = now;
			return out;
		}

		const near = p => Math.hypot(p.x - home.x, p.z - home.z) < cfg.homeThreatRadius;

		// 只算会动的火力：对面一个箭塔在家门口修着不算压境
		const raiders = field.foe.filter(f => this.isThreat(f) && !f.stat.structure && near(f));
		// 己方的塔和主城也在还手，把它们当守军，否则三匹骑兵就能把全军拽回家。
		// 括号不能省：&& 比 || 紧，写成 a && b || c 会把全图任何会射的建筑都算成守军
		const guards = field.own.filter(u => near(u) &&
			((u.stat.military && !u.stat.structure) || (u.stat.structure && this.isThreat(u))));

		out.foes = raiders.length;
		out.ours = guards.length;

		const verdict = this.judge(guards, field.foe, home, Math.max(cfg.judgeRadius, cfg.homeThreatRadius));
		out.exchange = verdict.exchange;
		// 家里一个能还手的都没有，或交换比打不平，才算守不住
		const overwhelmed = verdict.foes > 0 && (!guards.length || verdict.exchange < cfg.winMargin);

		const burst = raiders.length >= cfg.homeThreatEnter && overwhelmed;
		const calm = raiders.length <= cfg.homeThreatExit || !overwhelmed;

		if (!st.active)
		{
			if (burst)
			{
				st.active = true;
				st.since = now;
			}
		}
		else if (calm && now - st.since >= cfg.homeDwell)
		{
			st.active = false;
			st.since = now;
		}

		out.active = st.active;
		return out;
	}

	/** 己方防线锚点：优先玩家集结点，其次主建筑。 */
	anchorOf(world, field)
	{
		if (world.rally)
			return world.rally;

		const buildings = field.own.filter(u => u.stat.structure && u.maxHp > 0);
		if (!buildings.length)
			return null;

		for (const b of buildings)
			if (b.stat.template.indexOf("civil_centre") >= 0)
				return b;
		return buildings[0];
	}

	nearestShelter(field, from)
	{
		let best = null;
		let bestD = 1e9;
		for (const u of field.own)
		{
			if (!u.stat.structure)
				continue;
			if (!/civil_centre|field|house|tower|fortress|barracks|dock/.test(u.stat.template))
				continue;
			const d = Math.hypot(u.x - from.x, u.z - from.z);
			if (d < bestD)
			{
				bestD = d;
				best = u;
			}
		}
		return bestD < 120 ? best : null;
	}

	pickFormation(world, want)
	{
		if (!want || !world.formations || !world.formations.length)
			return null;
		return world.formations.indexOf(want) >= 0 ? want : world.formations[0];
	}
}
