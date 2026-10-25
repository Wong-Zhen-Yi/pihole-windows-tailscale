const fs = require('node:fs');
const path = require('node:path');

function loadSettings(file, defaultRepository = '') {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Desktop settings could not be read. Restore or rename settings.json in the app data folder.');
  }
  return {
    repository: typeof saved.repository === 'string' ? saved.repository : defaultRepository,
    mode: saved.mode === 'Tailscale' ? 'Tailscale' : 'Local',
    autoStart: saved.autoStart === true
  };
}

function saveSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function loginOptions(executable, packaged, appPath) {
  // Development needs the app path as well as electron.exe; quote paths with spaces.
  return { name: 'Pi-hole Desktop', path: executable,
    args: [...(packaged ? [] : [`"${appPath}"`]), '--startup'] };
}

function loginState(app, options) {
  const state = app.getLoginItemSettings({ path: options.path, args: options.args });
  return { enabled: state.openAtLogin, active: state.openAtLogin && state.executableWillLaunchAtLogin !== false };
}

module.exports = { loadSettings, saveSettings, loginOptions, loginState };
