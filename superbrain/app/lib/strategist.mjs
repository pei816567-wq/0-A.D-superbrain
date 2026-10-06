/**
 * 大模型接管模式：模型当战略层，游戏内内核当执行层。
 *
 * 护栏是这个模块的重点 —— 让一个 LLM 每几十秒改一次参数，最容易出的事故是
 * 来回抖动（打法反复切换）和把自己关出去（下发 release-all）。所以：
 *   - 只允许白名单指令；
 *   - 姿态/打法类改动有最短驻留时间，同一目标没变化不重复下；
 *   - 每轮最多 maxOrders 条，且禁止关闭接管；
 *   - 任何一轮失败只记日志，不中断循环。
 */

import { compile } from "./intents.mjs";
import { situationText, headline } from "./brief.mjs";
import { extractJson } from "./llm.mjs";
import { flatten } from "./interpreter.mjs";

const ALLOWED = new Set([
	"set-posture", "set-aggression", "set-economy-mode", "set-war-target", "set-doctrine",
	"defend-home", "retreat-all", "push-foe", "attack", "stop", "unload", "gather",
	"back-to-work", "set-objective", "set-rally-point", "set-micro-param", "set-econ-param", "train", "build", "research"
]);
const FORBIDDEN = new Set(["release-all", "set-military-takeover", "set-economy-takeover", "cheat-units", "set-speed"]);
const DWELL = { "set-posture": 90, "set-doctrine": 60, "set-economy-mode": 120, "set-aggression": 60, "set-war-target": 120 };

export class Strategist
{
	constructor({ llm, link, cfg, emit, viewOf, templatesProvider })
	{
		this.llm = llm;
		this.link = link;
		this.cfg = cfg;
		this.emit = emit || (() => {});
		this.viewOf = viewOf;
		this.templatesProvider = templatesProvider || (() => []);
		this.running = false;
		this.timer = null;
		this.lastOrderAt = {};
		this.rounds = 0;
		this.errors = 0;
		this.history = [];
		this.lastSay = "";
		this.nextAt = 0;
	}

	start()
	{
		if (this.running)
			return { "ok": true, "note": "已在运行" };
		if (!this.llm.enabled)
			return { "ok": false, "error": "大模型未启用：先在设置里填端点并打开开关" };
		this.running = true;
		this.nextAt = 0;
		this.emit("strategist", "大模型接管模式启动");
		this.schedule(1500);
		return { "ok": true };
	}

	stop(reason = "手动停止")
	{
		this.running = false;
		if (this.timer)
			clearTimeout(this.timer);
		this.timer = null;
		this.emit("strategist", `大模型接管模式停止（${reason}）`);
	}

	schedule(delay)
	{
		if (!this.running)
			return;
		this.timer = setTimeout(() => {
			this.tick().catch(e => {
				++this.errors;
				this.emit("error", `战略轮次失败：${e.message}`);
			}).finally(() => this.schedule((this.cfg.strategist.intervalSec || 25) * 1000));
		}, delay);
	}

	async tick()
	{
		const frame = this.link.poll();
		if (!frame)
		{
			this.emit("warn", "战略轮次：拿不到态势帧");
			return { "ok": false };
		}
		const view = this.viewOf(frame);
		const orders = await this.decide(view);
		const applied = this.apply(orders.list, view);
		++this.rounds;

		const say = orders.say && (!this.lastSay || this.rounds % (this.cfg.strategist.sayEvery || 3) === 0 || orders.urgent);
		if (say)
		{
			this.lastSay = orders.say;
			this.emit("strategist-say", `${headline(view)}\n${orders.say}`);
		}
		this.history.push({ "at": Date.now(), "seq": view.seq, "say": orders.say, "orders": applied.names });
		this.history = this.history.slice(-12);
		return { "ok": true, "applied": applied.names, "say": orders.say };
	}

	async decide(view)
	{
		const interval = Math.max(5, this.cfg.strategist.intervalSec || 25);
		const memory = this.history.slice(-4).map(h => `- ${Math.round((Date.now() - h.at) / 1000)}s 前：${h.say || "-"}（${h.orders.join(",") || "未下令"}）`).join("\n");
		const messages = [
			{
				"role": "system",
				"content": [
					"你是《0 A.D.》单人对局的战略层，每轮看到一次态势，决定是否调整打法/经济倾斜/攻击对象。",
					"游戏内已经有微操内核与经济副驾在执行细节，你只下发高阶意图。",
					`只允许使用这些指令：${Array.from(ALLOWED).join(", ")}。`,
					`禁止：${Array.from(FORBIDDEN).join(", ")}（不许关闭接管、不许改速度、不许作弊）。`,
					`每轮最多 ${this.cfg.strategist.maxOrders || 4} 条；态势没实质变化就返回空数组，宁可不动也不要来回动。`,
					`姿态类指令有最短驻留（${Object.keys(DWELL).join("/")}），刚下过的别立刻反悔。`,
					'只输出 JSON：{"say":"一句话汇报","urgent":true/false,"orders":[{"name":"...","args":{}}]}'
				].join("\n")
			},
			{
				"role": "user",
				"content": `当前态势：\n${situationText(view, { "verbose": true })}\n\n最近决策：\n${memory || "（首轮）"}\n\n请用不超过 ${interval} 秒的思考给出这一轮的决策。`
			}
		];

		const answer = await this.llm.chat(messages, { "maxTokens": 500 });
		const parsed = extractJson(answer.text) || {};
		const list = Array.isArray(parsed.orders) ? parsed.orders : Array.isArray(parsed.intents) ? parsed.intents : [];
		return {
			"say": String(parsed.say || parsed.assessment || "").trim(),
			"urgent": !!parsed.urgent,
			"list": list.slice(0, this.cfg.strategist.maxOrders || 4)
		};
	}

	apply(list, view)
	{
		const out = [];
		const now = Date.now();
		for (const raw of list)
		{
			const name = raw && raw.name;
			if (!name || FORBIDDEN.has(name) || !ALLOWED.has(name))
			{
				this.emit("warn", `战略指令被拦：${name}（不在白名单或禁止自锁）`);
				continue;
			}
			const dwell = DWELL[name];
			if (dwell && now - (this.lastOrderAt[name] || 0) < dwell * 1000)
			{
				this.emit("warn", `战略指令被限流：${name}（距上次不足 ${dwell}s）`);
				continue;
			}

			const compiled = compile({ "name": name, "args": raw.args || {} }, { "view": view, "templates": this.templates() });
			if (!compiled.ok)
			{
				this.emit("warn", `战略指令编译失败：${name} → ${compiled.error}`);
				continue;
			}
			out.push(compiled);
			this.lastOrderAt[name] = now;
		}

		if (!out.length)
			return { "names": [] };

		const commands = flatten(out);
		try
		{
			const receipt = this.link.send(commands);
			this.emit("strategist-cmd", `下发 ${commands.length} 条（包 ${receipt.seq}）：${out.map(o => `${o.name}${o.notes.length ? `(${o.notes[0]})` : ""}`).join(" ")}`);
		}
		catch (e)
		{
			this.emit("error", `战略指令下发失败：${e.message}`);
			return { "names": [] };
		}
		return { "names": out.map(o => o.name) };
	}

	ctx()
	{
		return { "link": this.link, "cfg": this.cfg };
	}

	templates()
	{
		return this.templatesProvider ? this.templatesProvider() : [];
	}

	status()
	{
		return {
			"running": this.running,
			"rounds": this.rounds,
			"errors": this.errors,
			"intervalSec": this.cfg.strategist.intervalSec,
			"maxOrders": this.cfg.strategist.maxOrders,
			"lastOrders": this.history.slice(-6)
		};
	}
}
