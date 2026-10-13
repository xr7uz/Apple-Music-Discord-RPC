# Installs (or updates) a hidden autostart entry so the presence starts at login.
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
# Keep this file ASCII only: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.
param(
    # Only write the autostart entry, don't start it right now
    [switch]$NoStart,
    [string]$StartupDir = [Environment]::GetFolderPath('Startup')
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Main = Join-Path $Root 'src\main.ts'
$EnvFile = Join-Path $Root '.env'
$DataDir = Join-Path $env:LOCALAPPDATA 'apple-music-discord-rpc'
$LogFile = Join-Path $DataDir 'music-rpc.log'
$Launcher = Join-Path $StartupDir 'apple-music-discord-rpc.vbs'

function Step($text) { Write-Host "> $text" -ForegroundColor Magenta }
function Fail($text) { Write-Host "x $text" -ForegroundColor Red; exit 1 }

function Stop-Agent {
    if (-not (Get-Command Get-CimInstance -ErrorAction SilentlyContinue)) { return }
    $helper = Join-Path $Root 'src\windows-media.ps1'
    # launcher first, so it can't restart node in between
    Get-CimInstance Win32_Process -Filter "Name = 'wscript.exe' OR Name = 'node.exe' OR Name = 'powershell.exe'" |
        Where-Object { $_.CommandLine -and ($_.CommandLine.Contains('apple-music-discord-rpc.vbs') -or $_.CommandLine.Contains($Main) -or $_.CommandLine.Contains($helper)) } |
        Sort-Object { $_.Name -ne 'wscript.exe' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'node not found, install Node.js 22.18+ first: winget install OpenJS.NodeJS.LTS' }
$version = [version](& $node.Source -p 'process.versions.node')
if ($version -lt [version]'22.18.0') { Fail "Node.js 22.18+ required, found $version" }
# the real node.exe, not a version manager shim
$NodeExe = (& $node.Source -p 'process.execPath').Trim()

Step 'stopping previous instance'
Stop-Agent

Step "writing $Launcher"
New-Item -ItemType Directory -Force -Path $DataDir, $StartupDir | Out-Null
$q = '""'
$command = "$q$NodeExe$q --disable-warning=ExperimentalWarning $q--env-file-if-exists=$EnvFile$q $q$Main$q"
$vbs = @"
' apple-music-discord-rpc: runs the presence hidden at login and restarts it if it stops
Set shell = CreateObject("WScript.Shell")
shell.Environment("PROCESS")("MUSIC_RPC_LOG_FILE") = "$LogFile"
shell.CurrentDirectory = "$Root"
Do
  shell.Run "$command", 0, True
  WScript.Sleep 10000
Loop
"@
# UTF-16 with BOM, so paths with umlauts survive
Set-Content -LiteralPath $Launcher -Value $vbs -Encoding Unicode

if (-not $NoStart) {
    Step 'starting'
    Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$Launcher`""
}

Write-Host "ok installed - log: $LogFile" -ForegroundColor Green
Write-Host '   starts automatically at every login'
