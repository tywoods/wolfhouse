"""Same-Luna Staff email-draft author owned by hermes-sunset-luna-http.

Closed authenticated contract on the live Lunabox WhatsApp gateway (8094).
Staff reaches POST /whatsapp/v1/internal/email-draft-plan through the existing
unchanged Caddy /whatsapp/* route (https://lunabox.lunafrontdesk.com/whatsapp/...).
A dedicated 8095 listener remains loopback-only local proof. Live identity is
bound from the isolated sunset-luna process (role, home, webhook port, Sol +
plugins SOUL). Config labels are not accepted as runtime proof. ACA luna-http
is not the author.
"""

from __future__ import annotations

import asyncio
import os
import socket
import sys
import threading
from http.server import ThreadingHTTPServer
from typing import Any

from wolfhouse.email_draft_contract import SAME_LUNA_DRAFT_PATH, SAME_LUNA_RUNTIME
from wolfhouse.email_draft_invoke import default_invoke, resolve_sunset_email_hermes_home
from wolfhouse.email_draft_replay import ReplayCache
from wolfhouse.email_draft_server import MAX_SEEN, handle_draft_request, make_handler

AUTHOR_LISTEN_HOST_ENV = "SUNSET_LUNA_EMAIL_AUTHOR_LISTEN_HOST"
AUTHOR_LISTEN_PORT_ENV = "SUNSET_LUNA_EMAIL_AUTHOR_LISTEN_PORT"
DEFAULT_AUTHOR_PORT = 8095
WHATSAPP_PORT = "8094"
AUTHOR_MAX_CONCURRENCY = 1
AUTHOR_ACQUIRE_TIMEOUT_SECONDS = 0.05

_LOCK = threading.Lock()
_STARTED: dict[str, Any] = {}
_AUTHOR_REPLAY = ReplayCache(MAX_SEEN)

_SECRET_KEYS = frozenset(
    {
        "API_SERVER_KEY",
        "EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET",
    }
)


def _load_author_secrets_from_home() -> None:
    root = resolve_sunset_email_hermes_home()
    path = root / ".env"
    if path.is_symlink() or not path.is_file():
        return
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return
    for line in raw.splitlines():
        stripped = line.replace("\r", "")
        if not stripped or stripped.lstrip().startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        if key not in _SECRET_KEYS:
            continue
        if os.environ.get(key, "").strip():
            continue
        os.environ[key] = value


def live_same_luna_identity() -> dict[str, Any] | None:
    """Bind hermes-sunset-luna-http from live process facts. Never a label echo."""
    role = (os.environ.get("HERMES_ROLE") or "").strip()
    isolated = (os.environ.get("SUNSET_LUNA_REQUIRE_ISOLATED_AUTH") or "").strip()
    webhook = (os.environ.get("WHATSAPP_CLOUD_WEBHOOK_PORT") or "").strip()
    if role != "sunset-luna" or isolated != "true" or webhook != WHATSAPP_PORT:
        return None
    try:
        port = int((os.environ.get(AUTHOR_LISTEN_PORT_ENV) or str(DEFAULT_AUTHOR_PORT)).strip())
    except ValueError:
        return None
    if port in {8094, 8092, 8093, 8090}:
        return None
    home = resolve_sunset_email_hermes_home()
    auth = home / "auth.json"
    soul = home / "SOUL.md"
    config_path = home / "config.yaml"
    if auth.is_symlink() or not auth.is_file():
        return None
    if (home / ".auth-shared" / "auth.json").exists() or (home.parent / ".auth-shared" / "auth.json").exists():
        return None
    if not soul.is_file() or soul.is_symlink():
        return None
    if not config_path.is_file():
        return None
    try:
        config = config_path.read_text(encoding="utf-8")
    except OSError:
        return None
    if "gpt-5.6-sol" not in config or "openai-codex" not in config:
        return None
    if "wolfhouse_staff_api" not in config and "wolfhouse-staff-api" not in config:
        return None
    return {
        "runtime": SAME_LUNA_RUNTIME,
        "hostname": socket.gethostname(),
        "pid": os.getpid(),
        "hermes_home": str(home.resolve()),
        "webhook_port": webhook,
        "author_port": port,
        "role": role,
        "draft_path": SAME_LUNA_DRAFT_PATH,
    }


def _author_log_line(payload: dict, identity: dict[str, Any] | None) -> str:
    authenticity = payload.get("authenticity") if isinstance(payload, dict) else {}
    provenance = payload.get("provenance") if isinstance(payload, dict) else {}
    request_id = ""
    if isinstance(authenticity, dict):
        request_id = str(authenticity.get("request_id") or "")
    ident = identity or {}
    return (
        "same-luna-author attempt "
        f"request_id={request_id} "
        f"hostname={ident.get('hostname', '')} "
        f"pid={ident.get('pid', '')} "
        f"home={ident.get('hermes_home', '')} "
        f"webhook_port={ident.get('webhook_port', '')} "
        f"author_port={ident.get('author_port', '')} "
        f"provider={provenance.get('provider') if isinstance(provenance, dict) else ''} "
        f"model={provenance.get('model') if isinstance(provenance, dict) else ''} "
        f"runtime={provenance.get('runtime') if isinstance(provenance, dict) else ''} "
        "hmac=ok\n"
    )


def reset_same_luna_author_listener_for_tests() -> None:
    with _LOCK:
        server = _STARTED.get("server")
        if server is not None:
            try:
                server.shutdown()
            except Exception:
                pass
            try:
                server.server_close()
            except Exception:
                pass
        _STARTED.clear()


def start_same_luna_author_listener() -> dict[str, Any]:
    """Start the dedicated 8095 author listener in this process. Idempotent.

    Loopback local proof only. Live Staff uses the 8094 gateway route via Caddy.
    """
    with _LOCK:
        if _STARTED.get("started"):
            return dict(_STARTED)
        _load_author_secrets_from_home()
        identity = live_same_luna_identity()
        if identity is None:
            result = {"started": False, "reason": "identity_mismatch"}
            return result
        token = os.environ.get("API_SERVER_KEY", "").strip()
        hmac_secret = os.environ.get("EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET", "")
        if not token or not hmac_secret or hmac_secret.strip() != hmac_secret:
            return {"started": False, "reason": "hmac_or_token_unconfigured"}
        host = (os.environ.get(AUTHOR_LISTEN_HOST_ENV) or "127.0.0.1").strip() or "127.0.0.1"
        port = identity["author_port"]
        handler = make_handler(
            token,
            default_invoke,
            _AUTHOR_REPLAY,
            hmac_secret,
            runtime=SAME_LUNA_RUNTIME,
            draft_path=SAME_LUNA_DRAFT_PATH,
        )
        httpd = ThreadingHTTPServer((host, port), handler)
        thread = threading.Thread(
            target=httpd.serve_forever,
            name="same-luna-email-author",
            daemon=True,
        )
        thread.start()
        _STARTED.update(
            {
                "started": True,
                "listen": f"{host}:{port}",
                "identity": identity,
                "server": httpd,
                "thread": thread,
                "draft_path": SAME_LUNA_DRAFT_PATH,
            }
        )
        sys.stderr.write(
            "same-luna-author listening "
            f"listen={host}:{port} path={SAME_LUNA_DRAFT_PATH} "
            f"hostname={identity['hostname']} "
            f"pid={identity['pid']} home={identity['hermes_home']} "
            f"webhook_port={identity['webhook_port']} runtime={SAME_LUNA_RUNTIME}\n"
        )
        return dict(_STARTED)


def register_same_luna_author_route(app: Any) -> bool:
    """Add POST /whatsapp/v1/internal/email-draft-plan on the gateway HTTP app.

    WhatsApp webhook routing is unchanged. Caddy already preserves /whatsapp/*
    to this 8094 process; do not add or change Caddy.
    """
    _load_author_secrets_from_home()
    identity = live_same_luna_identity()
    if identity is None:
        return False
    token = os.environ.get("API_SERVER_KEY", "").strip()
    hmac_secret = os.environ.get("EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET", "")
    if not token or not hmac_secret or hmac_secret.strip() != hmac_secret:
        return False

    # The synchronous model invocation must never block the event loop that also
    # owns the live WhatsApp webhook. Keep one bounded slot; overload fails closed.
    author_slots = asyncio.Semaphore(AUTHOR_MAX_CONCURRENCY)

    async def _handle_author(request: Any) -> Any:
        from aiohttp import web

        raw = await request.read()
        auth = request.headers.get("authorization") or request.headers.get("Authorization") or ""
        try:
            await asyncio.wait_for(
                author_slots.acquire(), timeout=AUTHOR_ACQUIRE_TIMEOUT_SECONDS
            )
        except TimeoutError:
            return web.json_response({"error": "author_busy"}, status=503)
        work = asyncio.create_task(
            asyncio.to_thread(
                handle_draft_request,
                raw_body=raw,
                authorization=auth,
                expected_token=token,
                invoke=default_invoke,
                replay=_AUTHOR_REPLAY,
                hmac_secret=hmac_secret,
                runtime=SAME_LUNA_RUNTIME,
            )
        )
        try:
            # Cancellation cannot release the slot while its worker is running.
            status, payload = await asyncio.shield(work)
        except asyncio.CancelledError:
            await asyncio.shield(work)
            raise
        finally:
            author_slots.release()
        if status == 200 and isinstance(payload.get("provenance"), dict):
            sys.stderr.write(_author_log_line(payload, identity))
        return web.json_response(payload, status=status)

    app.router.add_post(SAME_LUNA_DRAFT_PATH, _handle_author)
    return True


__all__ = (
    "SAME_LUNA_RUNTIME",
    "SAME_LUNA_DRAFT_PATH",
    "live_same_luna_identity",
    "start_same_luna_author_listener",
    "register_same_luna_author_route",
)
