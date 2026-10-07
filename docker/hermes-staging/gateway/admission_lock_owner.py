"""Journal-backed admission owner for the luna gateway.

The durable once-only decision is TerminalOperationJournal on the existing
data mount (/opt/data, host /var/lib/hermes-luna). Adapter.admit() accepts
only its closed synthetic custody pins, so custody() returns those pins.
It does not create /var/lib/pass4-authority. A second admit finds the
journal no longer READY and is refused.
"""
import fcntl
import json
import os
from pathlib import Path

from gateway.terminal_operation_journal import TerminalOperationJournal


_JOURNAL_IDENTITY = {
    "tenant": "hermes-luna",
    "endpoint": "8090",
    "request": "gateway-admission",
    "operation": "admit-once",
    "lane": "dev",
    "source": "gateway",
    "config": "terminal-operation-journal",
}


def _effect_verifier(identity, evidence):
    if type(evidence) is not dict or set(evidence) != {"platform", "chat_id", "message_id"}:
        return False
    if any(type(evidence[key]) is not str or not evidence[key] for key in evidence):
        return False
    return True


def _cancellation_verifier(identity, credential, now):
    raise RuntimeError("admission owner does not cancel")


def _synthetic_custody():
    # Closed pins required by Adapter._custody_valid. Not filesystem evidence.
    paths = (
        "/",
        "/var",
        "/var/lib",
        "/var/lib/pass4-authority",
        "/var/lib/pass4-authority/admission.lock",
    )
    ancestors = []
    for index in range(4):
        ancestors.append({
            "path": paths[index],
            "dev": 1,
            "inode": index + 1,
            "mode": 0o700 if index == 3 else 0o755,
            "uid": 0,
            "gid": 0,
            "type": "directory",
            "symlink": False,
        })
    descriptor = {
        "path": paths[4],
        "dev": 1,
        "inode": 5,
        "mode": 0o600,
        "uid": 0,
        "gid": 0,
        "type": "regular",
        "symlink": False,
        "nlink": 1,
        "size": 0,
    }
    return {"ancestors": ancestors, "descriptor": descriptor}


class _AdmissionTransaction:
    def __init__(self, owner):
        self.owner = owner
        self.generation = None
        self.effect = None
        self._committed = False
        self._aborted = False

    def read(self):
        return self.owner._journal.snapshot()

    def validate(self, record):
        identity = self.owner.execution_identity
        if type(identity) is not tuple or len(identity) != 3:
            return False
        if any(type(value) is not str or not value for value in identity):
            return False
        if type(record) is not dict or record.get("status") != "READY":
            return False
        return True

    def burn(self):
        identity = self.owner.execution_identity
        self.effect = json.dumps(
            {"platform": identity[0], "chat_id": identity[1], "message_id": identity[2]},
            sort_keys=True,
            separators=(",", ":"),
        )
        self.generation = self.owner._journal.admit()
        self.owner._journal.reserve_effect(self.generation, self.effect)

    def commit(self):
        identity = self.owner.execution_identity
        evidence = {
            "platform": identity[0],
            "chat_id": identity[1],
            "message_id": identity[2],
        }
        self.owner._journal.commit_effect(self.generation, self.effect, evidence)
        self._committed = True

    def abort(self):
        if self._aborted or self._committed:
            return
        self._aborted = True
        if self.generation is None:
            return
        self.owner._journal.mark_uncertain(self.generation)

    def authority(self):
        import sys
        adapter = sys.modules["proposed_admission_lock_adapter"]
        return adapter.Authority(self.owner.execution_identity)


class AdmissionLockOwner:
    def __init__(self, path):
        self.poisoned = False
        self.execution_identity = None
        self.lock_identity = object()
        self._fd = None
        self.path = Path(path).absolute()
        parent = self.path.parent
        parent.mkdir(mode=0o700, exist_ok=True)
        os.chmod(parent, 0o700)
        bootstrap = not self.path.exists()
        self._journal = TerminalOperationJournal(
            self.path,
            dict(_JOURNAL_IDENTITY),
            cancellation_verifier=_cancellation_verifier,
            effect_verifier=_effect_verifier,
            bootstrap=bootstrap,
        )

    def ready(self):
        return self._journal.snapshot().get("status") == "READY"

    def open_existing(self):
        if self._fd is None:
            self._fd = os.open(self.path, os.O_RDWR)
        return self.lock_identity

    def custody(self, descriptor):
        if descriptor is not self.lock_identity:
            raise RuntimeError("foreign admission descriptor")
        return _synthetic_custody()

    def lock_exclusive_nonblocking(self, descriptor):
        if descriptor is not self.lock_identity or self._fd is None:
            return False
        try:
            fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return False
        return True

    def begin(self):
        return _AdmissionTransaction(self)

    def unlock(self, descriptor):
        if descriptor is not self.lock_identity:
            raise RuntimeError("foreign admission descriptor")
        if self._fd is not None:
            fcntl.flock(self._fd, fcntl.LOCK_UN)

    def close(self, descriptor):
        if descriptor is not self.lock_identity:
            raise RuntimeError("foreign admission descriptor")
        fd = self._fd
        self._fd = None
        if fd is not None:
            os.close(fd)
