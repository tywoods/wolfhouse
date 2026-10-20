"""Map the selected Wolfhouse TEST WhatsApp env into adapter inputs.

The operator env file is already in the process environment. This module
never reads a vault, never calls Graph, and never writes an env file.
Absent WA_* keys leave other roles unchanged. Any present key fail-closes
unless the public identity and both secrets are valid. Stale adapter token
and app-secret values do not win: the selected values replace them in
process memory only.
"""

from __future__ import annotations

import os
import re

PUBLIC_KEYS = (
    "WA_PHONE_NUMBER_ID",
    "WA_BUSINESS_ACCOUNT_ID",
    "WA_APP_ID",
)
SECRET_KEYS = (
    "WA_ACCESS_TOKEN",
    "WA_APP_SECRET",
)
ALL_KEYS = PUBLIC_KEYS + SECRET_KEYS
PHONE_ALIASES = (
    "WHATSAPP_CLOUD_PHONE_NUMBER_ID",
    "WHATSAPP_PHONE_NUMBER_ID",
    "OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID",
)
APP_ALIASES = ("WHATSAPP_CLOUD_APP_ID",)
WABA_ALIASES = ("WHATSAPP_CLOUD_WABA_ID",)
ID_RE = re.compile(r"^[0-9]{8,20}$")
# Shared with scripts/lib/whatsapp-runtime-identity.js. Do not use \s:
# Python and JavaScript disagree on U+FEFF, U+0085, and U+001C-U+001F
# (Python str.strip treats the file separators as whitespace; JavaScript trim does not).
CREDENTIAL_REJECTED = re.compile(
    r"[\t\n\v\f\r \u001c\u001d\u001e\u001f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]"
)


class WhatsAppRuntimeConfigError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def selected(env: dict | None = None) -> bool:
    source = os.environ if env is None else env
    return any(key in source for key in ALL_KEYS)


def _raw(env: dict, key: str) -> str:
    value = env.get(key)
    return "" if value is None else str(value)


def resolve_public_identity(env: dict | None = None) -> dict:
    source = os.environ if env is None else env
    if not selected(source):
        raise WhatsAppRuntimeConfigError("identity_not_configured")
    phone_number_id = _raw(source, "WA_PHONE_NUMBER_ID").strip()
    waba_id = _raw(source, "WA_BUSINESS_ACCOUNT_ID").strip()
    app_id = _raw(source, "WA_APP_ID").strip()
    if not ID_RE.fullmatch(phone_number_id) or not ID_RE.fullmatch(waba_id) or not ID_RE.fullmatch(app_id):
        raise WhatsAppRuntimeConfigError("identity_malformed")
    for alias, expected in (
        *((alias, phone_number_id) for alias in PHONE_ALIASES),
        *((alias, app_id) for alias in APP_ALIASES),
        *((alias, waba_id) for alias in WABA_ALIASES),
    ):
        value = _raw(source, alias).strip()
        if value and value != expected:
            raise WhatsAppRuntimeConfigError("identity_alias_conflict")
    return {
        "phone_number_id": phone_number_id,
        "waba_id": waba_id,
        "app_id": app_id,
    }


def resolve_secrets(env: dict | None = None) -> dict:
    source = os.environ if env is None else env
    access_token = _raw(source, "WA_ACCESS_TOKEN")
    app_secret = _raw(source, "WA_APP_SECRET")
    if (
        not access_token.strip()
        or not app_secret.strip()
        or CREDENTIAL_REJECTED.search(access_token)
        or CREDENTIAL_REJECTED.search(app_secret)
    ):
        raise WhatsAppRuntimeConfigError("secret_missing")
    return {"access_token": access_token.strip(), "app_secret": app_secret.strip()}


def apply_whatsapp_runtime_config(env: dict | None = None) -> dict:
    """Apply twice is the same mapping. No-op when the profile is absent."""
    source = os.environ if env is None else env
    if not selected(source):
        return {"applied": False}
    identity = resolve_public_identity(source)
    secrets = resolve_secrets(source)
    source["WHATSAPP_CLOUD_PHONE_NUMBER_ID"] = identity["phone_number_id"]
    source["WHATSAPP_CLOUD_ACCESS_TOKEN"] = secrets["access_token"]
    source["WHATSAPP_CLOUD_APP_SECRET"] = secrets["app_secret"]
    source["WHATSAPP_CLOUD_APP_ID"] = identity["app_id"]
    source["WHATSAPP_CLOUD_WABA_ID"] = identity["waba_id"]
    return {"applied": True, "phone_configured": True}
