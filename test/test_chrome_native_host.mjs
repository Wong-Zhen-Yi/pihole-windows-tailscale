import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const id = "a".repeat(32);
const source = path.join(repository, "windows/chrome-helper");
const windows = process.platform === "win32";

test("Windows host framing, caller restriction, fixed actions and detached worker", { skip: !windows }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "Pi-hole native host "));
  try {
    // Prepare installer files in an isolated location; never register a test host.
    execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(source, "install.ps1"), "-ExtensionId", id, "-Mode", "Tailscale", "-InstallDirectory", directory, "-SkipRegistration"], { windowsHide: true });
    const manifest = JSON.parse(readFileSync(path.join(directory, "com.wong.pihole_companion.json")));
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${id}/`]);
    assert.equal(JSON.parse(readFileSync(path.join(directory, "config.json"))).mode, "Tailscale");
    // The real stdio host runs with a read-only status fixture and a harmless
    // detached worker fixture. These tests cannot touch Docker or DNS.
    writeFileSync(path.join(directory, "common.ps1"), readFileSync(path.join(source, "common.ps1"), "utf8") + '\nfunction Get-HelperStatus { param($Config, $Directory) return @{ ok = $true; phase = "stopped"; mode = $Config.mode; message = "fixture status" } }\n');
    writeFileSync(path.join(directory, "worker.ps1"), '[IO.File]::WriteAllText((Join-Path $PSScriptRoot "worker-started.txt"), "fixture worker")\n');

    const call = (request, origin = `chrome-extension://${id}/`, raw = null, wrapper = false) => new Promise((resolve, reject) => {
      let file = "powershell.exe";
      let args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(directory, "native-host.ps1"), origin, "--parent-window=0"];
      if (wrapper) {
        assert.ok(!/[&|<>%^"\r\n]/.test(directory));
        file = process.env.ComSpec;
        args = ["/d", "/s", "/c", `""${path.join(directory, "native-host.cmd")}" "${origin}" --parent-window=0"`];
      }
      const child = spawn(file, args, { windowsHide: true, windowsVerbatimArguments: wrapper });
      const output = [], errors = [];
      child.stdout.on("data", data => output.push(data)); child.stderr.on("data", data => errors.push(data));
      child.on("error", reject);
      const timer = setTimeout(() => { child.kill(); reject(new Error("Host timed out")); }, 15000);
      child.on("close", code => {
        clearTimeout(timer);
        try {
          assert.equal(code, 0, Buffer.concat(errors).toString());
          const data = Buffer.concat(output);
          assert.ok(data.length > 4, Buffer.concat(errors).toString());
          assert.equal(data.readUInt32LE(0), data.length - 4, "No text or CRLF can corrupt protocol stdout");
          resolve(JSON.parse(data.subarray(4).toString("utf8")));
        } catch (error) { reject(error); }
      });
      child.stdin.on("error", () => {});
      if (raw) child.stdin.end(raw);
      else {
        const body = Buffer.from(JSON.stringify(request)); const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
        // Split chunks exercise partial reads.
        child.stdin.write(header.subarray(0, 2)); child.stdin.write(header.subarray(2)); child.stdin.end(body);
      }
    });
    assert.equal((await call({ action: "status" })).phase, "stopped");
    assert.equal((await call({ action: "status" }, `chrome-extension://${id}/`, null, true)).phase, "stopped");
    assert.equal((await call({ action: "status" }, `chrome-extension://${"b".repeat(32)}/`)).ok, false);
    for (const request of [{ action: "stop" }, { action: "start", command: "unsafe" }, { action: "status", path: "other" }, "status", null, []]) {
      assert.equal((await call(request)).ok, false);
    }
    const oversized = Buffer.alloc(4); oversized.writeUInt32LE(4097);
    assert.equal((await call(null, `chrome-extension://${id}/`, oversized)).ok, false);
    const truncated = Buffer.alloc(5); truncated.writeUInt32LE(20); truncated[4] = 123;
    assert.equal((await call(null, `chrome-extension://${id}/`, truncated)).ok, false);
    const reply = await call({ action: "start" });
    assert.equal(reply.phase, "starting");
    const marker = path.join(directory, "worker-started.txt");
    for (let n = 0; n < 50 && !existsSync(marker); n++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(readFileSync(marker, "utf8"), "fixture worker");
  } finally {
    // The resolved target is the exact unique scratch folder created above.
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
