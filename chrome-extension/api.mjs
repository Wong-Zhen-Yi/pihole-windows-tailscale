export const DEFAULT_SERVER = "http://localhost:8080";

export function normalizeServer(input) {
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error("Enter a full address, such as http://localhost:8080."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || !["/", "/admin", "/admin/"].includes(url.pathname)) {
    throw new Error("Use an HTTP or HTTPS server address, without credentials, query parameters, or a proxy path.");
  }
  return url.origin;
}

// Chrome host permissions apply to every port on the selected hostname.
export function hostPermission(server) {
  const url = new URL(normalizeServer(server));
  return `${url.protocol}//${url.hostname}/*`;
}

export class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

export function normalizeDomain(input) {
  const value = input.trim().replace(/\.$/, "");
  if (!value || /[\s/\\?#%@:*[\]]/.test(value)) throw new Error("Enter an exact DNS name, such as ads.example.com, without a URL or wildcard.");
  let domain;
  try { domain = new URL(`http://${value}`).hostname; } catch { throw new Error("Enter a valid DNS name."); }
  if (domain.length > 253 || /^\d+(\.\d+)*$/.test(domain) || !domain.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error("Enter a DNS hostname, not an IP address or regular expression.");
  }
  return domain;
}

export class PiholeApi {
  // Window.fetch requires a Window receiver; calling an unbound native fetch as
  // this.fetcher() fails in Chrome before any request reaches the server.
  constructor(server, sid = null, fetcher = globalThis.fetch.bind(globalThis)) {
    this.server = normalizeServer(server);
    this.sid = sid;
    this.fetcher = fetcher;
  }

  async request(path, method = "GET", body) {
    const headers = { Accept: "application/json" };
    if (this.sid) headers["X-FTL-SID"] = this.sid;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await this.fetcher(`${this.server}/api/${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "omit", cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(8000)
      });
    } catch {
      throw new ApiError("Cannot reach Pi-hole. Check its address, Docker, site permission, and Tailscale if used." + (method === "POST" && path !== "auth" ? " The change may still finish. Check the dashboard before retrying." : ""));
    }
    if (response.status === 401) throw new ApiError("Sign in again. The password was rejected or your session expired. With 2FA, use a Pi-hole application password.", 401);
    if (response.status === 403) throw new ApiError("Pi-hole denied this action. Application passwords may have read-only access; use the dashboard to manage blocking.", 403);
    if (!response.ok) throw new ApiError(`Pi-hole returned HTTP ${response.status}. Check the dashboard.`, response.status);
    if (response.status === 204) return {};
    let data;
    try { data = await response.json(); } catch { throw new ApiError("This address did not return Pi-hole v6 API data. Check the server address."); }
    if (!data || typeof data !== "object" || data.error || data.processed?.errors?.length) {
      throw new ApiError("Pi-hole rejected the request or part of the change. Check the dashboard before retrying.");
    }
    return data;
  }

  async login(password) {
    const data = await this.request("auth", "POST", { password });
    if (data.session?.valid !== true) throw new ApiError("Pi-hole did not accept the login. Use an application password if 2FA is enabled.", 401);
    this.sid = data.session.sid || null;
    return this.sid;
  }

  async overview() {
    const [summary, state] = await Promise.all([
      this.request("stats/summary"), this.request("dns/blocking")
    ]);
    if (!summary.queries || !["enabled", "disabled", "failed", "unknown"].includes(state.blocking)) {
      throw new ApiError("Unexpected API response. This extension requires Pi-hole v6.");
    }
    return { summary, state };
  }

  setBlocking(enabled, seconds = 300) {
    if (typeof enabled !== "boolean" || ![30, 60, 300, 600, 1800, 3600].includes(seconds)) throw new Error("Select a pause duration between 30 seconds and one hour.");
    return this.request("dns/blocking", "POST", { blocking: enabled, timer: enabled ? null : seconds });
  }

  async collection(path, key) {
    const data = await this.request(path);
    if (!Array.isArray(data[key])) throw new ApiError("Unexpected Pi-hole list response.");
    return data[key];
  }

  topDomains(blocked = true) {
    return this.collection(`stats/top_domains?count=10&blocked=${Boolean(blocked)}`, "domains");
  }

  topClients() { return this.collection("stats/top_clients?count=10&blocked=false", "clients"); }
  upstreams() { return this.collection("stats/upstreams", "upstreams"); }

  queries({ domain = "", blocked = false } = {}) {
    const params = new URLSearchParams({ length: "25" });
    if (domain.trim()) params.set("domain", normalizeDomain(domain));
    if (blocked) params.set("upstream", "blocklist");
    return this.collection(`queries?${params}`, "queries");
  }

  domainRules(domain) {
    return this.collection(`domains/${encodeURIComponent(normalizeDomain(domain))}`, "domains");
  }

  addDomain(domain, type) {
    if (!["allow", "deny"].includes(type)) throw new Error("Select allow or block.");
    return this.request(`domains/${type}/exact`, "POST", {
      domain: normalizeDomain(domain), enabled: true, groups: [0], comment: "Added from Pi-hole Companion"
    });
  }

  logout() { return this.request("auth", "DELETE"); }
}
