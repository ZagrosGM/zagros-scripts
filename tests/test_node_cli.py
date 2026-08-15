"""Native node installer stores only bootstrap hash and never mounts Docker."""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def test_node_install_generates_tls_and_one_time_token_without_docker_socket(tmp_path: Path) -> None:
    if not shutil.which("unshare") or not shutil.which("openssl"):
        pytest.skip("unshare/openssl unavailable")
    tools = tmp_path / "bin"; tools.mkdir()
    docker_log = tmp_path / "docker.log"
    docker = tools / "docker"
    docker.write_text(f"#!/bin/sh\nprintf '%s\\n' \"$*\" >> {docker_log}\nexit 0\n")
    docker.chmod(0o755)
    home, data = tmp_path / "home", tmp_path / "data"
    env = os.environ.copy()
    env.update({
        "PATH": f"{tools}:{env['PATH']}",
        "ZAGROS_NODE_HOME": str(home),
        "ZAGROS_NODE_DATA": str(data),
        "ZAGROS_NODE_IMAGE": "example.invalid/zagros:test",
    })
    result = subprocess.run([
        "unshare", "-Ur", "bash", str(ROOT / "zagros-node"),
        "install", "127.0.0.1", "62443",
    ], env=env, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    compose = (home / "docker-compose.yml").read_text()
    lines = result.stdout.splitlines()
    token = lines[lines.index(
        "One-time registration token (shown once; only its SHA-256 is stored):") + 1]
    assert len(token) >= 32
    assert token not in compose
    assert "ZAGROS_NODE_REGISTRATION_HASH" in compose
    assert "docker.sock" not in compose
    assert "NET_ADMIN" in compose and "/dev/net/tun" in compose
    assert (data / "tls/node.crt").exists()
    assert (data / "tls/node.key").stat().st_mode & 0o777 == 0o600
    assert "compose up -d" in docker_log.read_text()
