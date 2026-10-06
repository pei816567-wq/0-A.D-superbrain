/**
 * 模板目录：从桥接层导出的 static-*.json 里合并本局真实见过的模板。
 *
 * 故意不去解 public.zip —— 安装包里的模板全在 zip 内，运行期那个文件被引擎独占，
 * 强行读它会踩"第二个实例读不到 mod 文件"同一个坑。
 * 代价是目录只覆盖出现过的模板；好处是每个名字都是本局真实可用的，
 * 交给引擎的 template 不会静默失效。
 */

import fs from "node:fs";
import path from "node:path";

import { listRuns, readJson } from "./ipc.mjs";

const TTL_MS = 20000;

export class Catalog
{
	constructor(cfg)
	{
		this.cfg = cfg;
		this.at = 0;
		this.entries = {};
		this.menus = {};
		this.formations = null;
		this.stances = null;
	}

	refresh(force = false)
	{
		if (!force && Date.now() - this.at < TTL_MS)
			return this;
		this.at = Date.now();

		const runs = listRuns(this.cfg.game.ipcRoots).slice(0, 12);
		for (const run of runs)
		{
			let files = [];
			try
			{
				files = fs.readdirSync(run.dir).filter(f => /^static-\d+\.json$/.test(f)).sort();
			}
			catch (e)
			{
				continue;
			}
			for (const f of files.slice(-2))
			{
				const data = readJson(path.join(run.dir, f));
				if (!data)
					continue;
				this.formations = data.availableFormations || this.formations;
				this.stances = data.availableStances || this.stances;
				for (const name in data.templates || {})
				{
					const t = data.templates[name];
					if (!this.entries[name])
						this.entries[name] = digest(name, t);
				}
			}
		}
		return this;
	}

	/**
	 * 把实时帧里的信息吸收进目录：
	 *   probe.trainers = 每类建筑能训练什么（桥接层顺手记下来的生产菜单），
	 *   entities       = 本局真实出现过的模板名。
	 * 这样"训练弓手"这类说法能解析到还没在场上出现、但兵营里确实有的模板名。
	 */
	absorb(frame)
	{
		if (!frame)
			return this;
		const trainers = (frame.probe && frame.probe.trainers) || {};
		for (const building in trainers)
		{
			this.menus[building] = (trainers[building] || []).slice(0, 60);
			this.note(building, "structure");
			for (const t of this.menus[building])
				this.note(t, /^structures\//.test(t) ? "structure" : "unit");
		}

		const fields = frame.fields || [];
		const ti = fields.indexOf("template");
		if (ti >= 0)
			for (const row of frame.entities || [])
				this.note(row[ti], null);
		return this;
	}

	note(name, kind)
	{
		if (!name || this.entries[name])
			return;
		this.entries[name] = {
			"kind": kind || (/^units\//.test(name) ? "unit" : /^structures\//.test(name) ? "structure" : "other"),
			"name": "",
			"civ": String(name).split("/")[1],
			"classes": [],
			"cost": {},
			"hp": null,
			"range": 0,
			"dps": 0,
			"inferred": true
		};
	}

	menusFor(buildingTemplate)
	{
		this.refresh();
		return this.menus[buildingTemplate] || [];
	}

	names(kind)
	{
		this.refresh();
		const re = kind === "unit" ? /^units\// : kind === "structure" ? /^structures\// : null;
		return Object.keys(this.entries).filter(n => !re || re.test(n)).sort();
	}

	/** 给指令层用的纯名字数组。 */
	templates()
	{
		return this.names();
	}

	get(name)
	{
		this.refresh();
		return this.entries[name] || null;
	}

	/** UI 的模板表：带成本与兵种属性，按文明过滤。 */
	list({ kind, civ, q, limit = 200 } = {})
	{
		const names = this.names(kind);
		const needle = String(q || "").toLowerCase();
		const out = [];
		for (const name of names)
		{
			if (civ && name.indexOf(`/${civ}/`) < 0 && name.indexOf("/gaia/") < 0)
				continue;
			const e = this.entries[name];
			if (needle && `${name} ${e.name || ""} ${e.classes.join(" ")}`.toLowerCase().indexOf(needle) < 0)
				continue;
			out.push(Object.assign({ "template": name }, e));
			if (out.length >= limit)
				break;
		}
		return out;
	}

	stats()
	{
		this.refresh();
		const all = Object.values(this.entries);
		return {
			"total": all.length,
			"units": all.filter(e => e.kind === "unit").length,
			"structures": all.filter(e => e.kind === "structure").length,
			"other": all.filter(e => e.kind === "other").length,
			"formations": this.formations,
			"stances": this.stances,
			"at": this.at
		};
	}
}

/** GetTemplateData 的原始结构很大，这里只留控制台要用的量。 */
function digest(name, t)
{
	const kind = /^units\//.test(name) ? "unit" : /^structures\//.test(name) ? "structure" : "other";
	const cost = t.cost || {};
	const attack = t.attack || {};
	const ranged = attack.Ranged || null;
	const melee = attack.Melee || null;
	return {
		"kind": kind,
		"name": plainName(t.name),
		"civ": name.split("/")[1],
		"classes": (t.visibleIdentityClasses || []).map(String),
		"cost": { "food": cost.food || 0, "wood": cost.wood || 0, "stone": cost.stone || 0, "metal": cost.metal || 0, "pop": cost.population || 0, "time": cost.time || 0 },
		"hp": t.health ? t.health.Hitpoints : (t.Health ? t.Health.HP : null),
		"range": ranged ? ranged.maxRange : (melee ? melee.maxRange : 0),
		"dps": ranged || melee ? Math.max(damageOf(ranged), damageOf(melee)) : 0,
		"speed": t.speed ? (t.speed.run || t.speed.running || null) : null,
		"garrisonCap": t.garrisonHolder ? t.garrisonHolder.capacity : (t.garrisonable ? t.garrisonable.size : null)
	};
}

function damageOf(a)
{
	if (!a)
		return 0;
	const d = (a.Damage && a.Damage.Pierce) || (a.Damage && a.Damage.Hack) || (a.Damage && a.Damage.Crush) || 0;
	const repeat = a.repeatTime || 1000;
	return Math.round(d * 1000 / repeat * 10) / 10;
}

function plainName(n)
{
	if (!n)
		return "";
	if (typeof n === "string")
		return n;
	return n.en || n["en"] || "";
}
