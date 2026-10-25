"""Validate the Windows deployment using Compose v2 (no Docker daemon needed)."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


COMPOSE_FILE = Path(__file__).resolve().parents[1] / "windows" / "compose.yaml"


class WindowsComposeTests(unittest.TestCase):
    def config(self, settings="", tailscale=False):
        # Do not let the developer's environment or windows/.env affect tests.
        env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith(("PIHOLE_", "COMPOSE_")) and key != "TZ"
        }
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text(settings, encoding="utf-8")
            command = [
                "docker", "compose", "--env-file", str(env_file),
                "--file", str(COMPOSE_FILE),
            ]
            if tailscale:
                command += ["--file", str(COMPOSE_FILE.with_name("compose.tailscale.yaml"))]
            result = subprocess.run(
                command + ["config", "--format", "json"],
                env=env, capture_output=True, text=True, check=True,
            )
        return json.loads(result.stdout)

    def test_local_defaults(self):
        config = self.config()
        self.assertEqual(config["name"], "pihole-windows")
        service = config["services"]["pihole"]
        self.assertEqual(service["image"], "pihole/pihole:latest")
        self.assertEqual(
            {
                (p["host_ip"], str(p["published"]), p["target"], p["protocol"])
                for p in service["ports"]
            },
            {
                ("127.0.0.1", "53", 53, "tcp"),
                ("127.0.0.1", "53", 53, "udp"),
                ("127.0.0.1", "8080", 80, "tcp"),
            },
        )
        self.assertEqual(service["environment"]["FTLCONF_dns_listeningMode"], "ALL")
        self.assertEqual(service["restart"], "unless-stopped")
        self.assertFalse(service.get("privileged", False))
        self.assertFalse(service.get("cap_add", []))
        volume = service["volumes"][0]
        self.assertEqual(volume["type"], "volume")
        self.assertEqual(volume["target"], "/etc/pihole")
        self.assertEqual(
            config["volumes"][volume["source"]]["name"],
            "pihole-windows_pihole-data",
        )

    def test_env_overrides(self):
        config = self.config(
            "PIHOLE_BIND_IP=192.168.1.10\nPIHOLE_WEB_PORT=8888\n"
            "PIHOLE_IMAGE=pihole/pihole:test-pin\nTZ=Europe/London\n"
        )
        service = config["services"]["pihole"]
        self.assertEqual(service["image"], "pihole/pihole:test-pin")
        self.assertEqual(service["environment"]["TZ"], "Europe/London")
        self.assertTrue(all(p["host_ip"] == "192.168.1.10" for p in service["ports"]))
        web_port = next(p for p in service["ports"] if p["target"] == 80)
        self.assertEqual(str(web_port["published"]), "8888")

    def test_tailscale_adds_bindings_without_replacing_lan(self):
        config = self.config(
            "PIHOLE_BIND_IP=192.168.1.10\nPIHOLE_TAILSCALE_IP=100.64.0.10\n",
            tailscale=True,
        )
        ports = config["services"]["pihole"]["ports"]
        self.assertEqual(
            {
                (p["host_ip"], str(p["published"]), p["target"], p["protocol"])
                for p in ports
            },
            {
                (ip, published, target, protocol)
                for ip in ("192.168.1.10", "100.64.0.10")
                for published, target, protocol in (
                    ("53", 53, "tcp"), ("53", 53, "udp"), ("8080", 80, "tcp")
                )
            },
        )
        self.assertEqual(len(ports), 6)

    def test_tailscale_requires_an_explicit_address(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.config(tailscale=True)


if __name__ == "__main__":
    unittest.main()
