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
