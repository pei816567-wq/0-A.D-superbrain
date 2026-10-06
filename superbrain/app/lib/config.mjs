/**
 * 控制台自身的配置读写。
 *
 * config.json 是可被 UI 改写的活文件（首次启动按默认值生成），
 * apiKey 只在服务端留存，对外一律脱敏 —— 这是个会被人贴截图的东西。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 环境变量把配置与状态目录指到别处：自测跑临时副本，绝不碰玩家真实配置
export const stateDir = process.env.SUPERBRAIN_STATE || path.join(appDir, "state");
export const configFile = process.env.SUPERBRAIN_CONFIG || path.join(appDir, "config.json");

const home = os.homedir();
const pathUser = path.join(home, "Documents", "My Games", "0ad");

/** 桥接 mod 的候选写盘根（与 superbrain_bridge.js 的 candidates 一一对应）。 */
function ipcCandidates()
{
	const out = [];
	for (const root of [pathUser, process.env.APPDATA ? path.join(process.env.APPDATA, "0ad") : null])
	{
		if (!root)
			continue;
		for (const sub of ["saves/campaigns/superbrain", "moddata/superbrain", "saves/superbrain", "config/superbrain", "cache/superbrain"])
			out.push(path.join(root, ...sub.split("/")));
	}
	return out;
}

export const DEFAULTS = {
	"host": "127.0.0.1",
	"port": 8712,

	"game": {
		"root": "G:\\0 A.D. Empires Ascendant",
		"exe": "binaries\\system\\pyrogenesis.exe",
		"ipcRoots": ipcCandidates(),
		"pinRun": ""
	},

	// 大模型接口：OpenAI 兼容的 /chat/completions 一条路走到底，
	// 云端（DeepSeek/Kimi/OpenAI）与本地（Ollama/LM Studio/llama.cpp server）只差 baseUrl 和 model。
	"llm": {
		"enabled": false,
		"baseUrl": "http://127.0.0.1:11434/v1",
		"apiKey": "",
		"model": "qwen2.5:14b-instruct",
		"temperature": 0.15,
		"maxTokens": 900,
		"timeoutMs": 45000,
		"jsonMode": "prompt"
	},

	// 大模型接管模式：模型只做战略层决策，微操与经济执行仍在游戏内内核里
	"strategist": {
		"enabled": false,
		"intervalSec": 25,
		"maxOrders": 4,
		"sayEvery": 3
	},

	"train": {
		"map": "random/alpine_lakes",
		"mapSize": 112,
		"players": 2,
		"ourCiv": "kush",
		"foeCiv": "brit",
		"foeAi": "petra",
		"aiDiff": 5,
		"speed": 2,
		"visibility": "revealed",
		"budgetSec": 900,
		"rounds": 3,
		"seed": -1
	},

	"ui": {
		"language": "zh",
		"compact": false
	}
};

function isPlainObject(v)
{
	return v && typeof v === "object" && !Array.isArray(v);
}

export function merge(base, patch)
{
	const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
	for (const key in patch)
	{
		const value = patch[key];
		if (value === undefined)
			continue;
		out[key] = isPlainObject(value) && isPlainObject(base && base[key]) ? merge(base[key], value) : value;
	}
	return out;
}

let cached = null;

export function load()
{
	if (cached)
		return cached;
	try
	{
		cached = merge(DEFAULTS, JSON.parse(fs.readFileSync(configFile, "utf8")));
	}
	catch (e)
	{
		cached = JSON.parse(JSON.stringify(DEFAULTS));
	}
	return cached;
}

export function save(patch)
{
	cached = merge(load(), patch || {});
	fs.mkdirSync(path.dirname(configFile), { "recursive": true });
	fs.writeFileSync(configFile, JSON.stringify(cached, null, "\t"), "utf8");
	return cached;
}

/** 对外可见的配置：密钥只留指纹。 */
export function publicConfig(cfg = load())
{
	const out = JSON.parse(JSON.stringify(cfg));
	const key = out.llm && out.llm.apiKey || "";
	out.llm = out.llm || {};
	out.llm.hasKey = !!key;
	out.llm.keyHint = key ? `${key.slice(0, 3)}…${key.slice(-4)}` : "";
	out.llm.apiKey = "";
	return out;
}

export function ensureDirs()
{
	for (const dir of [stateDir, path.join(stateDir, "training"), path.join(stateDir, "chat")])
		fs.mkdirSync(dir, { "recursive": true });
	return stateDir;
}
