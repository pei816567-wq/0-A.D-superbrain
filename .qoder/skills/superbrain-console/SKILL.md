---
name: superbrain-console
description: 驱动与改造 0 A.D. 的 Superbrain 副驾控制台（superbrain/app：接管军事/经济、41 条逻辑指令、战略旋钮、训练模式、大模型接管）。当用户要求"让 AI 打这局/回防/改攻击欲望/开训练/接大模型"，或要修改 superbrain/mod 或 superbrain/app 下代码、判断态势帧字段含义、排查"AI 没动作/命令没生效/帧停更"时使用。
---

# Superbrain 控制台

## 这是什么

玩家打《0 A.D.》单机，操作跟不上时把军队或运营交给 AI。分两层：

- **游戏内执行层**（`superbrain/mod/gui/session/`）：微操内核（风筝/集火/多军团）、经济副驾（农民/建筑/科技/配比）、桥接层（导出状态 + 注入与鼠标点击等价的命令）。
- **控制台层**（`superbrain/app/`）：零依赖 Node 后端 + 浏览器 UI，把执行层包成 41 条逻辑指令，再往上接一个大模型中间层做自然语言与战略决策。

所有动作都必须是"玩家鼠标能做出来的动作"，不走引擎内部接口 —— 这样换版本、换游戏时逻辑可迁移。
**只做单机**：`isSinglePlayer()` 按真实玩家席位判定，多人房自动禁用接管，任何情况下都不要绕过。

## 起手三件事

1. 后端在不在：`curl -s http://127.0.0.1:8712/api/health`。不在就
   `node superbrain/app/server.mjs`（后台跑，只绑 127.0.0.1）。
2. 对局连没连上：`node <skill>/scripts/sb.mjs status`。它给一行全部关键数字。
   没连上就 `sb.mjs runs` 看有没有新 run 目录，必要时 `sb.mjs game start --confirm` 开一局。
3. 别用 curl 发中文：Git Bash 会把 UTF-8 弄坏导致指令匹配不上，一律走 `sb.mjs` 或 Node fetch。

`<skill>` 指本技能目录 `.qoder/skills/superbrain-console`。

## 命令行（优先用它，不要手搓 HTTP）

```
sb.mjs status [foe]        一行态势；foe 附带对手表        sb.mjs watch 30      连续看 30 秒
sb.mjs params              游戏内微操/经济参数真值          sb.mjs groups        内核编组（含质心）
sb.mjs players / foes / buildings / nodes                  实体 id 与位置，下令要用
sb.mjs takeover mil|eco|all on|off                         四个按钮
sb.mjs knob aggression=.8 posture=attack economy=boom target=2 doctrine=push
sb.mjs intent <名> [k=v]                                   下发一条逻辑指令
sb.mjs intents [关键词]                                     查指令清单与参数
sb.mjs chat "自然语言"                                      走大模型/规则中间层
sb.mjs brief [--ai]                                        态势简报
sb.mjs train start trials=4 budgetSim=900 speed=4 mode=random|hill
sb.mjs train status|stop|best|apply|clear                  训练模式
sb.mjs sage start|stop                                     大模型接管模式（战略层）
sb.mjs llm set base_url=... model=... api_key=... on=true ; sb.mjs llm test
sb.mjs runs [n] / runs pin <dir> / runs auto               切对局
sb.mjs events [n] / econ-trace / config / game start --confirm
```

`k=v` 里数字、`true/false`、`{json}`、`40,80` 坐标、`[155,156]` id 数组都会自动转型。

## 常用工作流

**"帮我打这一局"** → `sb.mjs takeover all on` → `sb.mjs knob posture=attack` →
每 30 秒 `sb.mjs status`，看 `判定` 与 `比`（掉血比 >1 才算占便宜）。

**家里被偷** → 回防是内核自动的：`sb.mjs status` 末尾 `防卫稳` / `防卫压境(敌X/守Y)` 就是它的判定，
压境时外线编组 `task=return`、目的地是主城坐标（`sb.mjs groups` 的 `离家` 列看谁在赶回来）。
**这时不要再下 `defend-home`**，重复下令只会把滞回打断。要手动兜底（或者想让它们别回来）才用
`sb.mjs intent defend-home`；嫌它回得太勤/太钝就调 `homeThreatEnter` / `homeThreatRadius`（见 `knobs.md`）。

**运营落后** → `sb.mjs econ-trace` 对比 `实际` 与 `应有` 劳力 → `knob economy=boom` 抬农民目标 →
若 `关着 >0` 则 `intent unload`。断供告警要 `nodes` 找替代采集点，光调参数没用。
告警末尾的 `卡点：……` 决定处置方向（没人可抽 / 过不了抖动门槛 / 矿点太远 / 预算被截胡），
逐项对照见 `troubleshooting.md` §4；`econ.untracked` 接近农民总数而某项资源仍 0 人 = 劳力账本回归，
不是权重问题。钱够却不上时代看 `econ.phaseCost` 与 `squeezeEta`（教程节奏见 `econ-tutorial.md`）。

**只调经济（军事侧一行不动）** → `sb.mjs train start trials=4 target=econ mode=random budgetSim=1200 speed=4 aiDiff=6` →
排行榜那一行给的是**经济标尺**（人口@10分 / Town / City / 矿工 / 田 / 房 / 闲），评分只看经济，
撒的参数只有 `econSpace()` 里那些（`minerFloor`、`woodFloorShare`、`woodEmergency`、`squeezeEta`……）。

**要变强（训练）** → `sb.mjs train start trials=6 budgetSim=900 speed=4 mode=hill` →
`sb.mjs train status` 看排行榜 → `train apply` 把最优包下发当前对局。串行跑，一局约 3–5 分钟；
期间不要再开游戏。

**接大模型** → `sb.mjs llm set base_url=http://127.0.0.1:11434/v1 model=qwen2.5:14b-instruct on=true`
→ `sb.mjs llm test` → 需要它持续做战略决策再 `sb.mjs sage start`。
不接模型也能用：四个按钮、旋钮、指令台、训练模式、以及中文口令规则兜底全部照常工作。

## 硬性守则

- **绝不使用 `Engine.SendNetworkChat` 做探针**：本地单人无网络会话时它在 C++ 层解引用空指针，JS 的 try/catch 拦不住，直接崩进程。要发消息用 `addChatMessage`。
- **一个时刻只有一个 pyrogenesis**：`public.zip` 被独占，第二个实例读不到 mod 文件。
- **写 `user.cfg` 必须显式 UTF-8 无 BOM**，且游戏在跑时不写（会被它自己的存档覆盖并污染键名）。
- **改 `superbrain/mod/` 后必须同步到游戏目录并 `cmp`**：
  `cp` 到 `G:\0 A.D. Empires Ascendant\binaries\data\mods\superbrain\` 对应路径。
- **不要动用户的 `han_tank` mod。**
- 逻辑指令只加在 `app/lib/intents.mjs` 一处：UI、大模型工具表、战略层白名单都从它派生。
  加完必须跑 `app/test/console_test.mjs`（它会拿指令用到的 op 名和桥接层源码里的 `case` 标签对账）。
- 参数改动只允许走 `lib/presets.mjs`，两条防抖不变量都要守住：
  `civilianDanger × 2 ≤ unloadThreat`（军事关人 vs 经济放人）与
  `homeThreatExit < homeThreatEnter`（回进的滞回带宽）；
  且任何姿态都不要打开 `garrisonCivilians`（历史上关人与放人来回弹，人口从 18 抖到 10）。
- **经济与军事两套代码不许互相读对方的参数**：`g_SuperbrainConfig`（微操/回防）与
  `g_SuperbrainEconConfig`（劳力/建造/科技）各自独立，下发也是 `micro-config` / `econ-config` 两条命令。
  经济要微调时只改 `superbrain_economy.js` + `econSpace()`，不要为了经济节奏去动内核，
  反之亦然 —— 两边混着调就再也归因不了是哪一改起作用。

## 改完怎么验

按顺序，全绿才算完：

```
node superbrain/app/test/console_test.mjs    # 165 项：op 对账 / 指令编译 / 旋钮不变量 / HTTP 端到端 / 模型链路与护栏
node superbrain/tools/bridge_test.mjs        # 假引擎 400 拍
node superbrain/tools/econ_test.mjs          # 经济离线自转
node superbrain/tools/battle_sim.mjs         # 微操对拍 + 编组 key 唯一
node superbrain/tools/focus_test.mjs         # 指定打击对象
node superbrain/tools/recall_test.mjs        # 回防：判定/滞回/优先级/开关 + 判定窗宽度陷阱
node superbrain/tools/massacre_report.mjs all   # 复盘：每局 100 秒阵亡跳增 ≥40 就算不合格
```

`console_test.mjs` 的微操参数白名单是从内核源码里的 `g_SuperbrainConfig` 现取的，
所以加参数只需要改内核 + 改 `presets.mjs`，测试会自己发现漏没漏。

离线绿了不等于好用：涉及实战行为的改动要真开一局，用 `sb.mjs` 驱动并读回 `applied.cmdSeq`、
`diag.errors`、`cfg` 真值作为证据。改完 `superbrain/mod/**` 必须重新同步到
`G:\0 A.D. Empires Ascendant\binaries\data\mods\superbrain` 并 `cmp`，然后**重开一局**才生效
（脚本在进对局时加载，老对局里跑的还是旧内核）。

## 参考

- `references/intents.md` — 41 条逻辑指令全表（参数、必填、可选值）
- `references/api.md` — REST/SSE 接口与请求体
- `references/data.md` — 状态帧与视图字段含义（`seen` 编码、`holder`、`ageMs`、告警语义、编组字段读法）
- `references/knobs.md` — 旋钮→阈值映射表、防抖不变量、训练搜索空间与评分
- `references/econ-tutorial.md` — 运营教程口径→经济权重映射，每条被实测证实/证伪过的节奏约束
- `references/troubleshooting.md` — 症状→真因→处理（帧停更、命令不生效、zip 占用、经济断供的六种卡点、模型连不上）
