// Optional browser checks: requires Playwright and an installed Google Chrome.
// All Pi-hole API responses are mocked; no user profile or live DNS is touched.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

(async () => {
  const base = path.resolve(__dirname, "../chrome-extension");
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname.startsWith("/api/")) {
      // Exercise native Window.fetch against a local fixture, not a fetch mock.
      const payload = pathname === "/api/auth" ? { session: { valid: true, sid: "fixture-session" } }
        : pathname === "/api/stats/summary" ? { queries: { total: 100, blocked: 25 } }
        : { blocking: "enabled", timer: null };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(payload));
      return;
    }
    if (!/^\/(popup\.(html|css|js)|(?:api|view|launcher)\.mjs|icons\/(16|32|48|128)\.png)$/.test(pathname)) { res.writeHead(404).end(); return; }
    const file = path.join(base, pathname);
    res.setHeader("Content-Type", /\.m?js$/.test(file) ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".png") ? "image/png" : "text/html");
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 460, height: 600 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", response => { if (/\.m?js$/.test(response.url()) && response.status() !== 200) errors.push(`Script failed: ${response.status()}`); });
    await page.addInitScript(() => {
      const local = {}, session = {};
      const store = data => ({ get: async key => ({ [key]: data[key] }), set: async value => Object.assign(data, value), remove: async key => { delete data[key]; } });
      window.__calls = [];
      window.__mock = { failClient: false, writeDenied: false, expired: false, empty: false, helperMissing: false, nativeDenied: false };
      window.__nativeCalls = [];
      window.__tabs = [];
      window.__storage = { local, session };
      window.chrome = {
        storage: { local: store(local), session: store(session) },
        permissions: { request: async value => value.permissions ? !window.__mock.nativeDenied : true, contains: async () => true, remove: async () => true },
        tabs: { query: async () => [{ url: "https://www.example.com/a?private=1" }], create: async value => { window.__tabs.push(value); } },
        runtime: { id: "a".repeat(32), getURL: value => `chrome-extension://test/${value}`, sendNativeMessage: async (host, request) => {
          window.__nativeCalls.push({ host, request });
          if (window.__mock.helperMissing) throw new Error("not installed");
          return { ok: true, phase: request.action === "start" ? "starting" : "running", mode: "Tailscale", message: request.action === "start" ? "Launch requested" : "Pi-hole container is running" };
        } }
      };
      window.__poll = null;
      window.setInterval = (callback, delay) => { window.__poll = callback; window.__delay = delay; return 1; };
      window.clearInterval = () => { window.__poll = null; };
      window.fetch = async (url, options) => {
        window.__calls.push({ url, method: options.method, body: options.body });
        const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
        if (window.__mock.expired) return reply({}, 401);
        if (url.endsWith("/auth")) return reply({ session: { valid: true, sid: "mock-session" } });
        if (url.endsWith("stats/summary")) return reply({ queries: { total: 12840, blocked: 3245, percent_blocked: 25.27, cached: 4095, forwarded: 5500, unique_domains: 731, frequency: 2.4 }, clients: { active: 6 }, gravity: { domains_being_blocked: 178430, last_update: 1700000000 } });
        if (url.includes("stats/top_domains")) return reply({ domains: [{ domain: "ads.example.com", count: 1820 }, { domain: "metrics.example.com", count: 1125 }, { domain: "<img src=x onerror=alert(1)>", count: 300 }] });
        if (url.includes("stats/top_clients")) return window.__mock.failClient ? reply({}, 403) : reply({ clients: [{ name: "Laptop", count: 8130 }, { name: "Phone", count: 4710 }] });
        if (url.includes("stats/upstreams")) return reply({ upstreams: [{ name: "Resolver", count: 5500, port: 53, statistics: { response: 0.014 } }, { name: "cache", port: -1, count: 4095 }] });
        if (url.includes("/queries?")) return reply({ queries: window.__mock.empty ? [] : [{ time: 1700000000, domain: "ads.example.com", client: { name: "Laptop" }, status: "GRAVITY", type: "A", reply: { type: "IP" } }, { time: 1700000001, domain: "<svg onload=alert(1)>", client: { name: "Phone" }, status: "CACHE", type: "AAAA", reply: { type: "IP" } }] });
        if (url.includes("/domains/")) {
          if (options.method === "GET") return reply({ domains: [] });
          return window.__mock.writeDenied ? reply({}, 403) : reply({ processed: { errors: [], success: [{ item: "www.example.com" }] } }, 201);
        }
        return reply({ blocking: "enabled", timer: null });
      };
    });
    const idle = () => page.waitForFunction(() => !document.getElementById("connect").disabled);
    const click = async id => { await page.locator(`#${id}`).click(); await idle(); };
    await page.goto(`http://127.0.0.1:${server.address().port}/popup.html`);
    await idle();
    // Dashboard access is prominent and works without an API session or helper.
    const dashboard = page.getByRole("button", { name: "Open dashboard" });
    assert.ok(await dashboard.isVisible());
    assert.ok(await dashboard.evaluate(button => button.getBoundingClientRect().bottom <= innerHeight));
    for (const address of ["http://localhost:8080", "http://localhost:8080/admin/", "https://pi.hole:8443/admin"]) {
      await page.locator("#server").fill(address);
      await click("dashboard");
      assert.deepEqual(await page.evaluate(() => window.__tabs.at(-1)), { url: `${new URL(address).origin}/admin/` });
    }
    assert.equal(await page.evaluate(() => window.__calls.length), 0);
    const openedTabs = await page.evaluate(() => window.__tabs.length);
    await page.locator("#server").fill("http://localhost:8080/wrong-path");
    await click("dashboard");
    assert.equal(await page.evaluate(() => window.__tabs.length), openedTabs);
    assert.ok(await page.locator("#error").isVisible());
    await page.locator("#server").fill("http://localhost:8080");
    assert.ok(await page.locator("#launch-pihole").isVisible());
    assert.ok((await page.locator("#launch-setup").textContent()).includes("a".repeat(32)));
    // Launch controls work before API login and handle setup/permission failures.
    await page.evaluate(() => { window.__mock.nativeDenied = true; });
    await click("launch-status");
    await page.waitForFunction(() => !document.getElementById("launch-status").disabled);
    assert.match(await page.locator("#launch-message").textContent(), /not allowed/);
    assert.equal(await page.evaluate(() => window.__nativeCalls.length), 0);
    await page.evaluate(() => { window.__mock.nativeDenied = false; window.__mock.helperMissing = true; });
    await click("launch-status");
    await page.waitForFunction(() => !document.getElementById("launch-status").disabled);
    assert.match(await page.locator("#launch-message").textContent(), /helper unavailable/);
    await page.evaluate(() => { window.__mock.helperMissing = false; });
    await click("launch-pihole");
    await page.waitForFunction(() => !document.getElementById("launch-pihole").disabled);
    assert.match(await page.locator("#launch-message").textContent(), /container is running/);
    assert.ok(await page.evaluate(() => window.__nativeCalls.some(call => call.request.action === "start")));
    assert.equal(await page.locator("#workspace").isVisible(), false);
    await page.locator("#password").fill("mock-password");
    await click("connect");
    assert.equal(await page.locator("#status").textContent(), "Blocking is active");
    assert.equal(await page.locator("#password").inputValue(), "");
    assert.equal(await page.locator("#server-name").textContent(), "http://localhost:8080/admin/");
    await click("dashboard");
    assert.deepEqual(await page.evaluate(() => window.__tabs.at(-1)), { url: "http://localhost:8080/admin/" });
    assert.equal(await page.locator("#gravity").textContent(), "178,430");
    assert.equal(await page.locator("#frequency").textContent(), "2.4");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 460);
    await page.screenshot({ path: path.join(os.tmpdir(), "pihole-companion-overview.png"), fullPage: true });
    await click("nav-activity");
    assert.equal(await page.locator("#top-blocked .rank-row").count(), 3);
    assert.equal(await page.locator("#top-blocked img").count(), 0);
    assert.match(await page.locator("#top-blocked").textContent(), /<img/);
    await page.evaluate(() => { window.__mock.failClient = true; });
    await click("refresh");
    assert.match(await page.locator("#top-clients").textContent(), /denied/);
    assert.equal(await page.locator("#status").textContent(), "Blocking is active");
    assert.equal(await page.locator("#top-blocked .rank-row").count(), 3);
    await page.screenshot({ path: path.join(os.tmpdir(), "pihole-companion-activity.png"), fullPage: true });
    await click("nav-queries");
    assert.equal(await page.locator("#query-results tbody tr").count(), 2);
    assert.equal(await page.locator("#query-results svg").count(), 0);
    await page.locator("#query-domain").fill("Example.COM");
    await page.locator("#queries-blocked").check();
    await click("query-search");
    assert.ok(await page.evaluate(() => window.__calls.some(call => call.url.endsWith("queries?length=25&domain=example.com&upstream=blocklist"))));
    await page.screenshot({ path: path.join(os.tmpdir(), "pihole-companion-queries.png"), fullPage: true });
    await page.evaluate(() => { window.__mock.empty = true; });
    await click("refresh");
    assert.equal(await page.locator("#query-results tbody tr").count(), 0);
    assert.match(await page.locator("#query-results").textContent(), /No matching queries/);
    await click("nav-tools");
    await click("current-site");
    assert.equal(await page.locator("#rule-domain").inputValue(), "www.example.com");
    await click("allow-domain");
    assert.ok(await page.locator("#rule-review").isVisible());
    assert.equal(await page.evaluate(() => window.__calls.filter(call => call.url.includes("/domains/") && call.method === "POST").length), 0);
    await page.screenshot({ path: path.join(os.tmpdir(), "pihole-companion-tools.png"), fullPage: true });
    await page.locator("#rule-domain").fill("changed.example.com");
    assert.equal(await page.locator("#rule-review").isVisible(), false);
    await click("deny-domain");
    await page.evaluate(() => { window.__mock.writeDenied = true; });
    await click("confirm-rule");
    assert.match(await page.locator("#error").textContent(), /denied/);
    assert.equal(await page.locator("#status").textContent(), "Blocking is active");
    assert.equal(await page.locator("#rule-message").textContent(), "");
    await page.evaluate(() => { window.__mock.writeDenied = false; });
    await click("deny-domain"); await click("confirm-rule");
    assert.match(await page.locator("#rule-message").textContent(), /Added block rule/);
    assert.deepEqual(await page.evaluate(() => Object.keys(window.__storage.local)), ["server"]);
    await page.locator("#auto-refresh").check();
    assert.equal(await page.evaluate(() => window.__delay), 15000);
    await page.evaluate(() => { window.__mock.expired = true; window.__poll(); });
    await idle();
    assert.equal(await page.locator("#workspace").isVisible(), false);
    assert.equal(await page.locator("#query-results").textContent(), "");
    assert.equal(await page.evaluate(() => window.__poll), null);
    assert.deepEqual(await page.evaluate(() => window.__storage.session), {});
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto(`http://127.0.0.1:${server.address().port}/popup.html?view=full`);
    await idle();
    assert.equal(await page.locator("body").getAttribute("data-expanded"), "true");
    assert.equal(await page.locator("#expand").isVisible(), false);
    assert.ok(await dashboard.isVisible());
    await click("dashboard");
    assert.deepEqual(await page.evaluate(() => window.__tabs.at(-1)), { url: "http://localhost:8080/admin/" });
    // A separate context has the browser's genuine fetch implementation. Mocks
    // cannot catch the Window receiver requirement that broke real logins.
    const nativeContext = await browser.newContext({ viewport: { width: 190, height: 600 } });
    await nativeContext.addInitScript(() => {
      // Only extension storage is stubbed in this context; fetch stays native.
      window.chrome = { runtime: { id: "a".repeat(32) }, storage: { local: { get: async () => ({}) }, session: { get: async () => ({}) } } };
    });
    const nativePage = await nativeContext.newPage();
    await nativePage.goto(`http://127.0.0.1:${server.address().port}/popup.html`);
    const nativeResult = await nativePage.evaluate(async () => {
      const { PiholeApi } = await import("./api.mjs");
      const api = new PiholeApi(location.origin);
      const sid = await api.login("fixture-password");
      const { summary, state } = await api.overview();
      await api.logout();
      return { sid, total: summary.queries.total, blocking: state.blocking };
    });
    assert.deepEqual(nativeResult, { sid: "fixture-session", total: 100, blocking: "enabled" });
    // Popup sizing must not shrink at the narrow initial extension viewport.
    assert.equal(await nativePage.locator("body").evaluate(body => body.getBoundingClientRect().width), 460);
    await nativePage.goto(`http://127.0.0.1:${server.address().port}/popup.html?view=full`);
    assert.equal(await nativePage.locator("body").evaluate(body => body.getBoundingClientRect().width), 190);
    await nativeContext.close();
    assert.deepEqual(errors, []);
    console.log("Chrome browser checks passed: native-fetch login/read/logout against a local fixture, popup sizing, views, filters, safe text, rule review, denied writes, private storage, polling expiry and expanded layout. Mock screenshots saved in the system temp folder.");
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
