# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

AGENTS.md (imported above) is the source of truth for fork purpose, safety
rules, deployment invariants and upstream PR rules. This file adds the parts
AGENTS.md does not cover: the companion apps and how all the pieces connect.

## Architecture: how the pieces connect

Everything controls one deployment: Compose project `pihole-windows`, service
`pihole`, container `pihole-windows-pihole-1`, volume
`pihole-windows_pihole-data` at `/etc/pihole`. None of it builds this checkout's
Bash source. The container image is always the published `PIHOLE_IMAGE`.

- **`windows/pihole.ps1`** is the only code path that *creates* a container. It
  calls `docker compose --project-directory windows/` with `compose.yaml`, plus
  `compose.tailscale.yaml` when `-Tailscale` is passed. Compose reads
  `windows/.env`, but `$env:PIHOLE_*` overrides it.
- **`desktop/`** (Electron, CommonJS `.cjs`) lives in `backend.cjs`, which
  runs fixed Docker commands only. The renderer never supplies commands or
  arguments. IPC goes through `preload.cjs` → `contextBridge` → `ipcMain.handle('pihole:*')`.
  It forces `DOCKER_CONTEXT=desktop-linux` and strips `DOCKER_*`/`COMPOSE_*` env vars.
  It starts an existing stopped container directly, so the container keeps its
  bindings. If the container is missing, it calls `windows/pihole.ps1 Start`
  with or without `-Tailscale`, depending on the saved mode.
- **`chrome-extension/`** (Manifest V3, ES modules) talks to the Pi-hole v6 HTTP
  API directly (`api.mjs`). Only the server address is persisted. The session ID
  is kept in `chrome.storage.session`. The optional **Launch Pi-hole** feature
  uses Chrome native messaging to reach **`windows/chrome-helper/`**:
  `install.ps1` copies the helper to `%LOCALAPPDATA%\Pi-hole Companion\NativeHost`
  and registers an HKCU native-messaging host. `native-host.ps1` accepts only
  `start`/`status` messages from the one allowed extension ID. A detached
  `worker.ps1` (guarded by a lock file) does the startup. Changes to helper
  code take effect only after `install.ps1` is re-run.
- **`pihole-mcp/`** (Node ESM, stdio MCP server, 13 tools defined in `tools.mjs`)
  never calls the API from the host. `client.mjs` runs `docker exec` into the
  container and pipes in `bridge.sh`. That script authenticates with
  `/etc/pihole/cli_pw` *inside* the container, makes a single API call, and
  deletes the session. Neither the credential nor the session ID leaves the container.

Shared conventions across these components:

- Docker output and `execFile` errors are never sent on to the UI or the
  agent, because they may contain addresses or `.env` values. Code replaces
  them with fixed, safe messages. Keep that pattern when adding error paths.
- Existing container bindings win over any saved or preferred mode. A mode
  mismatch is refused rather than "fixed".
- No component edits `.env`, DNS, firewall, Tailscale or volumes.

## Commands

Run from the repository root unless noted. Docker is mocked in all of these
except the smoke tests and the BATS suite.

```powershell
# Windows launcher (run under both shells; CI does)
powershell.exe -NoProfile -File .\test\test_windows_launcher.ps1
pwsh -NoProfile -File .\test\test_windows_launcher.ps1

# Compose config (needs Compose v2, no daemon)
python test/test_windows_compose.py

# Chrome extension (Node 22+); browser test needs Playwright + installed Chrome
node --test test/test_chrome_extension.mjs
node test/test_chrome_extension_browser.cjs

# Chrome launch helper
node --test test/test_chrome_native_host.mjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\test\test_chrome_helper.ps1

# Pi-hole MCP
npm --prefix .\pihole-mcp ci --ignore-scripts
npm --prefix .\pihole-mcp test
npm --prefix .\pihole-mcp run smoke   # live, read-only: needs running container

# Desktop app (from desktop/)
npm ci; npm test; npm run test:ui
npm start                              # run from source
npm run package; npm run test:smoke    # smoke uses packaged exe + live deployment
```

To run a single Node test, add `--test-name-pattern "<name>"` to any `node --test` command.

Linux/upstream source (Bash) uses the BATS suite inside distro containers:
`bash test/run.sh --distro debian_12` (`--help` lists distros). It runs whole
suites. Run it from a Linux filesystem checkout (WSL), not the NTFS checkout.

CI (`.github/workflows/test.yml`) also runs differential ShellCheck,
codespell (`.codespellignore`), editorconfig-checker, TruffleHog, and an
executable-bit check on every `*.sh`/`*.bats`. `.gitattributes` forces LF for
all text files, `.ps1` and `.cmd` included.

## Docs to keep in sync

Each component has its own README with user-facing install, validation and
recovery steps: `desktop/README.md` (plus `desktop/VALIDATION.md`),
`chrome-extension/README.md`, `pihole-mcp/README.md` and `test/README.md`. When
behavior, commands or test coverage change, update the matching README and the
"Start here" table in the root `README.md`.
