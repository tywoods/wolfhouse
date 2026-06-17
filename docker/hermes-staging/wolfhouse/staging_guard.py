"""Refuse simulate / write tooling outside staging."""

from __future__ import annotations

import os
import re
import sys

STAGING_URL_SIGNALS = ("staging", "localhost", "127.0.0.1", "lunabox")
PROD_DB_PATTERNS = (
    re.compile(r"prod(uction)?[.\-]", re.I),
    re.compile(r"wolfhouse-prod", re.I),
    re.compile(r"\.postgres\.database\.azure\.com.*prod", re.I),
)
STAGING_DB_SIGNALS = re.compile(r"staging|localhost|127\.0\.0\.1|lunabox|wh-staging", re.I)


def _staff_api_base() -> str:
    return (os.getenv("WOLFHOUSE_STAFF_API_BASE_URL") or "").strip().lower()


def _database_url() -> str:
    return (
        os.getenv("WOLFHOUSE_DATABASE_URL")
        or os.getenv("DATABASE_URL")
        or ""
    ).strip()


def assert_staging_environment() -> None:
    """Exit non-zero if this does not look like Luna staging."""
    role = (os.getenv("HERMES_ROLE") or "luna").strip().lower()
    if role != "luna":
        raise SystemExit(f"refusing: HERMES_ROLE={role!r} (expected luna)")

    base = _staff_api_base()
    if not base:
        raise SystemExit("refusing: WOLFHOUSE_STAFF_API_BASE_URL is not set")
    if not any(sig in base for sig in STAGING_URL_SIGNALS):
        raise SystemExit(f"refusing: Staff API base does not look like staging ({base})")

    if os.getenv("NODE_ENV", "").strip().lower() == "production":
        raise SystemExit("refusing: NODE_ENV=production")

    db = _database_url()
    if db:
        for pat in PROD_DB_PATTERNS:
            if pat.search(db):
                raise SystemExit("refusing: production database URL pattern detected")
        if not STAGING_DB_SIGNALS.search(db) and os.getenv("NODE_ENV", "").lower() != "development":
            raise SystemExit("refusing: database URL lacks staging/local signal")


def assert_stripe_test_only(url: str | None) -> None:
    """Block live Stripe checkout URLs in simulate mode."""
    if not url:
        return
    low = str(url).lower()
    if "checkout.stripe.com" in low and "/test/" not in low and "cs_test_" not in low:
        raise SystemExit("refusing: non-test Stripe checkout URL in simulate mode")
