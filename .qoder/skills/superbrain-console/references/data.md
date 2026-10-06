# 数据字典：帧、视图、字段到底代表什么

## 传输层

游戏内 mod 与控制台之间只有文件，没有 socket：

```
Documents\My Games\0ad\saves\campaigns\superbrain\run-<时间戳>-<随机>\
  boot.json            目录身份证（一个对局一个目录）
  state-000123.json    每拍一帧完整态势（mod 写，控制台读）
  static-000004.json   GetTemplateData 快照 + 生产菜单 + 阵形/姿态表
  cmd-000007.json      控制台写的命令包（mod 读，回执在下一帧 applied.cmdSeq）
```

三条铁律，改代码前先读：
1. **一个对局一个 `run-*` 目录**。往同名文件重复写会触发引擎的 `wtruncate` 共享冲突，直接断言崩进程。
2. **cmd 序号必须严格大于桥接层已经消费过的值**，否则命令被静默丢弃（控制台已用帧里的 `applied.cmdSeq` 播种）。
3. **帧可能读到半截**，解析失败要沿用上一帧，不能当"对局结束"。

## 一帧 state 的顶层

| 字段 | 含义 |
|---|---|
| `seq` | 帧号，只增 |
| `wall` | 写出时刻（**本机毫秒**），用来算年龄 |
| `now` / `duration` | **仿真秒**（引擎的 `timeElapsed` 是毫秒，mod 已换算） |
| `me` | 本玩家 id（字符串键） |
| `autopilot` / `economy` | 军事 / 经济是否被接管 |
| `simRate` | 引擎速度倍率 |
| `fields` + `entities` | 实体表是「列名 + 定长数组」的压缩结构，**必须按 `fields` 顺序解**，否则整表错位 |
| `skippedPosless` | 因缺坐标被跳过的行数（正常应为 0；不为 0 说明驻军/坐标处理又出问题了） |
| `cfg` / `econCfg` | 游戏内微操 / 经济参数**真值**。旋钮显示以它为准，不拿控制台本地副本冒充 |
| `applied` | `{cmdSeq, ok, rejected, meta[], ops[]}` —— 命令回执 |
| `diag.errors` | 桥接层内部错误尾巴，判断"有没有下砸"就看它 |
| `probe.trainers` | 每类建筑能训练什么（模板名池的唯一权威来源） |
| `steps` | 启动阶段轨迹，崩在加载哪一步时用 |

### 实体行 11 列

`["id","template","owner","x","z","hp","maxHp","seen","idle","enemy","holder"]`

- `seen`：**3=己方可控，2=当前可见，1=只有最后已知位置，0=不可见（不导出）**。
  给集火/下令用的目标只能是 3 或 2；拿 `seen=1` 的坐标下令等于自欺欺人。
- `idle`：仅对 `seen=3` 有意义（单位 AI 是否空闲）。
- `holder`：`>0` 表示这个单位被关在那栋建筑里 —— **引擎不给驻军单位 position**，所以它的 `x,z` 是宿主建筑的坐标（锚点），不能当真实位置用；驻军单位不能采集、不能作战。
- `hp` 可能是 `-1`（读不到），别拿去算百分比。

## 视图（`/api/state` 的 `view`，由 `lib/frames.mjs` 生成）

| 字段 | 含义 / 用法 |
|---|---|
| `ageMs` | 帧年龄。`>8000` 基本等于游戏退出或**窗口被最小化**（0 A.D. 失焦会自最小化并暂停主循环，`pauseonfocusloss=false` 也拦不住） |
| `headline` / `alarms` | 一行摘要与告警灯（`ok/warn/bad`） |
| `my` | `{pop, popCap, phase, resources, techs, classes, state}` |
| `counts` | `ownRows/army/workers/idleWorkers/bunkered/structures/foesSeen/foeStructures/lastKnown` |
| `composition` / `foeComposition` | 兵种桶计数：`pikeman/sword/ranged/cav/hcav/siege`（显示用近似，真正影响配比的是 mod 内的 `g_SuperbrainShares`） |
| `armyHp` | 军队平均血量比例 |
| `home` / `armyCentroid` / `foeCentroid` | 主城、我军质心、敌军重心；`home` 优先取 civil_centre |
| `homeThreat` | `{seen, last}` —— 最近敌人离家的格数，分"当前可见"和"仅最后已知" |
| `armyToHome` / `armyToFoe` | 距离判断用：军队离家多远、离敌多远 |
| `ids` | 各池子的实体 id 数组，选择器的底层 |
| `points` | 带坐标的样本（`army/foes/buildings/workers/bunkered`），挑目标用 |
| `groups` | 内核编组：`{key, n, role, task, action, range, d, standoff, ttk, reach, wounded, at, dest, home}` |
| `fight` | 内核这一拍的判定：`{fight, edge, rangeEdge, exchange, foes}` |
| `guard` | 内核的基地防卫判定：`{active, foes, ours, home, exchange}` —— 旧帧可能没有这个字段 |
| `econ` | 经济副驾摘要，见下 |
| `combat` | `{ourHpLost, foeHpLost, ratio, ourLosses, foeKills}` |
| `map` | 画迷你地图用的抽稀点集 |
| `players` | 每个玩家：`{id, name, civ, color, state, dead, pop, popCap, phase, resources, classes, techs, enemy, ally}` |
| `foes` | 敌对且未败的玩家（"打击对象"下拉就是它） |

### 编组 `key`

`g1 / g2 / g3…`，跨拍稳定但**只在当前对局内有意义**：认领用上帧质心（阈值 70 格），
一支队被打散或跑太远会换 key。所以 `group:g2` 适合"立刻对这队做点什么"，
不适合当长期标识存到别处。历史上这里踩过坑：key 曾按质心坐标命名，导致三组撞成同一个 key、
移动记忆串组，`battle_sim.mjs` 现在有唯一性断言守着。

### `groups` 字段读法

- `role`：`ranged / cavalry / melee`，决定它这拍该干什么。
- `task`：`push / defend / anchor / flank / withdraw / hold / return`（打法 + 战场判定 + 基地防卫共同决定）。
  `return` = 全军回防，优先级最高：即使外线那一仗判定"打不动"（本会转 `withdraw` 往集结点撤），
  只要家里被判定压境，一律改朝基地走。
- `home`：这组质心到基地的格数，只在回防判定开启时才有值（`null`/缺列表示这拍没算）。
- `action`：实际执行的动作，`kite`（拉开打）/ `pull`（撤向防线）/ `hold`（站桩）/ `flank`（绕后）。
- `d`：距最近敌人；`-1` 表示这拍附近没人。
- `ttk` vs `reach`：清完这波要多久 vs 敌人贴脸要多久 —— 风筝判定的核心比较。

## `guard`（基地防卫）怎么读

内核每拍都会问一次"家里守不守得住"，判据不是敌人数量，而是**拿会战那套兰彻斯特交换比在基地上重算一遍**：

| 字段 | 含义 |
|---|---|
| `foes` | `homeThreatRadius` 内可见的敌方**机动**火力（敌军建筑不算，修在家门口的塔不构成"压境"） |
| `ours` | 同一半径内能还手的己方单位：野战军 + 会射箭的自家建筑（主城/塔都算守军） |
| `exchange` | 家里这场的交换比，`< winMargin` 即守不住 |
| `home` | 基地坐标（多主城取质心）。**不受集结点影响** —— 玩家把 rally 设到前线时，回防仍然回主城 |
| `active` | 是否处于回防状态 |

`active` 是带滞回的：`foes >= homeThreatEnter` 且守不住才进；要 `foes <= homeThreatExit` 或守得住了、
并且已经保持了 `homeDwell` 秒，才出。所以看到"敌人都跑了还没解除"不是 bug，是在防抖 ——
边界上一帧回防一帧继续推，两边都打不赢。

判断"该不该回防却没回"时按这个顺序看：`active` 为 false 但 `foes` 很高 → 家里 `ours` 也高（守得住，故意不回）；
`active` true 但没有组 `task=return` → 所有组都已在 `homeArriveRadius` 内，就地作战。

## `econ` 摘要字段

| 字段 | 含义 |
|---|---|
| `civilians` / `wantCivilians` | 实际农民数 / 目标数（目标 = min(`villagerCap`, 房间能容纳的)） |
| `workers` / `idle` / `bunkered` | 在干活的 / 闲着的 / 被关在建筑里的。**`workers` 不含 `builders`**（被工地锁走的人），人口在涨而 `workers` 不涨就是人被锁在工地上 |
| `builders` / `buildSites` | 当前被锁在建地基上的builder数 / 真的有人在建的工地数。地基没人建就永远建不完，所以副驾会锁住人并在血量 `siteStall` 秒没涨时重新派（续建走 `repair`） |
| `placeFails` | 这一拍被引擎否掉的地基理由统计（键是引擎自己的 `result.message`，如"不能在领地外建造"）。空 `{}` = 找点全部通过。每栋建筑都必须落在自己领地内（`template_structure.xml` 的 `BuildRestrictions/Territory=own`），旧螺旋第一环加了多少米间隙就会整圈推到领地外 |
| `gatherers` / `wantGatherers` | 引擎报的各资源劳力数 / 副驾算出的应有数。长期背离 = 断供。引擎这份**不完整**（人在往返路上就不计数），所以副驾内部另有一套"位置证据 + 自己下过的 gather 令"的账本 |
| `untracked` | 既不在任何采集点旁边、也不在副驾账本里的农民数。这个数很大而 `gatherers` 某项是 0，说明调度在瞎子模式；副驾绝不再把这些人平摊成"每种资源都有人在采"（旧写法就这么把石金整局藏成了 0 收入） |
| `phaseCost` | 下一个时代的报价（如 `{food:500, wood:500}`）。`squeezeEta` 用它和毛收入算"还差多久"，凑得齐就先不盖房。**故意不看"现在能不能研究"**：面板要凑够建筑栋数才让点，按可研究性过滤会让报价恒为 null，攒专款整局不触发 |
| `slots` / `nodes` | 资源点坑位上限 / 可见采集点数。`engine` 自己报的 `numGatherers` 恒为 0，不可信 |
| `income` | 每秒**净**收入（相邻帧库存差分，会为了攒报价而变负）。副驾内部另有毛收入 = 净变化 + 这段时间花掉的，`squeezeEta` 那条判断只看毛收入 |
| `mix` | 目标兵种配比（按敌方编制自适应后的结果） |
| `wallet` | 副驾记账：它以为自己花掉了多少，用来避免超支 |
| `threatDist` | 最近敌人离家的格数；`null` = 视野里一个敌人都没有 |
| `alerts` / `log` | 断供等告警、最近动作日志 |
| `issued` / `issuedTotal` / `rejectedTotal` | 本拍 / 累计 下令数与被拒数 |
| `ownRows` | 己方实体行数（判断"是不是又有单位看不见"，正常应接近 `pop + 建筑数`） |

## 告警语义（`alarms`）

| 文案 | 真因 | 该做什么 |
|---|---|---|
| `数据断了 N 秒` | 游戏退出 / 窗口最小化暂停主循环 | 恢复窗口焦点，或 `sb.mjs runs` 看有没有新 run 目录并 `reconnect` |
| `基地被压境：家门口 X 股火力、守军 Y，全军回防中` | 内核自动判定家里守不住，外线部队正朝基地 attack-walk | 不用管，也别再补 `defend-home`；想让它更晚回防就抬 `homeThreatEnter` |
| `敌人距家 X 格，建议回防` | 有敌人靠近但内核判家里还守得住（`guard.active` 为 false） | 想看真实判定就读 `view.guard`；确信要回防按 `intent defend-home` |
| `战损比 <0.7` | 交换吃亏 | 降攻击欲望或改打法为 `hold`，检查 `mix` 是否被对面兵种克制 |
| `农民只有 N` | 经济起不来 | `knob economy=boom`，看 `bunkered` 是不是有人被关着不干活 |
| `X 断供 N 秒（应有 a 人，实际 b 人）` | 排了人手却采不到（路被堵、点被抢、坐标太远） | `sb.mjs nodes` 找替代采集点，或 `intent gather` 手动派 |
| `N 人关在建筑里不产资源` | 驻军没放出来 | `intent unload`（无敌人可见时会立刻全放） |
