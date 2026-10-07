"""Narrow gateway composition for capacity-first durable message admission.

Fresh admission remains owned by the reviewed identity journal. A duplicate can
continue only when the existing first-yes ledger recognizes the exact original
completed or interrupted operation; it never grants a fresh model turn.
"""
from pathlib import Path

from gateway.identity_admission_owner import IdentityAdmissionOwner, admit_message
from wolfhouse.accepted_quote import arm_exact_gateway_retry

_JOURNAL_PATH = "/opt/data/gateway/admission.journal"
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
    path = str(Path(_JOURNAL_PATH).absolute())
    cached = getattr(runner, "_wolfhouse_identity_admission_owner", None)
    if cached is None or str(getattr(cached, "path", "")) != path:
        cached = IdentityAdmissionOwner(path)
        runner._wolfhouse_identity_admission_owner = cached
    return cached


def admit_gateway_message(runner, event, source, session_key):
    """Return True only for fresh admission or exact first-yes recovery."""
    identity = _identity(event, source)
    raw = getattr(event, "text", None)
    if type(raw) is not str:
        return False
    if admit_message(_owner(runner), identity) == "granted":
        return True
    return _arm_exact_first_yes_retry(
        runner=runner,
        session_key=session_key,
        identity=identity,
        message_id=identity[2],
        raw=raw,
    ) is True
