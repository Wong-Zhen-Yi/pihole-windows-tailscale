import { DEFAULT_SERVER, normalizeServer, normalizeDomain, hostPermission, PiholeApi } from "./api.mjs";
import { number, percent, stamp, message, renderRanking, renderQueries, renderRules } from "./view.mjs";
import { helperRequest } from "./launcher.mjs";

const $ = (id) => document.getElementById(id);
const views = ["overview", "activity", "queries", "tools"];
const privateViews = ["top-blocked", "top-permitted", "top-clients", "upstreams", "query-results", "rule-results"];
const actionButtons = ["connect", "refresh", "disconnect", "dashboard", "expand", "query-search", "current-site", "inspect-rules", "allow-domain", "deny-domain", "confirm-rule", "cancel-rule", ...views.map(view => `nav-${view}`)];
let api = null;
let blockingState = "unknown";
let busy = false;
let activeView = "overview";
let queryFilter = { domain: "", blocked: false };
let pendingRule = null;
let refreshTimer = null;
let launchBusy = false;

const extensionId = chrome.runtime.id;
$("launch-setup").textContent = /^[a-p]{32}$/.test(extensionId || "")
  ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\windows\\chrome-helper\\install.ps1 -ExtensionId ${extensionId}`
  : "Open this as an installed Chrome extension to see its setup command.";

async function updateLaunchStatus() {
  const result = await helperRequest("status");
  $("launch-message").textContent = `${result.message}${result.mode ? ` Mode: ${result.mode}.` : ""}`;
  return result.phase;
}

async function launchAction(start, permission) {
  if (launchBusy) return;
  launchBusy = true;
  $("launch-pihole").disabled = true;
  $("launch-status").disabled = true;
  try {
    if (!await permission) throw new Error("Native messaging was not allowed. Enable it when using the Windows launcher.");
    if (start) {
      const result = await helperRequest("start");
      $("launch-message").textContent = result.message;
      // Only poll while this view remains open. The separate Windows worker
      // continues startup after Chrome closes the popup or the browser.
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        if (document.hidden || await updateLaunchStatus() !== "starting") break;
      }
    } else { await updateLaunchStatus(); }
  } catch (error) { $("launch-message").textContent = error.message; }
  finally {
    launchBusy = false;
    $("launch-pihole").disabled = false;
    $("launch-status").disabled = false;
  }
}

for (const [id, start] of [["launch-pihole", true], ["launch-status", false]]) {
  $(id).addEventListener("click", () => {
    if (launchBusy) return;
    // Keep the optional permission request within the user's click gesture.
    const permission = chrome.permissions.request({ permissions: ["nativeMessaging"] });
    void launchAction(start, permission);
  });
}

if (new URLSearchParams(globalThis.location?.search || "").get("view") === "full") {
  document.body.dataset.expanded = "true";
  $("expand").hidden = true;
}

function setBusy(value) {
  busy = value;
  for (const id of actionButtons) $(id).disabled = value;
  $("blocking").disabled = value || !["enabled", "disabled"].includes(blockingState);
  $("pause-duration").disabled = value || blockingState !== "enabled";
}

function selectView(view) {
  activeView = view;
  for (const name of views) {
    $(name).hidden = name !== view;
    $(`nav-${name}`).setAttribute("aria-current", name === view ? "page" : "false");
  }
}

function cancelRule() {
  pendingRule = null;
  $("rule-review").hidden = true;
}

function stopAutoRefresh() {
  if (refreshTimer !== null) clearInterval(refreshTimer);
  refreshTimer = null;
  $("auto-refresh").checked = false;
}

function resetOverview() {
  blockingState = "unknown";
  $("workspace").hidden = true;
  $("overview").hidden = true;
  $("blocking").disabled = true;
  for (const id of privateViews) $(id).replaceChildren();
  for (const id of ["query-domain", "rule-domain"]) $(id).value = "";
  for (const id of ["rule-message", "rule-preview", "activity-updated", "queries-updated"]) $(id).textContent = "";
  $("queries-blocked").checked = false;
  queryFilter = { domain: "", blocked: false };
  cancelRule();
  stopAutoRefresh();
}

async function showError(error, invalidate = false) {
  $("error").textContent = error.message;
  $("error").hidden = false;
  if (invalidate || error.status === 401) {
    resetOverview();
    document.body.dataset.state = "error";
    $("status").textContent = "Connection needs attention";
    $("detail").textContent = "Reconnect or refresh to check protection.";
  }
  if (error.status === 401) {
    await chrome.storage.session.remove("connection");
    api = null;
    $("settings").open = true;
  }
}

async function refreshOverview() {
  if (!api) throw new Error("Connect to Pi-hole first.");
  let data;
  try { data = await api.overview(); }
  catch (error) { error.connectionFailure = true; throw error; }
  const { summary, state } = data;
  blockingState = state.blocking;
  document.body.dataset.state = ["enabled", "disabled"].includes(blockingState) ? blockingState : "error";
  $("status").textContent = {
    enabled: "Blocking is active", disabled: "Blocking is paused",
    failed: "Blocking has failed", unknown: "Blocking status unknown"
  }[blockingState];
  $("detail").textContent = state.timer > 0
    ? `Status changes automatically in about ${Math.ceil(state.timer)} seconds.`
    : "Reported by your Pi-hole server.";
  $("total").textContent = number(summary.queries.total);
  $("blocked").textContent = number(summary.queries.blocked);
  $("percent").textContent = percent(summary.queries.percent_blocked);
  $("blocked-meter").style.width = `${Math.max(0, Math.min(100, Number(summary.queries.percent_blocked) || 0))}%`;
  $("clients").textContent = number(summary.clients?.active);
  $("gravity").textContent = number(summary.gravity?.domains_being_blocked);
  $("unique").textContent = number(summary.queries.unique_domains);
  $("cached").textContent = number(summary.queries.cached);
  $("forwarded").textContent = number(summary.queries.forwarded);
  $("frequency").textContent = number(summary.queries.frequency);
  const updated = summary.gravity?.last_update;
  $("gravity-updated").textContent = typeof updated === "number" && updated > 0 && Number.isFinite(new Date(updated * 1000).getTime())
    ? new Date(updated * 1000).toLocaleString() : "Unknown";
  $("updated").textContent = stamp();
  $("blocking").textContent = blockingState === "disabled" ? "Enable blocking" : "Pause blocking";
  $("error").hidden = true;
  $("workspace").hidden = false;
  selectView(activeView);
}

async function loadActivity() {
  const sections = [
    ["top-blocked", () => api.topDomains(true), item => item.domain],
    ["top-permitted", () => api.topDomains(false), item => item.domain],
    ["top-clients", () => api.topClients(), item => item.name || item.ip],
    ["upstreams", () => api.upstreams(), item => item.name || item.ip, item => typeof item.statistics?.response === "number" && item.port > 0 ? `${(item.statistics.response * 1000).toFixed(1)} ms average response · port ${item.port}` : "Local reply destination"]
  ];
  for (const [id] of sections) message($(id), "Loading…");
  $("activity-updated").textContent = "";
  const results = await Promise.allSettled(sections.map(([, fetch]) => fetch()));
  const expired = results.find(result => result.status === "rejected" && result.reason.status === 401);
  if (expired) throw expired.reason;
  results.forEach((result, index) => {
    const [id, , label, detail] = sections[index];
    if (result.status === "fulfilled") renderRanking($(id), result.value, label, detail);
    else message($(id), result.reason.message);
  });
  $("activity-updated").textContent = `${stamp()} · Each section reports its own errors.`;
}

async function loadQueries() {
  message($("query-results"), "Loading…");
  $("queries-updated").textContent = "";
  try {
    const items = await api.queries(queryFilter);
    renderQueries($("query-results"), items);
    $("queries-note").textContent = `Most recent 25 ${queryFilter.blocked ? "blocked " : ""}queries${queryFilter.domain ? ` for ${queryFilter.domain}` : " across all domains"}. Pi-hole privacy settings apply.`;
    $("queries-updated").textContent = stamp();
  } catch (error) {
    message($("query-results"), "Queries unavailable. Search again or check the dashboard.");
    throw error;
  }
}

async function loadView() {
  if (!api) throw new Error("Connect to Pi-hole first.");
  if (activeView === "activity") await loadActivity();
  if (activeView === "queries") await loadQueries();
}

async function refresh() {
  await refreshOverview();
  await loadView();
}

async function run(action, critical = false) {
  if (busy) return;
  setBusy(true);
  $("error").hidden = true;
  try { await action(); }
  catch (error) { await showError(error, critical || error.connectionFailure); }
  finally { setBusy(false); }
}

async function endSession() {
  const { connection } = await chrome.storage.session.get("connection");
  // Forget local access even when the server cannot be reached.
  if (connection?.sid) {
    try { await new PiholeApi(connection.server, connection.sid).logout(); } catch { /* Server session expires. */ }
  }
  await chrome.storage.session.remove("connection");
  api = null;
}

$("connect-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) return;
  let server;
  try { server = normalizeServer($("server").value); }
  catch (error) { $("password").value = ""; void showError(error); return; }
  // Request inside the submit gesture, before any asynchronous work.
  const permission = chrome.permissions.request({ origins: [hostPermission(server)] });
  void run(async () => {
    let password = $("password").value;
    $("password").value = "";
    try {
      if (!await permission) throw new Error("Site access was not granted. Connect again and allow access to your Pi-hole host.");
      const { server: previousServer } = await chrome.storage.local.get("server");
      await endSession();
      resetOverview();
      if (previousServer && hostPermission(previousServer) !== hostPermission(server)) {
        await chrome.permissions.remove({ origins: [hostPermission(previousServer)] });
      }
      activeView = "overview";
      await chrome.storage.local.set({ server });
      $("server").value = server;
      $("server-name").textContent = server;
      $("disconnect").hidden = false;
      api = new PiholeApi(server);
      const sid = await api.login(password);
      await chrome.storage.session.set({ connection: { server, sid } });
      await refresh();
      $("settings").open = false;
    } finally { password = ""; }
  }, true);
});

for (const view of views) {
  $(`nav-${view}`).addEventListener("click", () => void run(async () => {
    selectView(view);
    cancelRule();
    await loadView();
  }));
}
$("refresh").addEventListener("click", () => void run(refresh));
$("auto-refresh").addEventListener("change", () => {
  if (refreshTimer !== null) clearInterval(refreshTimer);
  refreshTimer = null;
  if ($("auto-refresh").checked) {
    refreshTimer = setInterval(() => {
      if (!document.hidden && api && !busy) void run(refresh);
    }, 15000);
  }
});
$("blocking").addEventListener("click", () => void run(async () => {
  if (!api || !["enabled", "disabled"].includes(blockingState)) return;
  await api.setBlocking(blockingState === "disabled", Number($("pause-duration").value));
  await refresh();
}));
$("query-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void run(async () => {
    const value = $("query-domain").value.trim();
    queryFilter = { domain: value ? normalizeDomain(value) : "", blocked: $("queries-blocked").checked };
    await loadQueries();
  });
});

$("rule-domain").addEventListener("input", () => {
  cancelRule();
  $("rule-results").replaceChildren();
  $("rule-message").textContent = "";
});
$("current-site").addEventListener("click", () => void run(async () => {
  cancelRule();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let url;
  try { url = new URL(tab?.url); } catch { throw new Error("Open the companion from a regular website to use its hostname, or type a domain here."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("This tab has no website hostname. Type a domain instead.");
  $("rule-domain").value = normalizeDomain(url.hostname);
  $("rule-results").replaceChildren();
  $("rule-message").textContent = "Hostname filled locally. Review a rule to continue; nothing has been changed.";
}));
$("inspect-rules").addEventListener("click", () => void run(async () => {
  cancelRule();
  $("rule-results").replaceChildren();
  const domain = normalizeDomain($("rule-domain").value);
  const rules = await api.domainRules(domain);
  if (normalizeDomain($("rule-domain").value) === domain) renderRules($("rule-results"), rules);
}));
for (const type of ["allow", "deny"]) {
  $(`${type}-domain`).addEventListener("click", () => void run(async () => {
    cancelRule();
    $("rule-message").textContent = "";
    $("rule-results").replaceChildren();
    const domain = normalizeDomain($("rule-domain").value);
    const rules = await api.domainRules(domain);
    if (normalizeDomain($("rule-domain").value) !== domain) return;
    renderRules($("rule-results"), rules);
    if (rules.some(rule => rule.kind === "exact" && rule.type === type)) throw new Error("This exact rule already exists. Manage its enabled state and groups in the dashboard.");
    pendingRule = { domain, type, server: api.server };
    $("rule-preview").textContent = `Add an exact ${type === "allow" ? "ALLOW" : "BLOCK"} rule for ${domain} on ${api.server}? Applies to Default group (ID 0), with no subdomains. Existing rules remain. Allow rules can take precedence over blocks.`;
    $("rule-review").hidden = false;
  }));
}
$("cancel-rule").addEventListener("click", cancelRule);
$("confirm-rule").addEventListener("click", () => void run(async () => {
  if (!pendingRule || !api || pendingRule.server !== api.server || pendingRule.domain !== normalizeDomain($("rule-domain").value)) throw new Error("Review the current hostname before adding a rule.");
  const rule = pendingRule;
  // Clear before the write: a timeout must not invite an automatic duplicate retry.
  cancelRule();
  await api.addDomain(rule.domain, rule.type);
  $("rule-message").textContent = `Added ${rule.type === "allow" ? "allow" : "block"} rule for ${rule.domain} in Default group. Existing rules and client caches may affect results.`;
  renderRules($("rule-results"), [{ type: rule.type, kind: "exact", enabled: true, groups: [0] }]);
}));

$("dashboard").addEventListener("click", () => void run(async () => {
  await chrome.tabs.create({ url: `${normalizeServer($("server").value)}/admin/` });
}));
$("expand").addEventListener("click", () => void run(async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?view=full") });
}));
$("disconnect").addEventListener("click", () => void run(async () => {
  const { server } = await chrome.storage.local.get("server");
  resetOverview();
  await endSession();
  await chrome.storage.local.remove("server");
  if (server) await chrome.permissions.remove({ origins: [hostPermission(server)] });
  $("server").value = DEFAULT_SERVER;
  $("password").value = "";
  $("server-name").textContent = "";
  $("disconnect").hidden = true;
  $("settings").open = true;
  $("error").hidden = true;
  document.body.dataset.state = "";
  $("status").textContent = "Connect your Pi-hole";
  $("detail").textContent = "Use your existing Pi-hole v6 server.";
}));

void run(async () => {
  const { server } = await chrome.storage.local.get("server");
  const { connection } = await chrome.storage.session.get("connection");
  if (!server) return;
  $("server").value = normalizeServer(server);
  $("server-name").textContent = server;
  $("disconnect").hidden = false;
  if (!await chrome.permissions.contains({ origins: [hostPermission(server)] })) {
    await chrome.storage.session.remove("connection");
    throw new Error("Site access was removed. Connect again to grant access.");
  }
  if (connection?.server === server) {
    api = new PiholeApi(server, connection.sid);
    await refresh();
    $("settings").open = false;
  } else {
    $("detail").textContent = "Enter your password to start a new session.";
  }
}, true);
