"""Per-message admission owner for the luna gateway.

The checksummed journal is one terminal row. After the first COMMITTED
admit, every later identity fails validation, and that failure poisons
the shared owner. This owner keeps the installed live journal path as
the anchor and opens a separate once-only journal per message identity
under that directory. Poison is remembered per identity, so a refusal of
one message does not refuse a different message.
"""
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

from gateway.admission_lock_owner import AdmissionLockOwner

_ADAPTER_NAME = "proposed_admission_lock_adapter"
_ADAPTER_PATH = "/opt/hermes/proposed_admission_lock_adapter.py"


class IdentityAdmissionOwner:
    def __init__(self, path):
        self.path = Path(path).absolute()
        self._anchor = AdmissionLockOwner(str(self.path))
        self._execution_identity = None
        self._poison = {}
        self._inner = None
        self._inner_for = None

    def ready(self):
        return self._anchor.ready()

    @property
    def execution_identity(self):
        return self._execution_identity

    @execution_identity.setter
    def execution_identity(self, value):
        if self._inner_for != value:
            self._release_inner()
        self._execution_identity = value

    @property
    def poisoned(self):
        return self._poison.get(self._execution_identity, False)

    @poisoned.setter
    def poisoned(self, value):
        # The adapter treats only an exact False as healthy.
        self._poison[self._execution_identity] = False if value is False else True

    @property
    def lock_identity(self):
        if self._inner is None:
            return None
        return self._inner.lock_identity

    def _journal_path(self, identity):
        encoded = json.dumps(
            [identity[0], identity[1], identity[2]],
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        digest = hashlib.sha256(encoded).hexdigest()
        return self.path.parent / "by-message" / f"{digest}.journal"

    def _release_inner(self):
        inner = self._inner
        self._inner = None
        self._inner_for = None
        if inner is None:
            return
        journal = getattr(inner, "_journal", None)
        if journal is not None:
            try:
                journal.close()
            except Exception:
                pass

    def _ensure_inner(self):
        identity = self._execution_identity
        if self._inner is not None and self._inner_for == identity:
            self._inner.execution_identity = identity
            return self._inner
        self._release_inner()
        if (
            type(identity) is not tuple
            or len(identity) != 3
            or any(type(value) is not str or not value for value in identity)
        ):
            raise RuntimeError("admission identity is not bound")
        inner = AdmissionLockOwner(str(self._journal_path(identity)))
        inner.execution_identity = identity
        self._inner = inner
        self._inner_for = identity
        return inner

    def open_existing(self):
        return self._ensure_inner().open_existing()

    def custody(self, descriptor):
        return self._ensure_inner().custody(descriptor)

    def lock_exclusive_nonblocking(self, descriptor):
        return self._ensure_inner().lock_exclusive_nonblocking(descriptor)

    def begin(self):
        return self._ensure_inner().begin()

    def unlock(self, descriptor):
        if self._inner is None:
            raise RuntimeError("foreign admission descriptor")
        return self._inner.unlock(descriptor)

    def close(self, descriptor):
        inner = self._inner
        if inner is None:
            raise RuntimeError("foreign admission descriptor")
        try:
            return inner.close(descriptor)
        finally:
            self._release_inner()


def load_admission_adapter():
    """Load the checksummed adapter the same way gateway.run admits."""
    module = sys.modules.get(_ADAPTER_NAME)
    if module is not None:
        return module
    spec = importlib.util.spec_from_file_location(_ADAPTER_NAME, _ADAPTER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("admission adapter cannot load")
    module = importlib.util.module_from_spec(spec)
    sys.modules[_ADAPTER_NAME] = module
    spec.loader.exec_module(module)
    return module


def admit_message(owner, identity):
    """Grant or refuse one identity through the real adapter and owner.

    Returns "granted" or "refused". Does not schedule an agent and does
    not send on any platform.
    """
    adapter = load_admission_adapter()
    owner.execution_identity = identity
    permission = adapter.Adapter(owner).admit(identity)
    if permission is None:
        return "refused"
    if tuple(permission.identity) != tuple(identity):
        return "refused"
    return "granted"
