// Optional Windows smoke test: packaged Electron + read-only local Docker status.
// Requires Playwright. Refuses saved auto-start, and mocks Windows startup writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require(require.resolve('playwright', { paths: [path.resolve(__dirname, '../desktop')] }));
const { loadSettings } = require('../desktop/settings.cjs');

(async () => {
  if (process.platform !== 'win32') throw new Error('This smoke test requires Windows.');
  const preferences = path.join(process.env.APPDATA, 'Pi-hole Desktop/settings.json');
  if (loadSettings(preferences).autoStart) throw new Error('Disable Pi-hole auto-start before this read-only smoke test.');
  const executablePath = process.env.PIHOLE_DESKTOP_EXECUTABLE ||
    path.resolve(__dirname, `../desktop/dist/Pi-hole Desktop-win32-${process.arch}/Pi-hole Desktop.exe`);
  const application = await electron.launch({ executablePath, timeout: 30000 });
  try {
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => window.pihole && document.getElementById('status-badge').textContent !== 'Checking');
    let result = await page.evaluate(() => window.pihole.getState());
    assert.equal(result.ok, true);
    assert.equal(result.data.phase, 'running', result.data.message || 'Start Pi-hole manually before testing a running deployment.');
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await page.locator('#dashboard').isEnabled(), true);
    assert.equal(await page.locator('#start').isDisabled(), true);
    await application.evaluate(({ BrowserWindow }) => {
      const options = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      if (!options.sandbox || !options.contextIsolation || options.nodeIntegration) throw new Error('Unexpected renderer security settings.');
    });

    // Test the actual preload -> IPC -> main -> UI path without registry writes.
    await application.evaluate(({ app }) => {
      let enabled = false;
      app.setLoginItemSettings = settings => { enabled = settings.openAtLogin; };
      app.getLoginItemSettings = () => ({ openAtLogin: enabled, executableWillLaunchAtLogin: enabled });
    });
    await page.locator('#refresh').click();
    await page.locator('#startup-settings').click();
    await page.locator('#launch-startup').check();
    await page.waitForFunction(() => document.getElementById('startup-summary').textContent.startsWith('Launch at sign-in is on.'));
    assert.equal(await page.locator('#auto-start').isChecked(), false);
    await page.locator('#launch-startup').uncheck();
    await page.waitForFunction(() => document.getElementById('startup-summary').textContent.startsWith('Launch at sign-in is off.'));
    await page.getByRole('button', { name: 'Overview', exact: false }).click();
    const screenshot = path.join(os.tmpdir(), 'pihole-desktop-live.png');
    await page.screenshot({ path: screenshot });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    assert.deepEqual(errors, []);
    assert.equal(fs.existsSync(screenshot), true);
    console.log('Packaged Electron smoke passed: live read-only container status, sandboxed IPC, mocked startup switch and close-to-tray.');
  } finally { await application.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
