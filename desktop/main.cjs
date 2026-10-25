const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createBackend, validateRepository } = require('./backend.cjs');
const { loadSettings, saveSettings, loginOptions, loginState } = require('./settings.cjs');

app.setName('Pi-hole Desktop');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window, tray, settings, settingsFile, login, backend;
  let quitting = false;
  let operating = false;
  let checking = false;
  let snapshot = { phase: 'checking', engine: false, deployment: null };
  const activity = [];
  const page = pathToFileURL(path.join(__dirname, 'index.html')).href;

  function report(message) {
    activity.unshift({ time: new Date().toISOString(), message });
    activity.splice(40);
    publish();
  }

  function state() {
    return { ...snapshot, operating, settings, startup: loginState(app, login), activity: [...activity] };
  }

  function publish() {
    if (window && !window.isDestroyed()) window.webContents.send('pihole:state', state());
    if (tray) tray.setToolTip(`Pi-hole Desktop — ${operating ? 'working' : snapshot.phase}`);
  }

  async function refresh() {
    if (operating || checking) return state();
    checking = true;
    try { snapshot = await backend.status(); }
    catch (error) { snapshot = { phase: 'error', engine: false, deployment: null, message: error.message }; }
    finally { checking = false; }
    publish();
    return state();
  }

  async function perform(action) {
    if (operating || checking) throw new Error('Wait for the current operation to finish.');
    operating = true;
    report(action === 'start' ? 'Checking the local Pi-hole deployment…' : 'Checking Pi-hole before stopping…');
    try {
      snapshot = await backend.action(action, settings, report);
      report(action === 'start' ? 'Pi-hole container is running. Client DNS has not been tested.' : 'Pi-hole is stopped. Its data volume is retained.');
    } catch (error) {
      report(error.message);
      throw error;
    } finally {
      operating = false;
      await refresh();
    }
    return state();
  }

  function show() {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  async function openDashboard() {
    const current = await backend.status();
    if (!current.deployment?.running || !current.deployment.dashboardUrl) {
      throw new Error('Start Pi-hole with a private IPv4 dashboard binding first.');
    }
    // The URL is constructed from a verified local container, never renderer input.
    await shell.openExternal(current.deployment.dashboardUrl);
  }

  function handle(name, callback) {
    ipcMain.handle(`pihole:${name}`, async (event, value) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) {
        throw new Error('Untrusted desktop request.');
      }
      try { return { ok: true, data: await callback(value) }; }
      catch (error) { return { ok: false, error: error.message }; }
    });
  }

  app.on('second-instance', show);
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* Remain available in the notification area. */ });
  app.on('activate', show);

  app.whenReady().then(async () => {
    if (process.platform !== 'win32') throw new Error('Pi-hole Desktop currently supports Windows with Docker Desktop.');
    app.setAppUserModelId('org.pihole.windows.desktop');
    settingsFile = path.join(app.getPath('userData'), 'settings.json');
    let repository = '';
    // Packaged builds also discover a checkout containing desktop/dist/<app>.
    const roots = [path.resolve(__dirname, '..'), path.resolve(path.dirname(process.execPath), '../../..')];
    for (const root of roots) {
      try { repository = validateRepository(root); break; } catch { /* Ask in Settings if the checkout moved. */ }
    }
    settings = loadSettings(settingsFile, repository);
    login = loginOptions(process.execPath, app.isPackaged, app.getAppPath());
    backend = createBackend();
    const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
    window = new BrowserWindow({
      width: 1160, height: 820, minWidth: 880, minHeight: 680,
      title: 'Pi-hole Desktop', backgroundColor: '#f5f6f8', icon, show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, webviewTag: false, spellcheck: false }
    });
    window.removeMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.on('close', event => {
      if (!quitting) { event.preventDefault(); window.hide(); }
    });
    tray = new Tray(icon);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Pi-hole Desktop', click: show },
      { label: 'Open dashboard', click: () => openDashboard().catch(error => { show(); report(error.message); }) },
      { type: 'separator' },
      { label: 'Quit app (Pi-hole keeps running)', click: () => app.quit() }
    ]));
    tray.on('double-click', show);

    handle('state', refresh);
    handle('start', () => perform('start'));
    handle('stop', async () => {
      if (operating || checking) throw new Error('Wait for the current operation to finish.');
      const answer = await dialog.showMessageBox(window, {
        type: 'warning', title: 'Stop Pi-hole?',
        message: 'Devices using this Pi-hole may lose DNS resolution.',
        detail: 'Restore working DNS on dependent devices before an extended shutdown. Stored Pi-hole settings will be kept.',
        buttons: ['Keep running', 'Stop Pi-hole'], defaultId: 0, cancelId: 0, noLink: true
      });
      return answer.response === 1 ? perform('stop') : state();
    });
    handle('dashboard', openDashboard);
    handle('settings', value => {
      if (operating || checking) throw new Error('Wait for the current operation to finish.');
      if (!value || !['Local', 'Tailscale'].includes(value.mode) || typeof value.autoStart !== 'boolean') {
        throw new Error('Invalid desktop settings.');
      }
      const next = { ...settings, mode: value.mode, autoStart: value.autoStart };
      saveSettings(settingsFile, next);
      settings = next;
      report('Desktop preferences saved. Existing container bindings are preserved.');
      return state();
    });
    handle('startup', enabled => {
      if (typeof enabled !== 'boolean') throw new Error('Invalid startup preference.');
      app.setLoginItemSettings({ ...login, openAtLogin: enabled });
      const result = loginState(app, login);
      if (result.enabled !== enabled) throw new Error('Windows did not save the startup preference. Check Settings > Apps > Startup.');
      report(enabled ? 'Launch at Windows sign-in enabled for this user.' : 'Launch at Windows sign-in disabled.');
      return state();
    });
    handle('repository', async () => {
      if (operating || checking) throw new Error('Wait for the current operation to finish.');
      const result = await dialog.showOpenDialog(window, { title: 'Choose the Pi-hole fork repository', properties: ['openDirectory'] });
      if (!result.canceled) {
        if (operating || checking) throw new Error('Wait for the current operation to finish.');
        const next = { ...settings, repository: validateRepository(result.filePaths[0]) };
        saveSettings(settingsFile, next);
        settings = next;
        report('Repository folder saved. Its private .env was not changed.');
      }
      return state();
    });
    handle('guide', () => {
      const root = validateRepository(settings.repository);
      return shell.openPath(path.join(root, 'windows/README.md'));
    });
    handle('quit', () => app.quit());

    await window.loadFile(path.join(__dirname, 'index.html'));
    if (!process.argv.includes('--startup')) show();
    await refresh();
    // This preference is off by default and independent of Windows login registration.
    if (settings.autoStart) await perform('start').catch(() => show());
    const timer = setInterval(() => refresh().catch(() => {}), 15000);
    timer.unref();
  }).catch(error => {
    dialog.showErrorBox('Pi-hole Desktop could not open', error.message);
    app.quit();
  });
}
