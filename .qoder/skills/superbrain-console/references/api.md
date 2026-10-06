# REST / SSE 接口

服务默认只绑 `127.0.0.1:8712`（握着 LLM 密钥与游戏操控权，不暴露到局域网）。
除 GET 外全部要 `content-type: application/json`。失败统一返回 `{"ok":false,"error":"中文原因"}`。

优先用 `scripts/sb.mjs`，它已经把下面这些包好并且输出更省 token。需要自己发请求时才查这份表。

## 读

| 接口 | 返回 |
|---|---|
| `GET /api/health` | `{ok, version, node, uptimeSec}` —— 判断后端在不在 |
| `GET /api/state` | `{status, view, params, microCfg, aggression, llm, strategist, trainer, events}`，一个接口拿到全部现状 |
| `GET /api/situation` | `{text, headline}` —— 规则版中文态势简报，不经模型 |
| `GET /api/intents` | `{intents[], postures, economies, doctrines, count}` —— UI 表单与模型工具表同源 |
| `GET /api/catalog?q=&civ=` | `{stats, units[], structures[]}` —— 本局真实出现过的模板与成本 |
| `GET /api/runs` | `{runs[{dir,name,frames,mtime}], pinned, current}` |
| `GET /api/train` | `{running, job, log[], leaderboard{entries[]}, best, space}` |
| `GET /api/strategist` | `{running, rounds, errors, intervalSec, maxOrders, lastOrders[]}` |
| `GET /api/config` | 配置（`llm.apiKey` 恒为空，只给 `hasKey` 与 `keyHint` 指纹） |
| `GET /api/chat/log` | 最近 60 条对话 |
| `GET /api/events` | SSE：`hello`（整份 snapshot）→ `state`（新帧视图）→ `event`（日志条目） |

`view` 字段语义见 `data.md`。

## 写

| 接口 | 请求体 | 说明 |
|---|---|---|
| `POST /api/takeover` | `{all:true}` 或 `{military:bool}` / `{economy:bool}` | 四个按钮走的就是这里 |
| `POST /api/knobs` | `{aggression:0..1, posture:"defend\|balanced\|attack", economy:"boom\|balanced\|war", target:玩家id, doctrine:...}` | 高级旋钮；显式 `aggression` 会盖掉姿态里的隐含值 |
| `POST /api/params` | `{micro:{...}, econ:{...}, doctrine:"..."}` | 直接改阈值，键名受白名单约束 |
| `POST /api/intent` | `{name:"attack-move", args:{targets:"army", to:"foe"}}` | 单条逻辑指令 → `{ok, notes[], commands[], sent{seq,count}}` |
| `POST /api/intents` | `{intents:[{name,args},…]}`（≤12 条） | 批量，一次写进同一个 cmd 包 |
| `POST /api/chat` | `{text, history[]}` | 自然语言 → `{say, engine, intents[], sent}` |
| `POST /api/brief/ai` | `{focus?}` | 让模型润色简报；没配模型时直接返回规则版 |
| `POST /api/strategist` | `{action:"start"}` / `{action:"stop", reason?}` | 大模型接管模式 |
| `POST /api/train` | `{trials, budgetSim, speed, mode:"random\|hill", aiDiff, map, force?}` 或 `{action:"stop\|apply-best\|clear"}` | 训练模式；`force` 用来跳过"已有对局在跑"的检查 |
| `POST /api/config` | `{patch:{...}}` | 局部深合并；`llm.apiKey:""` 表示不改，不会误清密钥 |
| `POST /api/llm/test` | `{}` | 连通性测试，返回 `{ok, ms, model, reply}` 或 `{ok:false, error}` |
| `POST /api/reconnect` | `{dir?}` | 跟到新开的一局；带 `dir` 就等于手动指定 |
| `POST /api/runs/pin` | `{dir:""}` 取消指定 | |
| `POST /api/runs/prune` | `{keep:24}` | 清理陈旧 run 目录 |
| `POST /api/game/start` | `{confirm:true, map?, players?, ourCiv?, foeCiv?, aiDiff?}` | 拉起一局可视 autostart |

## 下发链路的时间尺度

`POST` 返回的 `sent.seq` 只代表**文件已写入**，不代表游戏执行过。真正确认要看下一帧的
`view.applied.cmdSeq >= seq`，以及 `view.diag.errors` 没有新增。桥接层每包最多处理 60 条命令，
超 120 个实体的 `entities` 会被控制台自动分批。
