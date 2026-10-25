const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createBackend, deploymentFromInspect, privateIPv4, localEnvironment, run } = require('../desktop/backend.cjs');
const { loadSettings, saveSettings, loginOptions, loginState } = require('../desktop/settings.cjs');

const id = 'a'.repeat(64);
const repository = path.resolve(__dirname, '..');
function inspect({ running = true, mode = 'Tailscale', ...rest } = {}) {
  return { id, running, health: 'healthy', labels: {
    'com.docker.compose.project': 'pihole-windows',
    'com.docker.compose.service': 'pihole',
    'com.docker.compose.project.config_files': mode === 'Tailscale' ? 'compose.yaml,compose.tailscale.yaml' : 'compose.yaml'
  }, mounts: [{ Type: 'volume', Name: 'pihole-windows_pihole-data', Destination: '/etc/pihole' }],
  ports: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] }, ...rest };
}

function fixture(options = {}) {
  const calls = [];
  let item = options.missing ? null : inspect(options);
  let online = !options.offline;
  let tick = 0;
  const execute = async (file, args, processOptions) => {
    calls.push({ file, args, options: processOptions });
    const verb = args[2];
    if (/powershell\.exe$/.test(file)) { item = inspect({ mode: args.includes('-Tailscale') ? 'Tailscale' : 'Local' }); return ''; }
    if (verb === 'context') return options.remote ? 'tcp://remote:2375' : 'npipe:////./pipe/dockerDesktopLinuxEngine';
    if (verb === 'info') {
      if (!online) throw new Error('offline');
      return options.windows ? 'windows' : 'linux';
    }
    if (verb === 'ps') return options.multiple ? `${id}\n${'b'.repeat(12)}` : item ? id : '';
    if (verb === 'inspect') return JSON.stringify(item);
    if (verb === 'start') item.running = true;
    if (verb === 'stop') item.running = false;
    return '';
  };
  const backend = createBackend({ execute, exists: () => true, now: () => tick,
    environment: { ProgramFiles: path.resolve('test Program Files'), SystemRoot: path.resolve('test Windows'), COMPOSE_PROJECT_NAME: 'wrong', DOCKER_HOST: 'tcp://remote' },
    pause: async () => { tick += 60000; if (!options.timeout) online = true; },
    launch: (file, args, settings) => {
      calls.push({ file, args, options: settings });
      const child = new EventEmitter(); child.unref = () => {};
      process.nextTick(() => child.emit(options.launchError ? 'error' : 'spawn'));
      return child;
    }
  });
  return { backend, calls };
}

test('status uses the local Desktop context and never retrieves container environment', async () => {
  const { backend, calls } = fixture();
  const status = await backend.status();
  assert.equal(status.phase, 'running'); assert.equal(status.deployment.mode, 'Tailscale');
  assert.equal(status.deployment.dashboardUrl, 'http://127.0.0.1:8080/admin/');
  assert.ok(calls.every(call => call.args[0] === '--context' && call.args[1] === 'desktop-linux'));
  const format = calls.find(call => call.args[2] === 'inspect').args[4];
  assert.ok(!format.includes('.Config.Env'));
  assert.ok(!calls.some(call => ['start', 'stop', 'compose'].includes(call.args[2])));
});

test('start preserves an existing Tailscale container even when preference is Local', async () => {
  const { backend, calls } = fixture({ running: false });
  assert.equal((await backend.action('start', { mode: 'Local' })).phase, 'running');
  assert.ok(calls.some(call => call.args[2] === 'start' && call.args[3] === id));
  assert.ok(!calls.some(call => /powershell/.test(call.file)));
});

test('starting an already running container is read-only', async () => {
  const { backend, calls } = fixture();
  await backend.action('start', {});
  assert.ok(!calls.some(call => call.args[2] === 'start'));
});

for (const mode of ['Local', 'Tailscale']) test(`missing container uses launcher and ${mode} mode with paths containing spaces`, async () => {
  const { backend, calls } = fixture({ missing: true });
  await backend.action('start', { mode, repository });
  const command = calls.find(call => /powershell\.exe$/.test(call.file));
  assert.ok(command); assert.equal(command.args.includes('-Tailscale'), mode === 'Tailscale');
  assert.equal(command.args[command.args.indexOf('-File') + 1], path.join(repository, 'windows/pihole.ps1'));
  assert.equal(command.options.env.DOCKER_CONTEXT, 'desktop-linux');
  assert.equal(command.options.env.COMPOSE_PROJECT_NAME, undefined);
  assert.equal(command.options.env.DOCKER_HOST, undefined);
});

test('invalid mode, repository and unsupported commands cannot dispatch a launcher', async () => {
  const { backend, calls } = fixture({ missing: true });
  await assert.rejects(backend.action('start', { repository, mode: 'Tailscale; exit' }), /Select Local/);
  await assert.rejects(backend.action('start', { repository: '.', mode: 'Local' }), /Choose this/);
  await assert.rejects(backend.action('remove', {}), /Unsupported/);
  assert.ok(!calls.some(call => /powershell\.exe$/.test(call.file)));
});

test('stop targets the verified existing container without deleting storage', async () => {
  const { backend, calls } = fixture();
  assert.equal((await backend.action('stop', {})).phase, 'stopped');
  assert.ok(calls.some(call => call.args[2] === 'stop' && call.args[3] === id));
  assert.ok(!calls.some(call => call.args.some(arg => /^(rm|down|volume|--volumes)$/.test(arg))));
});

test('cold start opens Docker hidden and waits; offline Stop does not launch Docker', async () => {
  const { backend, calls } = fixture({ offline: true, running: false });
  assert.equal((await backend.action('start', {})).phase, 'running');
  const desktop = calls.find(call => /Docker Desktop\.exe$/.test(call.file));
  assert.equal(desktop.options.windowsHide, true);
  const offline = fixture({ offline: true });
  await assert.rejects(offline.backend.action('stop', {}), /offline/);
  assert.ok(!offline.calls.some(call => /Docker Desktop\.exe$/.test(call.file)));
});

test('cold startup timeout and launch errors are actionable and release operation lock', async () => {
  const timed = fixture({ offline: true, timeout: true });
  await assert.rejects(timed.backend.action('start', {}), /still offline/);
  await assert.rejects(timed.backend.action('stop', {}), /offline/);
  const failed = fixture({ offline: true, launchError: true });
  await assert.rejects(failed.backend.action('start', {}), /Start it manually/);
});

test('remote context, Windows engine and ambiguous deployments fail before writes', async () => {
  for (const options of [{ remote: true }, { windows: true }, { multiple: true }]) {
    const { backend, calls } = fixture(options);
    await assert.rejects(backend.action('start', {}));
    assert.ok(!calls.some(call => ['start', 'stop'].includes(call.args[2])));
  }
});

test('unexpected volume or labels are rejected and public/dashboard catch-all bindings cannot open', () => {
  assert.throws(() => deploymentFromInspect(inspect({ mounts: [] })), /data volume/);
  assert.throws(() => deploymentFromInspect(inspect({ labels: {} })), /data volume/);
  for (const HostIp of ['0.0.0.0', '::', '8.8.8.8', 'example.com', '127.0.0.1;cmd']) {
    assert.equal(deploymentFromInspect(inspect({ ports: { '80/tcp': [{ HostIp, HostPort: '8080' }] } })).dashboardUrl, null);
  }
  for (const ip of ['127.0.0.1', '192.168.1.2', '10.0.0.1', '172.16.0.1', '100.64.0.1']) assert.equal(privateIPv4(ip), true);
  for (const HostPort of ['0', '65536', '8080/admin/?bad', 'NaN']) {
    assert.equal(deploymentFromInspect(inspect({ ports: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort }] } })).dashboardUrl, null);
  }
});

test('process failures do not disclose raw output and run uses an argument array', async () => {
  assert.equal(await run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'a b; literal']), 'a b; literal');
  await assert.rejects(run(process.execPath, ['-e', 'console.error("private-password");process.exit(1)']), error => !error.message.includes('private-password'));
});

test('environment sanitization is case insensitive and retains ordinary settings', () => {
  assert.deepEqual(localEnvironment({ Docker_Host: 'remote', compose_file: 'bad', PIHOLE_IMAGE: 'pihole/pihole:latest', Path: 'tools' }),
    { PIHOLE_IMAGE: 'pihole/pihole:latest', Path: 'tools', DOCKER_CONTEXT: 'desktop-linux' });
});

test('settings defaults are opt-in, persist outside checkout, and corrupt files are not silently overwritten', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pihole-desktop-'));
  const file = path.join(temp, 'settings.json');
  try {
    assert.deepEqual(loadSettings(file, repository), { repository, mode: 'Local', autoStart: false });
    const settings = { repository, mode: 'Tailscale', autoStart: true };
    saveSettings(file, settings); assert.deepEqual(loadSettings(file), settings);
    fs.writeFileSync(file, '{bad'); assert.throws(() => loadSettings(file), /could not be read/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('Windows startup has a stable per-user name, quoted development path and OS disabled status', () => {
  const development = loginOptions('C:\\Program Files\\Electron\\electron.exe', false, 'C:\\My Projects\\desktop');
  assert.deepEqual(development.args, ['"C:\\My Projects\\desktop"', '--startup']);
  const packaged = loginOptions('C:\\My Apps\\Pi-hole Desktop.exe', true, '.');
  assert.deepEqual(packaged.args, ['--startup']);
  assert.equal(packaged.name, 'Pi-hole Desktop');
  assert.deepEqual(loginState({ getLoginItemSettings: () => ({ openAtLogin: true, executableWillLaunchAtLogin: false }) }, packaged), { enabled: true, active: false });
});

test('preload exposes fixed operations and no generic IPC or shell access', async () => {
  let bridge;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(repository, 'desktop/preload.cjs'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return {
      contextBridge: { exposeInMainWorld: (name, api) => { assert.equal(name, 'pihole'); bridge = api; } },
      ipcRenderer: { invoke: (...args) => calls.push(args), on() {}, removeListener() {} }
    }; }
  });
  await bridge.setStartup(true); await bridge.start();
  assert.equal(calls[0][0], 'pihole:startup'); assert.equal(calls[0][1], true);
  assert.equal(calls[1][0], 'pihole:start');
  assert.equal(bridge.invoke, undefined); assert.equal(bridge.exec, undefined);
});

async function mainFixture({ autoStart = false, startup = false } = {}) {
  const calls = [], handlers = new Map();
  let window;
  const snapshot = { phase: 'running', engine: true, deployment: deploymentFromInspect(inspect()) };
  const app = new EventEmitter();
  Object.assign(app, {
    setName() {}, requestSingleInstanceLock: () => true, whenReady: async () => {},
    setAppUserModelId() {}, getPath: () => 'fixture-user-data', isPackaged: true,
    getAppPath: () => repository, quit: () => calls.push('quit'),
    getLoginItemSettings: () => ({ openAtLogin: startup, executableWillLaunchAtLogin: startup }),
    setLoginItemSettings: value => { startup = value.openAtLogin; calls.push(['startup', value]); }
  });
  class Window extends EventEmitter {
    constructor(options) {
      super(); window = this; this.options = options;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        mainFrame: { url: '' }, send() {}, setWindowOpenHandler: callback => { this.popup = callback; },
        session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }
      });
    }
    async loadFile(file) { this.webContents.mainFrame.url = require('node:url').pathToFileURL(file).href; }
    removeMenu() {} isDestroyed() { return false; } isMinimized() { return false; }
    show() { calls.push('show'); } focus() {} hide() { calls.push('hide'); }
  }
  const context = {
    __dirname: path.resolve(__dirname, '../desktop'),
    process: { platform: 'win32', argv: startup ? ['app.exe', '--startup'] : ['app.exe'], execPath: 'C:\\My Apps\\Pi-hole Desktop.exe' },
    setInterval: () => ({ unref() {} }),
    require: name => {
      if (name === 'electron') return {
        app, BrowserWindow: Window, ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
        dialog: { showMessageBox: async () => ({ response: 0 }), showErrorBox: message => { throw new Error(message); } },
        shell: { openExternal: async url => calls.push(['open', url]) },
        Tray: class { setContextMenu() {} on() {} setToolTip() {} },
        Menu: { buildFromTemplate: value => value }, nativeImage: { createFromPath() {} }
      };
      if (name === './backend.cjs') return { validateRepository: () => repository, createBackend: () => ({
        status: async () => snapshot,
        action: async action => { calls.push(['action', action]); return snapshot; }
      }) };
      if (name === './settings.cjs') return { ...require('../desktop/settings.cjs'),
        loadSettings: () => ({ repository, mode: 'Local', autoStart }),
        saveSettings: (_file, settings) => calls.push(['save', settings])
      };
      return require(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(repository, 'desktop/main.cjs'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  const event = () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const invoke = (name, value) => handlers.get(`pihole:${name}`)(event(), value);
  return { calls, handlers, window, invoke };
}

test('main starts read-only, authenticates IPC, isolates renderer and hides on close', async () => {
  const fixture = await mainFixture();
  assert.ok(!fixture.calls.some(call => Array.isArray(call) && ['action', 'startup'].includes(call[0])));
  assert.equal(fixture.window.options.webPreferences.nodeIntegration, false);
  assert.equal(fixture.window.options.webPreferences.contextIsolation, true);
  assert.equal(fixture.window.options.webPreferences.sandbox, true);
  assert.equal(fixture.window.popup().action, 'deny');
  assert.equal((await fixture.invoke('state')).data.phase, 'running');
  const callback = fixture.handlers.get('pihole:start');
  await assert.rejects(callback({ sender: {}, senderFrame: { url: 'https://example.com' } }), /Untrusted/);
  let prevented = false;
  fixture.window.emit('close', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true); assert.ok(fixture.calls.includes('hide'));
  await fixture.invoke('stop'); // Default native confirmation cancels.
  assert.ok(!fixture.calls.some(call => call[0] === 'action'));
});

test('main startup switch registers and removes current-user launch entry independently of Pi-hole auto-start', async () => {
  const fixture = await mainFixture();
  assert.equal((await fixture.invoke('startup', true)).data.startup.enabled, true);
  assert.equal((await fixture.invoke('startup', false)).data.startup.enabled, false);
  const startupCalls = fixture.calls.filter(call => call[0] === 'startup');
  assert.equal(startupCalls.length, 2);
  assert.equal(startupCalls[0][1].path, 'C:\\My Apps\\Pi-hole Desktop.exe');
  assert.equal(startupCalls[0][1].args[0], '--startup');
  assert.equal(startupCalls[0][1].name, 'Pi-hole Desktop');
  assert.ok(!fixture.calls.some(call => call[0] === 'action'));
  assert.equal((await fixture.invoke('startup', 'true')).ok, false);
});

test('opted-in Pi-hole startup runs once; sign-in launch hides the window', async () => {
  const fixture = await mainFixture({ startup: true, autoStart: true });
  assert.equal(fixture.calls.filter(call => call[0] === 'action' && call[1] === 'start').length, 1);
  assert.ok(!fixture.calls.includes('show'));
  assert.ok(!fixture.calls.some(call => call[0] === 'startup'));
  const hidden = await mainFixture({ startup: true });
  assert.ok(!hidden.calls.some(call => call[0] === 'action'));
});
