[CmdletBinding()]
param([string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Pi-hole Companion/NativeHost'))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$directory = [IO.Path]::GetFullPath($InstallDirectory)
$manifestPath = Join-Path $directory 'com.wong.pihole_companion.json'
$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.wong.pihole_companion'
if (Test-Path -LiteralPath $registryPath) {
    if ((Get-Item -LiteralPath $registryPath).GetValue('') -ne $manifestPath) { throw 'Refusing to unregister a different native host.' }
    # This registration is a single key with no child keys.
    Remove-Item -LiteralPath $registryPath
}
# Preserve files so a running worker is not interrupted. No Docker/DNS changes.
Write-Host 'Pi-hole helper unregistered for this Windows user. Helper files are retained; Pi-hole keeps running.'
Write-Host 'After startup finishes, the Pi-hole Companion/NativeHost folder under LocalAppData may be removed manually.'
