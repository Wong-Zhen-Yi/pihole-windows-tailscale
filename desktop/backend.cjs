// Local deployment adapter. The renderer never supplies commands or arguments.
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const PROJECT = 'pihole-windows';
const VOLUME = 'pihole-windows_pihole-data';
const REQUIRED = ['windows/pihole.ps1', 'windows/compose.yaml', 'windows/compose.tailscale.yaml'];

function localEnvironment(source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^(DOCKER_|COMPOSE_)/i.test(key)) delete env[key];
  }
  env.DOCKER_CONTEXT = 'desktop-linux';
  return env;
}

function run(file, args, { timeout = 15000, env = localEnvironment() } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, env, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      // Raw process errors/output may contain addresses, passwords or .env values.
      if (error) reject(new Error(error.killed ? 'Operation timed out. Check Docker Desktop before retrying.' :
        'Command failed. Check Docker Desktop, available ports and the Windows setup guide.'));
      else resolve(stdout.trim());
    });
  });
}

function validateRepository(repository) {
  if (typeof repository !== 'string' || !path.isAbsolute(repository) ||
      !REQUIRED.every(file => fs.existsSync(path.join(repository, file)))) {
    throw new Error('Choose this fork’s repository folder containing windows/pihole.ps1 and both Compose files.');
  }
  return path.resolve(repository);
}

function privateIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 127 || a === 10 || (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

function deploymentFromInspect(item) {
  const labels = item.labels || {};
  if (!/^[a-f0-9]{12,64}$/.test(item.id) || labels['com.docker.compose.project'] !== PROJECT || labels['com.docker.compose.service'] !== 'pihole' ||
      !(item.mounts || []).some(m => m.Type === 'volume' && m.Name === VOLUME && m.Destination === '/etc/pihole')) {
    throw new Error('Refusing a container without the expected Pi-hole project, service and data volume.');
  }
  const mode = /compose\.tailscale\.yaml/.test(labels['com.docker.compose.project.config_files'] || '') ? 'Tailscale' : 'Local';
  // Only private IPv4 bindings are eligible for opening in the user's browser.
  const bindings = (item.ports || {})['80/tcp'] || [];
  const candidates = bindings.filter(b => privateIPv4(b.HostIp) && /^\d+$/.test(b.HostPort) &&
    Number(b.HostPort) > 0 && Number(b.HostPort) <= 65535);
  const binding = candidates.find(b => b.HostIp.startsWith('127.')) || candidates[0];
  return {
    id: item.id, running: !!item.running, health: item.health || 'unknown', mode,
    dashboardUrl: binding ? `http://${binding.HostIp}:${binding.HostPort}/admin/` : null
  };
}

function createBackend({ execute = run, launch = spawn, exists = fs.existsSync,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now, environment = process.env } = {}) {
  const programFiles = environment.ProgramFiles || 'C:\\Program Files';
  const docker = path.join(programFiles, 'Docker/Docker/resources/bin/docker.exe');
  const powershell = path.join(environment.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const call = (args, timeout) => execute(docker, ['--context', 'desktop-linux', ...args], { timeout });
  let busy = false;

  async function checkContext() {
    if (!exists(docker)) throw new Error('Install Docker Desktop with Linux containers first.');
    const endpoint = await call(['context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}']);
    if (endpoint !== 'npipe:////./pipe/dockerDesktopLinuxEngine') {
      throw new Error('The local Docker Desktop Linux context is unavailable. Open Docker Desktop to restore it.');
    }
  }

  async function engine() {
    try {
      const os = await call(['info', '--format', '{{.OSType}}'], 6000);
      if (os !== 'linux') throw new Error('wrong-engine');
      return true;
    } catch (error) {
      if (error.message === 'wrong-engine') throw new Error('Switch Docker Desktop to Linux containers.');
      return false;
    }
  }

  async function deployment() {
    const ids = (await call(['ps', '-a', '--filter', `label=com.docker.compose.project=${PROJECT}`,
      '--filter', 'label=com.docker.compose.service=pihole', '--format', '{{.ID}}'])).split(/\s+/).filter(Boolean);
    if (!ids.length) return null;
    if (ids.length !== 1 || !/^[a-f0-9]{12,64}$/.test(ids[0])) throw new Error('Expected exactly one Pi-hole container. Check Docker Desktop.');
    // Avoid retrieving Config.Env (which can contain credentials).
    const format = '{"id":{{json .Id}},"running":{{json .State.Running}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"unknown"{{end}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"ports":{{json .HostConfig.PortBindings}}}';
    try {
      return deploymentFromInspect(JSON.parse(await call(['inspect', '--format', format, ids[0]])));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('Docker returned an unreadable container status.');
      throw error;
    }
  }

  async function status() {
    await checkContext();
    if (!await engine()) return { phase: 'offline', engine: false, deployment: null };
    const item = await deployment();
    return { phase: item?.running ? 'running' : item ? 'stopped' : 'missing', engine: true, deployment: item };
  }

  async function action(action, settings, report = () => {}) {
    if (!['start', 'stop'].includes(action)) throw new Error('Unsupported action.');
    if (busy) throw new Error('An operation is already in progress.');
    busy = true;
    try {
      await checkContext();
      if (!await engine()) {
        if (action === 'stop') throw new Error('Docker is offline. No stop command was sent.');
        const executable = path.join(programFiles, 'Docker/Docker/Docker Desktop.exe');
        if (!exists(executable)) throw new Error('Open Docker Desktop manually, then retry.');
        report('Starting Docker Desktop. Waiting for its Linux engine…');
        await new Promise((resolve, reject) => {
          const child = launch(executable, [], { detached: true, stdio: 'ignore', windowsHide: true });
          child.once('error', () => reject(new Error('Could not open Docker Desktop. Start it manually, then retry.')));
          child.once('spawn', () => { child.unref(); resolve(); });
        });
        const deadline = now() + 180000;
        while (!await engine()) {
          if (now() >= deadline) throw new Error('Docker is still offline. Finish Docker Desktop setup, then retry.');
          await pause(3000);
        }
      }
      const item = await deployment();
      if (action === 'stop') {
        if (item?.running) {
          report('Stopping Pi-hole. Its settings and data volume are retained.');
          await call(['stop', item.id], 60000);
        }
      } else if (item) {
        if (!item.running) {
          report(`Starting the existing ${item.mode} container with its current bindings…`);
          await call(['start', item.id], 60000);
        }
      } else {
        const repository = validateRepository(settings.repository);
        if (!['Local', 'Tailscale'].includes(settings.mode)) throw new Error('Select Local or Tailscale mode.');
        report(`Creating Pi-hole in ${settings.mode} mode through the Windows launcher…`);
        const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', path.join(repository, 'windows/pihole.ps1'), 'Start'];
        if (settings.mode === 'Tailscale') args.push('-Tailscale');
        await execute(powershell, args, { timeout: 240000, env: localEnvironment(environment) });
      }
      const result = await status();
      if (action === 'start' && result.phase !== 'running') throw new Error('Pi-hole has not reached the running state. Check Docker Desktop.');
      if (action === 'stop' && result.deployment?.running) throw new Error('Pi-hole is still running. Check Docker Desktop.');
      return result;
    } finally { busy = false; }
  }

  return { status, action };
}

module.exports = { createBackend, deploymentFromInspect, privateIPv4, validateRepository, localEnvironment, run };
