/**
 * 从逻辑指令注册表生成 skill 用的指令表（文档与代码同源，避免漂移）。
 *
 *   node superbrain/app/tools/gen_intent_docs.mjs > intents.md
 */

import { uiSchema } from "../lib/intents.mjs";

const KIND = { "tactical": "战术", "production": "生产 / 经济", "control": "接管与控制", "preset": "战略旋钮", "macro": "组合宏", "lab": "实验台" };
const rows = uiSchema();
const out = [];
let last = null;

for (const i of rows)
{
	const kind = KIND[i.kind] || i.kind;
	if (kind !== last)
	{
		out.push("", `### ${kind}`, "", "| 指令 | 作用 | 参数（* 为必填） |", "|---|---|---|");
		last = kind;
	}
	const args = i.args.map(a => {
		const type = a.type === "selector" ? "选择器" : a.type;
		const values = a.enum ? a.enum.join(" / ") : (a.default != null ? `默认 ${JSON.stringify(a.default)}` : "");
		return `\`${a.key}\`(${type}${values ? `: ${values}` : ""})${a.required ? " *" : ""}`;
	}).join("<br>");
	out.push(`| \`${i.name}\` | ${i.label} — ${i.desc} | ${args || "—"} |`);
}

console.log(`共 ${rows.length} 条逻辑指令。参数里的坐标一律接受 \`home\` / \`foe\` / \`x,z\` / \`{"x":n,"z":n}\`，` +
	"单位一律用选择器（`army` / `all` / `workers` / `idle` / `wounded` / `bunkered` / `structures` / `cc` / `group:gN`）。");
console.log(out.join("\n"));
