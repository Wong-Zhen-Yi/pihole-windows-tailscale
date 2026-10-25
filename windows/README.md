# Run Pi-hole on Windows

Pi-hole's installer, CLI and FTL service require Linux. Do not run the Linux
installer in PowerShell, Command Prompt or Git Bash. This setup runs the
[official Pi-hole image](https://github.com/pi-hole/docker-pi-hole) in Docker
Desktop's Linux VM, managed from Windows PowerShell. It deploys a published
image; it does **not** build or run modifications in this source checkout.

## Requirements

- A supported Windows 10/11 version for
  [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/),
  with hardware virtualization and WSL 2 enabled.
- Docker Desktop running with the WSL 2 backend and **Linux containers**.
- Windows PowerShell 5.1 or PowerShell 7, and Docker Compose v2 (included in
  Docker Desktop).
- Available TCP and UDP port **53**, and TCP port **8080**. Another DNS service,
  VPN or container can prevent Docker from binding these ports.

Docker Desktop must stay running, and Windows must stay awake, for DNS to work.
This is not a native Windows service or an unattended Windows Server install.

## Start locally

From the repository root in PowerShell:

```powershell
Copy-Item .\windows\.env.example .\windows\.env
.\windows\pihole.ps1 Start
.\windows\pihole.ps1 Status
```

The copy is optional for local testing; do not overwrite an existing `.env` when
updating. If local execution policy blocks the launcher, review the script and
use a one-process invocation rather than changing the machine-wide policy:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\pihole.ps1 Start
```

Wait for the container to initialize, then open <http://localhost:8080/admin/>.
The image generates an initial password in its startup logs. Set your own
password interactively (without putting it in shell history or a tracked file):

```powershell
docker compose --file .\windows\compose.yaml exec pihole pihole setpassword
```

Test DNS explicitly before changing any Windows or router DNS settings:

```powershell
Resolve-DnsName example.com -Server 127.0.0.1 -DnsOnly
```

The default port bindings accept **only local connections**. The launcher does
not change Windows DNS settings, open firewall ports or alter your router.

## Use Pi-hole for your network

1. Reserve a stable LAN IPv4 address for the Windows host in your router.
2. Edit `windows/.env`: set `PIHOLE_BIND_IP` to that address. Keep the host on a
   trusted private network. Avoid `0.0.0.0`,
   which publishes on every IPv4 interface.
3. Run `.\windows\pihole.ps1 Start` again to apply the new bindings. The local
   dashboard is now at `http://<Windows-LAN-IP>:8080/admin/`, not `localhost`.
4. If Windows Firewall blocks access, allow inbound TCP/UDP 53 from **only your
   trusted LAN subnet**, on the **Private** profile. Allow TCP 8080 only from
   machines that need the dashboard. Follow your network administrator's policy;
   do not disable the firewall or expose DNS/the dashboard to the Internet.
5. From another device, test `nslookup example.com <Windows-LAN-IP>` (replace the
   placeholder with the actual address). Then configure
   your router's DHCP DNS setting (or individual clients) to use this address.
   Do not configure a public secondary DNS server if you expect all queries to
   be filtered; clients may use it instead of Pi-hole.

Keep DHCP on your router. This setup intentionally does **not** publish DHCP
ports, use host networking or grant `NET_ADMIN`; DHCP broadcasts do not work
transparently across Docker Desktop's VM boundary. IPv6 DNS serving is not
configured here. If your router advertises another IPv6 DNS server, clients may
bypass Pi-hole; configure your network accordingly.

## Use Pi-hole from your phone over Tailscale

Use the [Tailscale setup guide](TAILSCALE.md) to add tailnet-only bindings while
preserving existing localhost/LAN access. Start with `-Tailscale` and configure
the Windows firewall before changing phone DNS. No router changes are needed.
Tailscale's global nameserver/Override DNS configuration can affect other tailnet
devices too; it is not a phone-only setting.

## Manage and update

```powershell
.\windows\pihole.ps1 Logs    # Follow logs; Ctrl+C stops following, not Pi-hole
.\windows\pihole.ps1 Stop    # Stop without deleting settings
.\windows\pihole.ps1 Start

docker compose --file .\windows\compose.yaml exec pihole pihole status
docker compose --file .\windows\compose.yaml pull
docker compose --file .\windows\compose.yaml up --detach
```

These direct update commands are for local/LAN-only mode. For a Tailscale
deployment, include `--file .\windows\compose.tailscale.yaml` after the base file
on both commands to retain the additional bindings. See the
[root runbook](../README.md#check-stop-and-update) for ready-to-copy commands.

Update containers by pulling/recreating, **not** by running `pihole -up` inside
one. `PIHOLE_IMAGE` can pin an official release tag or digest; change that pin
when deliberately updating. `PIHOLE_WEB_PORT` changes the host dashboard port.

Configuration and databases live in the Docker named volume
`pihole-windows_pihole-data`, so container recreation retains them. Back up via
the dashboard's Teleporter before updating, and back up important data before
resetting Docker Desktop. `docker compose --file .\windows\compose.yaml down`
removes containers but preserves the volume; adding `--volumes` **deletes the
stored Pi-hole data**. Removing Docker Desktop's VM/data also removes it.

If startup fails, check Docker Desktop is ready, run `Status`/`Logs`, and check
for port conflicts with `Get-NetTCPConnection -LocalPort 53,8080` and
`Get-NetUDPEndpoint -LocalPort 53`. Do not disable system services blindly to
free ports. If `.env` changes seem ignored, check for existing PowerShell
`$env:PIHOLE_*` variables, which take precedence over `.env`.

Before shutting down this host or removing Pi-hole, restore working DNS settings
on your router/clients to avoid leaving the network without DNS.

## Development tests

Run the launcher regression tests without Docker:

```powershell
powershell.exe -NoProfile -File .\test\test_windows_launcher.ps1
```

The existing Linux/BATS tests still require Linux containers and Bash. Use a
WSL checkout on its Linux filesystem and follow [the test guide](../test/README.md).
Running the published image above is not a substitute for testing source changes.
