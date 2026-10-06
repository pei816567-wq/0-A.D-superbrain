# 排错：症状 → 真因 → 处理

按"先看什么"的顺序排。绝大多数"AI 坏了"的报告最后都是下面前四条之一。

## 0. 浏览器 `Failed to fetch` / 拒绝连接 / "没连上"

- **地址只有一个**：`http://127.0.0.1:8712/`（`lib/config.mjs` 的 `port`，全仓库没有别的端口）。
  报"拒绝连接"先 `netstat -ano | grep ":8712 "` 看有没有人听，别猜端口。
- **一键起**：双击 `superbrain/打开控制台.bat`，或 `node superbrain/app/tools/ui.mjs`
  （`sb.mjs ui` 是同一条路）。它会：后端不在就代为拉起 → 打开浏览器 → 打印真实地址。
- **双击 `web/index.html`（file://）也要能用**：前端在非 http 协议下回退到写死的
  `http://127.0.0.1:8712`，后端补了 CORS 与 OPTIONS 预检。两样少任一个就只显示"没连上"。
- **后端静默消失的头号原因**：用 `node server.mjs &` 或 `child_process.spawn(..., {detached:true})`
  起的后端，仍挂在 agent shell 的作业里，**工具调用结束时被一起回收**。
  只有 `powershell Start-Process` 才是真脱离（`ui.mjs` 走的就是这条）。
  起了之后要在**下一次工具调用里**再探一次 `/api/health`，别用同一次调用里的结果当证据。

## 1. 界面显示"帧停止更新" / `ageMs` 一直涨

- **最可能**：0 A.D. 失焦会自己最小化并**暂停主循环**（最小化后 CPU 掉到 6% 左右，日志也停）。
  `pauseonfocusloss=false` 挡不住这个。表现极像 mod 崩了。
  处理：别动前台，用 `sb.mjs runs` 看目录 mtime 是否还在推进；要恢复就点回窗口。
- 游戏进程真退了：`tasklist | grep -i pyrogenesis`。
- 新开了一局但控制台还守着旧目录：`sb.mjs runs` → `sb.mjs intent` 前先看 `sb.mjs status` 里的 run 名；
  服务端本身有"跟局"逻辑（帧停更 8s 且别处有更新的目录就自动切），手动兜底用 `POST /api/reconnect`。

## 2. 命令返回 `ok:true` 但游戏里什么都没发生

回执 `sent.seq` 只代表文件写入了。按顺序查：

1. 下一帧 `view.applied.cmdSeq` 有没有追上你刚发的 seq。没追上 = 桥接层没读到（序号被复用或文件写坏）。
2. `applied.rejected` 与 `view.diag.errors` 有没有新增。有 = 命令被拒，看错误尾巴（多半是目标不可见、实体不是己方、模板名不存在）。
3. 都正常但效果没有 → 大概率**目标选择器落空**（例如 `wounded` 一支都没匹配到，会直接报错而不是空发）。
4. `seen=1`（仅最后已知位置）的目标不能下令，桥接层会拒。

## 3. 起第二局失败：`gui/common/*.js does not exist` / `AutoStart is not defined`

`public.zip` 被引擎独占打开，**第二个实例读不到任何 mod 文件**。训练模式因此串行；
手动开新局前确认没有活的 pyrogenesis。控制台里表现为
`检测到有对局正在运行…`，确认要抢就用 `train start force=true`。

## 4. 经济不动 / 农民长期不涨

- 看 `econ.wantCivilians` 是否已到 `villagerCap`（那就是设计如此，`knob economy=boom` 抬高）。
- `econ.bunkered > 0` 且不降 → 有人被关着；`intent unload`（视野无敌时立刻全放）。
- `econ.rejectedTotal` 猛涨 → 参数在跟引擎打架（人口满、资源不够、地基放不下）；看 `deadRetry` 退避是否生效，别手动狂点。
- `counts.ownRows` 明显小于 `pop + 建筑数` → 又有单位从视野里蒸发了（驻军/坐标类老 bug 的回归信号），
  跑 `node superbrain/tools/bridge_test.mjs`。

### 某项资源整局 0 收入（石/金最常中）

告警长这样：`stone 断供 94 秒（应有 2.0 人，实际 0 人；卡点：……）`。**先看卡点再看权重**，
四种卡点是四件完全不同的事：

| 卡点 | 意思 | 处置 |
|---|---|---|
| （没有卡点） | 副驾算出来的"已有人数"不小于应有数 —— 账本把不存在的人算进去了 | 查 `econ.untracked`：它接近农民总数而某项仍报 0 人，就是劳力账本回归（见 `econ-tutorial.md`） |
| `没有富余的人手可抽` | 每种资源都在缺，没人可挪 | 抬 `woodFloorShare`/`minerFloor` 没用，得先让总量涨（`villagerCap`）或降 `stockPerVillager` |
| `缺口低于 pullMin（抖动门槛）` | 缺口太小，抽人会来回抖 | `minerFloor` 或 `pullMin`；某资源 0 人时本应走紧急支路，没走就是回归 |
| `N 格内没有可挂的采集点` | 矿点离主城超过 `assignRadius` | 抬 `assignRadius`，或先派斥候把远处的点探出来 |
| `可抽的人手都在冷却里` | 刚动过的人 12 秒内不再动 | 正常现象；持续出现就降 `pullMax` 或抬 `maxOps` |
| `本拍命令预算用尽` | 前面几类命令（补农民/盖房）吃光了 `maxOps` | 抬 `maxOps`，或降 `buildPace` |

### 房子/农田整局只有个位数（地基层面）

两种长得一样、成因完全不同的"盖不出来"：

| 证据 | 真因 | 处置 |
|---|---|---|
| `econ.placeFails` 非空、日志刷 `XX 找不到合法地基` | 引擎拒绝落点（领地/地形/占地）。理由就在 `placeFails` 的键里，别再靠猜 | 这是搜索问题：`placeRadius`/`placeTries`/`badSpotTtl`，或者换锚点。**注意**找点失败只退让 45 秒并放大半径，不会走 `deadRetry`（旧写法三次就搁置 15 分钟，实测一整局只盖出 2 块田） |
| 地基实体在、血量却不动（`田0 房0` 但 `buildSites>0`） | builder 被采集调度抽走，工地中途弃建 | 看 `econ.builders`：正常应 ≈ `buildSites × buildersPerSite`。为 0 就是 `keepSites` 没接管（回归），跑 `node superbrain/tools/econ_test.mjs` 的"工地不许中途弃建" |

复盘一条命令搞定：`node superbrain/tools/econ_pacing.mjs <run目录>` ——
它直接打"首达 500 库存的时刻 / 各资源实际 vs 应有劳力 / 卡口拍数"。

### 钱够却一直不上时代

- 报价看 `econ.phaseCost`（`{food:500, wood:500}` 这种）。
- `econ.income` 是**净**收入，边采边花时恒等于 0；副驾用毛收入算 `squeezeEta`，
  所以"收入 0 但在攒"是正常的，而"报价凑齐了 1 分钟还没下单"才是 bug（离线断言 45 秒内下单）。
- 栋数不够也会卡住：手册的 Town 要 5 栋非农田建筑，看 `econ.cc + econ.houses + econ.producers`
  是否到达 `townBuildings`（农田和栅栏不计入栋数）。
- **标尺里 `Town@未` 而经济明明在涨**：科技名带文明后缀（实测 Kush 是 `phase_town_generic`），
  任何精确匹配 `phase_town` 的代码都会把已上城的局读成村阶段。`phaseOf()`/`hasTech()`
  都已改成前缀匹配；再写新的时代判断记得沿用这个口径。

## 5. 军队送死 / 不回防

回防已经自动化了（内核 `homeGuard`），所以先确认它到底判成了什么：
`sb.mjs status` 末尾的 `防卫稳` / `防卫压境(敌X/守Y)`，或 `node -e` 直接读 `view.guard`。

| 现象 | 真因 | 处置 |
|---|---|---|
| `guard.active=false` 且 `foes` 不低、`exchange` 很高 | 家里守得住（主城/塔/附近军队在还手），故意不回 | 正常。真嫌它不回就降 `homeThreatEnter` 或抬 `winMargin` |
| `guard.active=false` 且 `exchange=0` | 判定窗比压境窗小（`homeThreatRadius > judgeRadius`）—— 已修，旧 mod 副本才会犯 | 重新同步 `mod/gui/session/superbrain_kernel.js` 并重启对局 |
| `guard.active=true` 但没有组 `task=return` | 所有组都已进了 `homeArriveRadius`，就地作战 | 正常，别重复下 `defend-home` |
| 回防令下了军队却不动 | `moveCooldown`/`shouldMove` 节流，或命令被拒 | 看 `diag.errors` 与 `kernel.rejected`；`sb.mjs events 20` |
| 一有敌情就全军来回抖 | 滞回带宽没了：`homeThreatExit >= homeThreatEnter`，或 `homeDwell` 被调到 0 | 恢复 `exit < enter`，`homeDwell >= 10` |
| 仗打得好好的突然全军回家 | 姿态是 `attack`（`homeThreatEnter=5`）时被别家用大部队骗了一次 | 抬 `homeThreatEnter` 或把 `homeThreatRadius` 收小 |

手动兜底仍然是 `sb.mjs intent defend-home`：切 hold + 全军 attack-walk 回主城 +
把 `homeThreatEnter/Exit` 拧成"有一只就回家、不清完不走"。
`fight.fight=false` 且 `action=pull` 说明内核已经在撤 —— 那是撤得不够快，不是没撤。

验收尺子在 `superbrain/tools/massacre_report.mjs`：任意 100 仿真秒窗口内我方阵亡跳增 ≥40 记为不合格
（历史那局 860–960s 跳增 63、村民归零）。`node tools/massacre_report.mjs all` 一局一行。


## 6. 大模型相关

- `连不上 http://…`：本地服务没起（Ollama `ollama serve` / LM Studio 的 OpenAI 兼容端口），或系统代理把本地回环也劫了（这台机器有 127.0.0.1:7890 代理，`NO_PROXY` 要含 `127.0.0.1,localhost`）。
- `模型没返回可解析的 JSON`：换指令跟随更好的模型，或把 `jsonMode` 设为 `response_format`（部分网关支持）。控制台会先自动重试一次。
- 模型可用但话术很水：态势简报本身已带全部数字，问题通常在模型规模；链路（解析→校验→下发→护栏）用 mock 端点验过，见 `app/test/console_test.mjs` 的 G 段。
- 战略层不下令：护栏会拦 —— 白名单外、`release-all`/`cheat-units`/`set-speed` 禁止、姿态类有最短驻留（`set-posture` 90s、`set-economy-mode` 120s）。被拦的都会进 `events`，`sb.mjs events 20` 能看到原因。

## 7. 配置被写坏（乱码键名）

`user.cfg` 只能用显式 UTF-8（无 BOM）读写。PowerShell 5.1 的 `Get-Content` 按 GBK 解码、
`Set-Content -Encoding UTF8` 又加 BOM，来回一次就把键名变成 `锘縧ocale` 这种。
`tools/install.ps1` 已改成显式编码 + 游戏在跑时拒绝执行。改配置优先走 `POST /api/config`。

## 8. 改了东西不知道有没有坏

顺序（都要绿）：

```
node superbrain/app/test/console_test.mjs     # 控制台 155 项：op 名对账、指令编译、HTTP 端到端、模型链路、护栏
node superbrain/tools/bridge_test.mjs         # 桥接 + 内核在假引擎里 400 拍行为
node superbrain/tools/econ_test.mjs           # 经济副驾离线自转
node superbrain/tools/battle_sim.mjs          # 微操对拍 + 编组 key 唯一性
node superbrain/tools/focus_test.mjs          # 指定打击对象只改优先级
```

改了 `mod/` 下任何 JS，必须同步到 `G:\0 A.D. Empires Ascendant\binaries\data\mods\superbrain\` 并 `cmp` 校验，
否则测的还是旧代码（这一步历史上漏过不止一次）。
