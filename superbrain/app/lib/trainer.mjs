/**
 * 训练模式：自动生成对战、跑参数、收指标 —— "越玩越强"的手。
 *
 * 一条硬约束决定了整个设计：public.zip 被引擎独占打开，第二个 pyrogenesis 实例
 * 读不到任何 mod 文件。所以批量对局只能串行，一次一局，跑完杀进程再开下一局。
 *
 * 判胜负看 players[].state（引擎里的 "Defeated"），不猜：
 * 我方被击败 = 负；可见敌对玩家全部被击败 = 胜；仿真时长封顶 = 按当前积分判。
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { GameLink, readJson, seqOf } from "./ipc.mjs";
import { outcome, viewOf } from "./frames.mjs";
import { packCommands, samplePack, searchSpace, sampleEcon, econSpace } from "./presets.mjs";
import { stateDir } from "./config.mjs";

const TRAIN_DIR = path.join(stateDir, "training");
const POLL_MS = 1200;

export class Trainer
{
	constructor(cfg, emit)
	{
		this.cfg = cfg;
		this.emit = emit || (() => {});
		this.job = null;
		this.child = null;
		this.link = null;
		this.log = [];
		this.active = false;
		this.stopRequested = false;
	}

	get running()
	{
		return this.active;
	}

	leaderboard()
	{
		return readJson(path.join(TRAIN_DIR, "leaderboard.json")) || { "entries": [], "updated": 0 };
	}

	bestPack()
	{
		return readJson(path.join(TRAIN_DIR, "best.json"));
	}

	status()
	{
		return {
			"running": this.running,
			"job": this.job ? Object.assign({}, this.job, { "child": this.child ? this.child.pid : null }) : null,
			"log": this.log.slice(-40)
		};
	}

	note(message)
	{
		const line = { "at": Date.now(), "text": message };
		this.log.push(line);
		if (this.log.length > 200)
			this.log.shift();
		this.emit("train", message);
	}

	/**
	 * @param plan {trials, mode:"random"|"hill", budgetSim, wallLimitSec, speed, force, base}
	 */
	async start(plan = {})
	{
		if (this.running)
			throw new Error("已有训练任务在跑");

		const t = this.cfg.train;
		fs.mkdirSync(TRAIN_DIR, { "recursive": true });
		if (!plan.force && (this.engineRunning() || await this.gameAlive()))
			throw new Error("检测到引擎进程或在跑的对局。同一时刻只能有一个 pyrogenesis 实例，" +
				"两个实例会抢 public.zip 直接把第二个崩掉；请先退出游戏或勾选手动强制。");

		this.active = true;
		this.job = {
			"trials": clamp(plan.trials || t.rounds, 1, 200),
			"mode": ["hill", "baseline"].includes(plan.mode) ? plan.mode : "random",
			// target=econ：只撒经济参数、只按运营曲线打分，军事参数一个都不动。
			// 经济模块要能单独微调，不然调出来的分永远分不清是运营好还是微操好
			"target": plan.target === "econ" ? "econ" : "mixed",
			"budgetSim": plan.budgetSim || 1200,
			"wallLimitSec": plan.wallLimitSec || Math.round((plan.budgetSim || 1200) / (plan.speed || t.speed) * 1.8) + 120,
			"speed": plan.speed || t.speed,
			"startedAt": Date.now(),
			"running": true,
			"done": 0,
			"space": plan.space || (plan.target === "econ" ? { "econ": econSpace() } : searchSpace()),
			"base": plan.base || null,
			"map": plan.map || t.map,
			"aiDiff": plan.aiDiff != null ? clamp(+plan.aiDiff, 1, 10) : t.aiDiff,
			"seedBase": plan.seed != null ? plan.seed : t.seed,
			"note": ""
		};
		this.stopRequested = false;

		this.runLoop().catch(e => {
			this.note(`训练中断：${e.message}`);
			this.finish(e.message);
		});
		return this.job;
	}

	/** 最近一帧还在动 = 有人在玩，不能抢。 */
	async gameAlive()
	{
		const link = new GameLink(this.cfg);
		link.discover();
		const frame = link.poll();
		return !!frame && Date.now() - (frame.wall || 0) < 6000;
	}

	/**
	 * 只看帧不够：引擎从起进程到写出第一帧要十几秒，这段时间里"没有帧"和"没有实例"
	 * 长得一模一样，再起一个就是两个实例抢 public.zip —— 第二个必崩（实盘崩过两次）。
	 */
	engineRunning()
	{
		const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq pyrogenesis.exe", "/NH"],
			{ "windowsHide": true, "encoding": "utf8" });
		return /pyrogenesis\.exe/i.test(String(r.stdout || ""));
	}

	async runLoop()
	{
		const records = [];
		let best = this.bestPack();
		for (let i = 0; i < this.job.trials && !this.stopRequested; ++i)
		{
		// baseline = 一版参数都不下发，跑出厂默认值。改完内核要拿它做回归基线，
		// 否则排行榜只回答"哪组参数最会打"，回答不了"这次改动有没有把默认打法改坏"
		const pack = this.job.mode === "baseline" ? {} :
			this.job.target === "econ" ? sampleEcon(this.job.space.econ) :
				this.job.mode === "hill" && best ? neighbor(best, this.job.space) : samplePack(this.job.space);
			this.note(`第 ${i + 1}/${this.job.trials} 局开始（${this.job.mode}，speed ${this.job.speed}x，预算 ${this.job.budgetSim}s）`);
			let rec;
			try
			{
				rec = await this.runOne(pack);
			}
			catch (e)
			{
				this.note(`第 ${i + 1} 局失败：${e.message}`);
				rec = { "pack": pack, "error": e.message, "score": -1, "win": false, "simNow": 0 };
			}
			records.push(rec);
			this.job.done = i + 1;
			this.job.last = rec;
			if (rec.score != null && (!best || rec.score > (best.score || -1)))
			{
				best = Object.assign({}, rec.pack, { "score": rec.score });
				fs.writeFileSync(path.join(TRAIN_DIR, "best.json"), JSON.stringify(best, null, "\t"), "utf8");
				this.note(`新高：${Math.round(rec.score)} 分（${rec.win ? "胜" : rec.reason || "结算"}）`);
			}
			this.persist(records);
			if (i < this.job.trials - 1 && !this.stopRequested)
				await sleep(4000);   // 等引擎把文件句柄放干净再开下一局
		}
		this.finish(this.stopRequested ? "手动停止" : "跑完");
	}

	persist(records)
	{
		const board = records.slice().sort((a, b) => (b.score || -1) - (a.score || -1)).slice(0, 40)
			.map(r => ({ "score": Math.round(r.score || -1), "win": !!r.win, "reason": r.reason || "", "ruler": r.ruler || "", "simNow": Math.round(r.simNow || 0), "pop": r.pop || 0, "civilians": r.civilians || 0, "soldiers": r.soldiers || 0, "kills": r.kills || 0, "losses": r.losses || 0, "ratio": r.ratio || null, "pack": r.pack, "at": r.at }));
		fs.writeFileSync(path.join(TRAIN_DIR, "leaderboard.json"), JSON.stringify({ "updated": Date.now(), "entries": board }, null, "\t"), "utf8");
		fs.writeFileSync(path.join(TRAIN_DIR, "last-run.json"), JSON.stringify({ "job": this.job, "records": records.slice(-10) }, null, "\t"), "utf8");
	}

	finish(reason)
	{
		this.killChild();
		this.active = false;
		this.job = this.job ? Object.assign({}, this.job, { "running": false, "finished": reason, "finishedAt": Date.now() }) : null;
		this.note(`训练结束：${reason}`);
	}

	async runOne(pack)
	{
		// 上一局的进程必须真的退干净才起下一局：进程还在但还没写帧的那十几秒里，
		// "没有帧"和"没有实例"看不出区别，再起一个就是两个实例抢 public.zip（实测崩过两次）
		for (let waited = 0; this.engineRunning() && waited < 20000; waited += 1000)
			await sleep(1000);
		if (this.engineRunning())
			throw new Error("还有 pyrogenesis 进程没退干净，先关掉再重跑");

		const launchWall = Date.now();
		const child = this.launch();
		this.child = child;

		const link = new GameLink(this.cfg);
		let attached = null;
		for (let waited = 0; waited < 150000 && !this.stopRequested; waited += 2000)
		{
			if (child.exitCode != null)
				throw new Error(`引擎启动后即退出（码 ${child.exitCode}），多半是 public.zip 被另一个实例占用`);
			attached = link.discover({ "afterMs": launchWall });
			if (attached)
				break;
			await sleep(2000);
		}
		if (!attached)
		{
			this.killChild();
			throw new Error("150 秒内没等到 state 帧：副驾没进 GUI 作用域，查 interestinglog.html");
		}
		this.note(`已连上 ${path.basename(attached)}`);

		const commands = packCommands({ "micro": pack.micro, "econ": pack.econ }).concat([{ "op": "takeover", "on": true }, { "op": "econ", "on": true }, { "op": "speed", "value": this.job.speed }]);
		link.send(commands);

		const rec = { "at": Date.now(), "pack": pack, "run": path.basename(attached), "map": this.job.map };
		let lastFrame = 0;
		let staleFor = 0;

		for (;;)
		{
			if (this.stopRequested)
				break;
			const frame = link.poll();
			if (frame && frame.wall !== lastFrame)
			{
				lastFrame = frame.wall;
				staleFor = 0;
				const view = viewOf(frame);
				const o = outcome(view);
				rec.simNow = view.simNow;
				rec.pop = view.my.pop;
				rec.civilians = (view.econ || {}).civilians || view.counts.workers;
				rec.soldiers = view.counts.army;
				rec.kills = (view.combat || {}).foeKills || 0;
				rec.losses = (view.combat || {}).ourLosses || 0;
				rec.ratio = (view.combat || {}).ratio;
				rec.win = o.win;
				rec.reason = o.over ? o.reason : "";
				rec.rejected = (view.kernel || {}).rejected || 0;
				trackEcon(rec, view);
				if (o.over)
				{
					this.note(`判定：${o.reason}（仿真 ${Math.round(view.simNow)}s 人口 ${view.my.pop}）`);
					break;
				}
				if (view.simNow >= this.job.budgetSim)
				{
					rec.reason = rec.reason || "到达时间预算";
					break;
				}
			}
			else
			{
				staleFor += POLL_MS;
			}

			if (child.exitCode != null)
			{
				rec.reason = "对局进程退出（玩家或引擎自行结束）";
				break;
			}
			if (staleFor > 25000)
			{
				rec.reason = "帧停止更新（游戏最小化或崩溃）";
				break;
			}
			if (Date.now() - launchWall > this.job.wallLimitSec * 1000)
			{
				rec.reason = "到达墙钟上限";
				break;
			}
			await sleep(POLL_MS);
		}

		rec.score = this.job.target === "econ" ? econScoreOf(rec) : scoreOf(rec);
		rec.ruler = econRuler(rec);
		this.killChild();
		fs.writeFileSync(path.join(TRAIN_DIR, `trial-${Date.now().toString(36)}.json`),
			JSON.stringify(Object.assign({}, rec, { "dir": attached }), null, "\t"), "utf8");
		return rec;
	}

	launch()
	{
		const t = this.cfg.train;
		const exe = path.join(this.cfg.game.root, this.cfg.game.exe);
		if (!fs.existsSync(exe))
			throw new Error(`找不到引擎：${exe}`);

		const args = [
			`-autostart=${this.job.map}`,
			`-autostart-players=${t.players}`,
			`-autostart-size=${t.mapSize}`,
			`-autostart-civ=1:${t.ourCiv}`,
			`-autostart-civ=2:${t.foeCiv}`,
			`-autostart-ai=2:${t.foeAi}`,
			`-autostart-aidiff=2:${this.job.aiDiff}`,
			`-autostart-seed=${this.job.seedBase || t.seed}`,
			`-autostart-visibility=${t.visibility}`,
			`-autostart-speed=${Math.min(2, this.job.speed)}`,
			"-xres=1200",
			"-yres=720"
		];
		this.note(`启动：${path.basename(exe)} ${args.join(" ")}`);
		return spawn(exe, args, { "cwd": path.dirname(exe), "stdio": "ignore", "windowsHide": false });
	}

	killChild()
	{
		if (!this.child)
			return;
		const pid = this.child.pid;
		try
		{
			spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { "windowsHide": true });
		}
		catch (e)
		{
			try { this.child.kill(); } catch (e2) { /* 已经退了 */ }
		}
		this.child = null;
	}

	stop()
	{
		this.stopRequested = true;
		this.note("收到停止请求");
		return { "ok": true };
	}

	/** 把训练出来的最优包下发给当前对局。 */
	applyBest()
	{
		const best = this.bestPack();
		if (!best)
			return { "ok": false, "error": "还没有训练结果" };
		const link = new GameLink(this.cfg);
		if (!link.discover())
			return { "ok": false, "error": "没连上对局" };
		link.send(packCommands({ "micro": best.micro, "econ": best.econ }));
		return { "ok": true, "pack": best };
	}
}

/**
 * 逐帧累计经济读数。这些是 target=econ 的全部输入：
 * 只记运营能解释的东西（人口/农民里程碑、上阶段时刻、矿工峰值、田与房、闲汉、被拒），
 * 不记战果 —— 战果里混着微操，用它调经济权重就是隔靴搔痒。
 */
function trackEcon(rec, view)
{
	const e = view.econ || {};
	rec.marks = rec.marks || { "rise": {}, "at": {}, "miner": { "stone": 0, "metal": 0 }, "struct": {}, "stock": {} };
	const phase = view.my.phase;
	if (phase && rec.marks.rise[phase] == null)
		rec.marks.rise[phase] = Math.round(view.simNow);

	for (const s of [300, 600, 900, 1200])
	{
		if (view.simNow >= s && !rec.marks.at[s])
			rec.marks.at[s] = { "pop": view.my.pop, "civ": e.civilians ?? view.counts.workers, "sol": view.counts.army };
	}
	const g = e.gatherers || {};
	rec.marks.miner.stone = Math.max(rec.marks.miner.stone, g.stone || 0);
	rec.marks.miner.metal = Math.max(rec.marks.miner.metal, g.metal || 0);
	// 手册口径的报价时刻：Town 要 500 粮 + 500 木，City 要 1000 石 + 1000 金。
	// 库存会被花掉，所以记"首次达到"，这比终局库存更能说明节奏
	const res = view.my.resources || {};
	for (const r of ["food", "wood", "stone", "metal"])
	{
		const need = r === "stone" || r === "metal" ? 1000 : 500;
		if (rec.marks.stock[r] == null && (res[r] || 0) >= need)
			rec.marks.stock[r] = Math.round(view.simNow);
	}
	rec.marks.struct = { "houses": e.houses || 0, "fields": e.fields || 0, "cc": e.cc || 0, "producers": e.producers || 0 };
	rec.idleMax = Math.max(rec.idleMax || 0, e.idle || 0);
	rec.econRejected = e.rejectedTotal || 0;
	rec.stall = (e.alerts || []).length;
}

/** 一行经济标尺，给排行榜和日志用。 */
function econRuler(rec)
{
	const m = rec.marks || {};
	const at = m.at || {};
	const a6 = at[600] || at[300] || {};
	const rise = m.rise || {};
	const s = m.struct || {};
	const stock = m.stock || {};
	const fmt = v => (v == null ? "未" : `${Math.floor(v / 60)}分${String(v % 60).padStart(2, "0")}秒`);
	return `人口@10分${a6.pop ?? "?"} 农${a6.civ ?? "?"} ` +
		`Town@${rise.town ?? "未"} City@${rise.city ?? "未"} ` +
		`报价 粮${fmt(stock.food)} 木${fmt(stock.wood)} 石${fmt(stock.stone)} 金${fmt(stock.metal)} ` +
		`矿工${(m.miner || {}).stone}/${(m.miner || {}).metal} 田${s.fields ?? 0} 房${s.houses ?? 0} 闲${rec.idleMax || 0}`;
}

/**
 * 经济评分只按**里程碑**算，不看终局。
 * 实测同一套经济参数：10 分钟人口 47 / 农民 38（很好），终局人口 2 ——
 * 因为军队被打崩后村民被屠杀。那是军事侧（#14）的账，记到经济参数上会把搜索带偏，
 * 让它去优化"别死"而不是"发展快"。
 * 加分：各时刻人口与农民（起量快）、上时代时刻（越早报越高）、
 * 报价凑齐时刻（教程节奏）、矿工规模、田数。扣分：闲汉、被拒命令、断供告警。
 */
function econScoreOf(rec)
{
	const m = rec.marks || {};
	const at = m.at || {};
	const rise = m.rise || {};
	const stock = m.stock || {};
	const popAt = s => (at[s] || {}).pop || 0;
	const civAt = s => (at[s] || {}).civ || 0;

	const grow = popAt(300) * 1.2 + popAt(600) * 1.8 + popAt(900) * 1.6 + popAt(1200) * 1.4;
	const farm = civAt(600) * 1.5 + civAt(900) * 1.0;
	const town = rise.town != null ? Math.max(0, 900 - rise.town) : 0;
	const city = rise.city != null ? Math.max(0, 1800 - rise.city) : 0;
	// 报价凑齐得早晚直接决定上时代早晚，900 秒为满额线
	const ready = ["food", "wood"].map(r => (stock[r] != null ? Math.max(0, 900 - stock[r]) : 0))
		.reduce((a, b) => a + b, 0);
	const mine = ["stone", "metal"].map(r => (stock[r] != null ? Math.max(0, 1800 - stock[r]) : 0))
		.reduce((a, b) => a + b, 0);
	const miner = ((m.miner || {}).stone || 0) + ((m.miner || {}).metal || 0);
	const struct = (m.struct || {}).fields || 0;

	return Math.round((grow + farm + town * 0.5 + city * 0.9 + ready * 0.5 + mine * 0.2 +
		miner * 3 + struct * 2 -
		(rec.idleMax || 0) * 1.5 - (rec.econRejected || 0) * 2 - (rec.stall || 0) * 4) * 10) / 10;
}

function scoreOf(rec)
{
	// v1 启发式：赢 >> 活得久 >> 家底厚 >> 交换比好；扣分项是被引擎拒绝的命令（说明参数在跟引擎打架）
	return (rec.win ? 1200 : 0) +
		(rec.simNow || 0) * 0.3 +
		(rec.pop || 0) * 4 +
		(rec.civilians || 0) * 1.5 +
		((rec.kills || 0) - (rec.losses || 0)) * 1.2 +
		(rec.ratio || 0) * 20 -
		(rec.rejected || 0) * 2;
}

/** 爬山：围绕当前最优做 ±18% 抖动，越界就夹回搜索空间。 */
function neighbor(base, space)
{
	const out = { "micro": {}, "econ": {} };
	for (const side of ["micro", "econ"])
	{
		for (const k in space[side] || {})
		{
			const [lo, hi] = space[side][k];
			const cur = base[side] && base[side][k] != null ? base[side][k] : (lo + hi) / 2;
			const jittered = cur * (1 + (Math.random() * 2 - 1) * 0.18);
			const clamped = Math.min(hi, Math.max(lo, jittered));
			out[side][k] = Number.isInteger(lo) && Number.isInteger(hi) ? Math.round(clamped) : Math.round(clamped * 100) / 100;
		}
	}
	return out;
}

function clamp(v, lo, hi)
{
	return Math.min(hi, Math.max(lo, Math.round(v || lo)));
}

function sleep(ms)
{
	return new Promise(r => setTimeout(r, ms));
}
