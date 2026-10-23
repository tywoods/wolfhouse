"""Fail-closed Luna v3 runtime preflight."""

from __future__ import annotations

import os

FORBIDDEN_ENV = (
    "TELEGRAM_BOT_TOKEN",
    "WHATSAPP_ENABLED",
    "WHATSAPP_CLOUD_ACCESS_TOKEN",
    "WHATSAPP_CLOUD_APP_SECRET",
    "WHATSAPP_CLOUD_VERIFY_TOKEN",
    "WHATSAPP_CLOUD_PHONE_NUMBER_ID",
    "META_ACCESS_TOKEN",
    "SMTP_PASSWORD",
    "EMAIL_ADDRESS",
    "EMAIL_PASSWORD",
    "EMAIL_IMAP_HOST",
    "EMAIL_SMTP_HOST",
)


def validate_environment(env: dict[str, str] | None = None) -> None:
    values = os.environ if env is None else env
    if values.get("HERMES_ROLE") != "luna-v3":
        raise RuntimeError("HERMES_ROLE must be luna-v3")
    if values.get("LUNA_V3_TENANT_ID") != "wolfhouse-somo":
        raise RuntimeError("Luna v3 tenant must be wolfhouse-somo")
    if values.get("LUNA_V3_EXTERNAL_SEND_ENABLED", "false").lower() != "false":
        raise RuntimeError("external sends must remain disabled")
    if values.get("LUNA_V3_STAFF_ALERTS_ENABLED", "false").lower() != "false":
        raise RuntimeError("staff alerts must remain disabled")
    present = [
        name for name in FORBIDDEN_ENV
        if values.get(name)
        and not (
            name == "WHATSAPP_ENABLED"
            and values[name].lower() in {"false", "0", "no"}
        )
    ]
    if present:
        raise RuntimeError(f"forbidden transport credentials present: {','.join(present)}")


if __name__ == "__main__":
    validate_environment()
