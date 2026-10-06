# 战略旋钮 → 游戏内参数

UI 上只给玩家五个东西：攻击欲望、攻防模式、经济模式、打法、打击对象。
它们落到游戏里是下面这些阈值，映射唯一发生在 `superbrain/app/lib/presets.mjs`，
训练模式搜参数用的也是同一份空间 —— 别在别处再写一套映射。

## 攻击欲望 `aggression(0..1)`

| 参数 | 0 时 | 1 时 | 含义 |
|---|---|---|---|
| `resistBase` | 0.75 | 1.25 | "打得过才打"的基础阈值，**调高不等于更强，只等于更愿意接战** |
| `winMargin` | 0.70 | 1.50 | 判定交换比要多好才开打 |
| `pushGrit` | 0.35 | 1.20 | `push/harass` 打法下的坚持度 |
| `edgeMargin` | 0.98 | 1.26 | 机动优势要够大才敢压上 |
| `engageRadius` | 40 | 110 | 多少格内的敌人算"该打" |
| `judgeRadius` | ≥90 | 110+ | 判定窗口，永远比 engageRadius 大一圈 |
| `maxChase` | 40 | 120 | 允许为追目标脱离防线多远 |
| `standoff` | 0.86 | 0.73 | 射程系数，越小贴得越近 |
| `retreatHp` | 0.42 | 0.28 | 低于此血量比例开始后撤 |
| `attackStructures` | false | ≥0.7 为 true | 是否主动打建筑 |
| `kite` | true | <0.95 为 true | 极高欲望时才放弃拉开 |

## 攻防模式 `posture`

| | defend | balanced | attack |
|---|---|---|---|
| `doctrine` | hold | field | push |
| 隐含攻击欲望 | 0.25 | 0.55 | 0.85 |
| `civilianDanger` | 55 | 45 | 38 |
| `maxGroups` | 4 | — | 6 |
| `armyShare` | 0.45 | 0.55 | 0.65 |
| `armyPopShare` | 0.28 | 0.35 | 0.40 |
| `unloadThreat` | 120 | —（默认 90） | —（默认 90） |
| `homeThreatEnter` | 2 | —（默认 3） | 5 |
| `homeThreatExit` | 1 | —（默认 1） | 2 |
| `homeDwell` | 20 | —（默认 15） | 10 |
| 其他 | — | — | `villagerCap 55`、`militaryTarget 30`、`attackStructures true` |

**不变量（改任何一条都要重新检查）**：`civilianDanger × 2 ≤ unloadThreat`。
军事副驾在 `civilianDanger` 内会让村民躲避，经济副驾要等敌人超过 `unloadThreat` 才放人；
两个阈值挨太近就会出现"一个塞人一个放人"的来回弹，历史上真把人口从 18 抖到 10、房子永远盖不起来。
所有姿态都保持 `garrisonCivilians=false`（被骚扰时走开，不失踪）。

第二条不变量：`homeThreatExit < homeThreatEnter`。回防判定靠这个带宽 + `homeDwell` 防抖，
写成 `exit >= enter` 就等于让滞回失效，军队会在家门口敌人数在阈值附近时来回抖。
`console_test.mjs` 对每个姿态都断言这两条。

## 基地防卫 `homeGuard`

| 键 | 默认 | 含义 |
|---|---|---|
| `homeGuard` | true | 总开关。关掉就退回"军队只管自己那一仗"的旧行为 |
| `homeThreatRadius` | 90 | 离基地多远内的敌方机动火力算压境 |
| `homeThreatEnter` | 3 | 达到几只才触发回防 |
| `homeThreatExit` | 1 | 降到几只以下才允许解除 |
| `homeArriveRadius` | 26 | 组离基地多近算回到防线（此后就地作战，不再收移动令） |
| `homeDwell` | 15 | 触发/解除后至少保持多少仿真秒再谈切换 |

触发条件不是数量单独决定，而是"数量达标 **且** 家里交换比打不过 `winMargin`"，
所以有主城/塔守得住时三五个散兵不会把全军拽回家。想调"救村的勤快程度"就动 `homeThreatEnter`，
它在训练搜索空间里（`[1,6]`），`homeThreatRadius` 也在（`[60,120]`）。

## 经济模式 `economy`

| | boom（憋经济） | balanced | war（暴兵） |
|---|---|---|---|
| `villagerCap` | 85 | 60 | 45 |
| `armyShare` | 0.32 | 0.55 | 0.70 |
| `armyPopShare` | 0.18 | 0.35 | 0.45 |
| `minVillagers` | 12 | 8 | 8 |
| `minReserve` | 70 | 40 | 25 |
| `stockPerVillager` | 8 | 6 | 5 |
| `buildPace` | 14 | 18 | 22 |
| `farmTarget` | 6 | 4 | 5 |
| `techShare` | 0.90 | 0.85 | 0.80 |
| `militaryTarget` | 0 | 0 | 40 |

## 劳力底线与卡时代（经济模块独有，军事侧完全不读）

这几个键只出现在 `superbrain_economy.js`，改它们不会碰微操一行代码。数字来自运营教程，
但真正逼出来的是实盘事故（见 `econ-tutorial.md`）。

| 键 | 默认 | 含义 | 调坏了会怎样 |
|---|---|---|---|
| `minerFloor` | 2 | 场上有矿点就必须给石/金这么多人（**绝对值**，受 `minerShare` 封顶） | 0 → 石金整局 0 收入，1000 石 + 1000 金的上城报价永远凑不出 |
| `minerShare` | 0.2 | 矿工总名额上限 = 人手 × 这个比例，再在石/金之间分 | 实盘随机到 `minerFloor=5` 而只有 12 个农民 → 粮木抽干、田房整局 0 栋、人口卡 17 后被屠 |
| `woodFloorShare` | 0.28 | 农民没起满之前伐木至少留这个比例 | 太低 → 木头贴着 0，盖不起房，人口卡死 |
| `woodEmergency` | 0.5 | 只差木头就盖不起下一栋房时，压这么多人手去砍木 | 太高 → 粮断供 |
| `squeezeEta` | 120 | 按毛收入算，时代报价能在这么多秒内攒出来时就暂停扩人口开销 | 太大 → 为攒报价把发展停死；太小（=0 关掉）→ 木头一进账就花光，11 分钟上不了城 |
| `townBuildings` | 5 | 上 Town 需要的非农田建筑栋数（手册口径） | 只影响"为凑栋数盖房"的触发 |
| `buildersPerSite` | 1 | 每栋建筑派几个builder（教程要求一栋一个） | 2 人以上会把人钉在工地上，木头收入先崩 |
| `maxSites` | 2 | 同时最多开几个工地（只算真的有人在建的那些） | 开四块等于四块都建不完；调太小会把建造排成长队 |
| `siteStall` | 9 | 地基血量多少秒没涨就判定没人在建，重新派人续建 | 太小 → 反复重派；太大 → 人被抽走后工地长期停摆 |
| `badSpotTtl` | 25 | 被引擎否过的地基格子多久之内不再探测 | 太长 → 树砍了也不会利用新空地 |
| `placeBudget` | 22 | 一拍最多做几次引擎地基校验（`SetBuildingPlacementPreview` 走 C++） | 调高会拖慢主线程 |

`minerFloor / minerShare / woodFloorShare / woodEmergency / squeezeEta` 都在经济搜索空间里
（`node superbrain/app/lib/presets.mjs` 的 `econSpace()`），`train start target=econ` 只撒经济参数。

**劳力需求人头是个预算，不是愿望清单**：`wantGatherers` 的总和被硬性压到 ≤ 农民数
（超出时按"矿 → 木 → 粮"的顺序收回）。过去底线是**叠加**在份额上的，12 个农民时算出
"要 23 个人"，调度永远追不上目标、每一拍都在重排同一批人，实测 540~820 秒粮木收入双 0。

**builder 从下令那一拍起就锁在工地上**（`keepSites`，见 `econ.builders`/`econ.buildSites`），
地基出现后用 `repair` 命令续建 —— 引擎里点已有地基就是这个命令。不锁的话采集调度每十几秒
把人抽走，实测三块田分别停在 61/250、91/250、36/250，20 分钟一栋没盖完。

判断这些键有没有生效，看帧里的 `econ.wantGatherers` 与 `econ.gatherers`，
再看 `econ.untracked`（见 `data.md`）——**untracked 很大而石金仍然 0 人**就是调度没接住，
不是权重错。

## 打击对象 `target` / `focusPlayer`

只改**优先级**：集火打分时该玩家的单位 ×1.8，推进目标（`pressTarget`）优先朝可见的该玩家走。
不会把别家从威胁判定里删掉 —— 移出去等于放任另一家屠村。`0` = 恢复自动。

## 其余常用阈值

- `maxOpsPerTick`（默认 14）：一拍最多发多少条军事命令。调高会撞网络命令队列，收益递减。
- `passEvery`（1.1s）/ `maxOps`（8）：经济副驾的节奏，不需要高频。
- `deadRetry`（150s，上限 900s）：被拒命令的指数退避。**引擎的拒绝原因读不到**，
  没有这个退避就会出现"连吃三次拒绝就把农民训练永久关掉"的事故。
- `verifyGrace` / `queueGrace`：新实体的 id 要等 id 扫描走到才看得见，判"命令没生效"不能太急。
- `mineStockCap` / `maxMineWorkers`：石/金囤够了就把矿工压到 8 人以内，多余的人还给粮木。

## 训练模式的搜索空间

`searchSpace()` 列出会被随机化的键（微操 10 个、经济 7 个），只有这里的键允许被自动改。
`mode:"hill"` 围绕当前最优做 ±18% 抖动并夹回边界。评分（`scoreOf`）：
`胜 +1200`，再加 `仿真秒×0.3 + 人口×4 + 农民×1.5 + (击杀-阵亡)×1.2 + 掉血比×20 − 被拒命令×2`。
被拒命令扣分是故意的：参数抖到跟引擎打架，一定会体现在拒绝数上。

### `target=econ`：只搜经济参数，评分只看节奏

参数来自 `econSpace()`（撒出来的包里没有 micro），评分换成 `econScoreOf`，**只按里程碑算**：

- 加分：300/600/900/1200 秒的人口、600/900 秒的农民数、上 Town/City 的时刻（900/1800 秒为满额线）、
  报价凑齐时刻（粮/木 500、石/金 1000）、矿工峰值、田数。
- 扣分：闲汉峰值、被拒命令数、断供告警条数。

终局人口与兵力**故意不进经济分**。实测同一套经济参数能跑出"10 分钟人口 47、终局人口 2"
—— 军队被打崩后村民被屠，那是 #14（兵力规模）的账；把它记到经济参数上，搜索会去优化"别死"
而不是"发展快"。排行榜的经济标尺因此长这样：

```
人口@10分47 农38 Town@未 City@未 报价 粮6分20秒 木8分05秒 石12分30秒 金未 矿工7/2 田2 房6 闲0
```
