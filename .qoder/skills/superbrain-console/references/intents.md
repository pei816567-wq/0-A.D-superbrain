共 41 条逻辑指令。参数里的坐标一律接受 `home` / `foe` / `x,z` / `{"x":n,"z":n}`，单位一律用选择器（`army` / `all` / `workers` / `idle` / `wounded` / `bunkered` / `structures` / `cc` / `group:gN`）。

### 战术

| 指令 | 作用 | 参数（* 为必填） |
|---|---|---|
| `move` | 移动 — 选中单位走到目标点，途中不打架 | `targets`(选择器: 默认 "army")<br>`to`(point)<br>`formation`(string) |
| `attack-move` | 攻击移动 — 一边向目标点推进一边打沿途敌人（等价于玩家右键按住拖） | `targets`(选择器: 默认 "army")<br>`to`(point) |
| `attack` | 集火 — 全军点杀指定敌人 | `targets`(选择器: 默认 "army")<br>`target`(target: 默认 "nearest") |
| `stop` | 停止 — 立刻停手，清队列 | `targets`(选择器: 默认 "army") |
| `patrol` | 巡逻 — 在目标点一带来回巡防 | `targets`(选择器: 默认 "army")<br>`to`(point) |
| `guard` | 护卫 — 跟着某支部队/建筑走 | `targets`(选择器: 默认 "army")<br>`target`(target) |
| `unguard` | 解除护卫 — 结束跟随关系 | `targets`(选择器: 默认 "army") |
| `garrison` | 进驻 — 把单位关进建筑（村民被关后不产资源，慎用） | `targets`(选择器: 默认 "army")<br>`target`(target) |
| `unload` | 撤出驻军 — 从建筑里放出单位（默认放所有关着的人） | `holder`(id) |
| `heal` | 治疗 — 让医生治疗指定单位/建筑 | `targets`(选择器: 默认 "workers")<br>`target`(target: 默认 "nearest") |
| `repair` | 修理 — 修指定建筑/单位 | `targets`(选择器: 默认 "idle")<br>`target`(target) |
| `promote` | 晋升 — Veteran 单位晋升经验加成 | `targets`(选择器: 默认 "army") |
| `set-formation` | 变阵 — 全线换阵形 | `targets`(选择器: 默认 "army")<br>`name`(enum: special / box / column / line / wedge) |
| `set-stance` | 战斗姿态 — aggressive 主动出击 / defensive 还手 / standground 不动 / noattack 挨打不还手 | `targets`(选择器: 默认 "army")<br>`name`(enum: aggressive / defensive / standground / noattack) |

### 生产 / 经济

| 指令 | 作用 | 参数（* 为必填） |
|---|---|---|
| `gather` | 采集 — 派村民去采集某个资源点 | `targets`(选择器: 默认 "workers")<br>`target`(id) |
| `return-resources` | 交资源 — 把手上的资源送进仓库/主城 | `targets`(选择器: 默认 "workers")<br>`target`(target) |
| `back-to-work` | 回去干活 — 打断当前动作，回工作岗位 | `targets`(选择器: 默认 "workers") |
| `train` | 训练单位 — 在某个生产建筑里训练单位 | `entity`(id)<br>`template`(template)<br>`count`(int: 默认 5) |
| `build` | 建造 — 派村民在某点建造建筑 | `targets`(选择器: 默认 "idle")<br>`template`(template)<br>`to`(point) |
| `research` | 研究科技 — 在主城/兵营研究科技或升级 | `entity`(id)<br>`template`(template) |
| `upgrade` | 单位升级 — 把场上单位升级为高级兵种 | `targets`(选择器: 默认 "army")<br>`template`(template) |
| `autoqueue` | 自动续队列 — 打开/关闭建筑的 autoqueue（按人口上限挂机补单位） | `entity`(id)<br>`on`(bool: 默认 true) |
| `stop-production` | 取消生产 — 撤掉队列里的一项 | `entity`(id)<br>`id`(int) |

### 接管与控制

| 指令 | 作用 | 参数（* 为必填） |
|---|---|---|
| `set-military-takeover` | 军事接管 — 开/关军事副驾（关掉就是把军队交还玩家手操） | `on`(bool) * |
| `set-economy-takeover` | 经济接管 — 开/关经济副驾 | `on`(bool) * |
| `take-over-all` | 全部接管 — 军事 + 经济同时接管 | — |
| `release-all` | 全部取消 — 军事 + 经济全部交还玩家 | — |
| `set-doctrine` | 打法 — field | hold | push | harass | retreat：field 会战 / hold 守家 / push 压进 / harass 骚扰 / retreat 撤退 | `name`(enum: field / hold / push / harass / retreat) |
| `set-objective` | 战略目标点 — 告诉内核往哪推（省略坐标=清除） | `to`(point) |
| `set-rally-point` | 集结点 — 新生产单位自动去哪里（省略=清除手动集结点） | `to`(point) |
| `set-micro-param` | 微操参数 — 直接改内核阈值：resistBase/engageRadius/maxChase/standoff/kiteStep/retreatHp/maxGroups/… | `patch`(patch) * |
| `set-econ-param` | 经济参数 — 直接改经济副驾阈值：villagerCap/armyShare/minReserve/buildPace/techShare/farmTarget/… | `patch`(patch) * |
| `set-speed` | 仿真速度 — 引擎速度倍率（训练/实验台用，1~8） | `value`(number) * |

### 战略旋钮

| 指令 | 作用 | 参数（* 为必填） |
|---|---|---|
| `set-aggression` | 攻击欲望 — 0=绝不打，1=见人就上。内部展开成一整套交战阈值 | `value`(number) * |
| `set-posture` | 攻防模式 — defend 守家 | balanced 均势 | attack 全力进攻；一次改完打法+交战阈值+经济倾斜 | `name`(enum: defend / balanced / attack) |
| `set-economy-mode` | 经济模式 — boom 憋经济 | balanced 均衡 | war 极限暴兵；决定农民数、兵役份额与 reserve | `name`(enum: boom / balanced / war) |
| `set-war-target` | 打击对象 — 指定优先打击的玩家 id（0=按敌对关系自动） | `player`(int) * |

### 组合宏

| 指令 | 作用 | 参数（* 为必填） |
|---|---|---|
| `defend-home` | 回防 — 全军撤回主城并切守护姿态（屠村救援一键） | — |
| `retreat-all` | 全军撤退 — 脱离接触，向主城/集结点收缩 | `to`(point) |
| `push-foe` | 压向敌人 — 全军攻击移动到敌军重心 | — |

### 实验台

| 指令 | 作用 | 参数（* 为必填） |
|---|---|---|
| `cheat-units` | 实验台造兵 — 在己方主城旁直接生成 N 个单位（官方作弊码，只在单人对局生效，用来摆会战测战损比） | `count`(int) * |
