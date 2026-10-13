# Reads the Apple Music / iTunes session from the Windows media controls (SMTC),
# the same data the volume flyout shows. Started once by windows.ts and kept alive.
#
# Protocol: one JSON request per line on stdin, one JSON response per line on stdout.
#   {"cmd":"snapshot"}               -> {"state":"playing","title":...,"position":12.3,...}
#   {"cmd":"artwork","path":"C:\.."} -> {"ok":true}
# Both directions are pure ASCII (non-ASCII is \u-escaped), so console code pages never matter.
# Keep this file ASCII only: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Await($operation, [Type]$resultType) {
    $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    if (-not $task.Wait(5000)) { throw 'Windows media API did not answer in time' }
    $task.Result
}

$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$propertiesType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$pattern = if ($env:MUSIC_RPC_WINDOWS_APP) { $env:MUSIC_RPC_WINDOWS_APP } else { 'AppleMusic|iTunes' }

function Find-Session {
    foreach ($session in $manager.GetSessions()) {
        if ($session.SourceAppUserModelId -match $pattern) { return $session }
    }
    return $null
}

function Get-Snapshot {
    $session = Find-Session
    if ($null -eq $session) { return @{ state = 'closed' } }

    $state = switch ($session.GetPlaybackInfo().PlaybackStatus.ToString()) {
        'Playing' { 'playing' }
        'Changing' { 'playing' }
        'Paused' { 'paused' }
        default { 'stopped' }
    }
    if ($state -eq 'stopped') { return @{ state = 'stopped' } }

    $props = Await ($session.TryGetMediaPropertiesAsync()) $propertiesType
    $result = @{
        state       = $state
        app         = $session.SourceAppUserModelId
        title       = $props.Title
        artist      = $props.Artist
        albumArtist = $props.AlbumArtist
        album       = $props.AlbumTitle
    }

    # Position is reported as of LastUpdatedTime, so add what has played since
    $timeline = $session.GetTimelineProperties()
    $duration = ($timeline.EndTime - $timeline.StartTime).TotalSeconds
    if ($duration -gt 0) {
        $position = ($timeline.Position - $timeline.StartTime).TotalSeconds
        if ($state -eq 'playing' -and $timeline.LastUpdatedTime.Year -gt 2000) {
            $position += ([DateTimeOffset]::Now - $timeline.LastUpdatedTime).TotalSeconds
        }
        $result.duration = $duration
        $result.position = [Math]::Max(0, [Math]::Min($position, $duration))
    }
    return $result
}

function Save-Artwork([string]$path) {
    $session = Find-Session
    if ($null -eq $session) { return @{ ok = $false } }
    $props = Await ($session.TryGetMediaPropertiesAsync()) $propertiesType
    if ($null -eq $props.Thumbnail) { return @{ ok = $false } }

    $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    try {
        $size = [uint32]$stream.Size
        if ($size -eq 0) { return @{ ok = $false } }
        $reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
        $null = Await ($reader.LoadAsync($size)) ([uint32])
        $bytes = New-Object byte[] $size
        $reader.ReadBytes($bytes)
        [System.IO.File]::WriteAllBytes($path, $bytes)
    }
    finally {
        $stream.Dispose()
    }
    return @{ ok = $true }
}

function ConvertTo-AsciiJson($value) {
    $json = ConvertTo-Json $value -Compress -Depth 3
    [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    try {
        $request = ConvertFrom-Json $line
        $response = switch ($request.cmd) {
            'snapshot' { Get-Snapshot }
            'artwork' { Save-Artwork $request.path }
            default { @{ error = "unknown command: $($request.cmd)" } }
        }
    }
    catch {
        $response = @{ error = $_.Exception.Message }
    }
    [Console]::Out.WriteLine((ConvertTo-AsciiJson $response))
    [Console]::Out.Flush()
}
