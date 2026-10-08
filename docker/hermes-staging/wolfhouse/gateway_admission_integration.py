"""Capacity-first gateway admission using the existing live journal owner.

Fresh admission remains owned by the reviewed identity journal. Recovery is
considered only for a verified COMMITTED duplicate, while holding the same
nonblocking lock and custody boundary, and then must be authorized by the
existing first-yes owner for the exact frozen operation.
"""
import json

from gateway.identity_admission_owner import (
    IdentityAdmissionOwner,
    admit_message,
    load_admission_adapter,
)
from wolfhouse.accepted_quote import arm_exact_gateway_retry

_arm_exact_first_yes_retry = arm_exact_gateway_retry


def _identity(event, source):
    platform = getattr(getattr(source, "platform", None), "value", None)
    if not isinstance(platform, str) or not platform:
        platform = getattr(source, "platform", None)
    chat_id = getattr(source, "chat_id", None)
    message_id = getattr(event, "message_id", None) or getattr(source, "message_id", None)
    identity = (platform, chat_id, message_id)
    if any(type(value) is not str or not value for value in identity):
        raise RuntimeError("gateway admission identity is incomplete")
    return identity


def _owner(runner):
    """Use only the owner already installed by gateway.run; never fork history."""
    owner = getattr(runner, "_admission_lock_owner", None)
    if not isinstance(owner, IdentityAdmissionOwner):
        raise RuntimeError("existing gateway admission owner is unavailable")
    return owner


def _classify_record(row, identity):
    """Return READY, exact COMMITTED, or DENY. Uncertainty is always DENY."""
    try:
        status = row.get("status")
        if status == "READY":
            return "READY"
        if status != "COMMITTED":
            return "DENY"
        reservation = json.loads(row.get("reservation"))
        evidence = json.loads(row.get("evidence"))
        expected = {
            "platform": identity[0], "chat_id": identity[1],
            "message_id": identity[2],
        }
        return "COMMITTED" if reservation == expected and evidence == expected else "DENY"
    except Exception:
        return "DENY"


def _locked_admission_state(owner, identity, recover):
    """Inspect and authorize recovery only under reviewed custody and lock."""
    descriptor = None
    locked = False
    try:
        owner.execution_identity = identity
        adapter = load_admission_adapter()
        descriptor = owner.open_existing()
        custody = owner.custody(descriptor)
        if (descriptor is not owner.lock_identity
                or adapter.Adapter._custody_valid(custody) is not True):
            return "DENY"
        if owner.lock_exclusive_nonblocking(descriptor) is not True:
            return "DENY"
        locked = True
        custody = owner.custody(descriptor)
        if (descriptor is not owner.lock_identity
                or adapter.Adapter._custody_valid(custody) is not True):
            return "DENY"
        state = _classify_record(owner.begin().read(), identity)
        if state == "COMMITTED":
            return "RECOVERED" if recover() is True else "DENY"
        return state
    except Exception:
        return "DENY"
    finally:
        if locked:
            try:
                owner.unlock(descriptor)
            except Exception:
                pass
        if descriptor is not None:
            try:
                owner.close(descriptor)
            except Exception:
                pass


def admit_gateway_message(runner, event, source, session_key):
    """Admit fresh once, or recover one exact lock-authorized duplicate."""
    identity = _identity(event, source)
    raw = getattr(event, "text", None)
    if type(raw) is not str:
        return False
    owner = _owner(runner)
    state = _locked_admission_state(owner, identity, lambda: _arm_exact_first_yes_retry(
        runner=runner,
        session_key=session_key,
        identity=identity,
        message_id=identity[2],
        raw=raw,
    ))
    if state == "RECOVERED":
        return True
    if state != "READY":
        return False
    # The custody lock is deliberately released before the reviewed adapter
    # reacquires it and performs the only fresh durable admission transaction.
    return admit_message(owner, identity) == "granted"
