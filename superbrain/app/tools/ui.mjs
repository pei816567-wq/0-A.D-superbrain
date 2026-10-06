/**
 * 一键开控制台：后端没在跑就代为拉起（脱离终端，不会被关掉的窗口带死），然后打开浏览器。
 *
 *   node superbrain/app/tools/ui.mjs          起后端 + 打开页面
 *   node superbrain/app/tools/ui.mjs --no-open 只做连通性检查并打印地址
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appDir, load } from "../lib/config.mjs";

const cfg = load();
const BASE = `http://${cfg.host}:${cfg.port}`;

async function healthy()
{
	try
	{
		const r = await fetch(BASE + "/api/health", { "signal": AbortSignal.timeout(1200) });
		return r.ok;
	}
	catch (e)
	{
		return false;
	}
}

async function ensureServer()
{
	if (await healthy())
		return "后端已在跑";

	const log = path.join(appDir, "state", "server.log");
	const err = path.join(appDir, "state", "server.err");
	fs.mkdirSync(path.dirname(log), { "recursive": true });

	if (process.platform === "win32")
	{
		// 必须走 Start-Process：node 自己 spawn 的"detached"子进程仍挂在父 shell 的作业里，
		// shell 被回收时后端一起没了（实测静默死掉两次，浏览器就是 Failed to fetch）
		spawnSync("powershell", ["-NoProfile", "-Command",
			`Start-Process -FilePath '${process.execPath}' -ArgumentList 'server.mjs' -WorkingDirectory '${appDir}' -WindowStyle Hidden`],
			{ "windowsHide": true });
	}
	else
	{
		const child = spawn(process.execPath, [path.join(appDir, "server.mjs")], {
			"cwd": appDir,
			"detached": true,
			"stdio": ["ignore", fs.openSync(log, "a"), fs.openSync(err, "a")],
			"windowsHide": true
		});
		child.unref();
	}

	for (let waited = 0; waited < 15000; waited += 400)
	{
		await new Promise(r => setTimeout(r, 400));
		if (await healthy())
			return "后端已代为拉起";
	}
	throw new Error(`后端起不来，看 ${err}`);
}

const note = await ensureServer();
console.log(`${note} · 控制台 ${BASE}/`);
if (!process.argv.includes("--no-open"))
	spawnSync("cmd", ["/c", "start", "", BASE + "/"], { "windowsHide": true });
