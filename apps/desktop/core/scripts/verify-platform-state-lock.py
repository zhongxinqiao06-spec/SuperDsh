"""Exercise the installed pinned product lock with two real processes and temporary data."""
import ast
from contextlib import contextmanager
import errno
import hashlib
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time


def load_lock(source):
    tree = ast.parse(Path(source).read_text(encoding="utf-8"))
    names = {"state_lock_port", "_claim_state_lock", "state_lock"}
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    assert len(functions) == 3
    scope = dict(globals(), Iterator=object)
    # Keep the actual installed implementation; avoid unrelated runtime dependencies.
    code = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *functions], type_ignores=[])
    exec(compile(ast.fix_missing_locations(code), str(source), "exec"), scope)
    return scope["state_lock"]


source = sys.argv[1]
state_lock = load_lock(source)
if "--child" in sys.argv:
    with state_lock(Path(sys.argv[-1])):
        print("ready", flush=True)
        sys.stdin.readline()
else:
    with tempfile.TemporaryDirectory(prefix="superdsh-lock-verification-") as directory:
        path = Path(directory) / "runtime.json"
        child = subprocess.Popen([sys.executable, __file__, source, "--child", str(path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            assert child.stdout.readline().strip() == "ready"
            try:
                with state_lock(path, timeout=0.1):
                    raise AssertionError("Second process bypassed the active lock")
            except RuntimeError as exc:
                assert "busy" in str(exc)
            child.communicate("release\n", timeout=5)
            assert child.returncode == 0
            with state_lock(path, timeout=0.1):
                pass
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
    print("Installed Connector state lock passed: live cross-process exclusion and release.")
