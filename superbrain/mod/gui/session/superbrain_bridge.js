/**
 * Superbrain bridge
 *
 * 单人对局用的外部 AI 桥接层。每 sim turn:
 *   1) 读取外部进程写入的 cmd-*.json，校验后注入与玩家点击等价的命令；
 *   2) 导出己方与可见单位状态到 state-*.json；
 *   3) 首次遇到新 template 时把完整模板数值和实体状态样本写入 static-*.json（供外部大脑校准）。
 *
 * 文件协议（避免半读）：写入用带序号的文件名，读取方只认序号更大的文件，旧文件由外部进程清理。
 */

var g_SuperbrainBridge;

class SuperbrainBridge
{
	constructor()
	{
		try
		{
			this.me = Engine.GetPlayerID();
			this.exportEvery = 2;
			this.maxEntities = 1500;
			this.trace("ctor 开始 me=" + this.me);

			this.dir = this.findWritableDir();
			this.trace("ctor 写盘目录=" + this.dir);

			this.seq = 0;
			this.staticRev = 0;
			this.lastCmdSeq = 0;
			this.templates = {};
			this.samples = {};
			this.visValues = {};
			this.errors = [];
			this.lastApplied = null;
			this.writes = 0;
			this.reported = false;
			this.probe = { "shape": {}, "counts": {} };
			this.probeWrites = 0;
			this.live = [];
			this.slow = [];
			this.slowCache = {};
			this.known = {};
			this.cursor = 1;
			this.nextId = 1;
			this.maxId = 0;
			this.stride = 600;
			this.sweepCount = 0;
			this.idTop = 1200;
			this.sweepPasses = 5;
			this.garrisonSeed = {};
			this.posless = 0;

			this.tplCache = {};
			this.seenOf = {};
			this.kernel = null;
			this.autopilot = true;
			this.econ = null;
			this.economy = true;
			this.lastEcon = null;
			this.econTotal = 0;
			this.econRejected = 0;
			this.foeSeen = {};
			this.objective = null;
			this.rallyPoint = null;
			this.formations = [];
			this.stances = [];
			this.lastPlan = null;
			this.receipt = null;
			this.lastKernel = null;
			this.entities = {};

			this.singlePlayer = this.isSinglePlayer();
			this.trace("ctor 单人判定=" + this.singlePlayer);

			this.diagData = {
				"bridge": "minimal",
				"dir": this.dir,
				"me": this.me,
				"singlePlayer": this.singlePlayer
			};
			this.trace("ctor 最小 diag 已存");

			this.announce("booted dir=" + (this.dir || "none") +
				" singlePlayer=" + this.singlePlayer +
				" probe=" + uneval(this.probeResults || {}));

			this.writeDiag();
			this.trace("ctor 完成");
		}
		catch (e)
		{
			warn("[superbrain] 构造异常 " + (e && e.message) + " 行" + (e && e.lineNumber));
		}
	}

	trace(message)
	{
		this.steps = (this.steps || []).concat([message]);
		if (this.steps.length > 16)
			this.steps.shift();

		if (typeof warn === "function")
			warn("[superbrain] " + message);

		// 故意不写独立诊断文件：引擎对固定文件名做 wtruncate，
		// 外部读进程只要还握着句柄就会触发共享冲突并断言崩溃。诊断只并进唯一命名的 state 文件。
	}

	announce(message)
	{
		if (typeof warn === "function")
			warn("[superbrain] " + message);

		// 不要用 Engine.SendNetworkChat 做探针：本地单人对局没有网络会话，
		// 这个调用会在 C++ 层解引用空指针直接崩掉进程（JS try/catch 拦不住）。
	}

	findWritableDir()
	{
		// GUI 作用域只能访问引擎白名单路径。saves/campaigns/ 实测可写且落在
		// Documents\My Games\0ad\，外部进程能直接读写；moddata/ 作为备选。
		const candidates = [
			"saves/campaigns/superbrain/",
			"moddata/superbrain/",
			"saves/superbrain/",
			"config/superbrain/",
			"cache/superbrain/"
		];

		// 每个对局实例一个子目录：两个进程往同名文件里写 state-000001.json
		// 会撞上引擎的 wtruncate 共享冲突，那是会直接断言崩进程的
		const run = "run-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36);

		this.probeResults = {};

		for (const base of candidates)
		{
			const dir = base + run + "/";
			try
			{
				// 唯一命名：绝不覆盖写同名文件，否则外部读句柄会引发引擎 wtruncate 断言崩溃
				Engine.WriteJSONFile(dir + "boot.json", { "probe": 1, "dir": dir });
				this.probeResults[dir] = "ok";
				return dir;
			}
			catch (e)
			{
				this.probeResults[dir] = String(e.message || e);
			}
		}
		return null;
	}

	/**
	 * 多人房停用：AI 托管真人军队在多人对局里等同于作弊。
	 * 本地单人对局只有一个带 GUID 的席位，其余槽位由 AI 控制、不在 g_PlayerAssignments 里。
	 */
	isSinglePlayer()
	{
		if (typeof g_IsReplay !== "undefined" && g_IsReplay)
			return false;

		if (typeof g_PlayerAssignments === "undefined")
			return true;

		let humans = 0;
		for (const guid in g_PlayerAssignments)
			if (g_PlayerAssignments[guid].player > 0)
				++humans;

		return humans <= 1;
	}

	writeDiag()
	{
		this.diagData = {
			"bridge": "loaded",
			"dir": this.dir,
			"me": this.me,
			"singlePlayer": this.singlePlayer,
			"probeResults": this.probeResults,
			"visibilityValues": this.visValues,
			"lastCmdSeq": this.lastCmdSeq,
			"writes": this.writes,
			"errors": this.errors.slice(-20)
		};
	}

	update()
	{
		// 控制台热加载会留下旧实例且无法注销，只让当前全局实例干活
		if (g_SuperbrainBridge !== this)
			return;

		const sim = typeof GetSimState === "function" ? GetSimState() : null;
		if (!sim)
			return;

		// GUI 的 sim state 里没有实体总表，实体要按 id 批量扫
		const view = Object.assign({}, sim);
		view.entities = this.entities || {};

		if (!this.reported)
		{
			this.reported = true;
			this.trace("update 首次 待扫 id 起点=" + this.nextId);
			this.announce("sim 更新已挂钩 nextId=" + this.nextId + " dir=" + (this.dir || "none"));
		}

		if (!this.dir)
			return;

		if (++this.seq % this.exportEvery)
		{
			if (this.singlePlayer)
				this.pollCommands(view);
			return;
		}

		// 重活（全 id 段扫描）只在这里做
		view.entities = this.fetchEntities(sim);

		if (this.singlePlayer)
		{
			this.pollCommands(view);
			this.runKernel(view);
			this.runEconomy(view);
		}

		this.exportState(view);

		if (this.staticRevPending)
		{
			delete this.staticRevPending;
			this.exportStatic(view);
		}
	}

	/**
	 * id -> 实体状态。GetMultipleEntityStates 是批量接口，分块取以免单次调用过大。
	 */
	fetchEntities(sim)
	{
		// 引擎会复用实体 id（实测 t=1112 全图最大 id 只有 922），所以"扫描前沿一路向前、
		// 每 120 拍整体重扫"是错的：新村民拿的是早就扫过的低 id，要等下一轮重扫（约 24 秒）
		// 才进视野，期间经济把它们当不存在。改成滚动覆盖 —— sweepPasses 拍内保证整段 id 重扫一次。
		++this.sweepCount;

		const window = Math.max(200, Math.ceil(this.idTop / this.sweepPasses));
		const fresh = [];
		for (let id = this.cursor; id < this.cursor + window && id <= this.idTop; ++id)
			fresh.push(id);
		this.cursor = this.cursor + window > this.idTop ? 1 : this.cursor + window;
		this.nextId = this.cursor;

		// 新兵、新建筑的 id 一定高于已知最大值，而扫描前沿早就冲到头了。
		// 不额外盯这一段的话，刚练出来的兵要等下一轮整体重扫才归副驾管。
		const newborn = [];
		for (let id = this.maxId + 1; id <= this.maxId + 600; ++id)
			newborn.push(id);

		const slowDue = this.sweepCount % 10 === 0;
		if (slowDue)
			this.slowCache = {};

		// 驻军单位不在世界里（见 anchorOf），万一某拍没被扫到就再也找不到它们：
		// 宿主建筑报回来的驻军 id 每拍都要点名。
		const billeted = [];
		for (const idStr in this.garrisonSeed)
			billeted.push(+idStr);

		const ids = this.live.concat(slowDue ? this.slow : [], fresh, newborn, this.seedIds(sim), billeted);
		const uniq = Array.from(new Set(ids));

		const out = {};
		const live = [];
		const slow = [];
		const seed = {};
		const got = {};
		let returned = 0;

		for (let i = 0; i < uniq.length; i += 500)
		{
			const batch = this.safeCall(
				() => GetMultipleEntityStates(uniq.slice(i, i + 500)), null);
			if (!batch)
				continue;

			for (const item of batch)
			{
				if (!item || item.entId == null || !item.state)
					continue;

				const ent = item.state;
				const kind = this.classify(ent);
				got[item.entId] = true;
				++returned;
				if (item.entId > this.maxId)
					this.maxId = item.entId;
				if (kind === "skip")
					continue;

				out[item.entId] = ent;
				this.known[item.entId] = ent.player;

				// 谁把谁关起来了：驻军清单要进下一拍的必扫名单
				const held = ent.garrisonHolder && ent.garrisonHolder.entities;
				if (held && held.length)
					for (const id of held)
						seed[id] = true;

				if (kind === "live")
					live.push(item.entId);
				else
				{
					slow.push(item.entId);
					this.slowCache[item.entId] = ent;
				}
			}
		}

		this.garrisonSeed = seed;
		this.countDeaths(uniq, got, sim);

		// 不刷新的那几拍也要把建筑留在场上：它们不动，掉血也慢，
		// 但撤退锚点、驻军点、经济建模每秒都需要它们
		for (const id in this.slowCache)
			if (!out[id])
				out[id] = this.slowCache[id];

		this.live = live;
		this.slow = slowDue ? slow : Array.from(new Set(slow.concat(this.slow)));
		this.entities = out;

		// id 空间随对局缓慢增长，跟着实测最大值留点余量就够了，别去扫几十万个空位
		this.idTop = Math.min(Math.max(this.maxId + 400, 1200), 40000);
		this.stride = window;

		this.probe.counts = {
			"live": live.length,
			"slow": this.slow.length,
			"nextId": this.cursor,
			"fetched": ids.length,
			"returned": returned,
			"idTop": this.idTop,
			"window": window,
			"billeted": billeted.length
		};

		if (!this.probed && this.dir && Object.keys(out).some(k => out[k].player === this.me))
		{
			this.probed = true;
			this.safeCall(() => this.deepProbe(out), null);
		}

		return out;
	}

	/**
	 * 实体坐标。驻军单位没有 position（引擎只在 IsInWorld() 时才写这个字段），
	 * 但它们照样吃人口、照样是训练出来的资产 —— 直接丢掉等于把自己的人弄瞎，
	 * 实测因此让经济只剩 1 个劳力。所以借宿主的位置，并把 holder 一起报出去。
	 */
	holderOf(ent)
	{
		const g = ent.garrisonable;
		return g && g.holder > 0 ? g.holder : 0;
	}

	anchorOf(ent, ents)
	{
		if (ent.position)
			return { "x": ent.position.x, "z": ent.position.z, "holder": 0 };

		const holder = this.holderOf(ent);
		const host = holder ? ents[holder] : null;
		if (host && host.position)
			return { "x": host.position.x, "z": host.position.z, "holder": holder };

		return { "x": 0, "z": 0, "holder": holder };
	}

	/**
	 * 玩家面板实体（主城/当前选中）的 id 必须每拍都拿到：
	 * 否则自家建筑要等 id 段慢慢扫到才可见，撤退锚点就是空的，残血单位无处可退。
	 */
	seedIds(sim)
	{
		const out = [];

		for (const idStr in sim.players)
		{
			const p = sim.players[idStr];
			if (!p)
				continue;

			out.push(p.entity);
			for (const e of p.panelEntities || [])
				out.push(typeof e === "number" ? e : e && e.id);
		}

		return out.filter(id => typeof id === "number" && id > 0);
	}

	/**
	 * live = 每拍都要更新；slow = 每 10 拍；skip = 永不更新（树、装饰物、粒子）。
	 */
	classify(ent)
	{
		const template = String(ent.template || "");

		if (template.indexOf("units/") === 0)
			return "live";

		if (template.indexOf("structures/") === 0 || template.indexOf("sortinghub") === 0 ||
			template.indexOf("territory") === 0 || ent.resourceSupply || ent.foundation)
			return "slow";

		// 有 unitAI 的一律当活动单位处理（Mod 单位的模板路径可能不同，比如 han_tank）
		if (ent.unitAI)
			return "live";

		if (ent.hitpoints != null && ent.player > 0)
			return "slow";

		return "skip";
	}

	/**
	 * 阵亡判定：请求了某个已知 id 却拿不到状态，说明实体已经被消灭
	 * （掉血到 0 之后实体直接消失，不会给你一帧 hp=0 的样本）。
	 */
	countDeaths(requested, got, sim)
	{
		if (!this.combat)
			return;

		for (const id of requested)
		{
			if (got[id] || this.known[id] == null)
				continue;

			const owner = this.known[id];
			const lastHp = this.prevHp[id];
			delete this.known[id];
			delete this.slowCache[id];
			delete this.prevHp[id];

			if (owner === this.me)
			{
				++this.combat.ourLosses;
				// 补上没来得及导出的一口：实体消失时最后一帧的血量同样是掉掉的血
				if (lastHp > 0)
					this.combat.ourHpLost += lastHp;
			}
			else if (sim.players[owner] && sim.players[owner].isEnemy)
			{
				++this.combat.foeKills;
				if (lastHp > 0)
					this.combat.foeHpLost += lastHp;
			}

			this.combat.ratio = +(this.combat.foeHpLost / Math.max(this.combat.ourHpLost, 1)).toFixed(2);
		}
	}

	/**
	 * 一次性深度自检，把真实结构写进 state 的 probe 段，
	 * 让外部大脑按实测字段建模，而不是靠猜和反复人工探针。
	 */
	deepProbe(states)
	{
		const report = {
			"simKeys": Object.keys(GetSimState()),
			"nextId": this.nextId,
			"stride": this.stride,
			"engineFunctions": Object.keys(Engine)
		};

		const players = GetSimState().players;
		for (const idStr in players)
			if (players[idStr])
				report["player" + idStr] = { "keys": Object.keys(players[idStr]), "civ": players[idStr].civ, "state": players[idStr].state };

		const mine = Object.keys(states).filter(k => states[k].player === this.me);
		report.ownCount = mine.length;

		const soldier = mine.find(k => String(states[k].template || "").indexOf("units/") === 0 && states[k].attack);
		if (soldier)
		{
			const ent = states[soldier];
			report.ownUnitFields = Object.keys(ent);
			report.ownUnitAI = this.cut(ent.unitAI, 900);
			report.ownAttack = this.cut(ent.attack, 900);
			report.ownResistance = this.cut(ent.resistance, 300);
			report.ownIdentity = this.cut(ent.identity, 300);
		}

		report.cheats = this.safeCall(() => {
			const out = {};
			for (const file of Engine.ListDirectoryFiles("simulation/data/cheats/", "*.json", false))
			{
				const cheat = this.safeCall(() => Engine.ReadJSONFile(file), null);
				if (cheat)
					out[cheat.Name] = cheat.Data;
			}
			return out;
		}, null);

		// 有预置军队的场景图 = 不用等 AI 走图，进图就能打
		report.scenarios = this.safeCall(
			() => Engine.ListDirectoryFiles("maps/scenarios/", "*.json", false), null);
		report.randomMaps = this.safeCall(
			() => Engine.ListDirectoryFiles("maps/random/", "*.js", false), null);

		// 官方战绩统计是阵亡/击杀的权威来源，比差分准
		const me = GetSimState().players[this.me];
		report.statisticsKeys = me && me.statistics ? Object.keys(me.statistics) : null;
		report.statistics = me ? this.cut(me.statistics, 1500) : null;
		report.statKeysByOwner = {};
		for (const idStr in players)
			if (players[idStr] && players[idStr].statistics)
				report.statKeysByOwner[idStr] = Object.keys(players[idStr].statistics);

		this.probe.report = report;
	}

	/**
	 * 截断超长序列化结果，避免 probe 文件爆掉。
	 */
	cut(value, limit)
	{
		// 探针里的字段经常因为引擎版本/Mod 差异而缺失，cut 不能因为 undefined 就把整份探针带崩
		if (value == null)
			return null;

		const str = typeof value === "string" ? value : uneval(value);
		return str.length > limit ? str.slice(0, limit) + "…" : str;
	}

	// ---------------------------------------------------------------- 状态导出

	exportState(sim)
	{
		const entities = [];
		const seen = {};
		let hidden = 0;
		let posless = 0;
		this.formations = [];

		for (const idStr in sim.entities)
		{
			const ent = sim.entities[idStr];
			if (!ent || !ent.template)
				continue;

			const own = ent.player === this.me;
			const code = this.seenCode(ent, own, sim);

			if (!code)
			{
				++hidden;
				continue;
			}

			// 外人看不见的东西（驻军单位没有坐标）不该出现在地图上；己方必须留档
			const at = ent.position ? { "x": ent.position.x, "z": ent.position.z, "holder": 0 } :
				own ? this.anchorOf(ent, sim.entities) : null;
			if (!at)
			{
				++posless;
				continue;
			}
			if (own && !ent.position)
				++posless;

			if (!this.templates[ent.template])
			{
				this.rememberTemplate(ent);
				this.staticRevPending = true;
			}

			if (own && ent.unitAI && ent.unitAI.formations)
				for (const f of ent.unitAI.formations)
					if (this.formations.indexOf(f) < 0)
						this.formations.push(f);

			seen[code] = (seen[code] || 0) + 1;

			if (entities.length >= this.maxEntities)
				break;

			this.trackDamage(ent, own, code, sim);
			if (!own && code >= 2 && this.isEnemy(ent, own, sim))
				this.foeSeen[ent.player] = true;

			entities.push([
				ent.id,
				ent.template,
				ent.player,
				Math.round(at.x * 10) / 10,
				Math.round(at.z * 10) / 10,
				ent.hitpoints == null ? -1 : Math.round(ent.hitpoints * 10) / 10,
				ent.maxHitpoints == null ? -1 : Math.round(ent.maxHitpoints),
				code,
				code === 3 && ent.unitAI && ent.unitAI.isIdle ? 1 : 0,
				this.isEnemy(ent, own, sim) ? 1 : 0,
				at.holder
			]);
		}

		this.probe.seen = seen;

		const state = {
			"seq": this.seq,
			"wall": Date.now(),
			"me": this.me,
			"now": this.simTime(sim),
			"duration": this.simTime(sim),
			"simRate": this.safeCall(() => Engine.GetSimRate(), null),
			"skippedUnknown": hidden,
			"skippedPosless": posless,
			"players": this.exportPlayers(sim),
			"fields": ["id", "template", "owner", "x", "z", "hp", "maxHp", "seen", "idle", "enemy", "holder"],
			"entities": entities,
			"autopilot": this.autopilot,
			"kernel": this.lastPlan,
			"economy": this.economy,
			"econ": this.lastEcon,
			"combat": this.combat,
			"cfg": this.kernel ? this.kernel.cfg : null,
			// 经济副驾的参数表：控制台旋钮要显示真值，不能只显示"上次我下发了什么"
			"econCfg": this.econ ? this.econ.cfg : null,
			"applied": this.lastApplied,
			"diag": this.diagData,
			"probe": this.probe,
			"steps": this.steps
		};

		try
		{
			Engine.WriteJSONFile(this.dir + "state-" + this.pad(this.seq) + ".json", state);
			++this.writes;
		}
		catch (e)
		{
			this.noteError("state write: " + e.message);
		}

		if (!(this.writes % 50))
			this.writeDiag();
	}

	/**
	 * 仿真秒。引擎给的 timeElapsed 是毫秒 —— 内核所有冷却/间隔参数都按秒写，
	 * 不换算的话 0.6 秒的移动冷却每拍都算"早就过了"，节流会静默失效。
	 */
	simTime(sim)
	{
		const raw = sim.timeElapsed != null ? sim.timeElapsed :
			sim.state && sim.state.duration != null ? sim.state.duration : 0;
		return Math.round(raw / 100) / 10;
	}

	/**
	 * 可见性编码：3=己方可控 2=当前可见 1=仅最后已知位置 0=完全不可见（不导出）。
	 * fogged 是引擎给的最后已知快照，可以画在地图上，但绝不能当集火目标。
	 */
	seenCode(ent, own, sim)
	{
		// mirage| 前缀 = 引擎保留的"最后已知幽灵"，不是活着的实体
		if (String(ent.template || "").indexOf("mirage|") === 0)
			return 1;

		if (own)
			return 3;

		const vis = ent.visibility == null ? "unset" : ent.visibility;
		this.visValues[vis] = (this.visValues[vis] || 0) + 1;

		if (vis === "visible" || vis === "unencrypted")
			return 2;
		if (vis === "fogged")
			return 1;
		return 0;
	}

	isEnemy(ent, own, sim)
	{
		if (own || ent.player <= 0)
			return false;

		const p = sim.players && sim.players[ent.player];
		if (p && p.isEnemy !== undefined)
			return !!p.isEnemy;
		return true;
	}

	/**
	 * 战损统计：靠相邻两拍的 hp 差分，不靠引擎记账。
	 * 多方对局里敌方掉血未必全是我们打的，所以字段名如实写成 foeHpLost。
	 */
	trackDamage(ent, own, code, sim)
	{
		if (!this.combat)
		{
			this.combat = {
				"ourHpLost": 0,
				"foeHpLost": 0,
				"ourHealed": 0,
				"ourLosses": 0,
				"foeKills": 0,
				"ratio": 0,
				"since": this.simTime(sim)
			};
			this.prevHp = {};
		}

		const prev = this.prevHp[ent.id];
		const hp = ent.hitpoints == null ? 0 : ent.hitpoints;
		this.prevHp[ent.id] = hp;
		if (prev == null)
			return;

		const delta = hp - prev;
		const enemy = this.isEnemy(ent, own, sim);

		if (code === 3)
		{
			if (delta < 0)
				this.combat.ourHpLost -= delta;
			else
				this.combat.ourHealed += delta;
			if (prev > 0 && hp <= 0)
				++this.combat.ourLosses;
		}
		else if (enemy)
		{
			if (delta < 0)
				this.combat.foeHpLost -= delta;
			if (prev > 0 && hp <= 0)
				++this.combat.foeKills;
		}

		this.combat.ratio = +(this.combat.foeHpLost / Math.max(this.combat.ourHpLost, 1)).toFixed(2);
	}

	/**
	 * 时代只能从科技推：引擎的 player 对象上没有 phase 这个字段（实测导出来是空串），
	 * 而它自己就是靠 phase_town/phase_city/phase_empire 三项科技记时代的。
	 * 外部大脑的经济标尺（几分钟上城）完全依赖这个字段，宁可在这里补上。
	 */
	phaseOf(techs)
	{
		if (!techs)
			return "village";
		// 科技名带文明后缀（实测 Kush 报的是 phase_town_generic），
		// 精确匹配会把已经上城的局读成村阶段——标尺和评分里的 Town/City 因此全是"未"
		const has = n => Array.isArray(techs)
			? techs.some(t => String(t) === n || String(t).indexOf(n + "_") === 0)
			: Object.keys(techs).some(k => k === n || k.indexOf(n + "_") === 0);
		return has("phase_empire") ? "empire" :
			has("phase_city") ? "city" :
				has("phase_town") ? "town" : "village";
	}

	exportPlayers(sim)
	{
		const players = {};
		for (const idStr in sim.players)
		{
			const p = sim.players[idStr];
			if (!p)
				continue;

			players[idStr] = {
				"name": p.name,
				"civ": p.civ,
				"color": p.color,
				"resources": p.resourceCounts,
				"state": p.state,
				"alliances": p.alliances,
				"competents": p.competents,
				"phase": this.phaseOf(p.researchedTechs),
				"pop": p.popCount,
				"popCap": p.popLimit,
				"classes": p.classCounts,
				"types": p.typeCountsByClass,
				"entities": p.entityCounts,
				"gatherers": p.resourceGatherers,
				// 引擎里 researchedTechs 是 {科技名: 时间} 的表，不是数组
				"techs": p.researchedTechs ? Object.keys(p.researchedTechs) : [],
				"queuing": p.researchQueued,
				"enemy": p.isEnemy,
				"ally": p.isMutualAlly,
				"stats": p.statistics
			};
		}
		return players;
	}

	/**
	 * 首次遇到某个 template 时抓一份完整数值 + 一份实体状态样本，
	 * 让外部大脑拿到真实字段结构，而不是靠猜。
	 */
	rememberTemplate(ent)
	{
		this.templates[ent.template] = this.templateData(ent.template, ent.player);

		const sample = {};
		for (const key in ent)
			if (typeof ent[key] !== "object")
				sample[key] = ent[key];

		this.samples[ent.template] = {
			"scalarFields": sample,
			"objectFields": Object.keys(ent).filter(k => typeof ent[k] === "object")
		};
	}

	exportStatic(sim)
	{
		++this.staticRev;
		const payload = {
			"rev": this.staticRev,
			"me": this.me,
			"templates": this.templates,
			"samples": this.samples,
			"availableFormations": this.availableFormations(sim),
			"availableStances": this.availableStances(sim)
		};

		try
		{
			Engine.WriteJSONFile(this.dir + "static-" + this.pad(this.staticRev) + ".json", payload);
		}
		// static 写失败只影响外部大脑的精度，不中断桥接
		catch (e)
		{
			this.noteError("static write: " + e.message);
		}
	}

	availableFormations(sim)
	{
		for (const idStr in sim.entities)
		{
			const ent = sim.entities[idStr];
			if (ent && ent.player === this.me && ent.unitAI && ent.unitAI.formations)
				return ent.unitAI.formations;
		}
		return null;
	}

	availableStances(sim)
	{
		for (const idStr in sim.entities)
		{
			const ent = sim.entities[idStr];
			if (ent && ent.player === this.me && ent.unitAI && ent.unitAI.selectableStances)
				return ent.unitAI.selectableStances;
		}
		return null;
	}

	defaultFormation()
	{
		return this.safeCall(
			() => typeof g_AutoFormation !== "undefined" && g_AutoFormation ? g_AutoFormation.getDefault() : null,
			null);
	}

	// ---------------------------------------------------------------- 微操内核

	kernelInstance()
	{
		if (this.kernel)
			return this.kernel;

		// 内核脚本按文件名排在桥接之后，首拍可能还没加载完
		if (typeof SuperbrainKernel !== "function")
			return null;

		this.kernel = new SuperbrainKernel({
			"getTemplate": (t, p) => this.templateData(t, p),
			"log": m => this.trace("kernel " + m)
		});
		this.trace("内核已装载");
		return this.kernel;
	}

	templateData(template, player)
	{
		const key = template + "|" + player;
		if (!this.tplCache[key])
			this.tplCache[key] = this.safeCall(() => GetTemplateData(template, player), null) || {};
		return this.tplCache[key];
	}

	/** 把扫描到的实体整理成内核要的归一化快照。 */
	buildWorld(sim)
	{
		const units = [];
		this.seenOf = {};

		for (const idStr in sim.entities)
		{
			const ent = sim.entities[idStr];
			if (!ent || !ent.template)
				continue;

			const own = ent.player === this.me;
			const code = this.seenCode(ent, own, sim);
			this.seenOf[ent.id] = code;

			if (!code)
				continue;

			const at = ent.position ? { "x": ent.position.x, "z": ent.position.z, "holder": 0 } :
				own ? this.anchorOf(ent, sim.entities) : null;
			if (!at)
				continue;

			if (own && ent.unitAI && ent.unitAI.selectableStances)
				for (const s of ent.unitAI.selectableStances)
					if (this.stances.indexOf(s) < 0)
						this.stances.push(s);

			units.push({
				"id": ent.id,
				"t": ent.template,
				"owner": ent.player,
				"x": at.x,
				"z": at.z,
				"hp": ent.hitpoints == null ? 0 : ent.hitpoints,
				"maxHp": ent.maxHitpoints == null ? 1 : ent.maxHitpoints,
				"seen": code,
				"enemy": this.isEnemy(ent, own, sim),
				"holder": at.holder
			});
		}

		return {
			"now": this.simTime(sim),
			"me": this.me,
			"units": units,
			"formations": this.formations,
			"stances": this.stances,
			"rally": this.rallyPoint,
			"objective": this.objective
		};
	}

	runKernel(sim)
	{
		const kernel = this.kernelInstance();
		if (!kernel)
			return;

		if (!this.autopilot)
		{
			this.lastPlan = { "autopilot": false };
			return;
		}

		const world = this.buildWorld(sim);
		const result = this.safeCall(() => kernel.plan(world), null);
		if (!result)
			return;

		this.lastKernel = { "ok": 0, "rejected": 0, "ops": [] };
		this.receipt = this.lastKernel;

		let issued = 0;
		for (const op of result.ops)
		{
			if (issued >= 24)
				break;
			const before = this.receipt.ok;
			this.execute(sim, op);
			if (this.receipt.ok > before)
				++issued;
		}

		this.lastPlan = {
			"autopilot": true,
			"issued": issued,
			"rejected": this.lastKernel.rejected,
			"planned": result.ops.length,
			"foes": result.foes,
			"fight": result.fight,
			"guard": result.guard || null,
			"groups": result.summary,
			"note": result.note || null
		};
		this.receipt = null;
	}

	/** 外部大脑下发的意图/参数，不经过引擎命令通道。 */
	handleMeta(cmd)
	{
		switch (cmd.op)
		{
		case "takeover":
			this.autopilot = !!cmd.on;
			this.trace("接管=" + this.autopilot);
			return true;
		case "config":
			return !!this.configureKernel(cmd.patch);
		case "econ":
			this.economy = !!cmd.on;
			this.trace("经济接管=" + this.economy);
			return true;
		case "econ-config":
			return !!this.configureEcon(cmd.patch);
		case "doctrine":
			return !!this.configureKernel({ "doctrine": cmd.name });
		case "objective":
			this.objective = { "x": +cmd.x, "z": +cmd.z };
			this.trace("目标点 " + cmd.x + "," + cmd.z);
			return true;
		case "rally":
			this.rallyPoint = cmd.x == null ? null : { "x": +cmd.x, "z": +cmd.z };
			return true;
		case "cheat":
			return this.issueCheat(cmd);
		case "speed":
			// 实验台与批量训练用：-autostart-speed 在非观察者模式会被夹到 2，
			// 引擎的 SetSimRate 才是玩家速度按钮走的那条路
			return this.safeCall(() => {
				Engine.SetSimRate(+cmd.value || 1);
				this.trace("仿真速度=" + Engine.GetSimRate());
				return true;
			}, false);
		default:
			return false;
		}
	}

	/**
	 * 实验台：走引擎官方作弊通道，等价于玩家在聊天框敲作弊码。
	 * 用来摆一场可控会战量战损比；这条分支只在单人判定通过后才可达。
	 */
	issueCheat(cmd)
	{
		const receipt = this.bill();
		const payload = {
			"type": "cheat",
			"action": cmd.action,
			"text": cmd.text || "lab",
			"player": cmd.player > 0 ? cmd.player : this.me,
			"parameter": cmd.parameter,
			"templates": cmd.templates || [],
			"selected": cmd.entities || []
		};

		try
		{
			Engine.PostNetworkCommand(payload);
			++receipt.ok;
			receipt.ops.push("cheat:" + cmd.action);
			this.trace("作弊码 " + cmd.action + " x" + cmd.parameter);
		}
		catch (e)
		{
			++receipt.rejected;
			this.noteError("cheat " + cmd.action + ": " + e.message);
		}
		return true;
	}

	configureKernel(patch)
	{
		const kernel = this.kernelInstance();
		if (!kernel)
			return false;
		kernel.configure(patch || {});
		this.trace("参数已更新 " + Object.keys(patch || {}).join(","));
		return true;
	}

	// ---------------------------------------------------------------- 经济副驾

	econInstance()
	{
		if (this.econ)
			return this.econ;

		// 经济脚本按文件名排在桥接之后，首拍可能还没加载完
		if (typeof SuperbrainEconomy !== "function")
			return null;

		this.econ = new SuperbrainEconomy({
			"getTemplate": (t, p) => this.templateData(t, p == null ? this.me : p),
			"getTech": (t, civ) => this.safeCall(
				() => typeof GetTechnologyData === "function" ? GetTechnologyData(t, civ || this.civ()) : null, null),
			"techRequirementsMet": tech => this.safeCall(
				() => Engine.GuiInterfaceCall("CheckTechnologyRequirements", { "tech": tech, "player": this.me }), true),
			"buildable": id => this.safeCall(
				() => Engine.GuiInterfaceCall("GetAllBuildableEntities", { "entities": [id] }), []) || [],
			"canPlace": (t, x, z, angle) => this.placeOk(t, x, z, angle),
			// 经济内核的"引擎未受理"是决策日志，不是异常：进 steps 与 econ.log，
			// 别混进 errors，否则真正的桥接故障会被淹没
			"log": m => this.trace("econ " + m)
		});
		this.trace("经济内核已装载");
		return this.econ;
	}

	civ()
	{
		const sim = this.safeCall(() => GetSimState(), null);
		const p = sim && sim.players && sim.players[this.me];
		return p ? p.civ : null;
	}

	/**
	 * 玩家拖建筑时引擎给的红/绿框，就是这次校验。
	 * 通过返回 true，不通过返回引擎给的理由文字（不是布尔）——
	 * "盖不出田"到底是领地、地形还是占地的问题，之前丢掉 message 就只能靠猜。
	 * 玩家自己正在放建筑时不碰预览，否则会把他的拖拽状态清掉。
	 */
	placeOk(template, x, z, angle)
	{
		if (typeof placementSupport !== "undefined" && placementSupport && placementSupport.mode)
			return true;

		try
		{
			const result = Engine.GuiInterfaceCall("SetBuildingPlacementPreview", {
				"template": template,
				"x": x,
				"z": z,
				"angle": angle || 0,
				"actorSeed": 0
			});
			Engine.GuiInterfaceCall("SetBuildingPlacementPreview", { "template": "" });
			if (result && result.success)
				return true;

			const msg = String((result && result.message) || "引擎没给理由");
			return msg.replace(/%\(\w+\)s/g, "?").slice(0, 48);
		}
		catch (e)
		{
			this.noteError("canPlace: " + e.message);
			return "校验异常";
		}
	}

	/** 可采集点分类：优先用引擎给的 type.generic，缺字段再按模板名兜。 */
	nodeKind(ent)
	{
		const supply = ent.resourceSupply || {};
		const type = supply.type || {};
		const raw = String(type.generic || supply.kind || supply.class || "").split(".")[0];
		if (["food", "wood", "stone", "metal"].indexOf(raw) >= 0)
			return raw;

		const t = String(ent.template);
		if (/\/tree|wood/.test(t))
			return "wood";
		if (/\/rock|stone/.test(t))
			return "stone";
		if (/\/ore|metal/.test(t))
			return "metal";
		if (/field|farm|fruit|berry|fauna|fish|grain|chicken|deer|aurochs|boar|rabbit|herd/.test(t))
			return "food";
		return null;
	}

	/** 把扫描到的实体整理成经济内核要的国家级快照。 */
	buildEconWorld(sim)
	{
		const p = sim.players[this.me] || {};
		const own = [];
		const raw = [];
		const raiders = [];
		for (const idStr in sim.entities)
		{
			const ent = sim.entities[idStr];
			if (!ent || !ent.template)
				continue;

			const mine = ent.player === this.me;
			const code = this.seenCode(ent, mine, sim);
			if (!code)
				continue;

			const at = ent.position ? { "x": ent.position.x, "z": ent.position.z, "holder": 0 } :
				mine ? this.anchorOf(ent, sim.entities) : null;
			if (!at)
				continue;

			if (ent.resourceSupply)
			{
				const supply = ent.resourceSupply;
				if (!this.probe.supplyShape && this.dir)
					this.probe.supplyShape = this.cut(supply, 400);
				raw.push({
					"id": ent.id,
					"t": ent.template,
					"x": at.x,
					"z": at.z,
					"kind": this.nodeKind(ent),
					// 引擎直接告诉你这个点还剩多少、能同时挂几个人、已经挂了几个人
					"supply": supply.amount == null ? null : supply.amount,
					"cap": supply.maxGatherers == null ? null : supply.maxGatherers,
					"used": supply.numGatherers == null ? null : supply.numGatherers
				});
			}

			if (!mine)
			{
				// 家里安全不安全，是按"最近的敌人单位离家多远"算的
				if (code >= 2 && String(ent.template).indexOf("units/") === 0 &&
					this.isEnemy(ent, mine, sim) && raiders.length < 400)
					raiders.push(at);
				continue;
			}

			// 记下引擎自己声明的"这栋楼能训什么"：外部大脑据此建模，
			// 出问题时也能直接看出是不是 trainer 清单与现实不符
			if (ent.trainer && ent.trainer.entities)
			{
				if (!this.probe.trainers)
					this.probe.trainers = {};
				if (!this.probe.trainers[ent.template])
					this.probe.trainers[ent.template] = this.cut(ent.trainer.entities, 400);
			}
			if (ent.production && ent.production.queue && !this.probe.queueShape)
				this.probe.queueShape = this.cut(ent.production.queue, 400);

			// 成对科技/空洞的形状只探一次，让内核按实测结构处理而不是猜
			if (!this.probe.techShape && ent.researcher && ent.researcher.technologies)
			{
				this.probe.techShape = this.cut(ent.researcher.technologies.slice(0, 3), 600);
				this.probe.techKeys = ent.researcher.technologies.filter(t => t != null)
					.map(t => Object.keys(t)).slice(0, 3);
			}

			const held = ent.garrisonHolder ? ent.garrisonHolder.entities : null;

			own.push({
				"id": ent.id,
				"t": ent.template,
				"x": at.x,
				"z": at.z,
				"hp": ent.hitpoints == null ? 0 : ent.hitpoints,
				"maxHp": ent.maxHitpoints == null ? 1 : ent.maxHitpoints,
				"idle": !!(ent.unitAI && ent.unitAI.isIdle),
				"needsRepair": !!ent.needsRepair,
				"trainer": ent.trainer ? ent.trainer.entities : null,
				"queue": ent.production ? ent.production.queue : null,
				"autoqueue": !!(ent.production && ent.production.autoqueue),
				"techs": ent.researcher ? ent.researcher.technologies : null,
				"seen": code,
				// holder>0 = 被关在这栋楼/这个单位里，既不能采集也不能作战，要 unload 才回来
				"holder": at.holder,
				"garrison": held ? held.length : 0,
				"garrisonCap": ent.garrisonHolder && ent.garrisonHolder.capacity != null ?
					ent.garrisonHolder.capacity : null
			});
		}

		// 资源点只留城镇附近能用的那些：整张图几千棵树没必要进决策
		const nodes = this.pickNodes(raw, own);
		const home = own.find(e => /civil_centre|civic_center/.test(String(e.t))) ||
			own.find(e => String(e.t).indexOf("structures/") === 0 && !e.holder) || { "x": 0, "z": 0 };
		let threatDist = null;
		for (const r of raiders)
		{
			const d = Math.hypot(r.x - home.x, r.z - home.z);
			if (threatDist == null || d < threatDist)
				threatDist = d;
		}
		const foes = [];
		for (const idStr in sim.players)
		{
			const foe = sim.players[idStr];
			if (!foe || +idStr === this.me || !foe.isEnemy || !this.foeSeen[idStr])
				continue;
			foes.push({ "id": +idStr, "classes": foe.classCounts || {}, "pop": foe.popCount || 0 });
		}

		return {
			"now": this.simTime(sim),
			"me": this.me,
			"player": {
				"civ": p.civ,
				"pop": p.popCount,
				"popCap": p.popLimit,
				"phase": this.phaseOf(p.researchedTechs),
				"resources": p.resourceCounts || {},
				"gatherers": p.resourceGatherers || {},
				"classes": p.classCounts || {},
				"techs": p.researchedTechs ? Object.keys(p.researchedTechs) : []
			},
			"own": own,
			"nodes": nodes,
			"foes": foes,
			// 最近敌人离家的距离（没有可见敌人 = null）：经济据此决定什么时候把村民放出主城
			"threatDist": threatDist,
			"doctrine": this.kernel ? this.kernel.cfg.doctrine : "field"
		};
	}

	pickNodes(nodes, own)
	{
		const anchors = own.filter(e => String(e.t).indexOf("structures/") === 0);
		if (!anchors.length || !nodes.length)
			return nodes.slice(0, 240);

		const near = [];
		for (const n of nodes)
		{
			if (!n.kind)
				continue;
			let best = Infinity;
			for (const a of anchors)
			{
				const d = Math.hypot(n.x - a.x, n.z - a.z);
				if (d < best)
					best = d;
			}
			if (best < 150)
				near.push({ "n": n, "d": best });
		}

		near.sort((a, b) => a.d - b.d);
		return near.slice(0, 240).map(x => x.n);
	}

	runEconomy(sim)
	{
		const econ = this.econInstance();
		if (!econ)
			return;

		if (!this.economy)
		{
			this.lastEcon = { "off": true };
			return;
		}

		const world = this.buildEconWorld(sim);
		const result = this.safeCall(() => econ.plan(world), null);
		if (!result)
			return;

		this.lastEcon = result.summary;

		if (!result.ops.length)
		{
			if (this.lastEcon)
			{
				this.lastEcon.issued = 0;
				this.lastEcon.issuedTotal = this.econTotal;
			}
			return;
		}

		const receipt = { "ok": 0, "rejected": 0, "ops": [], "meta": [] };
		this.receipt = receipt;

		let issued = 0;
		for (const op of result.ops)
		{
			if (issued >= 10)
				break;
			const before = receipt.ok;
			this.execute(sim, op);
			if (receipt.ok > before)
				++issued;
		}

		this.receipt = null;
		this.econTotal += issued;
		this.econRejected += receipt.rejected;
		if (this.lastEcon)
		{
			this.lastEcon.issued = issued;
			this.lastEcon.issuedTotal = this.econTotal;
			this.lastEcon.rejectedTotal = this.econRejected;
		}
	}

	configureEcon(patch)
	{
		const econ = this.econInstance();
		if (!econ)
			return false;
		econ.configure(patch || {});
		this.trace("经济参数已更新 " + Object.keys(patch || {}).join(","));
		return true;
	}

	toggleEconomy()
	{
		this.economy = !this.economy;
		this.trace("经济接管=" + this.economy);
		this.notify(this.economy ? "副驾开始管经济" : "经济交还手动");
	}

	toggleAutopilot()
	{
		this.autopilot = !this.autopilot;
		this.trace("切换接管=" + this.autopilot);
		this.notify(this.autopilot ? "副驾已接管军队" : "已交还军队操控权");
	}

	setDoctrine(name)
	{
		if (!this.configureKernel({ "doctrine": name }))
			return;
		this.trace("教条=" + name);
		this.notify("打法切换：" + name);
	}

	/**
	 * 屏上提示走 addChatMessage（纯客户端渲染）。
	 * 别用 Engine.SendNetworkChat：本地单人对局没有网络会话，那个调用会在 C++ 层解引用空指针崩掉进程。
	 */
	notify(message)
	{
		this.announce(message);
		this.safeCall(() => {
			if (typeof addChatMessage !== "function")
				return;
			addChatMessage({
				"type": "message",
				"guid": -1,
				"player": this.me,
				"text": message,
				"translate": false,
				"translateParameters": [],
				"parameters": {}
			});
		}, null);
	}

	// ---------------------------------------------------------------- 命令注入

	pollCommands(sim)
	{
		// 等状态导出跑通 several 次之后才去读外部文件，避免首次崩溃点落在受限路径读取上
		if (this.writes < 5)
			return;

		let files;
		try
		{
			files = Engine.ListDirectoryFiles(this.dir, "cmd-*.json", false);
		}
		catch (e)
		{
			return;
		}
		if (!files || !files.length)
			return;

		let newest = null;
		let newestSeq = this.lastCmdSeq;
		for (const file of files)
		{
			const seq = this.seqFromName(file);
			if (seq > newestSeq)
			{
				newestSeq = seq;
				newest = file;
			}
		}
		if (!newest)
			return;

		const msg = this.safeCall(() => Engine.ReadJSONFile(newest), null);
		if (!msg || !msg.commands)
			return;

		this.lastCmdSeq = newestSeq;
		this.lastApplied = {
			"cmdSeq": newestSeq,
			"executedWall": Date.now(),
			"ok": 0,
			"rejected": 0,
			"meta": [],
			"ops": []
		};
		this.receipt = this.lastApplied;

		for (const cmd of msg.commands)
		{
			if (this.lastApplied.ok + this.lastApplied.rejected >= 60)
				break;
			if (this.handleMeta(cmd))
			{
				this.lastApplied.meta.push(cmd.op);
				continue;
			}
			this.execute(sim, cmd);
		}

		this.receipt = null;
	}

	seqFromName(path)
	{
		const match = /-(\d+)\.json$/.exec(path);
		return match ? +match[1] : -1;
	}

	bill()
	{
		if (!this.receipt)
		{
			this.receipt = { "ok": 0, "rejected": 0, "ops": [], "meta": [] };
			this.lastApplied = this.receipt;
		}
		return this.receipt;
	}

	execute(sim, cmd)
	{
		const receipt = this.bill();
		const payload = this.buildPayload(sim, cmd);
		if (!payload)
		{
			++receipt.rejected;
			return;
		}

		const actors = payload.entities || (payload.entity != null ? [payload.entity] : null);
		if (!actors || !actors.length)
		{
			++receipt.rejected;
			this.noteError(cmd.op + ": 无可控制单位");
			return;
		}

		try
		{
			Engine.PostNetworkCommand(payload);
			++receipt.ok;
			receipt.ops.push(cmd.op);
		}
		catch (e)
		{
			++receipt.rejected;
			this.noteError(cmd.op + ": " + e.message);
		}
	}

	/**
	 * 命令体与 gui/session/unit_actions.js 里玩家鼠标发出的结构完全一致。
	 * 任何不属于本玩家或不可见的目标都会被丢弃。
	 */
	buildPayload(sim, cmd)
	{
		const formation = this.defaultFormation();

		// 只有确实需要目标实体的命令才校验，避免把非法目标喂给引擎
		if (cmd.op === "attack" || cmd.op === "garrison" || cmd.op === "heal" ||
			cmd.op === "repair" || cmd.op === "gather" || cmd.op === "returnresource" ||
			cmd.op === "guard" || cmd.op === "remove-guard")
		{
			if (!this.visible(sim, cmd.target))
			{
				this.noteError(cmd.op + ": 非法目标 " + cmd.target);
				return null;
			}
		}

		switch (cmd.op)
		{
		case "walk":
			return {
				"type": "walk",
				"entities": this.own(sim, cmd.entities),
				"x": cmd.x, "z": cmd.z,
				"queued": false, "pushFront": false,
				"formation": cmd.formation === undefined ? formation : cmd.formation
			};
		case "attack-walk":
			return {
				"type": "attack-walk",
				"entities": this.own(sim, cmd.entities),
				"x": cmd.x, "z": cmd.z,
				"targetClasses": cmd.targetClasses || { "attack": ["Unit", "Structure"] },
				"queued": false, "pushFront": false,
				"formation": cmd.formation === undefined ? null : cmd.formation
			};
		case "attack":
			return {
				"type": "attack",
				"entities": this.own(sim, cmd.entities),
				"target": cmd.target,
				"allowCapture": true,
				"queued": false, "pushFront": false,
				"formation": null
			};
		case "stop":
			return { "type": "stop", "entities": this.own(sim, cmd.entities), "queued": false };
		case "guard":
			return {
				"type": "guard",
				"entities": this.own(sim, cmd.entities),
				"target": cmd.target,
				"queued": false, "pushFront": false, "formation": null
			};
		case "remove-guard":
			return {
				"type": "remove-guard",
				"entities": this.own(sim, cmd.entities),
				"target": cmd.target, "queued": false, "pushFront": false
			};
		case "patrol":
			return {
				"type": "patrol",
				"entities": this.own(sim, cmd.entities),
				"x": cmd.x, "z": cmd.z,
				"targetClasses": cmd.targetClasses || { "attack": ["Unit", "Structure"] },
				"queued": false, "allowCapture": false, "formation": formation
			};
		case "garrison":
			return {
				"type": "garrison",
				"entities": this.own(sim, cmd.entities),
				"target": cmd.target,
				"queued": false, "pushFront": false, "formation": null
			};
		case "unload":
			// 引擎格式见 simulation/helpers/Commands.js 的 "unload"：
			// entities 是被关的单位，garrisonHolder 是关着它们的建筑
			return {
				"type": "unload",
				"entities": this.own(sim, cmd.entities),
				"garrisonHolder": cmd.holder
			};
		case "heal":
			return {
				"type": "heal",
				"entities": this.own(sim, cmd.entities),
				"target": cmd.target,
				"queued": false, "pushFront": false, "formation": null
			};
		case "repair":
			return {
				"type": "repair",
				"entities": this.own(sim, cmd.entities),
				"target": cmd.target, "autocontinue": true,
				"queued": false, "pushFront": false, "formation": null
			};
		case "gather":
			return {
				"type": "gather",
				"entities": this.own(sim, cmd.entities),
				"target": cmd.target,
				"queued": false, "pushFront": false, "formation": formation
			};
		case "returnresource":
			return {
				"type": "returnresource",
				"entities": this.own(sim, cmd.entities),
				"target": cmd.target,
				"queued": false, "pushFront": false, "formation": formation
			};
		case "back-to-work":
			return { "type": "back-to-work", "entities": this.own(sim, cmd.entities) };
		case "autoqueue-on":
			return { "type": "autoqueue-on", "entities": this.own(sim, cmd.entities) };
		case "autoqueue-off":
			return { "type": "autoqueue-off", "entities": this.own(sim, cmd.entities) };
		case "stop-production":
			return { "type": "stop-production", "entity": this.own(sim, [cmd.entity])[0], "id": cmd.id };
		case "formation":
			return { "type": "formation", "entities": this.own(sim, cmd.entities), "formation": cmd.name };
		case "stance":
			return { "type": "stance", "entities": this.own(sim, cmd.entities), "name": this.pickStance(cmd.name) };
		case "promote":
			return { "type": "promote", "entities": this.own(sim, cmd.entities) };
		case "train":
			return {
				"type": "train",
				"entities": this.own(sim, [cmd.entity]),
				"template": cmd.template, "count": cmd.count || 1, "pushFront": false
			};
		case "research":
			return {
				"type": "research",
				"entity": this.own(sim, [cmd.entity])[0],
				"template": cmd.template, "pushFront": false
			};
		case "upgrade":
			return {
				"type": "upgrade",
				"entities": this.own(sim, cmd.entities),
				"template": cmd.template, "queued": false
			};
		case "construct":
			return {
				"type": "construct",
				"entities": this.own(sim, cmd.entities),
				"template": cmd.template,
				"x": cmd.x, "z": cmd.z, "angle": cmd.angle || 0,
				"autorepair": true, "autocontinue": false,
				"queued": false, "pushFront": false, "formation": formation,
				"actorSeed": 0
			};
		case "set-rallypoint":
			return {
				"type": "set-rallypoint",
				"entities": this.own(sim, cmd.entities),
				"x": cmd.x, "z": cmd.z, "data": cmd.data
			};
		default:
			this.noteError("unknown op: " + cmd.op);
			return null;
		}
	}

	pickStance(want)
	{
		if (!this.stances.length || (want && this.stances.indexOf(want) >= 0))
			return want;
		return this.stances.indexOf("aggressive") >= 0 ? "aggressive" : this.stances[0];
	}

	ent(sim, id)
	{
		if (sim.entities && sim.entities[id])
			return sim.entities[id];

		// 命令里出现的 id 未必在本轮扫描结果里，按需单取
		return this.safeCall(() => GetEntityState(id), null);
	}

	own(sim, ids)
	{
		if (!ids)
			return [];

		const out = [];
		for (const id of ids)
		{
			const ent = this.ent(sim, id);
			if (ent && ent.player === this.me)
				out.push(id);
		}
		return out;
	}

	/** 只有当前可见（或己方）的目标才允许下攻击/移动类指令；fogged 只是过期情报。 */
	visible(sim, id)
	{
		if (this.seenOf[id] != null)
			return this.seenOf[id] >= 2;

		const ent = this.ent(sim, id);
		if (!ent)
			return false;

		if (ent.player === this.me)
			return true;

		const vis = ent.visibility == null ? "unset" : ent.visibility;
		return vis === "visible" || vis === "unencrypted";
	}

	// ---------------------------------------------------------------- 工具

	pad(n)
	{
		let str = String(n);
		while (str.length < 6)
			str = "0" + str;
		return str;
	}

	safeCall(fn, fallback)
	{
		try
		{
			return fn();
		}
		catch (e)
		{
			this.noteError(e.message);
			return fallback;
		}
	}

	noteError(message)
	{
		this.errors.push(message);
		if (this.errors.length > 60)
			this.errors.shift();
	}
}

(function()
{
	var tries = 0;

	function boot()
	{
		if (typeof registerSimulationUpdateHandler !== "function")
		{
			if (tries++ < 2)
				warn("[superbrain] session.js 还没加载，延迟重试");
			setTimeout(boot, 300);
			return;
		}

		try
		{
			g_SuperbrainBridge = new SuperbrainBridge();
			registerSimulationUpdateHandler(g_SuperbrainBridge.update.bind(g_SuperbrainBridge));
			g_SuperbrainBridge.trace("已挂钩 update");
		}
		catch (e)
		{
			if (typeof warn === "function")
				warn("[superbrain] 挂钩失败 " + (e && e.message) + " 行 " + (e && e.lineNumber));
		}
	}

	boot();
})();

// gui/session/hotkeys/superbrain.xml 里的 action 直接按名字调这两个全局函数
function superbrainToggle()
{
	if (g_SuperbrainBridge)
		g_SuperbrainBridge.toggleAutopilot();
}

function superbrainDoctrine(name)
{
	if (g_SuperbrainBridge)
		g_SuperbrainBridge.setDoctrine(name);
}

function superbrainEconomy()
{
	if (g_SuperbrainBridge)
		g_SuperbrainBridge.toggleEconomy();
}
