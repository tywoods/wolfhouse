"""Fail-closed Sunset WhatsApp number to school routing for the live gateway."""
import os
from contextvars import ContextVar

_current_location = ContextVar("sunset_location_id", default="")

class TenantRoutingError(RuntimeError):
    pass

def _find(value, key="phone_number_id", seen=None):
    seen = seen or set()
    if id(value) in seen:
        return None
    seen.add(id(value))
    if isinstance(value, dict):
        if value.get(key):
            return str(value[key])
        for child in value.values():
            found = _find(child, key, seen)
            if found:
                return found
    elif isinstance(value, (list, tuple)):
        for child in value:
            found = _find(child, key, seen)
            if found:
                return found
    else:
        direct = getattr(value, key, None)
        if direct:
            return str(direct)
        for attr in ("metadata", "raw", "payload", "event", "data"):
            child = getattr(value, attr, None)
            if child is not None:
                found = _find(child, key, seen)
                if found:
                    return found
    return None

def resolve_location(event):
    phone_id = _find(event)
    routes = {
        os.getenv("SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID", ""): "sunset-somo",
        os.getenv("SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID", ""): "sunset-sardinero",
    }
    routes.pop("", None)
    if not phone_id or phone_id not in routes:
        raise TenantRoutingError("unknown Sunset WhatsApp phone_number_id")
    return routes[phone_id]

def bind_gateway_location(event):
    """Bind authoritative location for Staff API tools; unknown IDs abort the turn."""
    if os.getenv("HERMES_ROLE") != "sunset-luna":
        return None
    location = resolve_location(event)
    set_current_location(location)
    return location

def set_current_location(location):
    """Bind a canonical location to the current async/thread context only."""
    return _current_location.set(str(location).strip())

def get_current_location():
    return _current_location.get()

def reset_current_location(token):
    _current_location.reset(token)

def clear_current_location():
    _current_location.set("")
