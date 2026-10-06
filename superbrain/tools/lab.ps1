<#
拉起一局"可视 autostart"对局：命令行直接进 session GUI，
这样副驾内核的回归测试不用人手点菜单，M4 的批量自学习也走同一条路。

前提：必须没有其他 pyrogenesis 实例在跑。public.zip 被游戏独占打开，
第二个实例读不到任何 mod 文件（表现是 gui/common/*.js does not exist + AutoStart is not defined）。

  .\lab.ps1                       # 默认：kush vs brit，Petra 最难，2 倍速
  .\lab.ps1 -Speed 1 -AiDiff 3
  .\lab.ps1 -Map "random/arcadia" -MapSize 192
#>
param(
    [string]$GameRoot = "G:\0 A.D. Empires Ascendant",
    [string]$Map = "random/alpine_lakes",
    [int]$MapSize = 112,
    [int]$Players = 2,
    [string]$OurCiv = "kush",
    [string]$FoeCiv = "brit",
    [int]$AiDiff = 5,
    [double]$Speed = 2,
    [string]$Visibility = "revealed",
    [int]$XRes = 1200,
    [int]$YRes = 720,
    [switch]$NoWait
)

$running = @(Get-Process pyrogenesis -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    Write-Host "检测到 $(($running | ForEach-Object { $_.Id }) -join ', ') 号 pyrogenesis 还在运行。" -ForegroundColor Red
    Write-Host "public.zip 被它占用，第二个实例读不到 mod 文件。请先正常退出游戏再跑这个脚本。"
    exit 1
}

$exe = Join-Path $GameRoot "binaries\system\pyrogenesis.exe"
if (-not (Test-Path $exe)) { throw "找不到引擎: $exe" }

$argsList = @(
    "-autostart=$Map",
    "-autostart-players=$Players",
    "-autostart-size=$MapSize",
    "-autostart-civ=1:$OurCiv",
    "-autostart-civ=2:$FoeCiv",
    "-autostart-ai=2:petra",
    "-autostart-aidiff=2:$AiDiff",
    "-autostart-seed=-1",
    "-autostart-visibility=$Visibility",
    "-autostart-speed=$Speed",
    "-xres=$XRes",
    "-yres=$YRes"
)

Write-Host ("启动: " + ($argsList -join " "))
$proc = Start-Process -FilePath $exe -ArgumentList $argsList -WorkingDirectory (Split-Path $exe) -PassThru
Write-Host "PID = $($proc.Id)"

if ($NoWait) { exit 0 }

$ipcRoot = Join-Path $env:USERPROFILE "Documents\My Games\0ad\saves\campaigns\superbrain"
$start = Get-Date
Write-Host "等待 $ipcRoot\run-* 出现（RMG 建图可能要几十秒）……"
for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 2
    if ($proc.HasExited) {
        Write-Host "进程已退出，退出码 $($proc.ExitCode) —— 看 $env:LOCALAPPDATA\0ad\logs\interestinglog.html" -ForegroundColor Red
        exit 2
    }
    $runs = @(Get-ChildItem -Path $ipcRoot -Directory -Filter "run-*" -ErrorAction SilentlyContinue)
    # 必须是本次启动之后才写的帧，否则上一次对局的旧目录会被误判成"起来了"
    $live = $runs | Where-Object {
        $f = Join-Path $_.FullName "state-000002.json"
        (Test-Path $f) -and ((Get-Item $f).LastWriteTime -gt $start)
    }
    if ($live) {
        $dir = ($live | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
        Write-Host "副驾已进 session 页面: $dir" -ForegroundColor Green
        Write-Host "看遥测:  python ..\sidecar\superbraind.py --dir `"$dir`""
        exit 0
    }
}

Write-Host "90*2 秒内没等到 state 文件：副驾没进 GUI 作用域。查 interestinglog.html 里有没有 [superbrain]" -ForegroundColor Red
exit 3
