# Pi-hole Companion for Google Chrome

A local Manifest V3 extension for an existing **Pi-hole v6** server. See blocking
status, query statistics, top domains and clients, recent DNS queries and upstream
destinations. Open the dashboard, pause blocking temporarily, enable it again, or
review and add an exact allow/block rule.
Pausing affects **all clients using that Pi-hole**. Pi-hole owns the timer, so
blocking resumes even after closing Chrome. No live blocking changes occur on
installation, connection or refresh.

This companion manages an existing deployment; it does not install Docker or
configure Windows, router or Tailscale DNS. Devices must already use Pi-hole for
filtering. The server and Docker/Tailscale must stay available. See the
[Windows guide](../windows/README.md) and [Tailscale guide](../windows/TAILSCALE.md).
It is a personal fork companion, not an official Pi-hole extension or Chrome Web
Store release. Pi-hole v5 and reverse proxies with path prefixes are unsupported.

## Install locally

Version **1.1.1** fixes Chrome login failing with "Cannot reach Pi-hole" before
making a network request (the native fetch function needed its Window binding),
and prevents the toolbar popup shrinking to a narrow column. If upgrading, click
**Reload** on Pi-hole Companion's card at `chrome://extensions`, reopen the popup
and reconnect. No password reset or DNS changes are needed for this fix.

1. In Google Chrome, open `chrome://extensions`.
2. Enable **Developer mode**, then select **Load unpacked**.
3. Select this repository's `chrome-extension` folder (the folder containing
   `manifest.json`, not the repository root or a ZIP).
4. Pin **Pi-hole Companion** from Chrome's Extensions menu, then click it.
5. Keep `http://localhost:8080` for this repository's default local deployment.
   If you changed the bind address/port, enter the reachable dashboard server
   address, such as `http://YOUR_PIHOLE_HOST:8080`, without `/admin/` (that suffix
   is also accepted). Connect Tailscale first when using a tailnet address.
6. Enter your Pi-hole password, or an application password for a 2FA-enabled
   server, and click **Save & connect**. Allow access to that host when Chrome
   asks. An empty password is supported only if the server has no password.

The application password can be created in Pi-hole's web interface/API settings.
Application sessions can be read-only depending on the server's API settings. If
blocking or domain controls are denied, use **Open dashboard**; this extension does not
change server security settings. Never paste passwords into source files.

Only the server address is saved in Chrome's local extension storage. The
password is discarded after login; the session ID uses `chrome.storage.session`
(memory, no sync). Reconnect when the session expires, Chrome restarts, or the
extension reloads. Statistics refresh when opening the popup or clicking
**Refresh**. Optional **Refresh every 15s** runs only while this view is open and
visible; it resets when closed, disconnected, or the connection fails. It may
extend the Pi-hole session while in use. There is no background worker or polling
after closing the view. Each view shows its own update time; this is not a DNS
health check.

## Views and controls

- **Overview** adds blocklist size, unique queried domains, cached/local replies,
  forwarded queries, query rate and last gravity update to the four main counters.
  The bar shows blocked share, not a historical trend. Statistics use Pi-hole's
  current statistics window; the active-client count is for the last 24 hours.
- **Top activity** shows the top 10 blocked domains, permitted domains and clients,
  plus up to 10 upstream/local destinations with counts and available average
  response times. Each section handles errors independently. Pi-hole privacy
  settings may hide domains and client identities.
- **Query log** loads the most recent 25 queries. Search by exact domain and
  optionally select blocked queries only, then click **Search**. Each row shows
  the query time, domain, client, status, query/reply types and CNAME if available.
  Refresh uses the last applied filter. Empty results can also reflect privacy
  settings. No query history is saved or exported.
- **Tools** lets you type a domain or **Use current site** to fill its hostname.
  Current-site selection stays local until you check or review a rule. A review
  first reads existing explicit rules for that hostname; **Add rule** then creates
  an enabled exact allow/block rule for **Default group (ID 0)**. Editing the domain
  cancels a pending review. Rules for subdomains, other groups, broader regex
  patterns and removals belong in the dashboard. This is not a full explanation
  of every rule that can match a query. Existing rules are not overwritten; allow
  rules can override blocks. Domain changes affect all applicable clients.
- **Pause blocking** supports 30 seconds, 1, 5, 10 or 30 minutes, or 1 hour.
  Pi-hole owns the timer and resumes blocking even if Chrome closes. **Enable
  blocking** ends a pause immediately. These actions affect all Pi-hole clients.
- **Expand** opens the same companion in a larger browser tab, sharing the saved
  address and session. To select the hostname of a website, open the toolbar
  popup on that website; the expanded tab itself has no website hostname.

Connecting, opening views, searching and refreshing do not change rules, blocking,
upstreams, firewall, client DNS or Tailscale settings. Read-only application
sessions may show data but reject writes. A failed or timed-out write is never
retried automatically; inspect the dashboard before trying again.

## Launch Pi-hole from Chrome on Windows

Version **1.2** adds **Launch Pi-hole** and **Check startup**. The launcher starts
Pi-hole on the **same Windows PC** as Chrome and Docker Desktop. It works before
API login and does not start remote hosts. The address field controls API access,
not the launch target. Chrome uses its [native messaging interface](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
to talk to a helper for the current Windows user. No administrator rights, local
HTTP service, open port, Node.js or Python are required by this helper.

1. Reload the extension at `chrome://extensions` to load version 1.2.
2. Open **Setup Windows launcher** in the popup. Copy its command, containing
   this extension's ID, and run it in PowerShell **from this repository's root**:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\chrome-helper\install.ps1 -ExtensionId YOUR_32_CHARACTER_EXTENSION_ID
   ```

3. Installation detects Local/Tailscale mode from the existing container. If
   Docker is unavailable or no deployment exists, explicitly add `-Mode Local`
   or `-Mode Tailscale` after confirming the intended mode. Do not guess Local
   for a Tailscale deployment.
4. Click **Launch Pi-hole**, allowing Chrome's optional native messaging
   permission when prompted. It starts Docker Desktop if needed and waits up to
   three minutes for its Linux engine. Startup continues after closing the popup
   or Chrome. Use **Check startup** for progress, including after reopening.
5. Once running, use **Save & connect** or **Open dashboard**. A running container
   does not prove API readiness or successful client DNS.

Already-running containers are left running. Stopped containers are started
without recreation, preserving their current bindings and volume. If absent,
the helper runs `windows/pihole.ps1 Start`, adding `-Tailscale` in saved Tailscale
mode. The helper saves its mode separately; the existing launcher's `-Tailscale`
switch remains nonpersistent. A mode mismatch is refused. Connect Tailscale before
launching a deployment bound to its address; the helper does not connect the VPN.
No DNS, firewall, `.env`, passwords or volumes are changed. There is no stop,
reset or explicit update command. Initial creation can pull the configured image
if it is not cached, as the existing launcher does. Image download can outlast the
popup's polling window; check status again later before retrying a timed-out start.

The helper exclusively uses Docker Desktop's `desktop-linux` context and verifies
its local named-pipe endpoint. Remote Docker variables are overridden only for
helper child processes; the globally selected context is unchanged. Finish Docker
Desktop's initial setup manually if its local Linux context is absent.

Installation copies the helper scripts, native host manifest, extension ID/mode/
repository path and small runtime status files to
`%LOCALAPPDATA%\Pi-hole Companion\NativeHost`. The only registration is
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.wong.pihole_companion`.
Only that extension ID is allowed, with a second caller-origin check in the host.
Messages accept only `start` and `status`, without commands, paths or credentials.
Docker output is not returned to Chrome; concurrent launch workers share a lock.

Re-run installation after updating helper code, moving the repository, changing
the extension ID, or deliberately changing deployment mode. Reloading the Chrome
extension alone does not update the installed helper. To unregister it:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\chrome-helper\uninstall.ps1
```

Uninstall removes only its matching per-user registration and leaves Pi-hole
running. Files are retained so a startup is not interrupted; after startup ends,
the NativeHost folder can be removed manually. No Docker data is removed.

## Permissions and privacy

The extension requests `storage`, `activeTab`, optional `nativeMessaging` and
optional HTTP/HTTPS host access. Native messaging is requested only when clicking
**Launch Pi-hole** or **Check startup**; other features work without the helper.
`activeTab` lets **Use current site** read the selected website's hostname when
you invoke the popup. It does not grant browsing-history access or run page code.
See [Chrome's activeTab documentation](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab).
Connecting
requests access only to the selected hostname (Chrome host permissions include
all ports on that hostname). Switching hosts removes the previous host's
permission. Domain/client names and query details are rendered as text and kept
only in the open view; sign-out or session expiry clears them. It has no content scripts, browsing-history access,
tracking, analytics or remote code. API requests omit cookies, refuse redirects,
time out after eight seconds and send the session ID in a header rather than a
URL. HTTP sends credentials unencrypted: use it only over loopback, a trusted
local network or Tailscale; use valid HTTPS elsewhere. Never expose Pi-hole to
the public Internet to connect this extension.

**Sign out & forget server** attempts server logout, clears the saved address
and in-memory session, and removes the selected host permission. An offline
server's session expires normally. This does not change any DNS settings.
Remove the extension from `chrome://extensions` to uninstall. Keep the folder
in place while installed. After updating files, click **Reload** on the
extension's card and reconnect.

## Troubleshooting and development

- Open the same server's `/admin/` dashboard to check reachability first.
- A 401 means sign in again; use an application password with 2FA.
- A 403 can mean the application session cannot modify blocking; use the dashboard.
- If Chrome site access was revoked, reconnect and grant it again.
- If the launcher reports the helper is unavailable, run setup for this extension
  ID and reload. For a mode mismatch, reinstall with the confirmed mode; never
  remove the Tailscale overlay or data volume as a workaround.
- Check the Windows runbook for Docker, firewall and Tailscale issues. Do not
  broaden bindings or change DNS as a workaround for an extension error.
- Extension access tests do not establish that clients send DNS through Pi-hole.
  Verify DNS and the Query Log separately as described in the deployment guides.

No build tools or package installation are required. Run the mocked API and
popup regression tests from the repository root with Node.js 22 or newer:

```powershell
node --test test/test_chrome_extension.mjs
node --test test/test_chrome_native_host.mjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\test\test_chrome_helper.ps1
```

Optional browser tests require Playwright available to Node and an installed
Google Chrome. Run `node test/test_chrome_extension_browser.cjs`. They use an
isolated headless browser and mocked API responses, verify views, filters,
untrusted text rendering, staged domain writes and refresh/session behavior,
and save screenshots with mock data in the system temporary directory.
They also test login, reads and logout with Chrome's unmocked native `fetch`
against a local HTTP fixture, and check popup sizing at a narrow initial viewport.
Launcher UI checks mock native messaging. Windows helper tests mock Docker and
Desktop startup; native host tests verify real framing, caller restrictions,
fixed actions, the `.cmd` wrapper and a harmless detached worker in an isolated
temporary folder without registering a test host. Also run the PowerShell helper
tests under `pwsh` when available. No test stops live DNS or performs a real
Docker cold boot.

These tests do not contact a real Pi-hole or change live DNS. Manually verify in
Chrome: load the folder, connect to Pi-hole v6, reopen/refresh, test expired and
incorrect credentials, revoke site access, and sign out. Test pause/resume and
domain writes only when deliberately authorized for all affected clients.
After updating the files, reload the extension at `chrome://extensions` and
reconnect; version 1.1 adds the `activeTab` permission for current-site selection.
API implementation follows
[Pi-hole authentication](https://docs.pi-hole.net/api/auth/) and the official
[FTL API specification](https://github.com/pi-hole/FTL/tree/master/src/api/docs).
Permissions and session storage follow
[Chrome's permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions)
and [storage API](https://developer.chrome.com/docs/extensions/reference/api/storage).
