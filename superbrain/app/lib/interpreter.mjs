/**
 * 自然语言 ↔ 逻辑指令的中间层。
 *
 * 两条路：
 *   1) 有大模型：把指令清单 + 当前态势塞进 prompt，要求严格 JSON 输出，
 *      解析后逐条编译校验，编译失败会把错误回灌给模型重试一次；
 *   2) 没有大模型（或模型挂了）：规则兜底覆盖最常用的中文口令，
 *      保证四个按钮之外的"说人话"能力不依赖网络。
 */

import { compile, schemaText, INTENTS } from "./intents.mjs";
import { situationText } from "./brief.mjs";
import { extractJson } from "./llm.mjs";
import { estimateAggression } from "./presets.mjs";

const MAX_INTENTS = 4;
const MAX_ENTITIES_PER_CMD = 120;

export function systemPrompt({ allowLab = false } = {})
{
	// 实验台专用指令（改速度、作弊造兵）默认不进模型视野：
	// 批量训练时模型把自己调成 8 倍速会把采样节奏全打乱
	const allowed = INTENTS.filter(i => allowLab || (i.kind !== "lab")).map(i => i.name);
	return [
		"你是《0 A.D.》单人对局的战略中间层：把玩家的自然语言翻译成下面这套逻辑指令。",
		"游戏内已经有微操内核（风筝/集火/多军团）和经济副驾（农民/建筑/科技/配比）在执行，",
		"你只下意图与参数，不逐单位操作，也拿不到实体全表。",
		"",
		"可用指令：",
		schemaText(allowLab ? null : allowed),
		"",
		"只输出一个 JSON 对象，不要多余文字：",
		'{"say":"给玩家的一句话（中文，简短）","intents":[{"name":"指令名","args":{...},"why":"一句话理由"}]}',
		"规则：",
		`- intents 最多 ${MAX_INTENTS} 条，没有可做的事就返回空数组并在 say 里说明。`,
		"- 单位一律用选择器：army | all | workers | idle | wounded | bunkered | structures | cc，除非玩家明确给了实体 id。",
		'- 坐标一律用 "home" | "foe" 或 {"x":数字,"z":数字}，不要凭空编地图坐标。',
		"- 调强度优先用 set-aggression / set-posture / set-economy-mode 这类旋钮，别裸改一堆阈值参数。",
		"- 只做单机战略调整。玩家要求作弊或影响其他真人玩家时，say 里拒绝并不下发指令。",
		"- 态势里已经写明的数字直接用，不要重复查询同一件事。"
	].join("\n");
}

const INTENT_NAMES_EXCEPT_LAB = ["set-speed"];   // 实验台专用指令默认不给模型

/**
 * @returns {say, intents, engine, raw}
 */
export async function interpret(text, { llm, view, ctx, history = [], allowLab = false, retry = true })
{
	const asked = String(text || "").trim();
	if (!asked)
		return { "say": "没听到指令。", "intents": [], "engine": "none" };

	if (!llm || !llm.enabled)
		return ruleInterpret(asked, view, ctx);

	const messages = [
		{ "role": "system", "content": systemPrompt({ allowLab }) },
		...history.slice(-6),
		{ "role": "user", "content": `当前态势：\n${situationText(view)}\n\n玩家指令：${asked}` }
	];

	let answer;
	try
	{
		answer = await llm.chat(messages, { "maxTokens": 700 });
	}
	catch (e)
	{
		const fallback = ruleInterpret(asked, view, ctx);
		fallback.say = `${fallback.say}（大模型不可用：${e.message.slice(0, 120)}，已走规则兜底）`;
		fallback.engine = "rule-fallback";
		return fallback;
	}

	const parsed = extractJson(answer.text);
	if (!parsed)
	{
		if (retry)
			return interpret(asked, { llm, view, ctx, history, allowLab, retry: false });
		return { "say": `模型没返回可解析的 JSON：${String(answer.text).slice(0, 160)}`, "intents": [], "engine": "llm-bad" };
	}

	const list = Array.isArray(parsed.intents) ? parsed.intents : Array.isArray(parsed) ? parsed : [];
	const compiled = compileAll(list.slice(0, MAX_INTENTS), ctx);

	// 模型写错指令时把错误回灌一次，比直接报错的自愈率高得多
	if (compiled.some(c => !c.ok) && retry && compiled.every(c => !c.ok))
	{
		const errText = compiled.filter(c => !c.ok).map(c => `${c.name}: ${c.error}`).join("; ");
		const messages2 = messages.concat([
			{ "role": "assistant", "content": answer.text },
			{ "role": "user", "content": `上一轮指令编译失败：${errText}\n请只修正 args/name，仍按同一 JSON 格式输出。` }
		]);
		const again = await llm.chat(messages2, { "maxTokens": 500 }).catch(() => null);
		if (again)
		{
			const p2 = extractJson(again.text);
			if (p2 && (p2.intents || Array.isArray(p2)))
				return {
					"say": String(p2.say || parsed.say || "").trim(),
					"intents": compileAll((p2.intents || p2).slice(0, MAX_INTENTS), ctx),
					"engine": "llm-retry",
					"raw": again.text
				};
		}
	}

	return {
		"say": String(parsed.say || parsed.reply || "").trim() || "已处理。",
		"intents": compiled,
		"engine": "llm",
		"usage": answer.usage,
		"raw": answer.text
	};
}

export function compileAll(list, ctx)
{
	return (list || []).map(item => {
		const raw = typeof item === "string" ? { "name": item } : item;
		const out = compile(raw, ctx);
		return {
			"name": raw && raw.name,
			"args": raw && raw.args || {},
			"why": raw && raw.why || "",
			"ok": out.ok,
			"error": out.error || null,
			"notes": out.notes || [],
			"commands": out.commands || []
		};
	});
}

/** 把编译好的指令摊平成桥接层命令包（超长的 entities 分批）。 */
export function flatten(intents)
{
	const out = [];
	for (const it of intents)
	{
		if (!it.ok)
			continue;
		for (const cmd of it.commands)
		{
			if (Array.isArray(cmd.entities) && cmd.entities.length > MAX_ENTITIES_PER_CMD)
			{
				for (let i = 0; i < cmd.entities.length; i += MAX_ENTITIES_PER_CMD)
					out.push(Object.assign({}, cmd, { "entities": cmd.entities.slice(i, i + MAX_ENTITIES_PER_CMD) }));
				continue;
			}
			out.push(cmd);
		}
	}
	return out;
}

// ---------------------------------------------------------------- 规则兜底

const RULES = [
	[/^(全部接管|都交给你|全接管|接管一切)/, () => ({ "intents": [{ "name": "take-over-all" }] }), "军事与经济同时接管"],
	[/^(取消全部|全部取消|都还给我|全部交还|停止接管|放开我)/, () => ({ "intents": [{ "name": "release-all" }] }), "军事与经济全部交还"],
	[/(接管|帮我|你来)(军队|军事|打仗|操作)|(军事|军队)(接管|自动|你来)/, () => ({ "intents": [{ "name": "set-military-takeover", "args": { "on": true } }] }), "军事已接管"],
	[/(别管|我自己|取消|交还|不要|放开)(军队|军事|打仗)|(军队|军事|打仗)(我自己|取消|交还|别管|放开)/, () => ({ "intents": [{ "name": "set-military-takeover", "args": { "on": false } }] }), "军队交还手操"],
	[/(接管|帮我|你来)(经济|运营|家里|后勤)|(经济|运营|家里)(接管|自动|你来)/, () => ({ "intents": [{ "name": "set-economy-takeover", "args": { "on": true } }] }), "经济已接管"],
	[/(别管|我自己|取消|交还|不要|放开)(经济|运营|家里)|(经济|运营|家里)(我自己|取消|交还|别管|放开)/, () => ({ "intents": [{ "name": "set-economy-takeover", "args": { "on": false } }] }), "经济交还手操"],
	[/(回防|守家|救命|守城|保护村民|家里被攻)/, (m, v) => ({ "intents": [{ "name": "defend-home" }, { "name": "set-posture", "args": { "name": "defend" } }] }), "全军回防并转守护"],
	[/(全力进攻|总攻|推过去|压过去|打他老家|进攻模式)/, () => ({ "intents": [{ "name": "set-posture", "args": { "name": "attack" } }, { "name": "push-foe" }] }), "转全力进攻"],
	[/(防守模式|稳一点|别送|保守)/, () => ({ "intents": [{ "name": "set-posture", "args": { "name": "defend" } }] }), "转防守"],
	[/(撤退|撤回|先跑|脱离)/, () => ({ "intents": [{ "name": "retreat-all" }] }), "全军撤退"],
	[/(集火|优先打|点杀)(最近|残|远程|攻城|骑兵)?.*/, (m, v, c) => ({ "intents": [{ "name": "attack", "args": { "target": m[2] || "nearest" } }] }), "集火"],
	[/(停止|停下|别动|原地)/, () => ({ "intents": [{ "name": "stop" }] }), "已下令停止"],
	[/风筝|放风筝|拉开距离/, () => ({ "intents": [{ "name": "set-micro-param", "args": { "patch": { "kite": true, "standoff": 0.85 } } }] }), "已恢复风筝"],
	[/(憋经济|种田|发育|多资源|经济优先|资源优先)/, () => ({ "intents": [{ "name": "set-economy-mode", "args": { "name": "boom" } }] }), "经济模式转憋资源"],
	[/(暴兵|极限兵|军事经济|all?in)/, () => ({ "intents": [{ "name": "set-economy-mode", "args": { "name": "war" } }] }), "经济模式转极限暴兵"],
	[/(均衡|正常经济)/, () => ({ "intents": [{ "name": "set-economy-mode", "args": { "name": "balanced" } }] }), "经济模式回均衡"],
	[/(骚扰|游击|耗他)/, () => ({ "intents": [{ "name": "set-doctrine", "args": { "name": "harass" } }] }), "打法改骚扰"],
	[/放人|把人放出来|解除驻军|撤出驻军/, () => ({ "intents": [{ "name": "unload" }] }), "放出驻军"],
	[/补农民|多训农民|更多村民/, (m, v, c) => ({ "intents": [{ "name": "set-econ-param", "args": { "patch": { "villagerCap": Math.min(95, ((c.view && c.view.econ && c.view.econ.wantCivilians) || 60) + 10) } } }] }), "已上调农民目标"],
	[/建.*?(农田|田)/, () => ({ "intents": [{ "name": "build", "args": { "template": "field", "to": "home", "targets": "idle" } }] }), "尝试在-home 建田（模板名需本局可见）"],
	[/建.*?(房屋|房子)/, () => ({ "intents": [{ "name": "build", "args": { "template": "house", "to": "home", "targets": "idle" } }] }), "尝试建房"],
	[/(打|攻击|目标)(第?\s*)(\d+)\s*(家|方|玩家|个)?/, m => ({ "intents": [{ "name": "set-war-target", "args": { "player": +m[3] } }] }), "已设定打击对象"],
	[/(加速|快进|速度)(\d+(\.\d+)?)?/, m => ({ "intents": [{ "name": "set-speed", "args": { "value": m[2] ? +m[2] : 4 } }] }), "已改仿真速度"]
];

const AGG_RE = /攻击欲望| agressiveness|激进|保守一点|猛一点/i;

/**
 * 无模型兜底：一句话里能认出几个请求就下几条指令（玩家常说"回防，攻击欲望 80%"这种连句）。
 * 匹配不到就照实说，不做"看起来像成功"的假动作。
 */
export function ruleInterpret(text, view, ctx)
{
	const t = String(text).toLowerCase();
	const found = [];
	const says = [];
	const push = (intents, say) => {
		for (const it of intents || [])
		{
			if (found.some(f => f.name === it.name))
				continue;
			found.push(it);
		}
		if (say)
			says.push(say);
	};

	const agg = /攻击欲望\D*(\d{1,3})\s*%?/.exec(text) || /(\d{1,3})\s*%\s*(攻击欲望|激进)/.exec(text);
	if (agg)
		push([{ "name": "set-aggression", "args": { "value": Math.min(1, +agg[1] / 100) } }], `攻击欲望设为 ${Math.min(100, +agg[1])}%`);
	else if (AGG_RE.test(text))
	{
		const cur = estimateAggression(view && view.cfg);
		const v = Math.max(0, Math.min(1, (cur == null ? 0.55 : cur) + (/高|猛|加|强|升/.test(text) ? 0.15 : -0.15)));
		push([{ "name": "set-aggression", "args": { "value": v } }], `攻击欲望 ${cur == null ? "?" : Math.round(cur * 100)}% → ${Math.round(v * 100)}%`);
	}

	for (const [re, make, say] of RULES)
	{
		const m = re.exec(t);
		if (!m)
			continue;
		push(make(m, view, ctx).intents, say);
		if (found.length >= MAX_INTENTS)
			break;
	}

	if (!found.length)
	{
		return {
			"say": "没接住这句话。可用说法举例：全部接管 / 回防 / 全力进攻 / 攻击欲望 70% / 憋经济 / 打第 3 家 / 集火远程。接上大模型后随便说。",
			"intents": [],
			"engine": "rule-none"
		};
	}

	return { "say": says.join("；"), "intents": compileAll(found.slice(0, MAX_INTENTS), ctx), "engine": "rule" };
}

/** 大模型把态势翻成给玩家看的人话（可选，纯润色）。 */
export async function narrate(view, llm, { focus = "" } = {})
{
	if (!llm || !llm.enabled)
		return situationText(view);
	const out = await llm.chat([
		{ "role": "system", "content": "你是 RTS 副驾，用不超过 4 句中文向玩家汇报局势与建议，不要编造数据。" },
		{ "role": "user", "content": `${focus}\n原始数据：\n${situationText(view, { "verbose": true })}` }
	], { "maxTokens": 260 });
	return String(out.text).trim();
}
