<#
无头链路验证：跑一局关闭图形的对局，检查桥接 mod 是否真的被加载、状态文件是否在动。
这条命令会启动游戏进程（无渲染，但确实是启动程序），Ctrl+C 可中断。
#>
param(
    [string]$GameRoot = "G:\0 A.D. Empires Ascendant",
    [int]$Seconds = 75,
    [string]$Map = "random/alpine_lakes"
)

$exe = Join-Path $GameRoot "binaries\system\pyrogenesis.exe"
if (-not (Test-Path $exe)) { Write-Error "找不到引擎: $exe"; exit 1 }

$ipc = @(
    (Join-Path $env:APPDATA "0ad\saves\superbrain"),
    (Join-Path $env:APPDATA "0ad\config\superbrain")
)

$engineArgs = @(
    "-autostart=`"$Map`"",
    "-autostart-nonvisual",
    "-mod=superbrain",
    "-autostart-players=2",
    "-autostart-civ=1:athen",
    "-autostart-civ=2:brit",
    "-autostart-ai=2:petra",
    "-autostart-aidiff=2:5",
    "-autostart-seed=-1",
    "-autostart-player=1",
    "-autostart-ceasefire=0",
    "-autostart-victory=endless",
    "-autostart-disable-replay"
)

Write-Host "启动: $exe"
Write-Host ($engineArgs -join " ")
$proc = Start-Process -FilePath $exe -ArgumentList $engineArgs -PassThru

$hit = $null
for ($i = 0; $i -lt $Seconds; $i++) {
    Start-Sleep -Seconds 1
    foreach ($dir in $ipc) {
        if (Test-Path (Join-Path $dir "diag.json")) { $hit = $dir; break }
    }
    if ($hit) { break }
}

if (-not $hit) {
    Write-Host "`n结果: $Seconds 秒内没出现 diag.json。"
    Write-Host "两种解释: (a) -autostart-nonvisual 不加载 session GUI 页面; (b) mod 里 gui/session 子目录脚本不会被自动加载。"
    Write-Host "下一步改用带窗口的一次运行来区分这两种情况。"
}
else {
    Write-Host "`n桥接 mod 已加载，IPC 目录: $hit"
    Get-Content (Join-Path $hit "diag.json") -Raw
    $states = @(Get-ChildItem (Join-Path $hit "state-*.json") -ErrorAction SilentlyContinue)
    Write-Host "state 文件数: $($states.Count)"
    if ($states.Count -gt 0) {
        $newest = $states | Sort-Object Name | Select-Object -Last 1
        Write-Host "最新: $($newest.Name)  $([math]::Round($newest.Length/1KB,1)) KB"
        $sample = Get-Content $newest.FullName -Raw | ConvertFrom-Json
        Write-Host "seq=$($sample.seq) 实体数=$($sample.entities.Count) 己方=$(@($sample.entities | Where-Object { $_[7] -eq 1 }).Count)"
        Write-Host "可见性取值: $($sample.skippedHidden) 个被 fog 过滤"
        $statics = @(Get-ChildItem (Join-Path $hit "static-*.json") -ErrorAction SilentlyContinue)
        Write-Host "static 文件数: $($statics.Count)"
    }
}

if (-not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force
    Write-Host "`n已结束测试进程。"
}
