# Shared implementation. No browser-supplied paths or commands are accepted.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-HelperProcess {
    param([string]$File, [string[]]$Arguments, [int]$Timeout = 10000)
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $File
    # Windows paths cannot contain double quotes; every argument is quoted.
    $info.Arguments = ($Arguments | ForEach-Object {
        if ($_ -match '"|[\r\n]') { throw 'Invalid process argument.' }
        '"' + $_ + '"'
    }) -join ' '
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    # Never inherit a remote Docker host/context from Chrome or the shell.
    [void]$info.EnvironmentVariables.Remove('DOCKER_HOST')
    $info.EnvironmentVariables['DOCKER_CONTEXT'] = 'desktop-linux'
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($Timeout)) {
            $process.Kill()
            $process.WaitForExit()
            throw 'Operation timed out. Check Docker Desktop and startup status before retrying.'
        }
        # Consume stderr but never return raw Docker output or local addresses.
        [void]$stderr.GetAwaiter().GetResult()
        return @{ Code = $process.ExitCode; Output = $stdout.GetAwaiter().GetResult() }
    } finally { $process.Dispose() }
}

function Get-HelperConfig {
    param([string]$Directory = $PSScriptRoot)
    $config = Get-Content -LiteralPath (Join-Path $Directory 'config.json') -Raw | ConvertFrom-Json
    if ($config.extensionId -notmatch '^[a-p]{32}$' -or $config.mode -notin @('Local', 'Tailscale')) {
        throw 'Reinstall the Pi-hole Chrome helper: invalid configuration.'
    }
    if (-not [IO.Path]::IsPathRooted($config.repository) -or
        -not (Test-Path -LiteralPath (Join-Path $config.repository 'windows/pihole.ps1') -PathType Leaf)) {
        throw 'The Pi-hole repository moved. Reinstall the Chrome helper from its new location.'
    }
    return $config
}

function Get-HelperDocker {
    $command = Get-Command docker.exe -ErrorAction SilentlyContinue
    $path = if ($command) { $command.Source } else { Join-Path $env:ProgramFiles 'Docker/Docker/resources/bin/docker.exe' }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Install Docker Desktop with Linux containers before launching Pi-hole.' }
    $context = Invoke-HelperProcess $path @('context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}')
    if ($context.Code -ne 0 -or $context.Output.Trim() -ne 'npipe:////./pipe/dockerDesktopLinuxEngine') {
        throw 'Docker Desktop local Linux context is missing or changed. Open Docker Desktop to restore it; remote engines are not supported.'
    }
    return $path
}

function Get-HelperEngine {
    param([string]$Docker)
    try {
        $result = Invoke-HelperProcess $Docker @('info', '--format', '{{.OSType}}') 5000
        if ($result.Code -eq 0) { return $result.Output.Trim() }
    } catch { }
    return 'offline'
}

function Get-HelperDeployment {
    param([string]$Docker)
    $result = Invoke-HelperProcess $Docker @('ps', '-a', '--filter', 'label=com.docker.compose.project=pihole-windows', '--filter', 'label=com.docker.compose.service=pihole', '--format', '{{.ID}}')
    if ($result.Code -ne 0) { throw 'Cannot inspect the Pi-hole deployment.' }
    $ids = @($result.Output -split '\s+' | Where-Object { $_ })
    if ($ids.Count -eq 0) { return $null }
    if ($ids.Count -ne 1 -or $ids[0] -notmatch '^[a-f0-9]{12,64}$') { throw 'Expected one Pi-hole container in project pihole-windows.' }
    $result = Invoke-HelperProcess $Docker @('inspect', $ids[0])
    if ($result.Code -ne 0) { throw 'Cannot inspect the Pi-hole container.' }
    $item = @($result.Output | ConvertFrom-Json)[0]
    if ($item.Config.Labels.'com.docker.compose.project' -ne 'pihole-windows' -or
        $item.Config.Labels.'com.docker.compose.service' -ne 'pihole' -or
        -not @($item.Mounts | Where-Object { $_.Destination -eq '/etc/pihole' -and $_.Name -eq 'pihole-windows_pihole-data' }).Count) {
        throw 'Refusing a container without the expected Pi-hole project, service and data volume.'
    }
    $mode = if ($item.Config.Labels.'com.docker.compose.project.config_files' -match 'compose\.tailscale\.yaml') { 'Tailscale' } else { 'Local' }
    return @{ Id = $ids[0]; Running = [bool]$item.State.Running; Mode = $mode }
}

function Write-HelperState {
    param([string]$Directory, [string]$Phase, [string]$Message)
    $state = @{ phase = $Phase; message = $Message; pid = $PID; updated = [DateTime]::UtcNow.ToString('o') }
    $path = Join-Path $Directory 'state.json'
    $temp = Join-Path $Directory ('state-' + $PID + '.tmp')
    [IO.File]::WriteAllText($temp, ($state | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temp -Destination $path -Force
}

function Get-HelperJob {
    param([string]$Directory)
    $path = Join-Path $Directory 'state.json'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        $state = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        if ($state.phase -eq 'starting') {
            $process = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
            $age = [DateTime]::UtcNow - [DateTime]::Parse($state.updated).ToUniversalTime()
            if (-not $process -or $age.TotalMinutes -gt 10) {
                return @{ phase = 'failed'; message = 'Startup stopped or timed out. Check Docker Desktop before retrying.' }
            }
        }
        return $state
    } catch { return $null }
}

function Get-HelperStatus {
    param($Config, [string]$Directory)
    $job = Get-HelperJob $Directory
    if ($job -and $job.phase -eq 'starting') {
        return @{ ok = $true; phase = 'starting'; message = $job.message; mode = $Config.mode }
    }
    $docker = Get-HelperDocker
    $engine = Get-HelperEngine $docker
    if ($engine -eq 'windows') { throw 'Switch Docker Desktop to Linux containers, then launch again.' }
    if ($engine -eq 'offline') {
        return @{ ok = $true; phase = 'offline'; message = 'Docker is not ready. Launch Pi-hole can start Docker Desktop.'; mode = $Config.mode }
    }
    $deployment = Get-HelperDeployment $docker
    if ($deployment -and $deployment.Running) {
        return @{ ok = $true; phase = 'running'; message = 'Pi-hole container is running. Connect to its API or open the dashboard; this does not verify client DNS.'; mode = $deployment.Mode }
    }
    if ($job -and $job.phase -eq 'failed') {
        return @{ ok = $true; phase = 'failed'; message = $job.message; mode = $Config.mode }
    }
    return @{ ok = $true; phase = 'stopped'; message = 'Pi-hole is stopped or has not been created. Click Launch Pi-hole.'; mode = $Config.mode }
}

function Start-HelperPihole {
    param($Config, [string]$Directory)
    Write-HelperState $Directory 'starting' 'Checking Docker Desktop...'
    $docker = Get-HelperDocker
    $engine = Get-HelperEngine $docker
    if ($engine -eq 'windows') { throw 'Switch Docker Desktop to Linux containers, then launch again.' }
    if ($engine -eq 'offline') {
        $desktop = Join-Path $env:ProgramFiles 'Docker/Docker/Docker Desktop.exe'
        if (-not (Test-Path -LiteralPath $desktop -PathType Leaf)) { throw 'Docker Desktop was not found in Program Files. Start it manually, then retry.' }
        Write-HelperState $Directory 'starting' 'Starting Docker Desktop and waiting for the Linux engine...'
        Start-Process -FilePath $desktop -WindowStyle Hidden
        $deadline = [DateTime]::UtcNow.AddSeconds(180)
        do {
            Start-Sleep -Seconds 3
            $engine = Get-HelperEngine $docker
        } while ($engine -eq 'offline' -and [DateTime]::UtcNow -lt $deadline)
        if ($engine -ne 'linux') { throw 'Docker Linux engine is not ready. Finish Docker Desktop setup, then retry.' }
    }
    $deployment = Get-HelperDeployment $docker
    if ($deployment) {
        if ($deployment.Mode -ne $Config.mode) { throw 'Deployment mode changed. Reinstall the helper after confirming Local or Tailscale mode.' }
        if (-not $deployment.Running) {
            Write-HelperState $Directory 'starting' 'Starting the existing Pi-hole container with its current bindings...'
            $result = Invoke-HelperProcess $docker @('start', $deployment.Id) 60000
            if ($result.Code -ne 0) { throw 'Docker could not start Pi-hole. Check Docker Desktop and whether its bound addresses are available.' }
        }
    } else {
        Write-HelperState $Directory 'starting' 'Creating Pi-hole through the configured Windows launcher...'
        if ($Config.mode -eq 'Tailscale') {
            $tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
            if (-not $tailscale) { throw 'Connect Tailscale on this Windows host before launching Pi-hole.' }
            $ip = Invoke-HelperProcess $tailscale.Source @('ip', '-4')
            if ($ip.Code -ne 0 -or -not $ip.Output.Trim()) { throw 'Connect Tailscale on this Windows host before launching Pi-hole.' }
        }
        $powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
        $arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Config.repository 'windows/pihole.ps1'), 'Start')
        if ($Config.mode -eq 'Tailscale') { $arguments += '-Tailscale' }
        $result = Invoke-HelperProcess $powershell $arguments 240000
        if ($result.Code -ne 0) { throw 'Pi-hole launcher failed. Check the saved .env, Tailscale connection and Docker Desktop. No configuration was rewritten.' }
    }
    $deployment = Get-HelperDeployment $docker
    if (-not $deployment -or -not $deployment.Running) { throw 'Pi-hole did not reach the running state. Check Docker Desktop.' }
    Write-HelperState $Directory 'running' 'Pi-hole container is running. Open the dashboard or connect to its API.'
}
