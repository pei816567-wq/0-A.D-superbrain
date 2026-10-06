/**
 * Superbrain 控制台后端（零依赖）。
 *
 * 一个进程三件事：静态托管前端、把文件 IPC 包装成 REST/SSE、维护大模型中间层与训练循环。
 * 只绑 127.0.0.1 —— 这里握着 LLM 密钥和"能操作你游戏"的权力，不该暴露到局域网。
 *
 *   node superbrain/app/server.mjs            # 打开 http://127.0.0.1:8712
 *   node superbrain/app/server.mjs --port 9000
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

import { appDir, ensureDirs, load, publicConfig, save, stateDir } from "./lib/config.mjs";
import { Catalog } from "./lib/catalog.mjs";
import { alarms, headline, situationText } from "./lib/brief.mjs";
import { GameLink, listRuns, pruneRuns } from "./lib/ipc.mjs";
import { viewOf } from "./lib/frames.mjs";
import { INTENTS, compile, uiSchema } from "./lib/intents.mjs";
import { Llm } from "./lib/llm.mjs";
import { DOCTRINES, ECON_MODES, POSTURES, aggressionPatch, economyPatch, econSpace, estimateAggression, packCommands, posturePatch, searchSpace, targetPatch } from "./lib/presets.mjs";
import { flatten, interpret, narrate } from "./lib/interpreter.mjs";
import { Strategist } from "./lib/strategist.mjs";
import { Trainer } from "./lib/trainer.mjs";

const argv = process.argv.slice(2);
const argOf = (flag, dflt) => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : dflt;
};

let cfg = load();
ensureDirs();

const webDir = path.join(appDir, "web");
const link = new GameLink(cfg);
const catalog = new Catalog(cfg);
const llm = new Llm(cfg.llm);

const app = {
	"view": null,
	"status": null,
	"events": [],
	"clients": new Set(),
	"params": { "micro": {}, "econ": {} },
	"startedAt": Date.now()
};

const emit = (type, text, extra) => {
	const ev = Object.assign({ "at": Date.now(), "type": type, "text": text }, extra || {});
	app.events.push(ev);
	if (app.events.length > 240)
		app.events.shift();
	send({ "type": "event", "data": ev });
	return ev;
};

const strategist = new Strategist({ "llm": llm, "link": link, "cfg": cfg, emit, "viewOf": f => viewOf(f), "templatesProvider": () => catalog.templates() });
// Trainer 内部按 emit(type, message) 调用，这里必须两个参数都接下来
const trainer = new Trainer(cfg, (type, message) => emit(type || "train", message));

// ------------------------------------------------------------------ 轮询

function tick()
{
	try
	{
		const frame = link.poll();
		if (!frame || (frame.wall && Date.now() - frame.wall > 8000))
		{
			if (link.followNewer())
			{
				emit("cmd", `切到新的对局目录：${path.basename(link.dir || "")}`);
				return;
			}
		}
		app.status = link.status();
		if (!frame)
		{
			app.view = null;
			return;
		}
		if (frame.seq !== (app.view && app.view.seq))
		{
			catalog.absorb(frame);
			app.view = viewOf(frame);
			send({ "type": "state", "data": publicView(app.view) });
		}
		else
		{
			// 同一帧只刷新年龄，别把上千行实体表反复解码
			app.view.ageMs = Math.max(0, Date.now() - (frame.wall || 0));
		}
	}
	catch (e)
	{
		emit("error", `轮询失败：${e.message}`);
	}
}

// 启动即连一次：否则前端首个 /api/state 会看到"未连接"，像坏了
link.discover();
tick();
setInterval(tick, 700);

/** 发给前端的视图：丢掉整帧原始数据，但保留 raw 里 UI 需要的少量字段。 */
function publicView(view)
{
	if (!view)
		return null;
	const out = Object.assign({}, view);
	delete out.raw;
	out.headline = headline(view);
	out.alarms = alarms(view);
	out.appliedSeq = view.applied ? view.applied.cmdSeq : 0;
	return out;
}

function send(payload)
{
	if (!app.clients.size)
		return;
	const body = `data: ${JSON.stringify(payload)}\n\n`;
	for (const res of app.clients)
	{
		try { res.write(body); } catch (e) { app.clients.delete(res); }
	}
}

// ------------------------------------------------------------------ 指令下发

function ctxFor(view)
{
	return { "view": view || app.view, "templates": catalog.templates(), "link": link, "cfg": cfg };
}

/** 所有下发都走这里：没连上对局时返回可读错误，而不是把请求进程打死。 */
function safeSend(commands, note)
{
	if (!commands || !commands.length)
		return { "ok": false, "error": "没有可下发的命令" };
	if (!link.dir && !link.discover())
		return { "ok": false, "error": "还没连上对局：进入单人对局并勾选 superbrain mod（设置页也能手动指定 run 目录）" };
	try
	{
		const receipt = link.send(commands);
		emit("cmd", `${note ? note + " " : ""}包 ${receipt.seq} 已下发 ${receipt.count} 条：${commands.map(c => c.op).join(",")}`);
		return { "ok": true, "sent": receipt };
	}
	catch (e)
	{
		emit("error", `下发失败：${e.message}`);
		return { "ok": false, "error": e.message };
	}
}

function dispatch(intents)
{
	const commands = flatten(intents);
	if (!commands.length)
		return { "ok": false, "error": "没有可下发的命令", "sent": null };
	const out = safeSend(commands);
	return { "ok": out.ok, "sent": out.sent || null, "error": out.error || null };
}

function runIntent(raw)
{
	const out = compile(raw, ctxFor());
	if (!out.ok)
		return { "name": raw && raw.name, "ok": false, "error": out.error };
	const sent = dispatch([{ "ok": true, "commands": out.commands, "name": out.name }]);
	return { "name": out.name, "label": out.label, "ok": sent.ok, "notes": out.notes, "commands": out.commands, "sent": sent.sent, "error": sent.error || null };
}

function applyPacks({ micro, econ, doctrine })
{
	const commands = packCommands({ "micro": micro, "econ": econ, "doctrine": doctrine });
	if (!commands.length)
		return { "ok": false, "error": "空参数包" };
	Object.assign(app.params, {
		"micro": Object.assign({}, app.params.micro, micro || {}),
		"econ": Object.assign({}, app.params.econ, econ || {})
	});
	const out = safeSend(commands, "参数");
	if (!out.ok)
		return out;
	emit("param", `参数已下发 ${commands.map(c => c.op).join("+")}：${JSON.stringify(commands).slice(0, 200)}`);
	return { "ok": true, "sent": out.sent, "commands": commands };
}

// ------------------------------------------------------------------ HTTP

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon"
};

const server = http.createServer((req, res) => {
	const url = new URL(req.url, "http://localhost");
	const route = url.pathname;

	// 直接双击 index.html（file://）时请求是跨源的，不带头就会被浏览器拦掉
	res.setHeader("access-control-allow-origin", "*");
	res.setHeader("access-control-allow-headers", "content-type");
	res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
	if (req.method === "OPTIONS")
	{
		res.writeHead(204);
		res.end();
		return;
	}

	// handleApi 是 async：里面抛错是 rejection 而不是 throw，
	// 不接住就是 unhandled rejection —— Node 24 默认直接终止进程，整个控制台会静默死掉
	const run = () => route.startsWith("/api/") ? handleApi(req, res, route, url) : Promise.resolve(serveStatic(req, res, route));
	run().catch(e => {
		if (!res.headersSent)
			json(res, e instanceof SyntaxError ? 400 : 500, { "ok": false, "error": String(e.message || e) });
		else
			res.end();
	});
});

function json(res, code, body)
{
	const text = JSON.stringify(body);
	res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(text);
}

async function body(req)
{
	const chunks = [];
	let size = 0;
	for await (const c of req)
	{
		size += c.length;
		if (size > 2 * 1024 * 1024)
			throw new Error("请求体过大");
		chunks.push(c);
	}
	if (!chunks.length)
		return {};
	try
	{
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	}
	catch (e)
	{
		throw new Error("请求体不是合法 JSON");
	}
}

async function handleApi(req, res, route, url)
{
	const post = req.method === "POST";

	if (route === "/api/health")
		return json(res, 200, { "ok": true, "version": "0.6.0", "node": process.version, "uptimeSec": Math.round((Date.now() - app.startedAt) / 1000) });

	if (route === "/api/state")
		return json(res, 200, snapshot());

	if (route === "/api/events")
		return stream(res);

	if (route === "/api/situation")
		return json(res, 200, { "text": situationText(app.view, { "verbose": true }), "headline": headline(app.view) });

	if (route === "/api/intents")
		return json(res, 200, { "intents": uiSchema(), "postures": POSTURES, "economies": ECON_MODES, "doctrines": DOCTRINES, "count": INTENTS.length });

	// ---- 四个按钮
	if (route === "/api/takeover" && post)
	{
		const b = await body(req);
		const commands = [];
		if (b.military != null)
			commands.push({ "op": "takeover", "on": !!b.military });
		if (b.economy != null)
			commands.push({ "op": "econ", "on": !!b.economy });
		if (b.all != null)
			commands.push({ "op": "takeover", "on": !!b.all }, { "op": "econ", "on": !!b.all });
		if (!commands.length)
			return json(res, 400, { "ok": false, "error": "要给 military / economy / all 之一" });
		return json(res, 200, safeSend(commands, "接管开关"));
	}

	// ---- 旋钮
	if (route === "/api/knobs" && post)
	{
		const b = await body(req);
		const pack = { "micro": {}, "econ": {} };
		if (b.posture)
		{
			const p = posturePatch(b.posture);
			Object.assign(pack.micro, p.micro);
			Object.assign(pack.econ, p.econ);
			pack.doctrine = p.doctrine;
		}
		if (b.economy)
			Object.assign(pack.econ, economyPatch(b.economy));
		// 玩家明确写了数值，就盖掉姿态里的隐含值
		if (b.aggression != null)
			Object.assign(pack.micro, aggressionPatch(b.aggression));
		if (b.target != null)
			Object.assign(pack.micro, targetPatch(b.target));
		if (b.doctrine)
			pack.doctrine = b.doctrine;
		return json(res, 200, applyPacks(pack));
	}

	if (route === "/api/params" && post)
	{
		const b = await body(req);
		return json(res, 200, applyPacks({ "micro": b.micro, "econ": b.econ, "doctrine": b.doctrine }));
	}

	// ---- 逻辑指令
	if (route === "/api/intent" && post)
	{
		const b = await body(req);
		return json(res, 200, runIntent(b.intent || b));
	}
	if (route === "/api/intents" && post)
	{
		const b = await body(req);
		const list = Array.isArray(b.intents) ? b.intents : [];
		const results = [];
		const commands = [];
		for (const raw of list.slice(0, 12))
		{
			const out = compile(raw, ctxFor());
			if (out.ok)
				commands.push(...out.commands);
			results.push({ "name": raw && raw.name, "ok": out.ok, "error": out.error || null, "notes": out.notes || [] });
		}
		const sent = commands.length ? safeSend(commands, "批量") : { "ok": false, "error": "没有可下发的命令" };
		return json(res, 200, { "ok": sent.ok, "results": results, "sent": sent.sent || null, "error": sent.error || null });
	}

	// ---- 自然语言
	if (route === "/api/chat" && post)
	{
		const b = await body(req);
		const text = String(b.text || "");
		const answer = await interpret(text, { "llm": llm, "view": app.view, "ctx": ctxFor(), "history": b.history || [] });
		const commands = flatten(answer.intents);
		let sent = null;
		if (commands.length)
		{
			const out = safeSend(commands, `自然语言「${text.slice(0, 40)}」→ ${commands.map(c => c.op).join(",")}`);
			sent = out.sent || null;
			if (!out.ok)
				answer.say = `${answer.say}（但下发失败：${out.error}）`;
		}
		recordChat({ "role": "user", "text": text });
		recordChat({ "role": "ai", "text": answer.say, "engine": answer.engine, "intents": answer.intents.map(i => ({ "name": i.name, "ok": i.ok, "error": i.error })) });
		return json(res, 200, Object.assign({}, answer, { "sent": sent }));
	}
	if (route === "/api/brief/ai" && post)
	{
		const b = await body(req);
		const text = await narrate(app.view, llm, { "focus": b.focus || "" }).catch(e => `汇报失败：${e.message}`);
		return json(res, 200, { "ok": true, "text": text });
	}
	if (route === "/api/chat/log")
		return json(res, 200, { "log": readChat() });

	// ---- 大模型接管模式
	if (route === "/api/strategist")
	{
		if (!post)
			return json(res, 200, strategist.status());
		const b = await body(req);
		if (b.action === "start")
			return json(res, 200, strategist.start());
		strategist.stop(b.reason);
		return json(res, 200, strategist.status());
	}

	// ---- 配置
	if (route === "/api/config" && !post)
		return json(res, 200, { "config": publicConfig(cfg), "space": searchSpace(), "ipcRootsExist": cfg.game.ipcRoots.filter(p => fs.existsSync(p)) });
	if (route === "/api/config" && post)
	{
		const b = await body(req);
		const patch = JSON.parse(JSON.stringify(b.patch || b.config || {}));
		// 空 apiKey 表示"不改"，别把用户填的密钥擦掉
		if (patch.llm && patch.llm.apiKey === "")
			delete patch.llm.apiKey;
		cfg = save(patch);
		relink(cfg);
		emit("config", `配置已保存：${Object.keys(patch).join(",")}`);
		return json(res, 200, { "ok": true, "config": publicConfig(cfg) });
	}
	if (route === "/api/llm/test" && post)
	{
		try
		{
			return json(res, 200, await llm.ping());
		}
		catch (e)
		{
			return json(res, 200, { "ok": false, "error": e.message });
		}
	}

	// ---- 目录与 run
	if (route === "/api/catalog")
	{
		catalog.refresh(true);
		return json(res, 200, {
			"stats": catalog.stats(),
			"units": catalog.list({ "kind": "unit", "civ": url.searchParams.get("civ") || null, "q": url.searchParams.get("q"), "limit": 300 }),
			"structures": catalog.list({ "kind": "structure", "civ": url.searchParams.get("civ") || null, "q": url.searchParams.get("q"), "limit": 300 })
		});
	}
	if (route === "/api/runs")
		return json(res, 200, { "runs": listRuns(cfg.game.ipcRoots).slice(0, 40).map(r => ({ "dir": r.dir, "name": r.name, "frames": r.frames, "mtime": r.mtime })), "pinned": cfg.game.pinRun, "current": link.dir });
	if (route === "/api/reconnect" && post)
	{
		const b = await body(req);
		const dir = link.reconnect(b.dir || null);
		emit("cmd", dir ? `重连到 ${path.basename(dir)}` : "没找到可对局的 run 目录");
		return json(res, 200, { "ok": !!dir, "dir": dir || null });
	}
	if (route === "/api/runs/pin" && post)
	{
		const b = await body(req);
		cfg = save({ "game": { "pinRun": b.dir || "" } });
		relink(cfg);
		link.discover();
		return json(res, 200, { "ok": true, "pinned": cfg.game.pinRun, "dir": link.dir });
	}
	if (route === "/api/runs/prune" && post)
		return json(res, 200, pruneRuns(cfg.game.ipcRoots, +(await body(req)).keep || 24));

	// ---- 训练模式
	if (route === "/api/train")
	{
		if (!post)
			return json(res, 200, Object.assign(trainer.status(), { "leaderboard": trainer.leaderboard(), "best": trainer.bestPack(), "space": searchSpace(), "econSpace": econSpace() }));
		const b = await body(req);
		if (b.action === "stop")
			return json(res, 200, trainer.stop());
		if (b.action === "apply-best")
			return json(res, 200, trainer.applyBest());
		if (b.action === "clear")
		{
			for (const f of ["leaderboard.json", "best.json", "last-run.json"])
			{
				try { fs.unlinkSync(path.join(stateDir, "training", f)); } catch (e) { /* 本来就没有 */ }
			}
			return json(res, 200, { "ok": true });
		}
		try
		{
			return json(res, 200, await trainer.start(b));
		}
		catch (e)
		{
			return json(res, 200, { "ok": false, "error": e.message });
		}
	}

	if (route === "/api/game/start" && post)
		return json(res, 200, await launchGame(await body(req)));

	return json(res, 404, { "ok": false, "error": `没有这个接口：${route}` });
}

function relink(next)
{
	link.cfg = next;
	catalog.cfg = next;
	llm.cfg = next.llm;
	strategist.cfg = next;
	trainer.cfg = next;
}

async function launchGame(b = {})
{
	if (b.confirm !== true)
		return { "ok": false, "error": "启动游戏要确认（confirm:true）：同一时刻只能有一个引擎实例，会占用 public.zip" };
	// 引擎只能有一个实例：训练对局还在跑时再起一个，两个进程会抢 public.zip，第二个直接崩掉（实盘踩过）
	if (b.force !== true && (trainer.running || trainer.engineRunning() || await trainer.gameAlive()))
		return { "ok": false, "error": "已有引擎实例在跑（训练任务或对局进行中），再起一个会崩。先 train stop，或确认要插队就传 force:true" };
	const exe = path.join(cfg.game.root, cfg.game.exe);
	if (!fs.existsSync(exe))
		return { "ok": false, "error": `找不到引擎：${exe}` };
	const t = cfg.train;
	const args = [`-autostart=${b.map || t.map}`, `-autostart-players=${b.players || t.players}`, `-autostart-size=${b.mapSize || t.mapSize}`,
		`-autostart-civ=1:${b.ourCiv || t.ourCiv}`, `-autostart-civ=2:${b.foeCiv || t.foeCiv}`,
		`-autostart-ai=2:${b.foeAi || t.foeAi}`, `-autostart-aidiff=2:${b.aiDiff == null ? t.aiDiff : b.aiDiff}`,
		"-autostart-seed=-1", `-autostart-visibility=${t.visibility}`, "-autostart-speed=1", "-xres=1200", "-yres=720"];
	const r = spawn(exe, args, { "cwd": path.dirname(exe), "detached": true, "stdio": "ignore" });
	r.unref();
	emit("cmd", `启动对局：${args.join(" ")}`);
	return { "ok": !r.killed && r.pid > 0, "pid": r.pid, "args": args, "error": r.pid ? null : "进程启动失败" };
}

function snapshot()
{
	const view = app.view;
	return {
		"status": link.status(),
		"view": publicView(view),
		"params": app.params,
		"microCfg": view && view.cfg,
		"aggression": view && view.cfg ? estimateAggression(view.cfg) : null,
		"llm": { "enabled": llm.enabled, "model": cfg.llm.model, "baseUrl": cfg.llm.baseUrl },
		"strategist": strategist.status(),
		"trainer": trainer.status(),
		"events": app.events.slice(-40)
	};
}

function stream(res)
{
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
	res.write(`data: ${JSON.stringify({ "type": "hello", "data": snapshot() })}\n\n`);
	app.clients.add(res);
	const ping = setInterval(() => {
		try { res.write(": ping\n\n"); } catch (e) { /* 断了 */ }
	}, 15000);
	res.on("close", () => {
		clearInterval(ping);
		app.clients.delete(res);
	});
}

const CHAT_FILE = path.join(stateDir, "chat", "latest.json");

function recordChat(entry)
{
	const log = readChat().slice(-59);
	log.push(Object.assign({ "at": Date.now() }, entry));
	try
	{
		fs.mkdirSync(path.dirname(CHAT_FILE), { "recursive": true });
		fs.writeFileSync(CHAT_FILE, JSON.stringify(log, null, "\t"), "utf8");
	}
	catch (e) { /* 聊天记录不该影响主流程 */ }
}

function readChat()
{
	try
	{
		return JSON.parse(fs.readFileSync(CHAT_FILE, "utf8"));
	}
	catch (e)
	{
		return [];
	}
}

function serveStatic(req, res, route)
{
	const rel = route === "/" ? "index.html" : route.replace(/^\/+/, "");
	const file = path.join(webDir, rel);
	if (!file.startsWith(webDir) || !fs.existsSync(file) || !fs.statSync(file).isFile())
	{
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("404");
		return;
	}
	res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
	fs.createReadStream(file).pipe(res);
}

const port = +argOf("--port", cfg.port) || 8712;
const host = argOf("--host", cfg.host) || "127.0.0.1";
server.listen(port, host, () => {
	console.log(`Superbrain 控制台 → http://${host}:${port}`);
	console.log("IPC 根目录：", cfg.game.ipcRoots.filter(p => fs.existsSync(p)).join(" | ") || "（还没出现，进一局单人对局即可）");
});
