# Pi-hole runs in a Linux container; this launcher requires Docker Desktop.
[CmdletBinding()]
param(
    [ValidateSet('Start', 'Stop', 'Status', 'Logs')]
    [string]$Action = 'Start',

    # Keep this switch on subsequent Start calls to retain Tailscale bindings.
    [switch]$Tailscale
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker was not found. Install Docker Desktop with the WSL 2 backend and Linux containers, then reopen PowerShell.'
}

$dockerOS = & docker info --format '{{.OSType}}'
if ($LASTEXITCODE -ne 0) {
    throw 'Cannot connect to Docker. Start Docker Desktop and wait for its engine to be ready.'
}
if (($dockerOS | Out-String).Trim() -ne 'linux') {
    throw 'Pi-hole needs Linux containers. Switch Docker Desktop to Linux containers.'
}

& docker compose version
if ($LASTEXITCODE -ne 0) {
    throw 'Docker Compose v2 is required. Update Docker Desktop.'
}

# Resolve paths relative to this script, not the current working directory.
$composeArgs = @(
    'compose',
    '--project-directory', $PSScriptRoot,
    '--file', (Join-Path $PSScriptRoot 'compose.yaml')
)
if ($Tailscale) {
    $composeArgs += @('--file', (Join-Path $PSScriptRoot 'compose.tailscale.yaml'))
}

switch ($Action) {
    'Start'  { $composeArgs += @('up', '--detach') }
    'Stop'   { $composeArgs += @('stop') }
    'Status' { $composeArgs += @('ps') }
    'Logs'   { $composeArgs += @('logs', '--follow', '--tail', '100') }
}

& docker @composeArgs
if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose failed to $($Action.ToLowerInvariant()) Pi-hole. Check the Docker output above (including possible port conflicts)."
}

if ($Action -eq 'Start') {
    Write-Host 'Pi-hole is starting. With the default settings, open http://localhost:8080/admin/ once it is ready.'
    if ($Tailscale) {
        Write-Host 'Tailscale bindings are enabled. See windows/TAILSCALE.md for firewall and phone DNS setup.'
    }
    Write-Host 'See windows/README.md to set a password and enable DNS access from your network.'
}
