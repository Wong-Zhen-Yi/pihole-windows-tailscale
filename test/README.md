# Recommended way to run tests

The test suite is implemented with BATS and runs inside distro-specific Docker containers.

## Requirements

- Docker (with buildx support)
- Bash shell

## Run tests

From the repository root, run:

```bash
bash test/run.sh --distro debian_12
```

`test/run.sh` will:

- Build the distro test image from `test/_<distro>.Dockerfile`
- Run the mock/function BATS suite in a fresh container
- Run the fresh-install BATS suite in a separate fresh container

## Available distros

If you are unsure which distro names are valid, run:

```bash
bash test/run.sh --help
```

The help output includes the current list of supported distros.

## Windows launcher tests

The Windows Docker Desktop launcher has standalone regression tests, with Docker
mocked so no daemon or additional PowerShell modules are needed:

```powershell
powershell.exe -NoProfile -File .\test\test_windows_launcher.ps1
```

These tests cover action dispatch, paths containing spaces, dependency checks
and Docker failure handling, with and without the optional `-Tailscale` overlay.
To validate the deployment's default port bindings, persistent storage, `.env`
overrides and additive Tailscale bindings, run `python3 test/test_windows_compose.py`
with Python 3 and Docker Compose v2 installed (no running daemon is needed).
These checks do not replace the Linux/BATS suite or an end-to-end DNS test.
See [the Windows guide](../windows/README.md) for deployment and WSL development
requirements.

## Chrome extension tests

Run `node --test test/test_chrome_extension.mjs` with Node.js 22 or newer.
These mocked tests cover Pi-hole v6 API requests, credentials, failure handling,
host permission scoping and popup behavior. They do not contact live Pi-hole,
alter blocking or verify client DNS. See the
[extension guide](../chrome-extension/README.md) for installation and manual checks.
Optional `node test/test_chrome_extension_browser.cjs` uses Playwright and an
installed Google Chrome to check the rendered views, query filters, safe text,
domain rule review, rejected writes and refresh/session behavior in an isolated
headless browser with mocked API responses.

The optional Windows launch helper has additional checks:

```powershell
node --test test/test_chrome_native_host.mjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\test\test_chrome_helper.ps1
pwsh -NoProfile -File .\test\test_chrome_helper.ps1
```

Native host checks use a temporary unregistered installation and harmless worker
fixture to test caller restrictions, framing and fixed actions. Startup checks
mock Docker and Docker Desktop, including stopped/running containers, mode
mismatches, volume validation and initial creation with the correct overlay.
Browser checks mock native messaging. These do not stop live DNS or prove a real
Docker cold boot succeeds. See the extension guide for per-user installation.

## Pi-hole MCP tests

Install the local server dependencies with `npm --prefix .\pihole-mcp ci --ignore-scripts`,
then run `npm --prefix .\pihole-mcp test` with Node.js 22+. These tests mock writes
and check input validation, request scoping, privacy defaults, session cleanup
structure, error handling and metadata preservation. They do not change Pi-hole.
`npm --prefix .\pihole-mcp run smoke` also checks the actual stdio MCP handshake,
tool discovery and live read-only Pi-hole status. See the
[MCP guide](../pihole-mcp/README.md) for prerequisites and recovery.

## Electron desktop tests

From `desktop/`, install dependencies with `npm ci`, then run `npm test`.
Node tests cover fixed Docker actions, existing Tailscale binding preservation,
storage checks, startup arguments, timeouts and isolated IPC. `npm run test:ui`
uses the included Playwright dependency and installed Chrome; it checks UI states,
startup switches, failed writes and safe text with a mocked desktop bridge.
These tests do not change live DNS or the Windows startup registry. See the
[desktop guide](../desktop/README.md) for build and manual sign-in validation.
After packaging, `npm run test:smoke` uses the actual Windows executable and a
running local deployment for read-only status checks, with startup writes mocked.

## Optional: override BATS library versions

`test/run.sh` accepts optional environment variable overrides when building test images:

- `BATS_CORE_VER`
- `BATS_SUPPORT_VER`
- `BATS_ASSERT_VER`
- `BATS_MOCK_VER`
- `BATS_FILE_VER`

Example:

```bash
BATS_CORE_VER=v1.14.0 DISTRO=debian_12 bash test/run.sh
```
