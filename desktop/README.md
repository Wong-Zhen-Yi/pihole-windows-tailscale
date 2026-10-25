# Pi-hole Desktop for Windows

An Electron control panel for this fork's Windows Docker Desktop deployment.
Start or stop the container, open the Pi-hole web dashboard, check container
health, and choose whether the desktop app launches at Windows sign-in.
The dashboard provides the full Pi-hole UI, including query statistics, filtering
rules and Teleporter backups. The desktop app does not require a Pi-hole password.

## Run from source

Install Node.js **22.12 or newer**, Docker Desktop with Linux containers, and
the prerequisites in the [Windows setup guide](../windows/README.md).
From the repository root:

```powershell
Set-Location .\desktop
npm ci
npm start
```

Opening the app checks the local Docker Desktop deployment. Both startup
preferences default to off. Click **Start Pi-hole** to start Docker Desktop if
needed, wait up to three minutes for its engine, and start Pi-hole. Docker must
already be installed and have completed its first-run setup.

An existing container is identified by project `pihole-windows`, service
`pihole`, and volume `pihole-windows_pihole-data` mounted at `/etc/pihole`.
Starting a stopped container preserves all its current bindings, including
Tailscale. The app uses only the local `desktop-linux` Docker context and rejects
a remote endpoint. It does not follow shell `DOCKER_*` or `COMPOSE_*` overrides.

For a missing container, choose this checkout under **Settings > Repository
folder**, and choose **Local / LAN** or **Tailscale** as the new-container mode.
The app invokes `windows/pihole.ps1 Start`, adding `-Tailscale` in Tailscale mode.
The launcher reads the checkout's existing private `windows/.env`; ordinary
`PIHOLE_*` environment overrides still apply. No `.env` file is created or edited.
Configure it using the Windows guide before the first launch, especially for
Tailscale. An existing container's mode always takes precedence over this preference.
To apply `.env` changes or deliberately change bindings, use the launcher from
PowerShell with the intended mode, then refresh the app.

**Stop** asks for confirmation because dependent devices may lose DNS. It retains
the container and data volume. Closing the window hides the app in the Windows
notification area; double-click its tray icon to reopen it. **Quit app** exits
the GUI and leaves Docker and Pi-hole running.

## Launch on startup

In **Settings**, use these independent switches:

- **Launch at Windows sign-in** registers this app for the current Windows user.
  It opens in the notification area after sign-in. It does not run before login.
- **Start Pi-hole when this app opens** also starts Docker Desktop when needed
  and starts Pi-hole whenever the app opens. Enable both switches to start the
  app and Pi-hole at sign-in. This setting applies on the next app launch.

Windows **Settings > Apps > Startup** can disable the registered entry. The app
reports that condition. Turn the app's launch switch off and on to re-enable it.
Turn the launch switch off **before moving or deleting the executable or checkout**;
open the new copy and enable it again afterward. Use the packaged executable for
everyday startup; source mode depends on `node_modules/electron` and this checkout
remaining available. Switching copies replaces the same per-user startup entry.

Tailscale must already be connected before Docker can bind its address. The app
does not start or configure Tailscale, change client DNS/firewall rules, or alter
tailnet DNS. Startup failure is recorded in Activity and opens the app so you can
correct it and retry. Container running/health status does not verify client DNS;
follow the [phone validation guide](../windows/TAILSCALE.md#3-test-before-changing-phone-dns).
Windows, Docker Desktop and Tailscale must remain available for DNS service.

Desktop preferences live in `%APPDATA%\Pi-hole Desktop\settings.json`. The
Windows startup entry is named `Pi-hole Desktop` in the current user's Run key.
The app keeps at most 40 operation summaries in memory; it does not fetch or save
container logs, credentials or DNS query history. The web dashboard opens in your
default browser using an actual private IPv4 binding detected from the container.

## Build a Windows executable

In `desktop/`, after `npm ci`:

```powershell
npm test
npm run package
& '.\dist\Pi-hole Desktop-win32-x64\Pi-hole Desktop.exe'
```

On Windows ARM64 the folder ends in `win32-arm64`. Keep the **whole output folder**
together; the executable depends on its adjacent resources. The build includes
only the desktop UI and adapter files, not the checkout, `.env`, Docker data or
backups. If moved outside this checkout, select the repository in Settings.
The build is unsigned; signing and an installer are not configured. Quit the app
before rebuilding into the same output directory. Upgrading the app does not
update the published Pi-hole container image; follow the [update runbook](../README.md#check-stop-and-update).

## Checks

`npm test` runs Node regression checks for Docker dispatch, binding/storage
protection, timeout/error handling, settings, startup arguments and the preload
bridge. From `desktop/`, `npm run test:ui` additionally requires installed
Google Chrome; Playwright is included in the development dependencies. It tests the rendered UI with a
mock desktop bridge. These checks do not change live Docker or Windows startup.

After packaging, `npm run test:smoke` uses Playwright to launch the actual Windows
executable, check a running local container, exercise the isolated IPC bridge
and verify close-to-tray. It refuses saved Pi-hole auto-start and mocks Windows
startup registration. Quit other copies first; this check does not restart
Docker, stop Pi-hole or test phone DNS. A real Windows sign-out/reboot remains
a manual check after deliberately enabling your preferred startup settings.

For validation results and environment limits from development, see
[VALIDATION.md](VALIDATION.md).

Electron uses an isolated, sandboxed renderer, a restrictive Content Security
Policy and a fixed IPC bridge with sender validation. See Electron's
[security guide](https://www.electronjs.org/docs/latest/tutorial/security/) and
[Windows login-item API](https://www.electronjs.org/docs/latest/api/app/#appsetloginitemsettingssettings).
