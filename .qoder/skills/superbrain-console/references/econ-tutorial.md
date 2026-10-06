# 运营节奏依据（教程 → 经济权重）

副驾的经济参数不是拍脑袋，也不是从对局里瞎搜出来的：先按教程定的"应然节奏"立默认值与硬底线，
再用 `target=econ` 的训练去搜。这一页记录每个数从哪来、落到哪个键。

## 官方手册（play0ad.com Game Manual）

| 事实 | 落到的参数 |
|---|---|
| 采集者自动往返**最近的、能收这种资源的**仓库点；把仓库贴资源点建能省大量路程 | `dropsite` 选择、`maybeFarms` 把田锚在能收食物的 dropsite 上（`nodeRadius`/`assignRadius` 决定人多远还算"在点上是活"） |
| **Village→Town**：500 粮 + 500 木，另需 **5 栋任意建筑**（农田与栅栏不算） | `townBuildings: 5`（不足就一直补最便宜的可计栋建筑 = 房）；`techShare` 决定为它留多少钱 |
| **Town→City**：1000 石 + 1000 金，另需 4 栋 Town 级建筑 | `mineStockCap: 1400`（囤货上限必须高于上城报价，否则半路撤矿工）、`minerFloor`、`maxMineWorkers` |
| 阶段科技在 Civic Centre 研究；科技本身不是上阶段的必要条件，但**建筑栋数**是 | `techs()` 里阶段科技优先（`scoreTech` 给 `phase_*` 100 分），并走 `techRequirementsMet` |

## 社区运营教程（Wildfire Games 策略贴）

| 建议 | 落到的参数 |
|---|---|
| Town 目标 **8–10 分钟** | `econ_pacing.mjs` 与 `econ_test.mjs` 的 600s 断言就是这条 |
| 起始聚落周围 **8 块农田** | `farmTarget: 8` |
| **每栋建筑只派 1 个builder**（多派的人同时就不采集了） | `buildersPerSite: 1` |
| 前期 5 个兵左右帮忙盖东西，之后转远程 | `armyPopShare` / `militaryTarget` 与兵种配比 `g_SuperbrainShares` |
| 房子绕经济区分一圈，顺手当防御 | `popHeadroom` 与 `capacity()` 的盖房触发条件 |
| 第二座主城约 12 分钟（风险：兵力没跟上会被趁虚） | `popCap >= 60` 才考虑新城 + 军事侧 `homeGuard` |

## 我们自己的实测约束（比教程更重要，因为它证明过失败）

- **引擎不给"谁在采什么"，编出来的数字会把缺口藏掉**：`resourceGatherers` 只算当下挂在点上的那个人，
  采集是"点↔仓库"往返，所以 39 个农民里只有 4 个能按位置定位。旧代码把剩下 35 人**按引擎总数平摊给四种资源**，
  于是账面"石/金各有 6 人在采"，缺口永远算不出来 → 石金整局 0 收入。
  → 现在的账本只认两条证据：脚下就是采集点（位置），或副驾自己下过 gather 令（`econ.mem.role`）；
  两条都没有的人记进 `econ.untracked`，绝不摊给没有任何证据的资源。
- **石/金整局 0 收入**（另一半原因）：份额算出来的缺口长期只有 1.x 人，过不了 `pullMin` 的抖动门槛 → 三局实盘全中，
  于是 City 的 1000+1000 永远凑不齐。→ `minerFloor` + "某资源 0 人却有矿点"走紧急抽调（绕过 `pullMin`）。
- **木头断档**：纯按"囤货缺口"派人时 `want.wood` 掉到 0.5、实际 0 人，16 分钟只盖出 2 间房、人口卡死 30。
  → `woodFloorShare`：农民没起满之前伐木至少留这个比例。
- **想盖房却只差木头**：份额加出来的缺口永远追不上一栋房的价格，木头库存整段贴着 0。
  → `woodEmergency`：`build()` 记下"盖不起的那笔报价"，只差木头时把这么多人手压到伐木上。
- **会赚不会攒 = 上不了时代**：手册的 Town 报价是 500 粮 + 500 木 + 5 栋，但木头一到 100 就被一间房花光，
  11 分钟才凑齐。→ `squeezeEta`：按**毛收入**（净变化 + 这段时间花掉的）算出"多久能攒够报价"，
  攒得够快就暂停盖房/开田。注意只能用毛收入 —— 净库存差分在边采边花的资源上恒等于 0。
- **负结果：上城前把农民卡在 24 人更慢**。教程确实写"Village 阶段 20~25 人就该上城"，
  但实测按它给农民数量封顶后，收入被削掉，上城反而从 645s 退到 712s（离线模拟，固定种子）。
  这条口径更适合人（操作上限），不适合一个能同时管 60 人的副驾 → 只保留"报价优先"的 `squeezeEta`。
- **科技被最贵那一项堵死**：`pickTech` 只取最高分项，买不起 City 时把一整排便宜科技一起跳过（实测 900 秒只研究 1 项）。
  → 改为"按分数找**买得起**的最高分项"。
- **每拍只买一项，但要跨建筑比高低**：过去扫到第一个能买的建筑就下单，而时代科技挂在主城，
  实体顺序里兵营/仓库经常在前，便宜的科技每拍抢走研究位 → 现在先全表比较再下唯一一条 research。
- 离线节奏测试必须固定种子：随机地图下上城时刻在 557s/606s 之间跳，带 deadline 的断言就变成抛硬币。

- **负结果：先开田再盖房更慢**。教程口径"8 块田围着起始聚落"看着比"10 个人口格子"值，
  但一块田 100 木，实测把木头抽干：房子/生产建筑/科技全卡住，`pop@300` 从 19 掉到 14、
  上城从 645 秒（旧乐观模拟）→714 秒（诚实模拟）→884 秒。顺序保持"房 → 主城 → 田"。
- **负结果：把开田门槛从"收入转正 + 库存 >3×minReserve"放宽成"库存 ≥ minReserve"也退步**
  （上城 714s → 858s）。早期木头太薄，田抢走了房子的木头。想提前开田得先解决木头总量，
  而不是改触发条件。
- **工地会被人抽走（比落点问题更致命）**：引擎不会替我们留住builder。实测三块田的地基
  分别建到 61/250、91/250、36/250 之后血量再没动过，20 分钟一栋没盖完 —— 采集调度每十几秒
  把人抽回去。修复是 `keepSites`：从下令那一拍起锁人（`econ.builders`），地基出现后用
  `repair` 续建（引擎里点已有地基就是这个命令，`unit_actions.js` 的 repair + `action.foundation`），
  并且同时限制开工数（`maxSites`，"一栋盖完再开下一栋"）。
- **落点半径的隐藏代价**：每栋建筑都要求落在自己领地内（`template_structure.xml` 的
  `BuildRestrictions/Territory=own`）。旧螺旋第一环 = 田半径 + 主城半径 + 4 米人为间隙，
  正好把整圈候选推到领地外，实测一整局只盖出 2 块田。现在从 `半径+锚点占地+1` 起步、
  按 `0.6×半径` 步进，并记住被否过的格子（`badSpotTtl`）。
- **引擎的拒绝理由一直都有，只是被我们丢了**：`SetBuildingPlacementPreview` 返回
  `{success, message}`（`gui/session/input.js` 就是拿它画红框提示的）。现在 `placeOk`
  通过返回 `true`、否则返回理由文字，统计进 `econ.placeFails` 导出。
- **需求人头必须 ≤ 人手**：底线过去是**叠加**在份额之上的，12 个农民时算出"要 23 人"，
  调度永远追不上目标 → 每一拍重排同一批人 → 实测 540~820 秒粮木收入双 0。
  现在超出预算时按"矿 → 木 → 粮"收回，吃饭的人最后才动。
- **科技名带文明后缀**：实测 Kush 的面板报 `phase_town_generic`。任何 `phase_town` 精确匹配
  都会把已上城的局读成村阶段（标尺里 Town/City 全是"未"就是这么来的）。
  `phaseOf()`/`hasTech()` 改前缀匹配；`fundPhase` 也改成"只看报价、不管能不能研究"，
  否则栋数没满时报价恒为 null，攒专款整局不触发。

## 复现/验证

```
node superbrain/tools/econ_test.mjs                    # 离线：固定种子下的节奏断言（报价凑齐/下单延迟/矿工转正/能上 City）
node superbrain/tools/econ_pacing.mjs <run目录|all>    # 实盘复盘：阶段时刻、库存、劳力分配、卡口
node .qoder/skills/superbrain-console/scripts/sb.mjs train start trials=4 target=econ mode=random budgetSim=1500
```

实盘验收口径（离线模拟的收入模型比真机慷慨，所以最终以真机为准）：
`首达 500 库存` 必须出现 stone/metal（改之前是"无"），`econ.gatherers.stone/metal` 在 5 分钟内转正，
`untracked` 不长期贴着农民总数。

## 来源

- [Game Manual — 8. Technologies and Phases](https://play0ad.com/8-technologies-and-phases/)
- [Game Manual — 3. Gathering Resources](https://play0ad.com/3-gathering-resources/)
- [Game Manual 目录](https://play0ad.com/category/game-manual/)
- [0 AD Strategy Discussion（社区节奏：Town 8–10 分钟、8 块田、一栋一个builder）](https://wildfiregames.com/forum/topic/19433-0-ad-strategy-discussion/)
- [0 A.D. Strategy Guide 讨论帖](https://wildfiregames.com/forum/topic/19463-0-ad-strategy-guide/page/2/)
