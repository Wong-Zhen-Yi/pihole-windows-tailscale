# Use Pi-hole from a phone over Tailscale

This adds bindings on the Windows host's Tailscale IPv4 address without replacing
its existing localhost/LAN bindings. No router configuration, port forwarding,
exit node or subnet router is needed. Your phone and Windows host must be signed
into the same tailnet (or have explicitly permitted access), and Tailscale must
be connected on both. Windows, Docker Desktop and Pi-hole must remain awake and
running, including while the phone is on mobile data.

## 1. Add the Tailscale bindings

In PowerShell on the Windows host, run `tailscale ip -4`. Put that address in
`windows/.env`, replacing the placeholder below with the actual address:

```dotenv
PIHOLE_TAILSCALE_IP=YOUR_WINDOWS_TAILSCALE_IPV4
```

Keep `PIHOLE_BIND_IP` unchanged to preserve existing access. Start Tailscale
before Docker tries to bind its address. From the repository root, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\pihole.ps1 Start -Tailscale
```

Keep using `-Tailscale` on subsequent launcher calls. A base-only `Start` or
`docker compose --file windows/compose.yaml up` removes the additional bindings.
For direct Compose commands, specify both files in this order:

```powershell
docker compose --file .\windows\compose.yaml --file .\windows\compose.tailscale.yaml ps
```

For the optional [Chrome launch helper](../chrome-extension/README.md#launch-pi-hole-from-chrome-on-windows),
install while this Tailscale deployment exists so its mode is detected correctly,
or explicitly choose `-Mode Tailscale`. It preserves existing containers' bindings
and includes the overlay when creating a missing container. Connect Tailscale
before using **Launch Pi-hole**. Reinstall the helper after deliberately changing
deployment mode; it does not change firewall rules or Tailscale DNS settings.

## 2. Allow DNS through the Windows firewall

Run the following in **Administrator PowerShell**. These rules apply only to
traffic arriving on the Tailscale adapter, addressed to this host's Tailscale IP,
from the Tailscale IPv4 range. They do not publish DNS on the Internet. `Any`
allows Tailscale's virtual adapter to work regardless of its Windows profile;
the interface and address restrictions must not be omitted. Use the phone's
specific Tailscale IPv4 address instead of the range if access should be limited
to just that phone. Tailnet access controls also need to allow TCP/UDP 53 and,
if desired, TCP 8080 from the phone to this host.

The hashtable format avoids accidentally executing incomplete firewall commands
when copying multiple lines. Run this setup once; repeating it creates duplicate
rules with the same display names.

```powershell
$tsIP = (tailscale ip -4 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $tsIP) {
    throw 'Connect Tailscale first, then retry.'
}

$rule = @{
    DisplayName    = 'Pi-hole Tailscale DNS UDP'
    Direction      = 'Inbound'
    Action         = 'Allow'
    Enabled        = 'True'
    Profile        = 'Any'
    InterfaceAlias = 'Tailscale'
    LocalAddress   = $tsIP
    RemoteAddress  = '100.64.0.0/10'
    Protocol       = 'UDP'
    LocalPort      = 53
}
New-NetFirewallRule @rule

$rule.DisplayName = 'Pi-hole Tailscale DNS and dashboard TCP'
$rule.Protocol = 'TCP'
$rule.LocalPort = @(53, 8080)
New-NetFirewallRule @rule
```

If you changed `PIHOLE_WEB_PORT`, replace 8080 in the rule accordingly. If the
adapter has been renamed, use its actual name instead of `Tailscale`. Do not
disable the firewall or open these ports on all Windows interfaces.

## 3. Test before changing phone DNS

In the phone's Tailscale app, verify the Windows host is online. While connected
to Tailscale, open `http://<Windows-Tailscale-IP>:8080/admin/` in the phone's
browser. This tests web access only; it does not prove that DNS works.

From another Tailscale-connected Windows device, if available, test DNS directly:

```powershell
$serverIP = Read-Host 'Pi-hole Windows host Tailscale IPv4 address'
nslookup example.com $serverIP
```

If these fail, check the container, firewall, Tailscale access policy and whether
Tailscale permits incoming connections on the Windows host. Do not disable VPN
or firewall protections blindly. Confirm Pi-hole blocking is enabled and that
its blocklists have been downloaded using Tools > Update Gravity.

## 4. Have the phone use Pi-hole DNS

The simplest Tailscale-managed method is a **global nameserver**. This is a
**tailnet-wide setting**, not a phone-only setting: other devices accepting
Tailscale DNS can also be affected. Do not enable this unless that scope is
intended. If other devices must stay unchanged, decide on device-specific DNS
configuration first; do not assume the global nameserver applies only to phones.

Before enabling a global nameserver, prevent the Pi-hole Windows host from using
its own Tailscale DNS service as upstream, which can cause a DNS loop:

```powershell
tailscale set --accept-dns=false
```

This changes only the Windows host's acceptance of Tailscale DNS, not its VPN
connection. MagicDNS name resolution on this host may change. In Pi-hole's DNS
settings, use a working external upstream resolver rather than this host's own
LAN/Tailscale address or Tailscale's `100.100.100.100` resolver.

If the tailnet-wide DNS setting is acceptable:

1. Open the [Tailscale admin DNS page](https://login.tailscale.com/admin/dns).
2. Under Nameservers, add a custom **global** nameserver using the Windows host's
   Tailscale IPv4 address. Do not restrict it to a single domain.
3. Enable **Override DNS servers**. Do not add a public secondary global
   nameserver if you expect every query to be filtered.
4. On the phone, connect Tailscale and ensure **Use Tailscale DNS settings** is
   enabled (the label/location depends on the OS/app version). Reconnect the app
   if necessary.
5. Browse a few sites and check Pi-hole's Query Log for new queries and blocked
   domains. Temporarily disconnect Wi-Fi to check mobile-data access too.

Android Private DNS, browser Secure DNS, another VPN or privacy services may
bypass/conflict with Tailscale DNS. Do not change them unless testing shows a
conflict. DNS filtering cannot reliably remove YouTube video ads or advertising
served from the same domains as desired content. No exit node is required for
DNS filtering; normal browsing traffic need not pass through this Windows PC.

## Undo

If the Windows host will be unavailable, restore working DNS before leaving
clients dependent on it. Remove this global nameserver/disable Override DNS
servers in Tailscale as appropriate, or turn off Tailscale DNS acceptance on the
client. To restore the Windows host's previous Tailscale DNS acceptance, run
`tailscale set --accept-dns=true` only if it was previously enabled.

To remove the extra container bindings, start the launcher without `-Tailscale`.
Remove only the firewall rules you created for this setup, using their names.
The container's persistent Pi-hole data is not deleted by changing bindings.
