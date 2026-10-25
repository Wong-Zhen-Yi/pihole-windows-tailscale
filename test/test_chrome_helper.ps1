# Mocked startup checks: no Docker, registry, firewall or live DNS changes.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../windows/chrome-helper/common.ps1')
$realProcess = ${function:Invoke-HelperProcess}
$calls = New-Object 'System.Collections.Generic.List[object]'
$states = New-Object 'System.Collections.Generic.List[object]'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$exists = $true
$running = $false
$containerMode = 'Tailscale'
$engineCalls = 0
$coldBoot = $false
$failStart = $false
$badVolume = $false
$engineType = 'linux'

function Assert-True([bool]$Value, [string]$Message) { if (-not $Value) { throw "Assertion failed: $Message" } }
function Get-HelperDocker { 'mock-docker.exe' }
function Get-Command { param($Name, $ErrorAction) if ($Name -eq 'tailscale.exe') { [pscustomobject]@{ Source = 'mock-tailscale.exe' } } }
function Test-Path { param($LiteralPath, $PathType) if ($LiteralPath -like '*Docker Desktop.exe') { return $true }; Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath -PathType $PathType }
function Write-HelperState { param($Directory, $Phase, $Message) $states.Add(@{ phase = $Phase; message = $Message }) }
function Start-Sleep { param($Seconds) }
function Start-Process { param($FilePath, $WindowStyle) $calls.Add(@{ File = $FilePath; Hidden = $WindowStyle }) }
function Invoke-HelperProcess {
    param($File, $Arguments, $Timeout)
    $calls.Add(@{ File = $File; Arguments = @($Arguments) })
    if ($Arguments[0] -eq 'info') {
        $script:engineCalls++
        if ($coldBoot -and $script:engineCalls -eq 1) { return @{ Code = 1; Output = '' } }
        return @{ Code = 0; Output = $engineType }
    }
    if ($Arguments[0] -eq 'ps') { return @{ Code = 0; Output = $(if ($exists) { 'abcdef123456' } else { '' }) } }
    if ($Arguments[0] -eq 'inspect') {
        $configFiles = if ($containerMode -eq 'Tailscale') { 'compose.yaml,compose.tailscale.yaml' } else { 'compose.yaml' }
        $volume = if ($badVolume) { 'other-volume' } else { 'pihole-windows_pihole-data' }
        $data = @(@{ Config = @{ Labels = @{ 'com.docker.compose.project' = 'pihole-windows'; 'com.docker.compose.service' = 'pihole'; 'com.docker.compose.project.config_files' = $configFiles } }; State = @{ Running = $running }; Mounts = @(@{ Destination = '/etc/pihole'; Name = $volume }) })
        return @{ Code = 0; Output = (ConvertTo-Json -InputObject $data -Depth 8 -Compress) }
    }
    if ($Arguments[0] -eq 'start') {
        if ($failStart) { return @{ Code = 1; Output = 'sensitive diagnostic that must not be returned' } }
        $script:running = $true
        return @{ Code = 0; Output = '' }
    }
    if ($Arguments -contains '-File') {
        $script:exists = $true
        $script:running = $true
        return @{ Code = 0; Output = '' }
    }
    if ($Arguments[0] -eq 'ip') { return @{ Code = 0; Output = 'test-connected' } }
    throw 'Unexpected helper command.'
}

$config = [pscustomobject]@{ repository = $repository; mode = 'Tailscale' }
Start-HelperPihole $config $env:TEMP
Assert-True (@($calls | Where-Object { $_.ContainsKey('Arguments') -and $_.Arguments[0] -eq 'start' }).Count -eq 1) 'Stopped existing container starts once'
Assert-True (-not @($calls | Where-Object { $_.ContainsKey('Arguments') -and $_.Arguments -contains '-File' }).Count) 'Existing container is not recreated'
Assert-True ($states[$states.Count - 1].phase -eq 'running') 'Successful startup reported'

$calls.Clear()
Start-HelperPihole $config $env:TEMP
Assert-True (-not @($calls | Where-Object { $_.ContainsKey('Arguments') -and $_.Arguments[0] -eq 'start' }).Count) 'Already running is a no-op'

$running = $false
$config.mode = 'Local'
$message = ''
try { Start-HelperPihole $config $env:TEMP } catch { $message = $_.Exception.Message }
Assert-True ($message -match 'Deployment mode changed') 'Mode mismatch fails instead of changing bindings'
$config.mode = 'Tailscale'

$badVolume = $true
$message = ''
try { Start-HelperPihole $config $env:TEMP } catch { $message = $_.Exception.Message }
Assert-True ($message -match 'expected Pi-hole project') 'Unexpected volume is refused'
$badVolume = $false

$failStart = $true
$message = ''
try { Start-HelperPihole $config $env:TEMP } catch { $message = $_.Exception.Message }
Assert-True ($message -match 'could not start Pi-hole' -and $message -notmatch 'sensitive diagnostic') 'Failed startup does not leak raw output'
$failStart = $false

$engineType = 'windows'
$message = ''
try { Start-HelperPihole $config $env:TEMP } catch { $message = $_.Exception.Message }
Assert-True ($message -match 'Switch Docker Desktop to Linux') 'Windows containers are refused'
$engineType = 'linux'

# Initial creation must use the existing launcher and the configured overlay.
foreach ($mode in @('Local', 'Tailscale')) {
    $config.mode = $mode
    $containerMode = $mode
    $exists = $false
    $running = $false
    $calls.Clear()
    Start-HelperPihole $config $env:TEMP
    $launch = @($calls | Where-Object { $_.ContainsKey('Arguments') -and $_.Arguments -contains '-File' })
    Assert-True ($launch.Count -eq 1) 'Missing container uses the launcher once'
    Assert-True ($launch[0].Arguments -contains (Join-Path $repository 'windows/pihole.ps1')) 'Launcher path with spaces is a separate argument'
    Assert-True (($launch[0].Arguments -contains '-Tailscale') -eq ($mode -eq 'Tailscale')) 'Configured Tailscale mode is preserved'
}

# Docker Desktop is only started when its Linux engine is unavailable.
$coldBoot = $true
$engineCalls = 0
$calls.Clear()
Start-HelperPihole $config $env:TEMP
$desktop = @($calls | Where-Object { $_.ContainsKey('Hidden') })
Assert-True ($desktop.Count -eq 1 -and $desktop[0].Hidden -eq 'Hidden') 'Docker Desktop starts hidden on a cold boot'

# Verify the real process runner cannot inherit a remote Docker destination.
$oldHost = $env:DOCKER_HOST
$oldContext = $env:DOCKER_CONTEXT
try {
    $env:DOCKER_HOST = 'tcp://example.invalid:2375'
    $env:DOCKER_CONTEXT = 'test-remote'
    $systemPowerShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $result = & $realProcess $systemPowerShell @('-NoProfile', '-NonInteractive', '-Command', '$env:DOCKER_CONTEXT; [bool]$env:DOCKER_HOST') 10000
    Assert-True ($result.Code -eq 0 -and $result.Output.Trim() -eq "desktop-linux`r`nFalse") 'Child processes use local Docker Desktop without DOCKER_HOST'
} finally {
    $env:DOCKER_HOST = $oldHost
    $env:DOCKER_CONTEXT = $oldContext
}
Write-Host 'All Chrome helper startup tests passed (mocked).'
