import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PiholeApi, normalizeServer, normalizeDomain, hostPermission } from "../chrome-extension/api.mjs";
import { helperRequest } from "../chrome-extension/launcher.mjs";

const root = new URL("../chrome-extension/", import.meta.url);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const summary = { queries: { total: 100, blocked: 25, percent_blocked: 25 }, clients: { active: 2 } };

test("server accepts origin and dashboard suffix, strips default ports", () => {
  assert.equal(normalizeServer(" http://localhost:8080/admin/ "), "http://localhost:8080");
  assert.equal(normalizeServer("https://pi.hole:443"), "https://pi.hole");
  assert.equal(hostPermission("http://localhost:8080"), "http://localhost/*");
  assert.equal(hostPermission("https://[::1]:8443"), "https://[::1]/*");
});

test("rejects credentials, proxy paths, unsafe schemes, query strings and fragments", () => {
  for (const url of ["pi.hole", "javascript:alert(1)", "file:///a", "ftp://pi.hole", "http://user:secret@pi.hole", "http://pi.hole/proxy", "http://pi.hole/?sid=secret", "http://pi.hole/#secret"]) {
    assert.throws(() => normalizeServer(url));
  }
});

test("login sends password only to auth; later requests use SID header, never cookies", async () => {
  const calls = [];
  const api = new PiholeApi("http://localhost:8080", null, async (url, options) => {
    calls.push({ url, options });
    return json(url.endsWith("/auth") ? { session: { valid: true, sid: "test-session" } } : { blocking: "enabled" });
  });
  assert.equal(await api.login("test-password"), "test-session");
  await api.request("dns/blocking");
  assert.deepEqual(JSON.parse(calls[0].options.body), { password: "test-password" });
  assert.equal(calls[1].options.headers["X-FTL-SID"], "test-session");
  for (const { url, options } of calls) {
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(!url.includes("test-session") && !url.includes("test-password"));
  }
  assert.equal(calls[1].options.body, undefined);
});

test("passwordless authentication and invalid session responses", async () => {
  const api = new PiholeApi("http://pi.hole", null, async () => json({ session: { valid: true, sid: null } }));
  assert.equal(await api.login(""), null);
  api.fetcher = async () => json({ session: { valid: false } });
  await assert.rejects(api.login("wrong"), { status: 401 });
});

test("overview reads summary and blocking without mutations", async () => {
  const calls = [];
  const api = new PiholeApi("http://pi.hole", "sid", async (url, options) => {
    calls.push(options.method);
    return json(url.endsWith("/summary") ? summary : { blocking: "disabled", timer: 240 });
  });
  assert.deepEqual(await api.overview(), { summary, state: { blocking: "disabled", timer: 240 } });
  assert.deepEqual(calls, ["GET", "GET"]);
});

test("pause uses a server-side 300-second timer; enable clears the timer", async () => {
  const bodies = [];
  const api = new PiholeApi("http://pi.hole", "sid", async (url, options) => {
    assert.ok(url.endsWith("/dns/blocking"));
    assert.equal(options.method, "POST");
    bodies.push(JSON.parse(options.body));
    return json({ blocking: "enabled" });
  });
  await api.setBlocking(false);
  await api.setBlocking(true);
  assert.deepEqual(bodies, [{ blocking: false, timer: 300 }, { blocking: true, timer: null }]);
});

test("logout uses DELETE and accepts no-content responses", async () => {
  const api = new PiholeApi("http://pi.hole", "sid", async (url, options) => {
    assert.equal(options.method, "DELETE");
    assert.ok(url.endsWith("/auth"));
    return new Response(null, { status: 204 });
  });
  assert.deepEqual(await api.logout(), {});
});

test("exact domain input normalizes case and IDNs while rejecting URLs, wildcards, IPs and invalid labels", () => {
  assert.equal(normalizeDomain(" ADS.Example.COM. "), "ads.example.com");
  assert.equal(normalizeDomain("bücher.example"), "xn--bcher-kva.example");
  for (const input of ["", "https://example.com", "a/b", "*.example.com", "a?b", "a#b", "a%b", "a:b", "a@b", "a b", "127.0.0.1", "[::1]", "0x7f000001", "-bad.example", "bad-.example", "a..example", "x".repeat(64) + ".example"]) {
    assert.throws(() => normalizeDomain(input), undefined, input);
  }
});

test("all preset pauses are bounded; invalid input never sends a request", async () => {
  const bodies = [];
  const api = new PiholeApi("http://pi.hole", "sid", async (url, options) => { bodies.push(JSON.parse(options.body)); return json({ blocking: "disabled" }); });
  for (const seconds of [30, 60, 300, 600, 1800, 3600]) await api.setBlocking(false, seconds);
  assert.deepEqual(bodies.map(x => x.timer), [30, 60, 300, 600, 1800, 3600]);
  for (const seconds of [0, -1, 31, 3601, NaN, Infinity, "60"]) assert.throws(() => api.setBlocking(false, seconds));
  assert.throws(() => api.setBlocking("false", 60));
  assert.equal(bodies.length, 6);
});

test("activity endpoints are bounded and query filters cannot inject parameters", async () => {
  const calls = [];
  const api = new PiholeApi("http://pi.hole", "sid", async (url, options) => {
    calls.push({ url, method: options.method });
    return json({ domains: [], clients: [], upstreams: [], queries: [] });
  });
  await api.topDomains(true); await api.topDomains(false); await api.topClients(); await api.upstreams();
  await api.queries({ domain: "EXAMPLE.com", blocked: true });
  assert.deepEqual(calls.map(x => x.url.split("/api/")[1]), [
    "stats/top_domains?count=10&blocked=true", "stats/top_domains?count=10&blocked=false",
    "stats/top_clients?count=10&blocked=false", "stats/upstreams", "queries?length=25&domain=example.com&upstream=blocklist"
  ]);
  assert.ok(calls.every(x => x.method === "GET"));
  assert.throws(() => api.queries({ domain: "example.com&length=100000" }));
  api.fetcher = async () => json({ queries: null });
  await assert.rejects(api.queries(), /Unexpected Pi-hole list/);
});

test("domain writes use exact rules for Default group and detect partial API failures", async () => {
  const calls = [];
  const api = new PiholeApi("http://pi.hole", "sid", async (url, options) => { calls.push({ url, options }); return json(options.method === "GET" ? { domains: [] } : { processed: { errors: [] } }, 201); });
  await api.domainRules("Example.com"); await api.addDomain("Example.com", "allow");
  assert.ok(calls[0].url.endsWith("domains/example.com"));
  assert.ok(calls[1].url.endsWith("domains/allow/exact"));
  assert.deepEqual(JSON.parse(calls[1].options.body), { domain: "example.com", groups: [0], enabled: true, comment: "Added from Pi-hole Companion" });
  assert.throws(() => api.addDomain("example.com", "regex"));
  api.fetcher = async () => json({ processed: { errors: [{ item: "example.com", error: "duplicate" }] } }, 201);
  await assert.rejects(api.addDomain("example.com", "allow"), /rejected/);
  api.fetcher = async () => { throw new Error("timeout"); };
  await assert.rejects(api.addDomain("example.com", "deny"), /change may still finish/);
});

test("handles expired auth, forbidden controls, server errors and non-JSON responses", async () => {
  for (const status of [401, 403, 404, 500]) {
    const api = new PiholeApi("http://pi.hole", null, async () => json({}, status));
    await assert.rejects(api.request("stats/summary"), { status });
  }
  const api = new PiholeApi("http://pi.hole", null, async () => new Response("<html>"));
  await assert.rejects(api.request("stats/summary"), /Pi-hole v6/);
  api.fetcher = async () => { throw new Error("private network detail"); };
  await assert.rejects(api.request("stats/summary"), /Cannot reach Pi-hole/);
  api.fetcher = async () => json({});
  await assert.rejects(api.overview(), /Unexpected API response/);
});

test("manifest has no automatic host access, injection, or background polling", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root)));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage", "activeTab"]);
  assert.deepEqual(manifest.optional_permissions, ["nativeMessaging"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.background, undefined);
  for (const file of [manifest.action.default_popup, ...Object.values(manifest.icons)]) {
    assert.ok((await readFile(new URL(file, root))).length > 0);
  }
});

test("launcher only sends fixed native actions and handles missing or malformed hosts", async () => {
  const calls = [];
  globalThis.chrome = { runtime: { sendNativeMessage: async (host, request) => {
    calls.push({ host, request });
    return { ok: true, phase: "running", message: "Container running", mode: "Tailscale" };
  } } };
  try {
    assert.equal((await helperRequest("status")).phase, "running");
    assert.deepEqual(calls[0], { host: "com.wong.pihole_companion", request: { action: "status" } });
    await assert.rejects(helperRequest("stop"), /Unsupported/);
    assert.equal(calls.length, 1);
    chrome.runtime.sendNativeMessage = async () => { throw new Error("private local path"); };
    await assert.rejects(helperRequest("start"), /Windows helper unavailable/);
    chrome.runtime.sendNativeMessage = async () => ({ ok: true, message: "no phase" });
    await assert.rejects(helperRequest("status"), /Unexpected/);
    chrome.runtime.sendNativeMessage = async () => ({ ok: false, phase: "error", message: "Refusing a container" });
    await assert.rejects(helperRequest("start"), /Refusing a container/);
  } finally { delete globalThis.chrome; }
});

// Minimal DOM exercises real popup event handlers without a browser or live DNS.
test("popup connects, restores sessions, handles expiry and forgets host access", async () => {
  const elements = new Map();
  const local = {}, session = {}, calls = [], grants = new Set();
  let status = "enabled", expire = false, denied = false, failLogout = false;
  const storage = (data) => ({
    get: async (key) => ({ [key]: data[key] }),
    set: async (value) => Object.assign(data, value),
    remove: async (key) => { delete data[key]; }
  });
  const makeNode = () => ({ value: "", hidden: true, disabled: false, checked: false, textContent: "", open: true,
    handlers: {}, style: {}, attributes: {}, children: [],
    addEventListener(name, handler) { this.handlers[name] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; this.textContent = ""; }
  });
  const element = (id) => {
    if (!elements.has(id)) { const node = makeNode(); if (id === "pause-duration") node.value = "300"; elements.set(id, node); }
    return elements.get(id);
  };
  globalThis.document = { getElementById: element, createElement: makeNode, body: { dataset: {} } };
  globalThis.chrome = {
    storage: { local: storage(local), session: storage(session) },
    permissions: {
      request: async ({ origins }) => { if (denied) return false; origins.forEach((x) => grants.add(x)); return true; },
      contains: async ({ origins }) => origins.every((x) => grants.has(x)),
      remove: async ({ origins }) => { origins.forEach((x) => grants.delete(x)); }
    },
    tabs: { create: async (value) => calls.push(value), query: async () => [{ url: "https://www.example.com/a?private=1" }] },
    runtime: { getURL: path => `chrome-extension://test/${path}` }
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (expire) return json({}, 401);
    if (url.endsWith("/auth")) {
      if (options.method === "DELETE") {
        if (failLogout) throw new Error("offline");
        return new Response(null, { status: 204 });
      }
      return json({ session: { valid: true, sid: "test-sid" } });
    }
    if (url.includes("stats/top_domains")) return json({ domains: [{ domain: "ads.example.com", count: 25 }] });
    if (url.includes("stats/top_clients")) return json({ clients: [{ name: "Test client", count: 100 }] });
    if (url.endsWith("stats/upstreams")) return json({ upstreams: [{ name: "cache", count: 10, port: -1 }] });
    if (url.includes("/queries?")) return json({ queries: [{ domain: "ads.example.com", status: "GRAVITY", time: 1700000000 }] });
    if (url.includes("/domains/")) return json(options.method === "GET" ? { domains: [] } : { processed: { success: [{ item: "www.example.com" }], errors: [] } }, options.method === "GET" ? 200 : 201);
    if (options.method === "POST") status = JSON.parse(options.body).blocking ? "enabled" : "disabled";
    return json(url.endsWith("/summary") ? summary : { blocking: status, timer: status === "disabled" ? 300 : null });
  };
  const idle = async () => {
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (!element("connect").disabled) return;
    }
    throw new Error("Popup did not settle");
  };
  const load = async (suffix) => { await import(new URL(`popup.js?test=${suffix}`, root)); await idle(); };
  const click = async (id) => { element(id).handlers.click(); await idle(); };
  const connect = async () => {
    element("server").value = "http://localhost:8080/admin/";
    element("password").value = "test-password";
    element("connect-form").handlers.submit({ preventDefault() {} });
    await idle();
  };
  try {
    await load("initial");
    await connect();
    assert.deepEqual(local, { server: "http://localhost:8080" });
    assert.deepEqual(session.connection, { server: local.server, sid: "test-sid" });
    assert.equal(element("password").value, "");
    assert.equal(element("status").textContent, "Blocking is active");
    assert.equal(element("blocked").textContent, "25");
    assert.ok(!calls.some((x) => x.url?.endsWith("dns/blocking") && x.options.method === "POST"));
    await click("blocking");
    assert.equal(element("status").textContent, "Blocking is paused");
    await click("blocking");
    assert.equal(element("status").textContent, "Blocking is active");
    await click("nav-activity");
    assert.equal(element("activity").hidden, false);
    assert.equal(element("top-blocked").children.length, 1);
    assert.ok(calls.some(x => x.url?.includes("stats/top_clients")));
    await click("nav-queries");
    assert.equal(element("query-results").children.length, 1);
    element("query-domain").value = "Example.COM";
    element("queries-blocked").checked = true;
    element("query-form").handlers.submit({ preventDefault() {} });
    await idle();
    assert.ok(calls.some(x => x.url?.endsWith("queries?length=25&domain=example.com&upstream=blocklist")));
    await click("nav-tools");
    await click("current-site");
    assert.equal(element("rule-domain").value, "www.example.com");
    calls.length = 0;
    await click("allow-domain");
    assert.equal(element("rule-review").hidden, false);
    assert.ok(calls.every(x => x.options.method === "GET"));
    await click("cancel-rule");
    assert.equal(element("rule-review").hidden, true);
    await click("deny-domain");
    element("rule-domain").value = "different.example.com";
    element("rule-domain").handlers.input();
    await click("confirm-rule");
    assert.ok(!calls.some(x => x.options.method === "POST"));
    await click("deny-domain");
    await click("confirm-rule");
    const added = calls.find(x => x.options.method === "POST");
    assert.deepEqual(JSON.parse(added.options.body), { domain: "different.example.com", enabled: true, groups: [0], comment: "Added from Pi-hole Companion" });
    assert.equal(element("rule-review").hidden, true);
    assert.match(element("rule-message").textContent, /Added block rule/);
    // Private activity and rule data never enters either storage area.
    assert.deepEqual(local, { server: "http://localhost:8080" });
    assert.deepEqual(session.connection, { server: local.server, sid: "test-sid" });
    calls.length = 0;
    await load("reopen");
    assert.equal(element("overview").hidden, false);
    assert.ok(calls.every((x) => x.options.method === "GET"));
    expire = true;
    await click("refresh");
    assert.equal(session.connection, undefined);
    assert.equal(element("overview").hidden, true);
    assert.equal(element("query-results").children.length, 0);
    assert.equal(element("rule-domain").value, "");
    assert.equal(element("blocking").disabled, true);
    assert.equal(element("settings").open, true);
    expire = false;
    await connect();
    grants.clear();
    await load("revoked");
    assert.equal(session.connection, undefined);
    assert.match(element("error").textContent, /Site access was removed/);
    denied = true;
    await connect();
    assert.match(element("error").textContent, /not granted/);
    assert.equal(element("password").value, "");
    denied = false;
    await connect();
    element("server").value = "https://pi.hole";
    element("connect-form").handlers.submit({ preventDefault() {} });
    await idle();
    assert.deepEqual([...grants], ["https://pi.hole/*"]);
    assert.equal(local.server, "https://pi.hole");
    failLogout = true;
    await click("disconnect");
    assert.deepEqual(local, {});
    assert.deepEqual(session, {});
    assert.equal(grants.size, 0);
    assert.equal(element("overview").hidden, true);
    assert.equal(element("server").value, "http://localhost:8080");
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.document;
    delete globalThis.chrome;
  }
});
