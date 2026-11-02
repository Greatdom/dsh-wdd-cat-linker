<#
.SYNOPSIS
    把插件源码同步到 DSH 的安装目录，并做一致性校验。

.DESCRIPTION
    DSH 加载的是 profile 里的一份**实体副本**，不是我们的源码目录：
        E:\程序代码\dsh\dsh-wdd-cat-linker        ← 你改这里
        D:\dsh\workspace\profiles\desktop\node_modules\dsh-wdd-cat-linker  ← DSH 实际加载这里

    改完源码必须复制过去，否则你改的东西一行都不会生效。
    这个脚本做三件事：
        1. 检查 DSH 是否还开着（开着就复制会失败，因为文件被占用）
        2. 按清单复制源码文件（**不动** node_modules / package-lock.json / test / .git）
        3. 逐文件比对哈希，确认真的同步了

.PARAMETER Force
    跳过「DSH 可能还在运行」的提示，直接复制。

.PARAMETER VerifyOnly
    只比对，不复制。用来确认当前安装的是不是最新源码。

.EXAMPLE
    .\sync.ps1
    .\sync.ps1 -VerifyOnly
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'

$Source = 'E:\程序代码\dsh\dsh-wdd-cat-linker'
$Target = 'D:\dsh\workspace\profiles\desktop\node_modules\dsh-wdd-cat-linker'

# 要同步的文件清单（相对路径）。
# 刻意不含 package-lock.json / test / .git —— 那些是安装时生成的，覆盖会出问题。
$Files = @(
    'index.js',
    'cordis.patch.yml',
    'icon.svg',
    'locale/en.json',
    'locale/zh.json',
    'src/bridge.js',
    'src/config.js',
    'src/inbound.js',
    'src/media.js',
    'src/outbound.js',
    'src/resolver.js'
)

# ⚠ package.json 刻意**不同步**。
#   pnpm 安装时会往安装目录那份里写 dependencies（例如 @deepseek-ai/schemastery），
#   覆盖它就等于抹掉依赖声明，插件会加载失败。
#   改 package.json 的元信息（版本号、描述）时，请手动确认安装目录那份。
$Volatile = @('package.json')

function Write-Step([string]$Text) {
    Write-Host ""
    Write-Host "== $Text" -ForegroundColor Cyan
}

function Get-Hash([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm MD5).Hash
}

# ── 前置检查 ──────────────────────────────────────────────────────────

if (-not (Test-Path -LiteralPath $Source)) {
    throw "源码目录不存在：$Source"
}
if (-not (Test-Path -LiteralPath $Target)) {
    throw "安装目录不存在：$Target`n（插件可能还没装好，或者装在了别的 profile）"
}

Write-Step '路径'
Write-Host "源码: $Source"
Write-Host "安装: $Target"

# DSH 是否在运行。不强制拦截，因为很多情况下进程名不叫 dsh，
# 但被占用时复制会抛 UnauthorizedAccessException，那时再提示。
$dshProcesses = @(Get-Process -Name 'dsh', 'DSH NEXT', 'electron' -ErrorAction SilentlyContinue)
if ($dshProcesses.Count -gt 0 -and -not $Force -and -not $VerifyOnly) {
    Write-Host ""
    Write-Host "检测到 DSH/Electron 正在运行：" -ForegroundColor Yellow
    $dshProcesses | ForEach-Object { Write-Host ("  {0} (PID {1})" -f $_.ProcessName, $_.Id) }
    Write-Host "文件可能被占用导致复制失败。建议先关闭 DSH 再同步。" -ForegroundColor Yellow
    $answer = Read-Host "仍要继续？(y/N)"
    if ($answer -ne 'y') {
        Write-Host "已取消。"
        exit 1
    }
}

# ── 复制 ──────────────────────────────────────────────────────────────

$copied = 0
$skipped = 0
$failed = 0

if (-not $VerifyOnly) {
    Write-Step '复制'
    foreach ($rel in $Files) {
        $src = Join-Path $Source $rel
        $dst = Join-Path $Target $rel

        if (-not (Test-Path -LiteralPath $src)) {
            Write-Host ("  跳过  {0}  （源码里没有）" -f $rel) -ForegroundColor DarkGray
            $skipped++
            continue
        }

        # 目标目录可能不存在（例如源码新增了子目录）
        $dstDir = Split-Path -Parent $dst
        if (-not (Test-Path -LiteralPath $dstDir)) {
            New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
        }

        try {
            Copy-Item -LiteralPath $src -Destination $dst -Force
            $copied++
        } catch {
            Write-Host ("  失败  {0}  {1}" -f $rel, $_.Exception.Message) -ForegroundColor Red
            $failed++
        }
    }
    Write-Host ("  复制 {0} 个，跳过 {1} 个，失败 {2} 个" -f $copied, $skipped, $failed)
}

# ── 校验 ──────────────────────────────────────────────────────────────

Write-Step '一致性校验'
$mismatch = 0
foreach ($rel in $Files) {
    $src = Join-Path $Source $rel
    if (-not (Test-Path -LiteralPath $src)) { continue }

    $h1 = Get-Hash $src
    $h2 = Get-Hash (Join-Path $Target $rel)

    if ($null -eq $h2) {
        Write-Host ("  缺失  {0}" -f $rel) -ForegroundColor Red
        $mismatch++
    } elseif ($h1 -eq $h2) {
        Write-Host ("  OK    {0}" -f $rel) -ForegroundColor DarkGray
    } else {
        Write-Host ("  不一致 {0}  src={1} run={2}" -f $rel, $h1.Substring(0, 8), $h2.Substring(0, 8)) -ForegroundColor Red
        $mismatch++
    }
}

# package.json 不同步，但要单独检查「依赖声明是否还在」——这是安装目录那份的命根子
foreach ($rel in $Volatile) {
    $dstPkg = Join-Path $Target $rel
    if (-not (Test-Path -LiteralPath $dstPkg)) {
        Write-Host ("  缺失  {0}（安装目录）" -f $rel) -ForegroundColor Red
        $mismatch++
        continue
    }
    # 手工从文本里找 "dependencies"，不用 ConvertFrom-Json：
    # Windows PowerShell 5.1 的该 cmdlet 对 UTF-8 内容容易报 ArgumentException。
    $text = [System.IO.File]::ReadAllText($dstPkg, [System.Text.Encoding]::UTF8)
    if ($text -match '"dependencies"\s*:\s*\{') {
        Write-Host ("  提示  {0} 不同步；安装目录那份含 dependencies（正常）" -f $rel) -ForegroundColor DarkGray
    } else {
        Write-Host ("  警告  {0} 的安装目录没有 dependencies —— 依赖可能没装上" -f $rel) -ForegroundColor Yellow
    }
}

# 安装目录里多出来的 .js（我们清单里没有的），提示一下，防止旧模块残留
$installedJs = Get-ChildItem (Join-Path $Target 'src') -Filter '*.js' -ErrorAction SilentlyContinue |
    ForEach-Object { 'src/' + $_.Name }
$expected = $Files | Where-Object { $_ -like 'src/*' }
$extra = $installedJs | Where-Object { $_ -notin $expected }
if ($extra) {
    Write-Host ""
    Write-Host "安装目录里还有这些文件不在源码清单中（可能是已删除的旧模块）：" -ForegroundColor Yellow
    $extra | ForEach-Object { Write-Host ("  {0}" -f $_) -ForegroundColor Yellow }
    Write-Host "它们会在下次加载时被 import 到吗？如果没被引用可以忽略；建议删掉避免混淆。" -ForegroundColor Yellow
}

# ── 结论 ──────────────────────────────────────────────────────────────

Write-Host ""
if ($failed -gt 0) {
    Write-Host "同步失败：有文件复制不进去。最可能是 DSH 正开着占用文件 —— 关掉 DSH 后重试。" -ForegroundColor Red
    exit 1
}
if ($mismatch -gt 0) {
    Write-Host "校验未通过：$mismatch 个文件不一致。" -ForegroundColor Red
    exit 1
}

if ($VerifyOnly) {
    Write-Host "校验通过：安装目录与源码完全一致。" -ForegroundColor Green
} else {
    Write-Host "同步完成：安装目录已与源码一致。" -ForegroundColor Green
    Write-Host "⚠ 别忘了重启 DSH —— JS 改动不会热更新。" -ForegroundColor Yellow
}
