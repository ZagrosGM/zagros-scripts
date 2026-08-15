from __future__ import annotations

import json
import os
import stat
import subprocess
import time
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
AGENT = ROOT / "zagros-ssh-accounting-agent"


def test_read_only_ssh_accounting_agent_heartbeat_and_permissions(tmp_path: Path) -> None:
    if os.geteuid() != 0:
        pytest.skip("host collector intentionally requires root; covered on real VPS")
    env = dict(os.environ, ZAGROS_SSH_ACCOUNTING_DIR=str(tmp_path),
               ZAGROS_SSH_ACCOUNTING_INTERVAL="0.25")
    process = subprocess.Popen([str(AGENT)], env=env)
    try:
        state = tmp_path / "host-transport-usage.json"
        for _ in range(40):
            if state.exists():
                break
            time.sleep(0.1)
        assert state.exists()
        payload = json.loads(state.read_text())
        assert payload["version"] == 1
        assert payload["totals"] == {}
        assert payload["live"] == {}
        assert stat.S_IMODE(state.stat().st_mode) == 0o600
        assert stat.S_IMODE(tmp_path.stat().st_mode) == 0o700
    finally:
        process.terminate()
        process.wait(timeout=5)


def test_agent_has_fixed_scope_and_no_shell_execution_surface() -> None:
    text = AGENT.read_text()
    assert '"/usr/bin/ss"' in text
    assert "shell=True" not in text
    assert "eval(" not in text
    assert "os.system" not in text
    assert "sys.argv" not in text
    assert "token" not in text.lower()
    assert "password" not in text.lower()


def test_forget_tombstone_blocks_lingering_socket_then_allows_uid_reuse(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Deletion must not re-import a still-closing socket's lifetime bytes."""
    import importlib.machinery
    import importlib.util

    loader = importlib.machinery.SourceFileLoader("zg_ssh_acct_agent", str(AGENT))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)

    module.ROOT = tmp_path
    module.STATE = tmp_path / "host-transport-usage.json"
    module.FORGET = tmp_path / "accounting-forget.json"
    module.FORGET.write_text("[1001]")
    totals = {1001: (111, 222)}
    live = {"2022:7": (1001, 111, 222)}
    totals, live, forgotten = module.apply_forget(totals, live, set())
    assert totals == {} and live == {} and forgotten == {1001}

    # The deleted session still appears in one collector sample: ignore it and
    # persist the tombstone rather than importing 111/222 again.
    monkeypatch.setattr(module, "snapshot", lambda: {"2022:7": (1001, 111, 222)})
    live = module.collect(totals, live, forgotten)
    assert totals == {} and live == {} and forgotten == {1001}
    loaded_totals, loaded_live, loaded_forgotten = module.load_state()
    assert loaded_totals == {} and loaded_live == {} and loaded_forgotten == {1001}

    # One clean sample bounds the tombstone. A later OS reuse of UID 1001 is
    # therefore counted normally instead of being forgotten forever.
    monkeypatch.setattr(module, "snapshot", lambda: {})
    module.collect(totals, live, forgotten)
    assert forgotten == set()
    monkeypatch.setattr(module, "snapshot", lambda: {"2022:9": (1001, 7, 9)})
    live = module.collect(totals, {}, forgotten)
    assert live == {"2022:9": (1001, 7, 9)}
    assert totals == {1001: (7, 9)}
