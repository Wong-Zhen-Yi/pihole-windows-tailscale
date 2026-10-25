param(
    [Parameter(Position = 0)][string]$Origin,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$ChromeArguments
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

function Read-Exact {
    param([IO.Stream]$Stream, [int]$Length)
    $bytes = New-Object byte[] $Length
    $offset = 0
    while ($offset -lt $Length) {
        $read = $Stream.Read($bytes, $offset, $Length - $offset)
        if ($read -eq 0) { throw 'Incomplete native message.' }
        $offset += $read
    }
    return ,$bytes
}

try {
    $config = Get-HelperConfig
    if ($Origin -cne ('chrome-extension://' + $config.extensionId + '/')) { throw 'Extension is not allowed.' }
    $inputStream = [Console]::OpenStandardInput()
    $length = [BitConverter]::ToUInt32((Read-Exact $inputStream 4), 0)
    if ($length -lt 2 -or $length -gt 4096) { throw 'Invalid native message length.' }
    $json = (New-Object Text.UTF8Encoding($false, $true)).GetString((Read-Exact $inputStream $length))
    $request = $json | ConvertFrom-Json
    $fields = @($request.PSObject.Properties.Name)
    if ($fields.Count -ne 1 -or $fields[0] -cne 'action' -or $request.action -cnotin @('start', 'status')) { throw 'Unsupported helper action.' }
    if ($request.action -eq 'start') {
        $powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
        $worker = Join-Path $PSScriptRoot 'worker.ps1'
        Start-Process -FilePath $powershell -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $worker + '"')) -WindowStyle Hidden
        $reply = @{ ok = $true; phase = 'starting'; mode = $config.mode; message = 'Launch requested. Startup continues if you close this popup. Check startup status for progress.' }
    } else { $reply = Get-HelperStatus $config $PSScriptRoot }
} catch {
    $message = $_.Exception.Message
    if ($message -notmatch '^(Extension is not allowed|Unsupported helper action|Invalid native message|Incomplete native message|Reinstall the Pi-hole|The Pi-hole repository|Install Docker|Docker Desktop local|Switch Docker|Operation timed out|Cannot inspect|Refusing a container|Expected one)') {
        $message = 'The Pi-hole helper could not handle this request. Reinstall it and check Docker Desktop.'
    }
    $reply = @{ ok = $false; phase = 'error'; message = $message }
}
$outputStream = [Console]::OpenStandardOutput()
$payload = [Text.Encoding]::UTF8.GetBytes(($reply | ConvertTo-Json -Compress))
$outputStream.Write([BitConverter]::GetBytes([uint32]$payload.Length), 0, 4)
$outputStream.Write($payload, 0, $payload.Length)
$outputStream.Flush()
