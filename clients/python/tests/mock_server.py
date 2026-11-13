"""Run the repository's mock server (mock-server/server.mjs) as a subprocess.

The tests need Node.js >= 20 on PATH. The mock picks a free port (--port 0)
and prints the real one, so parallel runs do not collide.
"""

from __future__ import annotations

import shutil
import subprocess
import unittest
from pathlib import Path

SERVER = Path(__file__).resolve().parents[3] / "mock-server" / "server.mjs"
PREFIX = "MolochAI mock API listening on "


class MockServer:
    def __init__(self, *args: str) -> None:
        node = shutil.which("node")
        if node is None:
            raise unittest.SkipTest("Node.js is needed to run the mock server")
        self.proc = subprocess.Popen(
            [node, str(SERVER), "--port", "0", "--delay-ms", "0", "--quiet", *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        assert self.proc.stdout is not None
        line = self.proc.stdout.readline().strip()
        if not line.startswith(PREFIX):
            self.stop()
            raise RuntimeError(f"mock server did not start: {line!r}")
        self.base_url = line[len(PREFIX) :]
        self.origin = self.base_url.removesuffix("/api/v1")

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        for stream in (self.proc.stdout, self.proc.stderr):
            if stream:
                stream.close()
