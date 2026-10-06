/**
 * 与游戏内桥接 mod 的文件通道。
 *
 * 契约（见 superbrain_bridge.js）：
 *   state-%06d.json  每拍一帧完整态势，桥接层写、这里读
 *   cmd-%06d.json    外部下发的命令包，这里写、桥接层读，回执在下一帧的 applied.cmdSeq
 *   boot.json        一个 run 目录的身份证
 *
 * 三条铁律都是踩出来的：
 *   1) 每个对局独占 run-* 子目录，绝不能往同名文件里重复写 —— 引擎对同名文件 wtruncate，
 *      外部进程还握着读句柄就是共享冲突，直接断言崩进程；
 *   2) cmd 序号必须严格大于目录里已有的一切，复用旧名同理；
 *   3) 帧可能读到半截，解析失败就沿用上一帧，不能当"对局结束"。
 */

import fs from "node:fs";
import path from "node:path";

export function seqOf(name)
{
	const m = /-(\d+)\.json$/.exec(name);
	return m ? +m[1] : -1;
}

export function readJson(file)
{
	try
	{
		return JSON.parse(fs.readFileSync(file, "utf8"));
	}
	catch (e)
	{
		return null;   // 半写入 / 正在改名 / 权限抖动
	}
}

export function listRuns(roots)
{
	const runs = [];
	for (const root of roots || [])
	{
		let names = [];
		try
		{
			names = fs.readdirSync(root);
		}
		catch (e)
		{
			continue;
		}

		for (const name of names)
		{
			if (!/^run-/.test(name))
				continue;
			const dir = path.join(root, name);
			let stat = null;
			try
			{
				stat = fs.statSync(dir);
			}
			catch (e)
			{
				continue;
			}
			if (!stat.isDirectory())
				continue;

			const states = framesIn(dir);
			runs.push({
				"dir": dir,
				"name": name,
				"root": root,
				"frames": states.length,
				"latest": states.length ? states[states.length - 1] : null,
				"mtime": mtimeOf(dir)
			});
		}
	}

	return runs.sort((a, b) => b.mtime - a.mtime);
}

function mtimeOf(dir)
{
	try
	{
		const st = fs.statSync(dir);
		return st.mtimeMs;
	}
	catch (e)
	{
		return 0;
	}
}

export function framesIn(dir)
{
	try
	{
		return fs.readdirSync(dir).filter(f => /^state-\d+\.json$/.test(f)).sort()
			.map(f => path.join(dir, f));
	}
	catch (e)
	{
		return [];
	}
}

export class GameLink
{
	constructor(cfg)
	{
		this.cfg = cfg;
		this.dir = null;
		this.frame = null;
		this.frameFile = null;
		this.frameSeq = -1;
		this.reads = 0;
		this.parseFails = 0;
		this.cmdSeq = 0;
		this.sentCmds = [];
		this.lastAppliedSeq = 0;
		this.attachedAt = 0;
	}

	roots()
	{
		return this.cfg.game.ipcRoots;
	}

	/** 找最近的 run；fresh=true 时只认这次启动之后写出来的目录。 */
	discover({ afterMs = 0 } = {})
	{
		const pin = this.cfg.game.pinRun;
		if (pin && fs.existsSync(pin))
			return this.attach(pin);

		const runs = listRuns(this.roots());
		const live = afterMs ? runs.filter(r => r.mtime > afterMs) : runs;
		const best = live.find(r => r.latest);
		if (!best)
			return null;
		return this.attach(best.dir);
	}

	attach(dir)
	{
		this.dir = dir;
		this.attachedAt = Date.now();
		this.cmdSeq = Math.max(seqOfCmds(dir), this.frameSeq, 0);
		this.frame = null;
		this.frameSeq = -1;
		return dir;
	}

	/**
	 * 跟局：手上这帧已经不新鲜了，而磁盘上有个更新的 run 在写 → 切过去。
	 * 没有这条逻辑，控制台会一直守着上一局留下的旧目录，新开的一局看不见。
	 * 只有对方帧的 mtime 确实更新才切，避免把"被最小化暂停的真在跑的局"甩掉。
	 */
	followNewer({ staleMs = 8000 } = {})
	{
		const age = this.frame && this.frame.wall ? Date.now() - this.frame.wall : Infinity;
		if (age < staleMs)
			return false;
		if (this.cfg.game.pinRun && this.cfg.game.pinRun === this.dir)
			return false;

		const candidate = listRuns(this.roots()).find(r => r.latest);
		if (!candidate || candidate.dir === this.dir)
			return false;
		if (this.frame && this.frame.wall && candidate.mtime <= this.frame.wall)
			return false;

		this.attach(candidate.dir);
		this.frame = null;
		this.frameFile = null;
		this.frameSeq = -1;
		return true;
	}

	/** 手动重连（UI 上的"重连"按钮）。 */
	reconnect(dir)
	{
		this.frame = null;
		this.frameFile = null;
		this.frameSeq = -1;
		if (dir)
		{
			this.cfg.game.pinRun = dir;
			return this.attach(dir);
		}
		return this.discover({ "afterMs": 0 });
	}

	/** 读最新一帧；没有新帧就返回缓存帧（ageMs 告诉调用者有多旧）。 */
	poll()
	{
		if (!this.dir)
			this.discover();
		if (!this.dir)
			return null;

		const files = framesIn(this.dir);
		const latest = files[files.length - 1];
		if (!latest)
			return null;

		if (latest !== this.frameFile)
		{
			const parsed = readJson(latest);
			if (parsed)
			{
				this.frame = parsed;
				this.frameFile = latest;
				this.frameSeq = seqOf(latest);
				++this.reads;
				this.claimSeq(parsed);
				this.reap();
			}
			else
			{
				++this.parseFails;
			}
		}

		return this.frame;
	}

	/**
	 * 桥接层只认"比它上次消费的序号更大"的 cmd 文件。
	 * 中途接上别人开好的对局时，那些旧 cmd 文件可能已被回收、目录里读不到最大值，
	 * 所以序号必须同时向帧里的 applied.cmdSeq 看齐 —— 否则新命令会被静默丢掉。
	 */
	claimSeq(frame)
	{
		const applied = frame && frame.applied && frame.applied.cmdSeq;
		if (applied && applied > this.cmdSeq)
			this.cmdSeq = applied;
	}

	/** 桥接层确认收到哪条 cmd 就回收哪条，别让目录越长越乱。 */
	reap()
	{
		const applied = this.frame && this.frame.applied && this.frame.applied.cmdSeq;
		if (!applied)
			return;
		this.lastAppliedSeq = Math.max(this.lastAppliedSeq, applied);
		this.sentCmds = this.sentCmds.filter(s => {
			if (s.seq > applied)
				return true;
			try { fs.unlinkSync(s.file); } catch (e) { /* 引擎随时可能已删 */ }
			return false;
		});
	}

	/**
	 * 下发一组命令。写临时文件再改名，桥接层永远读不到半截 JSON。
	 * 序号从 max(已有, 上次) 往上走 —— 复用旧名会触发引擎的 wtruncate 断言。
	 */
	send(commands)
	{
		if (!this.dir)
			throw new Error("还没连上对局");
		const list = (Array.isArray(commands) ? commands : [commands]).filter(Boolean);
		if (!list.length)
			throw new Error("空命令包");
		if (list.length > 60)
			throw new Error("一条 cmd 包最多 60 个命令（桥接层每包只处理 60 条）");

		const seq = ++this.cmdSeq;
		const file = path.join(this.dir, `cmd-${String(seq).padStart(6, "0")}.json`);
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ "seq": seq, "wall": Date.now(), "commands": list }), "utf8");
		fs.renameSync(tmp, file);
		this.sentCmds.push({ "seq": seq, "file": file, "at": Date.now(), "n": list.length });

		return { "seq": seq, "count": list.length, "sentAt": Date.now() };
	}

	status()
	{
		const frame = this.frame;
		return {
			"connected": !!frame && Date.now() - (frame.wall || 0) < 8000,
			"dir": this.dir,
			"seq": this.frameSeq,
			"wall": frame ? frame.wall : 0,
			"ageMs": frame ? Math.max(0, Date.now() - frame.wall) : null,
			"reads": this.reads,
			"parseFails": this.parseFails,
			"pending": this.sentCmds.length,
			"applied": frame && frame.applied ? frame.applied.cmdSeq : 0,
			"cmdSeq": this.cmdSeq
		};
	}
}

function seqOfCmds(dir)
{
	try
	{
		return Math.max(0, ...fs.readdirSync(dir).filter(f => /^cmd-\d+\.json$/.test(f)).map(seqOf));
	}
	catch (e)
	{
		return 0;
	}
}

/** 清理陈旧 run 目录（训练模式会一晚上攒出几十个）。 */
export function pruneRuns(roots, keep = 24)
{
	const runs = listRuns(roots);
	const stale = runs.slice(keep);
	const removed = [];
	for (const r of stale)
	{
		try
		{
			fs.rmSync(r.dir, { "recursive": true, "force": true });
			removed.push(r.name);
		}
		catch (e) { /* 游戏还开着这个目录，跳过 */ }
	}
	return { "removed": removed, "kept": runs.length - stale.length };
}
