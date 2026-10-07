"""Capacity-first gateway admission using the existing live journal owner.

Fresh admission remains owned by the reviewed identity journal. Recovery is
considered only for a verified COMMITTED duplicate and then must be authorized
by the existing first-yes owner for the exact frozen operation.
"""
import json

from gateway.identity_admission_owner import IdentityAdmissionOwner, admit_message
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


def _admission_state(owner, identity):
    """Return READY, exact COMMITTED, or DENY. Uncertainty is always DENY."""
    try:
        owner.execution_identity = identity
        row = owner._ensure_inner()._journal.snapshot()
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
        if reservation != expected or evidence != expected:
            return "DENY"
        return "COMMITTED"
    except Exception:
        return "DENY"


def admit_gateway_message(runner, event, source, session_key):
    """Admit fresh once, or recover one exact verified committed duplicate."""
    identity = _identity(event, source)
    raw = getattr(event, "text", None)
    if type(raw) is not str:
        return False
    owner = _owner(runner)
    state = _admission_state(owner, identity)
    if state == "READY":
        # A race or storage error can turn this into refusal; refusal remains closed.
        return admit_message(owner, identity) == "granted"
    if state != "COMMITTED":
        return False
    return _arm_exact_first_yes_retry(
        runner=runner,
        session_key=session_key,
        identity=identity,
        message_id=identity[2],
        raw=raw,
    ) is True
