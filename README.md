# pihole-windows-tailscale

Run **Pi-hole on Windows using Docker Desktop**, with optional **Tailscale DNS
access from a phone away from home**. This personal fork of
[Pi-hole Core](https://github.com/pi-hole/pi-hole) keeps its deployment in
[`windows/`](windows/README.md).

Pi-hole runs inside the official Linux container; the deployment does not build
the Linux source in this checkout. Upstream Pi-hole is maintained by the
[Pi-hole project](https://pi-hole.net/). This fork's Windows/Tailscale setup is
maintained separately. The source retains its [EUPL 1.2 license](LICENSE).

## Start here when you come back

| What you need | Where to look |
| --- | --- |
| First install, password, local/LAN access | [Windows setup](windows/README.md) |
| Phone access over mobile data | [Tailscale setup and undo steps](windows/TAILSCALE.md) |
| Restart, update, backup, troubleshooting | Commands below |
| Continue development with an agent | [AGENTS.md](AGENTS.md) |
| Regression tests | [Test guide](test/README.md) |

The deployment branch is `windows-docker`, based on upstream `development`.
Use that branch when cloning this fork. The original Linux installer is still
present, but **do not run it in PowerShell, CMD or Git Bash**.

## First setup

You need Docker Desktop running **Linux containers** with the WSL 2 backend,
Windows PowerShell 5.1 or PowerShell 7, and free TCP/UDP port 53 and TCP port
8080. For remote phone access, connect Tailscale on both devices.
See the [full requirements](windows/README.md#requirements).

```powershell
git clone --branch windows-docker https://github.com/Wong-Zhen-Yi/pihole-windows-tailscale.git
Set-Location .\pihole-windows-tailscale

# Create local settings once; preserve an existing .env.
if (-not (Test-Path .\windows\.env)) {
    Copy-Item .\windows\.env.example .\windows\.env
}
.\windows\pihole.ps1 Start
.\windows\pihole.ps1 Status
```

Open [the local dashboard](http://localhost:8080/admin/) after initialization.
Set a password interactively and test DNS before changing client settings:

```powershell
docker compose --file .\windows\compose.yaml exec pihole pihole setpassword
Resolve-DnsName example.com -Server 127.0.0.1 -DnsOnly
```

If script execution is blocked, see the
[per-process invocation](windows/README.md#start-locally) in the Windows guide.
For LAN access, follow the [network setup](windows/README.md#use-pi-hole-for-your-network).
For phone access, complete the [Tailscale guide](windows/TAILSCALE.md), including
its firewall, DNS-loop prevention and validation steps, before changing DNS.
Tailscale global nameservers with Override DNS can affect the whole tailnet;
this is not a phone-only setting.

## Restart after a reboot

1. Start Docker Desktop and wait for its Linux engine to be ready.
2. Connect Tailscale before starting the container if using Tailscale bindings.
3. Open PowerShell in this repository and use the same mode as before:

```powershell
# Tailscale deployment: preserve both base and Tailscale bindings.
.\windows\pihole.ps1 Start -Tailscale
.\windows\pihole.ps1 Status -Tailscale

# For a deployment without Tailscale, omit -Tailscale on both commands.
```

**Keep `-Tailscale` on later launcher calls.** A base-only `Start` recreates the
service without the additional Tailscale bindings. The launcher does not
remember the switch. Docker's restart policy helps once its engine is running,
but Windows, Docker Desktop and Tailscale must remain available; host sleep or
shutdown interrupts DNS for dependent devices.

## Settings and data to preserve

| Item | Purpose |
| --- | --- |
| `windows/.env` | Local settings; ignored by Git |
| `PIHOLE_BIND_IP` | `127.0.0.1` by default; optionally the host's reserved LAN IPv4 |
| `PIHOLE_TAILSCALE_IP` | Host's `tailscale ip -4` address; required with `-Tailscale` |
| `PIHOLE_WEB_PORT` | Dashboard port, default `8080` |
| `PIHOLE_IMAGE` | Official image, default `pihole/pihole:latest`; may be pinned |
| Docker volume `pihole-windows_pihole-data` | Pi-hole settings and databases at `/etc/pihole` |
| Windows Firewall and Tailscale admin DNS | Configuration outside this repository |

The Compose project name stays **`pihole-windows`**, regardless of the GitHub name
or checkout directory. Do not rename it or override it with a different Compose
project name during recovery: that can select a different volume and appear to
lose your settings.

Keep passwords, `.env`, backups, query logs, device names and actual network
addresses out of commits. Record host addresses, chosen mode, firewall rule
names, image pin and previous DNS settings privately. Git does not back up the
Docker volume, firewall or tailnet DNS configuration. A fresh clone needs those
settings recreated and a Pi-hole backup restored.

## Check, stop and update

From the repository root, for Tailscale mode:

```powershell
.\windows\pihole.ps1 Status -Tailscale
.\windows\pihole.ps1 Logs -Tailscale  # Ctrl+C ends log following only.
.\windows\pihole.ps1 Stop -Tailscale # Keeps settings and databases.
.\windows\pihole.ps1 Start -Tailscale
```

Before updating, export a backup using **Settings > Teleporter** in the dashboard
and save it privately outside this repository. Pull and recreate with both files:

```powershell
docker compose --file .\windows\compose.yaml --file .\windows\compose.tailscale.yaml pull
docker compose --file .\windows\compose.yaml --file .\windows\compose.tailscale.yaml up --detach
```

For local/LAN-only mode, omit the second `--file` argument. A pinned
`PIHOLE_IMAGE` must be changed deliberately to obtain a newer release. Do not use
`pihole -up` inside the container. Updating this Git checkout does not update the
running image, and pulling an image does not update this checkout.

Container recreation and `Stop` retain the named volume. **`down --volumes`,
volume deletion and Docker Desktop data resets can erase your Pi-hole data.**
For migration, recreate the settings and import the Teleporter backup on the new
instance, then test DNS before redirecting clients.

## If it stops working

| Symptom | Checks |
| --- | --- |
| Docker unavailable | Start Docker Desktop; verify `docker info --format '{{.OSType}}'` reports `linux` |
| Port bind error | Check `Get-NetTCPConnection -LocalPort 53,8080` and `Get-NetUDPEndpoint -LocalPort 53`; confirm bind IPs still belong to the host |
| Local access works, phone fails | Check Tailscale on both devices, `.env`, `-Tailscale`, scoped firewall rules and tailnet access controls |
| Dashboard works, DNS does not | Test DNS on port 53 separately; web access alone does not prove DNS works |
| DNS works but ads remain | Check Query Log, blocking status and gravity lists; browser Secure DNS/Private DNS may bypass filtering |
| `.env` edits seem ignored | Existing `$env:PIHOLE_*` variables take precedence; run `Start` again in the intended mode |
| Settings appear missing | Check `docker volume inspect pihole-windows_pihole-data` and the project name before resetting anything |

Test from a device that can reach the configured bind address:

```powershell
$serverIP = Read-Host 'Pi-hole Windows host LAN or Tailscale IPv4 address'
nslookup example.com $serverIP
```

Check Pi-hole's Query Log for those requests. Test the phone on mobile data as
well as Wi-Fi. DNS filtering cannot reliably remove ads served from the same
domains as desired content, including many YouTube video ads.

Before stopping this host for an extended period, **restore working DNS** on
dependent clients/router or in Tailscale. Follow the
[Tailscale undo instructions](windows/TAILSCALE.md#undo).
Do not expose ports 53 or 8080 through your Internet router, disable the firewall,
or add an unfiltered secondary DNS server while expecting every query to be
filtered. Keep DHCP on the router; this deployment does not configure DHCP or
IPv6 DNS serving.

## Development and upstream

Read [AGENTS.md](AGENTS.md) before changing the setup. The Windows launcher has
mocked PowerShell tests and Compose configuration tests; Linux source changes
also require the distro BATS suite. See [test/README.md](test/README.md).

The upstream source includes `pihole`, `gravity.sh`, `advanced/` and
`automated install/`. For Linux installations, use the
[upstream README](https://github.com/pi-hole/pi-hole#readme),
[Pi-hole documentation](https://docs.pi-hole.net/) and
[official Docker project](https://github.com/pi-hole/docker-pi-hole).
Upstream contributions target `development` and follow the
[contributor guide](https://docs.pi-hole.net/guides/github/contributing/).
