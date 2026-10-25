export const number = (value) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "—";
export const percent = (value) => typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";
export const stamp = () => `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

export function message(target, text) {
  target.replaceChildren(node("p", text, "caption"));
}

export function renderRanking(target, items, label, detail = () => "") {
  target.replaceChildren();
  if (!items.length) { message(target, "No data available. Pi-hole privacy settings may hide these details."); return; }
  const maximum = Math.max(1, ...items.map(item => Number(item.count) || 0));
  for (const item of items.slice(0, 10)) {
    const row = node("div", undefined, "rank-row");
    const info = node("div", undefined, "rank-info");
    info.append(node("span", label(item) || "Unknown", "rank-label"), node("span", number(item.count), "rank-count"));
    row.append(info);
    const extra = detail(item);
    if (extra) row.append(node("span", extra, "query-meta"));
    const bar = node("div", undefined, "rank-bar");
    bar.style.width = `${Math.max(0, Math.min(100, (Number(item.count) || 0) / maximum * 100))}%`;
    row.append(bar);
    target.append(row);
  }
}

export function renderQueries(target, items) {
  target.replaceChildren();
  if (!items.length) { message(target, "No matching queries. Pi-hole privacy settings may also hide the log."); return; }
  const wrap = node("div", undefined, "table-wrap");
  const table = node("table");
  const head = node("thead");
  const labels = node("tr");
  for (const label of ["Time", "Domain / client", "Result"]) {
    const th = node("th", label); th.setAttribute("scope", "col"); labels.append(th);
  }
  head.append(labels); table.append(head);
  const body = node("tbody");
  for (const query of items.slice(0, 25)) {
    const row = node("tr");
    const time = typeof query.time === "number" ? new Date(query.time * 1000) : null;
    row.append(node("td", time && Number.isFinite(time.getTime()) ? time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"));
    const domain = node("td", query.domain || "Hidden");
    domain.append(node("span", query.client?.name || query.client?.ip || "Client hidden", "query-meta"));
    if (query.cname) domain.append(node("span", `CNAME: ${query.cname}`, "query-meta"));
    const result = node("td", query.status || "Unknown", /^(GRAVITY|REGEX|DENYLIST|EXTERNAL_BLOCKED|SPECIAL_DOMAIN)/.test(query.status) ? "query-blocked" : "");
    result.append(node("span", `${query.type || "?"} · ${query.reply?.type || "No reply"}`, "query-meta"));
    row.append(domain, result); body.append(row);
  }
  table.append(body); wrap.append(table); target.append(wrap);
}

export function renderRules(target, rules) {
  target.replaceChildren();
  if (!rules.length) { message(target, "No explicit rules for this exact hostname. Blocklists and broader regex rules may still apply."); return; }
  for (const rule of rules) {
    target.append(node("div", `${rule.type === "allow" ? "Allow" : "Block"} · ${rule.kind} · ${rule.enabled ? "enabled" : "disabled"} · groups ${(rule.groups || []).join(", ") || "none"}`, "rule-row"));
  }
}
