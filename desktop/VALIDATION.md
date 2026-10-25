# Desktop validation — 25 October 2026

- `npm ci`: installed the pinned dependencies; npm reported no known vulnerabilities.
- `npm test`: 19 Node regression tests passed, including mocked Electron startup
  registration/removal, opt-in Pi-hole startup, IPC sender validation and
  preservation of existing Tailscale bindings and storage.
- `npm run test:ui`: rendered checks passed in Chrome with a mocked desktop bridge,
  including startup toggles, rejected settings changes, service controls, safe text
  rendering and widths of 880, 1160 and 1440 pixels.
- `npm run package`: built the Windows x64 executable and resources. The packaged
  application archive contains only the allowlisted desktop files; it excludes
  private deployment settings and development dependencies.
- `npm run test:smoke`: passed against the packaged executable and live local
  Docker status. The existing Tailscale deployment reported running and healthy.
  The check exercised the real preload/IPC bridge with Windows startup writes
  mocked, verified renderer isolation and close-to-tray, and left the deployment
  unchanged.
- Windows launcher checks passed in PowerShell 5.1 (using per-process
  `-ExecutionPolicy Bypass`) and PowerShell 7. All four Compose configuration
  tests passed with the bundled Python runtime.
- In the existing `pihole_test:debian_12` Linux test image, all 52 function/mock
  tests passed. Its fresh-install suite failed on the first test while trying to
  clone Core into an existing directory; it also reported a missing `man`
  package. The five dependent fresh-install tests were skipped. This cached
  image was not rebuilt from the desktop changes.
- The host command `bash test/run.sh --distro debian_12` could not run because
  WSL has no `/bin/bash`. ShellCheck is unavailable on the host and in that
  cached image; no Bash sources were changed.

A real sign-out/reboot and cold Docker Desktop startup have not been exercised.
Windows startup registration and cold-start process dispatch were tested with
mocks. No client DNS or phone/mobile-data tests were performed. A running or
healthy container does not prove end-to-end DNS filtering.
