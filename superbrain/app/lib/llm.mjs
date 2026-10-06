/**
 * 大模型客户端：只认 OpenAI 兼容的 /chat/completions。
 *
 * 云端（DeepSeek / Kimi / OpenAI / 任一网关）和本地（Ollama / LM Studio / llama.cpp server）
 * 只差 baseUrl 与 model —— 这是"接口自由"的最低成本实现，不为每家 SDK 各写一遍。
 * 输出侧不依赖函数调用：默认让模型直出 JSON，本地小模型也能用；
 * 需要时可开 tools（部分云端模型函数调用更稳）。
 */

export class Llm
{
	constructor(llmCfg)
	{
		this.cfg = llmCfg || {};
	}

	get enabled()
	{
		return !!(this.cfg.enabled && this.cfg.baseUrl && this.cfg.model);
	}

	url()
	{
		const base = String(this.cfg.baseUrl || "").replace(/\/+$/, "");
		if (/\/chat\/completions$/.test(base))
			return base;
		if (/\/v\d+/.test(base) || /11434/.test(base))
			return `${base}/chat/completions`;
		return `${base}/v1/chat/completions`;
	}

	headers()
	{
		const h = { "content-type": "application/json" };
		if (this.cfg.apiKey)
			h.authorization = `Bearer ${this.cfg.apiKey}`;
		return h;
	}

	/**
	 * @param messages OpenAI 形消息
	 * @returns {text, toolCalls, usage, raw}
	 */
	async chat(messages, { temperature, maxTokens, tools, json, signal } = {})
	{
		if (!this.enabled)
			throw new Error("大模型未启用：先在设置里填 baseUrl 与 model");

		const body = {
			"model": this.cfg.model,
			"messages": messages,
			"temperature": temperature == null ? (this.cfg.temperature == null ? 0.15 : this.cfg.temperature) : temperature,
			"max_tokens": maxTokens || this.cfg.maxTokens || 800,
			"stream": false
		};
		if (tools && tools.length)
			body.tools = tools;
		if (json && this.cfg.jsonMode === "response_format")
			body.response_format = { "type": "json_object" };

		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs || 45000);
		if (signal)
			signal.addEventListener("abort", () => ac.abort());

		let res;
		try
		{
			res = await fetch(this.url(), { "method": "POST", "headers": this.headers(), "body": JSON.stringify(body), "signal": ac.signal });
		}
		catch (e)
		{
			throw new Error(`连不上 ${this.url()}：${e.name === "AbortError" ? "超时" : e.message}（本地模型请先起服务，云端请检查密钥与代理）`);
		}
		finally
		{
			clearTimeout(timer);
		}

		const text = await res.text();
		if (!res.ok)
			throw new Error(`模型返回 ${res.status}：${text.slice(0, 300)}`);

		let data;
		try
		{
			data = JSON.parse(text);
		}
		catch (e)
		{
			throw new Error(`模型响应不是 JSON：${text.slice(0, 200)}`);
		}

		const msg = data.choices && data.choices[0] && data.choices[0].message;
		return {
			"text": (msg && msg.content) || (data.message && data.message.content) || "",
			"toolCalls": (msg && msg.tool_calls) || null,
			"usage": data.usage || null,
			"model": data.model || this.cfg.model
		};
	}

	/** 设置页的"连通性测试"。 */
	async ping()
	{
		const t0 = Date.now();
		const out = await this.chat([{ "role": "user", "content": "只回复两个字：通了" }], { "maxTokens": 16, "temperature": 0 });
		return { "ok": true, "ms": Date.now() - t0, "reply": String(out.text).trim().slice(0, 40), "model": out.model, "url": this.url() };
	}
}

/** 从模型输出里抠出 JSON：容忍 ```json 包裹和前后废话。 */
export function extractJson(text)
{
	const s = String(text == null ? "" : text).trim();
	if (!s)
		return null;

	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
	const body = fenced ? fenced[1].trim() : s;

	const start = body.search(/[[{]/);
	if (start < 0)
		return null;

	for (let i = body.length; i > start; --i)
	{
		const slice = body.slice(start, i);
		try
		{
			return JSON.parse(slice);
		}
		catch (e) { /* 继续缩短到最后一个能闭合的花括号 */ }
	}
	return null;
}
