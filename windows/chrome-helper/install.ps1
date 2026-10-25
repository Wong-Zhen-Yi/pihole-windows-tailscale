# Per-user Chrome registration. Administrator rights are not required.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
    [ValidateSet('Detect', 'Local', 'Tailscale')][string]$Mode = 'Detect',
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Pi-hole Companion/NativeHost'),
    [switch]$SkipRegistration
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not (Test-Path -LiteralPath (Join-Path $repository 'windows/pihole.ps1') -PathType Leaf)) { throw 'Run the installer from the Pi-hole repository.' }
if ($Mode -eq 'Detect') {
    $docker = Get-HelperDocker
    if ((Get-HelperEngine $docker) -ne 'linux') { throw 'Start Docker Desktop to detect mode, or explicitly pass -Mode Local or -Mode Tailscale.' }
    $deployment = Get-HelperDeployment $docker
    if (-not $deployment) { throw 'No deployment exists to detect. Explicitly pass -Mode Local or -Mode Tailscale.' }
    $Mode = $deployment.Mode
}
$directory = [IO.Path]::GetFullPath($InstallDirectory)
$manifestPath = Join-Path $directory 'com.wong.pihole_companion.json'
$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.wong.pihole_companion'
if (-not $SkipRegistration -and (Test-Path -LiteralPath $registryPath)) {
    $existing = (Get-Item -LiteralPath $registryPath).GetValue('')
    if ($existing -ne $manifestPath) { throw 'Another Pi-hole native host is registered. Uninstall that helper first.' }
}
$configPath = Join-Path $directory 'config.json'
if (Test-Path -LiteralPath $configPath) {
    $existing = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($existing.owner -ne 'pihole-companion') { throw 'Install directory belongs to another application.' }
}
New-Item -ItemType Directory -Path $directory -Force | Out-Null
foreach ($file in @('common.ps1', 'worker.ps1', 'native-host.ps1', 'native-host.cmd')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $directory $file) -Force
}
$config = @{ owner = 'pihole-companion'; extensionId = $ExtensionId; repository = $repository; mode = $Mode }
$manifest = @{
    name = 'com.wong.pihole_companion'
    description = 'Start and inspect this user''s Pi-hole Windows deployment'
    path = (Join-Path $directory 'native-host.cmd')
    type = 'stdio'
    allowed_origins = @('chrome-extension://' + $ExtensionId + '/')
}
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), $utf8)
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), $utf8)
if (-not $SkipRegistration) {
    New-Item -Path $registryPath -Force | Out-Null
    Set-Item -LiteralPath $registryPath -Value $manifestPath
    Write-Host "Pi-hole Chrome helper installed for this Windows user. Launch mode: $Mode."
    Write-Host 'Reload Pi-hole Companion in chrome://extensions, then use Launch Pi-hole.'
} else { Write-Host "Helper prepared without registry changes. Launch mode: $Mode." }
