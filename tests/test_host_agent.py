"""Root host-agent regression: listener collision is non-destructive."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


def test_softether_443_conflict_never_rewrites_env_or_calls_docker(tmp_path: Path) -> None:
    if not shutil.which("unshare"):
        pytest.skip("unshare is unavailable")
    tools = tmp_path / "bin"
    home = tmp_path / "home"
    data = tmp_path / "data"
    actions = data / "host-actions"
    tools.mkdir(); home.mkdir(); actions.mkdir(parents=True)
    env_file = home / ".env"
    original = "UVICORN_PORT=4000\nDOMAIN=old.example.test\n"
    env_file.write_text(original)
    (home / "docker-compose.yml").write_text("services: {}\n")
    docker_called = tmp_path / "docker-called"
    (tools / "docker").write_text(
        f"#!/bin/sh\ntouch {docker_called}\nexit 99\n")
    (tools / "ss").write_text(
        "#!/bin/sh\nprintf '%s\\n' 'LISTEN 0 128 0.0.0.0:443 0.0.0.0:* users:((\"vpnserver\",pid=77,fd=3))'\n")
    os.chmod(tools / "docker", 0o755)
    os.chmod(tools / "ss", 0o755)
    request = {
        "version": 1,
        "operation_id": "0123456789abcdef0123456789abcdef",
        "requested_at": int(time.time()),
        "settings": {
            "domain": "panel.example.test", "port": 443,
            "scheme": "http", "bind_address": "0.0.0.0",
            "trusted_proxies": [], "hsts": False,
            "redirect_http_to_https": False,
            "tls_certificate_id": None,
        },
    }
    (actions / "panel-network.request.json").write_text(json.dumps(request))
    env = os.environ.copy()
    env.update({
        "PATH": f"{tools}:{env['PATH']}",
        "ZAGROS_HOME": str(home), "ZAGROS_DATA": str(data),
        "ENV_FILE": str(env_file), "ACTION_DIR": str(actions),
    })
    result = subprocess.run(
        ["unshare", "-Ur", "bash", str(ROOT / "zagros-host-agent")],
        env=env, text=True, capture_output=True, timeout=30,
    )
    assert result.returncode == 2, result.stderr
    assert env_file.read_text() == original
    assert not docker_called.exists()
    assert not (actions / "panel-network.request.json").exists()
    payload = json.loads((actions / "panel-network.result.json").read_text())
    assert payload["status"] == "failed"
    assert payload["rolled_back"] is False
    assert "Port 443 is already owned by SoftEther SSTP" in payload["message"]
    assert not list(actions.glob(".env.before.*"))
