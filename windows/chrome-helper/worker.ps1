# Detached from Chrome so startup continues after the popup closes.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$lock = $null
try {
    # Only one launch worker can hold this file, including across Chrome windows.
    try { $lock = [IO.File]::Open((Join-Path $PSScriptRoot 'launch.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { exit 0 }
    $config = Get-HelperConfig
    Start-HelperPihole $config $PSScriptRoot
} catch {
    # Messages generated above are deliberately free of Docker output/secrets.
    $known = $_.Exception.Message
    if ($known -notmatch '^(Install Docker|Switch Docker|Docker |Connect Tailscale|Deployment mode|Pi-hole |Operation timed out|The Pi-hole repository|Reinstall the Pi-hole|Cannot inspect|Refusing a container|Expected one)') {
        $known = 'Startup failed. Check Docker Desktop and reinstall the helper if the repository moved.'
    }
    Write-HelperState $PSScriptRoot 'failed' $known
} finally { if ($lock) { $lock.Dispose() } }
