# Standalone launcher tests for Windows PowerShell 5.1 and PowerShell 7.
# Docker is mocked; no daemon, Pester module or administrator rights required.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot '../windows/pihole.ps1'
$windowsDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../windows'))
$calls = New-Object 'System.Collections.Generic.List[object]'
$dockerMissing = $false
$dockerOS = 'linux'
$failCommand = ''

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

# Shadow only the launcher's dependency lookup, not any installed Docker CLI.
function Get-Command {
    param([string]$Name, [string]$ErrorAction)
    if ($Name -ne 'docker') { throw "Unexpected command lookup: $Name" }
    if (-not $dockerMissing) { 'mock-docker' }
}

function docker {
    $commandArgs = @($args)
    $calls.Add($commandArgs)
    $global:LASTEXITCODE = 0
    $command = if ($args[0] -eq 'info') {
        'info'
    } elseif ($args[1] -eq 'version') {
        'version'
    } elseif ($args[5] -eq '--file') {
        $args[7]
    } else {
        $args[5]
    }
    if ($command -eq $failCommand) {
        $global:LASTEXITCODE = 1
        return
    }
    if ($command -eq 'info') { $dockerOS }
}

function Assert-LaunchFailure([string]$ExpectedMessage, [int]$ExpectedCalls) {
    $calls.Clear()
    $message = ''
    try { & $launcher Start | Out-Null } catch { $message = $_.Exception.Message }
    Assert-True ($message -like "*$ExpectedMessage*") "Expected '$ExpectedMessage', got '$message'"
    Assert-True ($calls.Count -eq $ExpectedCalls) 'Launcher must stop immediately on failure'
}

$actions = @{
    Start = @('up', '--detach')
    Stop = @('stop')
    Status = @('ps')
    Logs = @('logs', '--follow', '--tail', '100')
}

# An unrelated directory (with spaces) must not affect Compose paths.
$previousLocation = Get-Location
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ('Pi-hole launcher ' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tempDir | Out-Null
try {
    Set-Location $tempDir
    foreach ($useTailscale in @($false, $true)) {
        foreach ($action in $actions.Keys) {
            $calls.Clear()
            & $launcher $action -Tailscale:$useTailscale | Out-Null
            Assert-True ($calls.Count -eq 3) "$action should check Docker, Compose, then run"
            Assert-True (($calls[0] -join '|') -eq 'info|--format|{{.OSType}}') 'Check Docker engine type'
            Assert-True (($calls[1] -join '|') -eq 'compose|version') 'Check Compose v2'
            $expected = @(
                'compose', '--project-directory', $windowsDir,
                '--file', (Join-Path $windowsDir 'compose.yaml')
            )
            if ($useTailscale) {
                $expected += @('--file', (Join-Path $windowsDir 'compose.tailscale.yaml'))
            }
            $expected += $actions[$action]
            Assert-True (($calls[2] -join '|') -eq ($expected -join '|')) "$action arguments (Tailscale=$useTailscale)"
        }
    }

    $calls.Clear()
    & $launcher | Out-Null
    Assert-True ($calls[2][5] -eq 'up') 'Default action is Start'

    $dockerMissing = $true
    Assert-LaunchFailure 'Install Docker Desktop' 0
    $dockerMissing = $false

    $dockerOS = 'windows'
    Assert-LaunchFailure 'Switch Docker Desktop to Linux containers' 1
    $dockerOS = 'linux'

    $failCommand = 'info'
    Assert-LaunchFailure 'Cannot connect to Docker' 1
    $failCommand = 'version'
    Assert-LaunchFailure 'Docker Compose v2 is required' 2
    $failCommand = 'up'
    Assert-LaunchFailure 'Docker Compose failed' 3
    $failCommand = ''

    # Every action must report a failed Compose invocation, not just Start.
    foreach ($useTailscale in @($false, $true)) {
        foreach ($action in $actions.Keys) {
            $failCommand = $actions[$action][0]
            $message = ''
            try { & $launcher $action -Tailscale:$useTailscale | Out-Null } catch { $message = $_.Exception.Message }
            Assert-True ($message -like '*Docker Compose failed*') "$action propagates Compose failure (Tailscale=$useTailscale)"
        }
    }
    $failCommand = ''

    $calls.Clear()
    $message = ''
    try { & $launcher 'InvalidAction' | Out-Null } catch { $message = $_.Exception.Message }
    Assert-True ($message -ne '') 'Reject invalid actions'
    Assert-True ($calls.Count -eq 0) 'Invalid actions must not invoke Docker'
} finally {
    Set-Location $previousLocation
    Remove-Item -LiteralPath $tempDir -Recurse -Force
}

Write-Host 'All Windows launcher tests passed.'
