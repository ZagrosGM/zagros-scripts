"""Pytest entry point for the repository's canonical Bash CLI harness.

The CLI is implemented in Bash, so tests/test_cli.sh remains the source of
truth. This wrapper makes the documented ``pytest`` gate execute that full
harness instead of reporting "no tests collected".
"""
from __future__ import annotations

import subprocess
from pathlib import Path


def test_full_cli_harness() -> None:
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["bash", "tests/test_cli.sh"],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=1200,
        check=False,
    )
    assert result.returncode == 0, (
        "full CLI harness failed\n--- stdout ---\n"
        + result.stdout[-12000:]
        + "\n--- stderr ---\n"
        + result.stderr[-4000:]
    )
    assert "0 failed" in result.stdout
    assert "ALL CLI TESTS PASSED" in result.stdout
