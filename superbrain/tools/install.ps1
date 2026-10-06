<#
安装 superbrain 副驾 mod 到 0 A.D.，并打开外部操控必需的两个开关。
写游戏目录前会先问你确认（-Apply 才真正落盘）。
#>
param(
    [string]$GameRoot = "G:\0 A.D. Empires Ascendant",
    [switch]$Apply
)

$src = Join-Path $PSScriptRoot "..\mod"
$dst = Join-Path $GameRoot "binaries\data\mods\superbrain"
$userCfg = Join-Path $env:APPDATA "0ad\config\user.cfg"

Write-Host "mod 源目录: $((Resolve-Path $src).Path)"
Write-Host "mod 目标:   $dst"
Write-Host "配置文件:   $userCfg"

$root = (Resolve-Path $src).Path
Get-ChildItem -Path $src -Recurse -File | ForEach-Object {
    Write-Host ("  将安装 " + $_.FullName.Substring($root.Length + 1) + "  (" + $_.Length + " 字节)")
}

if (-not $Apply) {
    Write-Host "`n预览模式，未做任何修改。加 -Apply 才会写入游戏目录。"
    exit 0
}

New-Item -ItemType Directory -Force -Path $dst | Out-Null
# 把目录本身当 -Path 拷进已存在的目标会变成 dst\mod\...，所以要拷目录内容
Copy-Item -Path (Join-Path $src "*") -Destination $dst -Recurse -Force

foreach ($probe in @("mod.json", "gui\session\superbrain_bridge.js", "gui\session\superbrain_kernel.js",
                     "gui\session\superbrain_economy.js", "gui\session\hotkeys\superbrain.xml",
                     "gui\hotkeys\spec\superbrain.json")) {
    if (-not (Test-Path (Join-Path $dst $probe))) { throw "安装后缺少 $probe" }
}
Write-Host "已复制 mod，关键文件校验通过。"

# 失焦暂停必须关：否则你一切到编辑器/终端，对局就停住，外部大脑等于被掐断。
# 读写一律显式按 UTF-8（无 BOM）：PowerShell 5.1 的 Get-Content 默认按本地 ANSI(GBK)
# 解码，Set-Content -Encoding UTF8 再写回去 —— 跑一次就把用户配置里的键名污染成乱码。
# 游戏随时会重写 user.cfg，边跑边改会把两份内容搅成垃圾行，所以先要求退出游戏。
if (Get-Process pyrogenesis -ErrorAction SilentlyContinue) {
    Write-Host "pyrogenesis 还在运行：它会随时重写 user.cfg。请先退出游戏再跑安装脚本。" -ForegroundColor Red
    exit 1
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
$lines = @()
if (Test-Path $userCfg) {
    Copy-Item $userCfg "$userCfg.bak" -Force
    $text = [System.IO.File]::ReadAllText($userCfg, $utf8)
    # 别用 -split "`r?`n"：那是 CR + 字面问号 + LF，切不开任何东西，
    # 整份文件会被当成一行，写回去就只剩一行配置
    $lines = @([regex]::Split($text.Replace([string][char]0xFEFF, ""), "\r?\n") | Where-Object { $_ -ne "" })
    Write-Host "已备份 $userCfg.bak，读到 $($lines.Count) 行"
}

$out = @()
$found = $false
foreach ($line in $lines) {
    if ($line -match '^\s*pauseonfocusloss\s*=') {
        $out += 'pauseonfocusloss = "false"'
        $found = $true
    } else {
        $out += $line
    }
}
if (-not $found) { $out += 'pauseonfocusloss = "false"' }

[System.IO.File]::WriteAllLines($userCfg, $out, $utf8)
Write-Host '已设置 pauseonfocusloss = "false"'

Write-Host @"

下一步：
  1) 开一局单人对局（mod.enabledmods 已含 superbrain）。副驾默认接管军队：
     接触后自动集火、按射程站桩/放风筝、近战吸线、骑兵分边包夹、残血后送。
  2) 另开终端看遥测与实测战损比:
       python ..\sidecar\superbraind.py
     交还操控:    python ..\sidecar\superbraind.py --takeover off --no-watch
     换打法:      python ..\sidecar\superbraind.py --doctrine hold --no-watch
     调参:        python ..\sidecar\superbraind.py --config standoff=0.7,kiteStep=14 --no-watch
  3) 想用键盘：进 选项 → 热键 → 'Superbrain 副驾' 自行绑键。
     引擎默认键位 F5-F8 已被相机跳转占用，所以安装脚本不自动改键。
  4) 看真实字段结构:  python ..\sidecar\superbraind.py --probe
"@
