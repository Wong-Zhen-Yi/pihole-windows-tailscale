# AGENTS.md

## Fork purpose and recovery context

This is `Wong-Zhen-Yi/pihole-windows-tailscale`, a personal fork of
`pi-hole/pi-hole`. Its deployment branch is `windows-docker`, based on upstream
`development`. It runs the official Pi-hole Linux container on Windows Docker
Desktop and optionally serves phone DNS over Tailscale.
Read `README.md`, `windows/README.md` and `windows/TAILSCALE.md` before changes.
Keep them usable without chat history; update them whenever commands, defaults,
storage, network exposure or recovery steps change.

The deployment pulls a published image; it does not build this checkout's Linux
source. Never claim source changes were deployed just because a container
started, or that mocked tests prove phone DNS works. Do not run the Linux
installer in PowerShell, CMD or Git Bash.

## Resume work safely

- Inspect `git status --short --branch`, `git remote -v` and actual files first.
  Preserve uncommitted work; do not reset, clean or switch a dirty checkout to
  match a branch name in these instructions.
- `origin` is `https://github.com/Wong-Zhen-Yi/pihole-windows-tailscale.git`;
  `upstream` is `https://github.com/pi-hole/pi-hole.git`. Verify before pushing.
  The local directory may still be called `pi-hole`; renaming GitHub does not
  require moving it.
- Continue fork work on `windows-docker` or a focused branch based on it. Base
  new upstream Linux contributions on `upstream/development`; target upstream
  PRs at `development`. Do not push fork deployment changes to upstream.
- Verify relevant container/network state; do not infer it from doc examples.
  Read-only diagnostics include `docker info`,
  `.\windows\pihole.ps1 Status -Tailscale` and `tailscale ip -4`.
- `windows/.env` is private and ignored by Git. Use `.env.example` for defaults.
  Never overwrite an existing `.env`, print secrets, or commit passwords, real
  device/IP details, query logs or Teleporter backups. Use public placeholders.
- Firewall rules, Windows/client DNS and Tailscale admin DNS are outside Git.
  Document manual steps and verify scope before changing them. A request to edit
  this repository alone does not authorize live DNS changes.

## Windows deployment invariants

- `windows/pihole.ps1` supports Start, Stop, Status and Logs, plus `-Tailscale`.
  Keep PowerShell 5.1 and 7 compatibility. Resolve paths and `.env` relative to
  the script, including from working paths with spaces.
- `windows/compose.yaml` defaults to localhost TCP/UDP 53 and TCP 8080 to
  container port 80. `compose.tailscale.yaml` adds explicit Tailscale-IP bindings
  while preserving localhost/LAN bindings. Keep both files in that order.
- `-Tailscale` is not persisted. Base-only `Start` removes extra bindings.
  Include the overlay when updating/recreating a Tailscale deployment.
- Preserve project name `pihole-windows` and volume
  `pihole-windows_pihole-data` mounted at `/etc/pihole`. The GitHub rename must
  not rename storage. Do not delete volumes/reset Docker data as a routine fix.
- Keep DHCP on the router; no DHCP ports, host networking, `NET_ADMIN` or
  privileged containers are needed. IPv6 DNS serving is not configured here.
- Do not broaden bindings to `0.0.0.0` or expose public DNS/dashboard access.
  Scope firewall rules to intended interfaces, addresses and clients.
- Tailscale global nameservers/Override DNS may affect the whole tailnet.
  Prevent the host using Pi-hole through its own Tailscale DNS path; never point
  Pi-hole upstream at itself or `100.100.100.100`.
- Update by pulling/recreating, not `pihole -up`. Back up with Teleporter first;
  restore working client DNS before taking the host offline. Windows, Docker
  Desktop and Tailscale must remain available.

## Project overview

The upstream portion contains Pi-hole's installer, the `pihole` command line
interface, and the gravity subsystem that builds the domain blocking database.
That portion is almost entirely Bash; fork deployment additions are PowerShell
and Compose YAML.

## Repository layout

- `README.md` - fork overview and restart/update/recovery runbook
- `windows/README.md`, `windows/TAILSCALE.md` - local/LAN and phone setup
- `windows/pihole.ps1` - PowerShell launcher
- `windows/compose.yaml`, `windows/compose.tailscale.yaml` - base and overlay
- `windows/.env.example` - public template; `.env` stays private
- `test/test_windows_launcher.ps1`, `test/test_windows_compose.py` - Windows checks
- `automated install/basic-install.sh` - the installer (also handles updates and repairs)
- `automated install/uninstall.sh` - the uninstaller
- `pihole` - the `pihole` CLI entry point
- `advanced/Scripts/` - scripts backing the CLI subcommands (version, query, api, etc.)
- `advanced/Templates` and `advanced/` generally - service files, templates and assets installed onto the system
- `gravity.sh` - builds `gravity.db` from configured blocklists
- `manpages/` - man pages
- `test/` - BATS test suite, run inside distro-specific Docker containers

## Dev environment tips

- You need Docker (with buildx) and a bash shell; tests and most realistic verification run inside containers, not on the host.
- Keep scripts bash-compatible across all supported distros; do not introduce dependencies that are not available (or installed by the installer) on all of them.
- Installed scripts must remain executable.

## Testing instructions

- Launcher: `powershell.exe -NoProfile -File .\test\test_windows_launcher.ps1`.
  Also run under `pwsh` when available. Docker is mocked; no container/DNS changes.
- Compose: `python3 test/test_windows_compose.py` (or your Windows Python 3).
  Requires Compose v2, not a daemon. Tests isolate `.env` and environment
  overrides; cover defaults, storage, overrides and additive Tailscale bindings.
- From the repository root: `bash test/run.sh --distro debian_12`
- Run `bash test/run.sh --help` for the list of supported distros. The suite covers mocked function tests and a fresh-install test.
- Run at least one distro locally before proposing changes; CI runs the full matrix.
- Lint shell code with shellcheck; CI enforces it.
- Add or update tests in `test/` for any behavioural change.
- Use a Linux filesystem checkout for BATS (WSL or a disposable container) to
  preserve executable bits/LF; never run tests against live DNS data.
- For deployment validation, test DNS from a reachable client and inspect the
  Query Log, including mobile data for phone access. Report tests actually run,
  failures and unavailable tools. Do not claim end-to-end success from mocked
  tests or configuration checks, or change live DNS just to finish a repo test.

## PR instructions

- Upstream work is based on `development` and PRs target `development`; fork
  deployment work follows the branch guidance above.
- Read the [contributors guide](https://docs.pi-hole.net/guides/github/contributing/)
- Every commit must be signed off (DCO): use `git commit -s`.
- Run the tests and shellcheck before committing.
- Use Unix line endings (LF).
- Code is licensed under the EUPL 1.2; contributions must be compatible.
- Stability comes before features. This code runs unattended on a huge variety of systems; prefer conservative, well-tested changes and avoid speculative refactors.
- Match the existing style of surrounding code, including the `# shellcheck` directives and local/readonly variable conventions already in use.
- The correct project spelling is "Pi-hole" (capital P, lowercase h, hyphen).

## Security considerations

- The installer and most scripts run as root on end-user systems. Quote variables, validate all user-supplied and downloaded input, and avoid constructs that can expand into unintended commands.
- Gravity consumes remote blocklists; treat downloaded content as untrusted data, never as executable input.
- If you believe you have found a vulnerability, do not open a public issue or PR; report it privately per the organisation's security policy (disclosure@pi-hole.net).

## Common pitfalls

- Testing only on one distro and breaking another; the installer supports many package managers and init systems.
- Using bashisms in contexts executed by `sh`, or GNU-only flags on tools that differ on busybox/Alpine.
- Forgetting the DCO sign-off on commits.
- Changing installer behaviour without updating the corresponding tests in `test/`.
