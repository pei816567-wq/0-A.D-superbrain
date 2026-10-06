/**
 * 指定打击对象（focusPlayer）的离线验证。
 *
 * 战场设定：我军弓兵在中间，P2 的杂兵离得近、P3 的主力离得远。
 * 不指定时应该先打近的（省走路）；指定 P3 之后，集火目标必须换到 P3 身上 ——
 * 但 P2 仍然算威胁（否则玩家会被家门口那家白嫖），所以这里只断言"优先级变了"。
 *
 *   node superbrain/tools/focus_test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "mod", "gui", "session", "superbrain_kernel.js"), "utf8");
const Kernel = new Function(src + "\nreturn SuperbrainKernel;")();

const TEMPLATES = {
	"units/kush/infantry_archer_b": {
		health: 50, speed: { walk: 10.3, run: 17.2 },
		resistance: { Damage: { Crush: 10, Hack: 1, Pierce: 1 } },
		visibleIdentityClasses: ["Soldier", "Infantry", "Ranged", "Archer"],
		attack: { Ranged: { maxRange: 60, repeatTime: 1250, Damage: { Pierce: 7.2 } } }
	},
	"units/brit/infantry_spearman_b": {
		health: 100, speed: { walk: 9.5, run: 15.86 },
		resistance: { Damage: { Crush: 15, Hack: 3, Pierce: 3 } },
		visibleIdentityClasses: ["Soldier", "Infantry", "Melee", "Spearman"],
		attack: { Melee: { maxRange: 4, repeatTime: 1000, Damage: { Hack: 4.5 } } }
	}
};

const ctx = { "getTemplate": t => TEMPLATES[t], "log": () => {} };
let id = 100;

function unit(template, owner, x, z)
{
	const tpl = TEMPLATES[template];
	return {
		"id": ++id, "t": template, "owner": owner, "x": x, "z": z,
		"hp": tpl.health, "maxHp": tpl.health, "seen": owner === 1 ? 3 : 2,
		"enemy": owner !== 1, "idle": false, "holder": 0
	};
}

function world(now)
{
	const units = [];
	for (let i = 0; i < 10; ++i)
		units.push(unit("units/kush/infantry_archer_b", 1, 100 + (i % 5) * 3, 100 + Math.floor(i / 5) * 3));
	// P2：贴脸的一小队
	for (let i = 0; i < 4; ++i)
		units.push(unit("units/brit/infantry_spearman_b", 2, 128 + (i % 2) * 3, 100 + Math.floor(i / 2) * 3));
	// P3：稍远但更多的一队（在射程边缘附近）
	for (let i = 0; i < 8; ++i)
		units.push(unit("units/brit/infantry_spearman_b", 3, 148 + (i % 4) * 3, 96 + Math.floor(i / 4) * 3));
	return { "now": now, "me": 1, "units": units, "formations": ["line", "box"], "rally": null, "objective": null };
}

/** 跑若干拍，统计集火令落在哪家身上，并记下威胁判定看到的敌人数。 */
function tally(patch)
{
	const k = new Kernel(ctx);
	k.configure(Object.assign({ "maxOpsPerTick": 30, "engageRadius": 90, "judgeRadius": 140 }, patch));
	const w = world(10);
	const hits = { "2": 0, "3": 0 };
	const owners = {};
	for (const u of w.units)
		owners[u.id] = u.owner;

	let foeCount = 0;
	for (let tick = 0; tick < 20; ++tick)
	{
		const out = k.plan(w);
		for (const op of out.ops || [])
		{
			if (op.op === "attack" && owners[op.target])
				++hits[String(owners[op.target])];
		}
		foeCount = Math.max(foeCount, (k.fight || {}).foes || 0);
		w.now += 0.1;
	}
	return Object.assign(hits, { "foeCount": foeCount });
}

const free = tally({});
const focused = tally({ "focusPlayer": 3 });

console.log("不指定对象 :", free);
console.log("指定打 P3  :", focused);

const problems = [];
if (free["2"] + free["3"] === 0)
	problems.push("两拨人都没被集火，说明用例没造出可打的目标（测试本身失效）");
if (focused["3"] <= focused["2"])
	problems.push(`指定 P3 后仍然更倾向打 P2：${JSON.stringify(focused)}`);
if (focused["3"] <= free["3"])
	problems.push(`指定 P3 没有提高对 P3 的集火量：${free["3"]} → ${focused["3"]}`);
// 优先级只能改"先打谁"，不能改"谁算威胁"：把别家从判定里剔掉等于放任屠村
if (focused.foeCount !== free.foeCount)
	problems.push(`指定对象后威胁判定少看见了敌人：${free.foeCount} → ${focused.foeCount}`);

if (problems.length)
{
	console.error("FAIL\n  " + problems.join("\n  "));
	process.exit(1);
}
console.log("OK: focusPlayer 只改优先级，P3 集火量上升且 P2 仍在目标池里");
