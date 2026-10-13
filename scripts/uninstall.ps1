# Stops the presence and removes the autostart entry. The cloned folder is left alone.
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
# Keep this file ASCII only: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.
param(
    [string]$StartupDir = [Environment]::GetFolderPath('Startup')
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Main = Join-Path $Root 'src\main.ts'
$DataDir = Join-Path $env:LOCALAPPDATA 'apple-music-discord-rpc'
$Launcher = Join-Path $StartupDir 'apple-music-discord-rpc.vbs'

if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) {
    $helper = Join-Path $Root 'src\windows-media.ps1'
    # launcher first, so it can't restart node in between
    Get-CimInstance Win32_Process -Filter "Name = 'wscript.exe' OR Name = 'node.exe' OR Name = 'powershell.exe'" |
        Where-Object { $_.CommandLine -and ($_.CommandLine.Contains('apple-music-discord-rpc.vbs') -or $_.CommandLine.Contains($Main) -or $_.CommandLine.Contains($helper)) } |
        Sort-Object { $_.Name -ne 'wscript.exe' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

Remove-Item -LiteralPath $Launcher -Force -ErrorAction SilentlyContinue
# give Windows a moment to release the log file
Start-Sleep -Milliseconds 500
Remove-Item -LiteralPath $DataDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host 'ok uninstalled' -ForegroundColor Green
