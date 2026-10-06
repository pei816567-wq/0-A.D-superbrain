"""Superbrain sidecar (M2).

微操跑在游戏内 JS 内核里（往返 300ms 的进程外通道做不了逐单位微操）。
这个进程负责三件事：
  1. 下发意图与参数：接管开关、教条、内核参数包、目标点；
  2. 遥测：状态年龄、内核判定、实测战损比、端到端 RTT；
  3. 兜底宏：没有可见敌人时把全军推向敌方重心（内核负责接触后的一切）。

用法:
    python superbraind.py                        # 遥测面板（默认）
    python superbraind.py --takeover off         # 交还军队操控权（经济继续托管）
    python superbraind.py --econ off             # 交还经济运营
    python superbraind.py --doctrine harass      # 换打法
    python superbraind.py --config standoff=0.7,kiteStep=14
    python superbraind.py --econ-config villagerCap=70,armyShare=0.65
    python superbraind.py --params pack.json     # 持续下发参数包（M4 自学习接口）
    python superbraind.py --advance              # 无接触时自动压向敌人
    python superbraind.py --probe                # 打印模板/实体真实字段结构
"""

import argparse
import glob
import json
import os
import re
import statistics
import sys
import time

MILITARY_HINTS = ("infantry", "cavalry", "archer", "spear", "sword", "pikeman", "camels",
                  "chariot", "hero", "warship", "trireme", "bireme", "siege", "catapult",
                  "ballista", "ram", "tower", "monreme", "dromon")
NON_MILITARY_HINTS = ("worker", "villager", "merchant", "fishing", "support", "trade",
                      "corral", "berry", "farm")

MAX_UNITS_PER_OP = 120
ADVANCE_INTERVAL = 6.0
DOCTRINES = ("field", "hold", "push", "harass", "retreat")


def ipc_candidates():
    roots = [
        os.path.join(os.path.expanduser("~"), "Documents", "My Games", "0ad"),  # path_user，实测落点
        os.path.expandvars(r"%APPDATA%\0ad"),
        os.path.expandvars(r"%LOCALAPPDATA%\0ad"),
    ]
    out = []
    for root in roots:
        out.append(os.path.join(root, "saves", "campaigns", "superbrain"))
        out.append(os.path.join(root, "mods", "user", "moddata", "superbrain"))
        out.append(os.path.join(root, "moddata", "superbrain"))
    return out


def newest_run(base):
    """每个对局实例写自己的 run-xxxx/ 子目录，取最近活动的那个。"""
    try:
        subs = [os.path.join(base, name) for name in os.listdir(base) if name.startswith("run-")]
    except OSError:
        return None

    live = [p for p in subs if os.path.isdir(p) and glob.glob(os.path.join(p, "state-*.json"))]
    if not live:
        return None
    return max(live, key=os.path.getmtime)


def find_ipc_dir(override=None):
    if override:
        return override if os.path.isdir(override) else None

    for base in ipc_candidates():
        if not os.path.isdir(base):
            continue
        run = newest_run(base)
        if run:
            return run
        if glob.glob(os.path.join(base, "state-*.json")):
            return base
    return None


def seq_of(path):
    m = re.search(r"-(\d+)\.json$", path)
    return int(m.group(1)) if m else -1


def newest(directory, prefix):
    paths = glob.glob(os.path.join(directory, prefix + "-*.json"))
    if not paths:
        return None, -1
    best = max(paths, key=seq_of)
    return best, seq_of(best)


def load(path):
    if not path:
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None  # 半写入或正在改名，下一帧再读


def prune(directory, prefix, keep=2):
    paths = sorted(glob.glob(os.path.join(directory, prefix + "-*.json")), key=seq_of)
    for old in paths[:-keep] if keep > 0 else paths:
        try:
            os.remove(old)
        except OSError:
            pass


def is_military(template):
    low = template.lower()
    if "structures/" in low or any(h in low for h in NON_MILITARY_HINTS):
        return False
    return any(h in low for h in MILITARY_HINTS)


def rows(state):
    fields = state.get("fields", [])
    for row in state.get("entities", []):
        yield dict(zip(fields, row))


def centroid(points):
    if not points:
        return None
    return (sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points))


def dist(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


class Intents:
    """只发意图，不碰逐单位微操。"""

    def __init__(self, opts):
        self.opts = opts
        self.cmd_seq = 0
        self.advance_wall = 0.0
        self.pending = []      # 一次性指令队列
        self.pack_stamp = None

    def queue(self, commands):
        self.pending.extend(commands)

    def load_pack(self, path):
        """参数包文件变了就整体下发一次 —— M4 的搜索循环就挂在这个接口上。"""
        if not path or not os.path.exists(path):
            return
        stamp = os.path.getmtime(path)
        if stamp == self.pack_stamp:
            return
        self.pack_stamp = stamp
        try:
            with open(path, "r", encoding="utf-8") as handle:
                pack = json.load(handle)
        except (OSError, ValueError) as exc:
            print("参数包读取失败:", exc)
            return

        # 一份参数包同时喂两块：写成 {"micro":{...},"econ":{...}}，
        # 裸写则全部按微操参数处理（老写法继续可用）
        commands = []
        for name, op in (("micro", "config"), ("econ", "econ-config")):
            patch = pack.get(name)
            if isinstance(patch, dict) and patch:
                commands.append({"op": op, "patch": patch})
        if not commands:
            commands = [{"op": "config", "patch": pack}]
        self.queue(commands)
        print("已下发参数包", path, json.dumps(pack, ensure_ascii=False)[:200])

    def decide(self, state):
        commands, self.pending = self.pending, []

        if not self.opts.advance:
            return commands

        mine = [e for e in rows(state) if e.get("seen") == 3 and is_military(str(e.get("template", "")))]
        foes = [e for e in rows(state) if e.get("seen") == 2 and e.get("enemy") and
                is_military(str(e.get("template", "")))]
        if not mine:
            return commands

        my_center = centroid([(e["x"], e["z"]) for e in mine])
        contact = any(dist((f["x"], f["z"]), my_center) < 90 for f in foes) if foes else False

        if not contact and time.time() - self.advance_wall > ADVANCE_INTERVAL:
            goal = centroid([(f["x"], f["z"]) for f in foes]) if foes else None
            if goal:
                self.advance_wall = time.time()
                ids = [e["id"] for e in mine]
                for i in range(0, len(ids), MAX_UNITS_PER_OP):
                    commands.append({"op": "attack-walk", "entities": ids[i:i + MAX_UNITS_PER_OP],
                                     "x": round(goal[0], 1), "z": round(goal[1], 1)})
        return commands


class Telemetry:
    def __init__(self):
        self.rtts = []
        self.sent = {}

    def note_send(self, seq, wall):
        self.sent[seq] = wall

    def note_state(self, state, seq):
        applied = state.get("applied") or {}
        cmd_seq = applied.get("cmdSeq")
        if cmd_seq in self.sent:
            self.rtts.append(time.time() * 1000 - self.sent.pop(cmd_seq))
            self.rtts = self.rtts[-50:]

    def median_rtt(self):
        return statistics.median(self.rtts) if self.rtts else -1


def hud(state, telemetry, brain):
    ents = list(rows(state))
    own = [e for e in ents if e.get("seen") == 3]
    foes = [e for e in ents if e.get("seen") == 2 and e.get("enemy")]
    last = [e for e in ents if e.get("seen") == 1 and e.get("enemy")]
    own_mil = [e for e in own if is_military(str(e.get("template", "")))]
    combat = state.get("combat") or {}
    kernel = state.get("kernel") or {}
    fight = kernel.get("fight") or {}

    age = time.time() * 1000 - state.get("wall", 0)
    print("seq=%d 年龄=%.0fms 我方%d(兵%d) 可见敌%d 过期敌%d | 接管=%s 下令=%s 拒=%s | 判定=%s 交换=%.2f 射程系数=%.2f" % (
        state.get("seq", -1), age, len(own), len(own_mil), len(foes), len(last),
        state.get("autopilot"), kernel.get("issued"), kernel.get("rejected"),
        ("打" if fight.get("fight") else "撤") if fight else "-",
        fight.get("exchange", 0), fight.get("rangeEdge", 1)))

    for g in (kernel.get("groups") or [])[:6]:
        print("    组 %-9s %-7s %-8s n=%-3d 距=%-4s 射程=%-4s 姿态=%-4s 到位=%-8s 残血=%d" % (
            g.get("key"), g.get("role"), g.get("task"), g.get("n", 0), g.get("d"),
            g.get("range"), g.get("action"),
            ("%.0f,%.0f" % tuple(g["dest"])) if g.get("dest") else "-",
            g.get("wounded", 0)))

    econ = state.get("econ") or {}
    if econ:
        want = econ.get("wantGatherers") or {}
        have = econ.get("gatherers") or {}
        print("    经济 人口%s/%s 农民%s(目标%s 闲%s) 兵%s | 上限%s 房%s 田%s 产兵建筑%s | 下令%s | 收入/秒 %s" % (
            econ.get("pop"), econ.get("popCap"), econ.get("villagers"), econ.get("wantVillagers"),
            econ.get("idle"), econ.get("soldiers"), econ.get("popCap"), econ.get("houses"),
            econ.get("fields"), econ.get("producers"), econ.get("issued"),
            " ".join("%s=%s" % (k, v) for k, v in sorted((econ.get("income") or {}).items()))))
        if want:
            print("    劳力 实际 %s / 应有 %s" % (
                " ".join("%s=%s" % (k, v) for k, v in sorted(have.items())),
                " ".join("%s=%.1f" % (k, v) for k, v in sorted(want.items()))))

    print("    战损 我方掉血=%s 敌方掉血=%s 交换比=%s 我方阵亡=%s 击杀=%s | RTT中位=%.0fms | 待下发=%d" % (
        round(combat.get("ourHpLost", 0)), round(combat.get("foeHpLost", 0)),
        combat.get("ratio"), combat.get("ourLosses"), combat.get("foeKills"),
        telemetry.median_rtt(), len(brain.pending)))
    sys.stdout.flush()


def write_cmd(directory, seq, commands):
    path = os.path.join(directory, "cmd-%06d.json" % seq)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump({"seq": seq, "wall": int(time.time() * 1000), "commands": commands}, handle)
    os.replace(tmp, path)


def prune_commands(directory, up_to):
    """桥接层没有删除权限，已执行的 cmd 文件由这边回收。"""
    for path in glob.glob(os.path.join(directory, "cmd-*.json")):
        if seq_of(path) <= up_to:
            try:
                os.remove(path)
            except OSError:
                pass


def parse_config(pairs):
    patch = {}
    for pair in pairs or []:
        if "=" not in pair:
            continue
        key, value = pair.split("=", 1)
        try:
            patch[key.strip()] = json.loads(value)
        except ValueError:
            patch[key.strip()] = value
    return patch


def own_centre(state):
    """己方主城 id（作弊码要一个落点）。"""
    if not state:
        return None
    for e in rows(state):
        if e.get("seen") == 3 and "civil_centre" in str(e.get("template", "")):
            return e["id"]
    for e in rows(state):
        if e.get("seen") == 3 and str(e.get("template", "")).startswith("structures/"):
            return e["id"]
    return None


def build_initial_queue(opts, state=None):
    queue = []
    if opts.takeover is not None:
        queue.append({"op": "takeover", "on": opts.takeover == "on"})
    if opts.econ is not None:
        queue.append({"op": "econ", "on": opts.econ == "on"})
    if opts.doctrine:
        if opts.doctrine not in DOCTRINES:
            print("教条只能是", DOCTRINES)
            sys.exit(2)
        queue.append({"op": "doctrine", "name": opts.doctrine})
    patch = parse_config(opts.config)
    if patch:
        queue.append({"op": "config", "patch": patch})
    econ_patch = parse_config(opts.econ_config)
    if econ_patch:
        queue.append({"op": "econ-config", "patch": econ_patch})
    if opts.speed:
        queue.append({"op": "speed", "value": opts.speed})
    if opts.objective:
        parts = opts.objective.split(",")
        if len(parts) == 2:
            queue.append({"op": "objective", "x": float(parts[0]), "z": float(parts[1])})
    if opts.army:
        civ = "kush"
        if state:
            me = state.get("me")
            civ = (state.get("players") or {}).get(str(me), {}).get("civ") or civ
        spot = own_centre(state)
        if not spot:
            print("找不到己方主城，--army 需要已经进图的对局")
        else:
            queue.append({
                "op": "cheat", "action": "createunits", "parameter": opts.army,
                "entities": [spot],
                "templates": ["units/%s/infantry_archer_b" % civ,
                              "units/%s/infantry_spearman_b" % civ,
                              "units/%s/cavalry_javelineer_b" % civ]
            })
    return queue


def probe(static):
    if not static:
        print("还没有 static-*.json —— 先开一局让桥接 mod 导出模板数据")
        return

    print("availableFormations:", static.get("availableFormations"))
    print("availableStances:", static.get("availableStances"))
    templates = static.get("templates", {})
    print("模板数量:", len(templates))
    for name in list(templates)[:3]:
        print("\n###", name)
        data = templates[name]
        if isinstance(data, dict):
            for key, value in data.items():
                print("  %s: %s" % (key, json.dumps(value, ensure_ascii=False)[:160]))
    samples = static.get("samples", {})
    for name in list(samples)[:2]:
        print("\n### 实体状态样本", name)
        print(json.dumps(samples[name], ensure_ascii=False, indent=2)[:1200])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", help="IPC 目录覆盖")
    parser.add_argument("--hz", type=float, default=20.0)
    parser.add_argument("--no-watch", action="store_true", help="只下发一次性指令后退出")
    parser.add_argument("--advance", action="store_true", help="无接触时把全军推向敌人")
    parser.add_argument("--takeover", choices=("on", "off"), help="接管/交还军队")
    parser.add_argument("--econ", choices=("on", "off"), help="接管/交还经济运营")
    parser.add_argument("--speed", type=float, help="改仿真速度（引擎速度按钮那条路，批量对局用）")
    parser.add_argument("--doctrine", help=" ".join(DOCTRINES))
    parser.add_argument("--config", action="append", metavar="K=V", help="微操内核参数，可重复")
    parser.add_argument("--econ-config", action="append", metavar="K=V", help="经济副驾参数，可重复")
    parser.add_argument("--params", help="参数包 JSON 文件，改动即下发（微操/经济两块自动分流）")
    parser.add_argument("--army", type=int, help="实验台：在己方主城旁造这么多兵（走引擎官方作弊码）")
    parser.add_argument("--objective", help="目标点 x,z")
    parser.add_argument("--keep", type=int, default=2, help="本地保留多少帧完整状态（回放/训练要就调大）")
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--wait", type=int, default=1200, help="等待 IPC 目录出现的最长秒数")
    opts = parser.parse_args()

    directory = None
    deadline = time.time() + opts.wait
    while time.time() < deadline:
        directory = find_ipc_dir(opts.dir)
        if directory:
            break
        print("等待 IPC 目录（进入对局后桥接 mod 会自动创建）……")
        sys.stdout.flush()
        time.sleep(2)

    if not directory:
        print("找不到 IPC 目录，期望其一存在:")
        for cand in ipc_candidates():
            print("  ", cand)
        print("进一局单人对局（勾选 superbrain mod）后再跑这个脚本。")
        return 2

    print("IPC 目录:", directory)

    _, static_seq = newest(directory, "static")
    static = load(os.path.join(directory, "static-%06d.json" % static_seq))
    if opts.probe:
        probe(static)
        return 0

    brain = Intents(opts)
    # 序号必须比目录里已有的都大：引擎对同名文件做 wtruncate，
    # 复用旧名会和残留读句柄撞车并直接断言崩溃
    brain.cmd_seq = max([seq_of(p) for p in glob.glob(os.path.join(directory, "cmd-*.json"))] + [0])
    brain.load_pack(opts.params)
    first = load(newest(directory, "state")[0])
    queue = build_initial_queue(opts, first)
    if queue:
        brain.cmd_seq += 1
        write_cmd(directory, brain.cmd_seq, queue)
        print("已下发:", json.dumps(queue, ensure_ascii=False)[:300])
    if opts.no_watch:
        return 0

    telemetry = Telemetry()
    last_seq = -1
    last_report = 0.0
    last_static = static_seq
    print("监听中…… Ctrl+C 退出")

    while True:
        state_path, seq = newest(directory, "state")
        state = None
        if seq != last_seq:
            state = load(state_path)
            if state:
                last_seq = seq
                prune(directory, "state", keep=max(opts.keep, 2))
                telemetry.note_state(state, seq)

                applied = (state.get("applied") or {}).get("cmdSeq")
                if applied:
                    prune_commands(directory, applied)

                if seq % 10 == 0:
                    _, cur = newest(directory, "static")
                    if cur != last_static:
                        last_static = cur
                        static = load(os.path.join(directory, "static-%06d.json" % cur))

        if state:
            brain.load_pack(opts.params)
            commands = brain.decide(state)
            if commands:
                brain.cmd_seq += 1
                write_cmd(directory, brain.cmd_seq, commands)
                telemetry.note_send(brain.cmd_seq, time.time() * 1000)

        now = time.time()
        if state and now - last_report > 1.0:
            last_report = now
            hud(state, telemetry, brain)

        time.sleep(1.0 / max(opts.hz, 1.0))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n退出")
