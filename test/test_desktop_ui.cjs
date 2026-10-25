// Optional rendered UI checks. Uses Playwright + Chrome; all desktop actions are mocked.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(require.resolve('playwright', { paths: [path.resolve(__dirname, '../desktop')] }));
const { pathToFileURL } = require('node:url');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1160, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const state = {
        phase: 'running', engine: true, operating: false,
        deployment: { running: true, mode: 'Tailscale', health: 'healthy', dashboardUrl: 'http://127.0.0.1:8080/admin/' },
        settings: { repository: 'C:\\Example Checkout\\pi-hole', mode: 'Local', autoStart: false },
        startup: { enabled: false, active: false }, activity: []
      };
      window.__state = state; window.__calls = []; window.__fail = false;
      const reply = () => ({ ok: true, data: structuredClone(state) });
      window.pihole = {
        getState: async () => reply(),
        onState: callback => { window.__publish = () => callback(structuredClone(state)); },
        start: async () => { window.__calls.push('start'); state.phase = 'running'; state.deployment.running = true; return reply(); },
        stop: async () => { window.__calls.push('stop'); state.phase = 'stopped'; state.deployment.running = false; return reply(); },
        openDashboard: async () => { window.__calls.push('dashboard'); return { ok: true }; },
        setStartup: async enabled => {
          window.__calls.push(['startup', enabled]);
          if (window.__fail) return { ok: false, error: 'Windows did not save the startup preference.' };
          state.startup = { enabled, active: enabled }; return reply();
        },
        saveSettings: async settings => { window.__calls.push(['settings', settings]); Object.assign(state.settings, settings); return reply(); },
        chooseRepository: async () => { state.settings.repository = 'C:\\Other Checkout'; return reply(); },
        openGuide: async () => ({ ok: true }), quit: async () => ({ ok: true })
      };
    });
    await page.goto(pathToFileURL(path.resolve(__dirname, '../desktop/index.html')).href);
    await page.getByText('Pi-hole is running', { exact: true }).waitFor();
    assert.equal(await page.locator('#start').isDisabled(), true);
    assert.equal(await page.locator('#dashboard').isEnabled(), true);
    assert.equal(await page.locator('#mode-value').textContent(), 'Tailscale');
    await page.locator('#dashboard').click();
    await page.locator('#stop').click();
    await page.getByText('A quiet moment', { exact: true }).waitFor();
    assert.equal(await page.locator('#stop').isDisabled(), true);
    await page.locator('#start').click();
    await page.getByText('Pi-hole is running', { exact: true }).waitFor();

    await page.locator('#startup-settings').click();
    assert.equal(await page.locator('#overview').isVisible(), false);
    await page.locator('#launch-startup').check();
    await page.waitForFunction(() => window.__state.startup.enabled);
    assert.equal(await page.locator('#auto-start').isChecked(), false);
    await page.locator('#auto-start').check();
    await page.waitForFunction(() => window.__state.settings.autoStart);
    await page.locator('#mode').selectOption('Tailscale');
    await page.waitForFunction(() => window.__state.settings.mode === 'Tailscale');
    await page.locator('#choose-repository').click();
    await page.getByText('C:\\Other Checkout', { exact: true }).waitFor();

    await page.evaluate(() => { window.__fail = true; });
    // A rejected write immediately restores the saved value, so use click here.
    await page.locator('#launch-startup').click();
    await page.getByRole('alert').getByText('Windows did not save the startup preference.').waitFor();
    assert.equal(await page.locator('#launch-startup').isChecked(), true);
    await page.evaluate(() => { window.__state.startup.active = false; window.__publish(); });
    await page.getByText('Windows has disabled this startup entry.', { exact: false }).waitFor();

    await page.evaluate(() => {
      window.__state.activity = [{ time: new Date().toISOString(), message: '<img src=x onerror=alert(1)>' }];
      window.__state.phase = 'error'; window.__state.message = 'Docker fixture unavailable';
      window.__publish();
    });
    await page.getByRole('button', { name: 'Activity', exact: false }).click();
    assert.equal(await page.locator('#full-activity img').count(), 0);
    assert.ok((await page.locator('#full-activity').textContent()).includes('<img src=x onerror=alert(1)>'));
    await page.getByRole('button', { name: 'Overview', exact: false }).click();
    await page.getByText('A little attention needed').waitFor();
    assert.equal(await page.locator('#dashboard').isDisabled(), true);

    await page.evaluate(() => {
      window.__state.phase = 'offline'; window.__state.engine = false; window.__state.deployment = null;
      window.__state.startup = { enabled: false, active: false }; window.__state.activity = [];
      window.__publish();
    });
    await page.getByText('Let’s get connected').waitFor();
    for (const width of [880, 1160, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    if (process.env.PIHOLE_DESKTOP_SCREENSHOT) await page.screenshot({ path: process.env.PIHOLE_DESKTOP_SCREENSHOT, fullPage: true });
    assert.deepEqual(errors, []);
    assert.ok((await page.evaluate(() => window.__calls)).some(call => call[0] === 'startup' && call[1] === true));
    console.log('Desktop UI checks passed: service states, controls, startup toggles, errors, safe text and responsive layout.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
