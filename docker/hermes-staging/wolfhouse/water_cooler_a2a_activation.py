"""Gated Water-cooler A2A activation (Seadog/Deckhand only; fail-closed).

Source-level wiring for a future per-container opt-in. Default is inactive:

- Role must be exactly ``seadog`` or ``deckhand``.
- ``WATER_COOLER_A2A_ENABLED`` must be exactly ``true`` (case-sensitive).
- Every missing/malformed ID or config value fails closed.
- Luna, Sunset Luna, Wolfhouse Luna, orchestrator/Skipper, and unknown roles
  never activate the patch, plugin, toolset, bot-admission env, or hooks.

Does not log raw task/review content or env secret values.
"""

from __future__ import annotations

import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any, Dict, Mapping, MutableMapping, Optional, Sequence, Tuple

# ---------------------------------------------------------------------------
# Constants (no real Discord tokens; IDs come from deployment env only)
# ---------------------------------------------------------------------------

A2A_ROLES = frozenset({"seadog", "deckhand"})
EXCLUDED_ROLES = frozenset(
    {"luna", "sunset-luna", "orchestrator", "skipper", ""}
)

# Exact enablement token — not "1"/"yes"/"TRUE" at the activation gate.
ENABLED_TOKEN = "true"

CFG_ENABLED = "WATER_COOLER_A2A_ENABLED"
CFG_PARENT_CHANNEL_ID = "WATER_COOLER_A2A_PARENT_CHANNEL_ID"
CFG_THREAD_ID = "WATER_COOLER_A2A_THREAD_ID"
# Legacy alias for the exact message channel (Navigation thread only).
CFG_CHANNEL_ID = "WATER_COOLER_A2A_CHANNEL_ID"
CFG_LOCAL_BOT_ID = "WATER_COOLER_A2A_LOCAL_BOT_ID"
CFG_SEADOG_BOT_ID = "WATER_COOLER_A2A_SEADOG_BOT_ID"
CFG_DECKHAND_BOT_ID = "WATER_COOLER_A2A_DECKHAND_BOT_ID"
CFG_ALLOWED_HUMAN_STARTER_IDS = "WATER_COOLER_A2A_ALLOWED_HUMAN_STARTER_IDS"
CFG_TASK_TTL_SECONDS = "WATER_COOLER_A2A_TASK_TTL_SECONDS"

REQUIRED_ID_KEYS = (
    CFG_PARENT_CHANNEL_ID,
    CFG_THREAD_ID,
    CFG_LOCAL_BOT_ID,
    CFG_SEADOG_BOT_ID,
    CFG_DECKHAND_BOT_ID,
    CFG_ALLOWED_HUMAN_STARTER_IDS,
)

PLUGIN_DIR_NAME = "water_cooler_a2a"
PLUGIN_ENABLED_NAME = "water-cooler-a2a"
TOOLSET_NAME = "water_cooler_a2a"
DISCORD_ALLOW_BOTS_VALUE = "mentions"

_SNOWFLAKE_RE = re.compile(r"^[1-9][0-9]{0,31}$")
_A2A_ENV_PREFIX = "WATER_COOLER_A2A_"


class ActivationError(RuntimeError):
    """Fail-closed activation error (no raw env values in message)."""


# ---------------------------------------------------------------------------
# Pure gate helpers
# ---------------------------------------------------------------------------


def normalize_role(role: object) -> str:
    if not isinstance(role, str):
        return ""
    return role.strip().lower()


def is_a2a_target_role(role: object) -> bool:
    return normalize_role(role) in A2A_ROLES


def is_explicitly_enabled(enabled_value: object) -> bool:
    """True only for the exact string ``true`` (after strip). Fail closed otherwise."""
    if not isinstance(enabled_value, str):
        return False
    return enabled_value.strip() == ENABLED_TOKEN


def should_activate_a2a(
    *,
    role: object,
    enabled_value: object,
) -> bool:
    """Role-scoped AND explicit enable. Missing/malformed → False."""
    return is_a2a_target_role(role) and is_explicitly_enabled(enabled_value)


def is_snowflake_id(value: object) -> bool:
    if not isinstance(value, str):
        return False
    text = value.strip()
    if not text or len(text) > 32:
        return False
    return bool(_SNOWFLAKE_RE.fullmatch(text))


def parse_human_starter_ids(value: object) -> Optional[Tuple[str, ...]]:
    """Parse human starter IDs. None = malformed (fail closed)."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        parts = [p.strip() for p in value.split(",") if p.strip()]
    elif isinstance(value, (list, tuple, set, frozenset)):
        parts = []
        for item in value:
            if not isinstance(item, str):
                return None
            s = item.strip()
            if s:
                parts.append(s)
    else:
        return None
    if not parts:
        return None
    for p in parts:
        if not is_snowflake_id(p):
            return None
    # Dedup preserve order
    seen = set()
    out = []
    for p in parts:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return tuple(out)


def extract_a2a_env_mapping(
    env: Optional[Mapping[str, str]] = None,
) -> Dict[str, str]:
    """Copy only ``WATER_COOLER_A2A_*`` keys. Never returns non-A2A secrets."""
    source = os.environ if env is None else env
    out: Dict[str, str] = {}
    try:
        items = source.items()
    except Exception:
        return out
    for key, value in items:
        if not isinstance(key, str) or not key.startswith(_A2A_ENV_PREFIX):
            continue
        if isinstance(value, str):
            out[key] = value
        elif value is None:
            continue
        else:
            # Non-string values are coerced only for test mappings; production
            # env is always str. Reject non-str at validation stage.
            out[key] = str(value)
    return out


def validate_activation_ids(
    *,
    role: object,
    mapping: Mapping[str, Any],
) -> Dict[str, Any]:
    """Validate IDs/config for an already role+enable gated activation.

    Returns a normalized dict for runtime/bootstrap emission.
    Raises :class:`ActivationError` on any missing/malformed value.
    Does not embed raw invalid values in the error message.
    """
    role_n = normalize_role(role)
    if role_n not in A2A_ROLES:
        raise ActivationError("a2a_role_not_eligible")

    enabled_raw = mapping.get(CFG_ENABLED, "")
    if not is_explicitly_enabled(enabled_raw if isinstance(enabled_raw, str) else ""):
        raise ActivationError("a2a_not_explicitly_enabled")

    parent = mapping.get(CFG_PARENT_CHANNEL_ID)
    thread = mapping.get(CFG_THREAD_ID)
    legacy_channel = mapping.get(CFG_CHANNEL_ID)
    local_bot = mapping.get(CFG_LOCAL_BOT_ID)
    seadog = mapping.get(CFG_SEADOG_BOT_ID)
    deckhand = mapping.get(CFG_DECKHAND_BOT_ID)
    humans_raw = mapping.get(CFG_ALLOWED_HUMAN_STARTER_IDS)

    for label, val in (
        ("parent_channel_id", parent),
        ("thread_id", thread),
        ("local_bot_id", local_bot),
        ("seadog_bot_id", seadog),
        ("deckhand_bot_id", deckhand),
    ):
        if not isinstance(val, str) or not val.strip():
            raise ActivationError(f"a2a_missing_{label}")
        if not is_snowflake_id(val):
            raise ActivationError(f"a2a_invalid_{label}")

    parent_s = str(parent).strip()
    thread_s = str(thread).strip()
    local_s = str(local_bot).strip()
    seadog_s = str(seadog).strip()
    deckhand_s = str(deckhand).strip()

    if parent_s == thread_s:
        raise ActivationError("a2a_parent_and_thread_must_differ")

    # Legacy CHANNEL_ID is optional; when present it must equal THREAD_ID
    # (exact message channel) so there is no parent/thread ambiguity.
    if legacy_channel is not None and str(legacy_channel).strip() != "":
        if not isinstance(legacy_channel, str) or not is_snowflake_id(legacy_channel):
            raise ActivationError("a2a_invalid_channel_id")
        if str(legacy_channel).strip() != thread_s:
            raise ActivationError("a2a_channel_id_must_match_thread_id")

    if seadog_s == deckhand_s:
        raise ActivationError("a2a_peer_bot_ids_must_differ")

    if role_n == "seadog" and local_s != seadog_s:
        raise ActivationError("a2a_local_bot_must_match_seadog_role")
    if role_n == "deckhand" and local_s != deckhand_s:
        raise ActivationError("a2a_local_bot_must_match_deckhand_role")

    humans = parse_human_starter_ids(humans_raw)
    if humans is None:
        raise ActivationError("a2a_missing_or_invalid_human_starter_ids")
    for hid in humans:
        if hid in (seadog_s, deckhand_s):
            raise ActivationError("a2a_human_id_collides_with_bot")

    ttl: Optional[float] = None
    if CFG_TASK_TTL_SECONDS in mapping and mapping.get(CFG_TASK_TTL_SECONDS) not in (
        None,
        "",
    ):
        raw_ttl = mapping.get(CFG_TASK_TTL_SECONDS)
        try:
            if isinstance(raw_ttl, bool):
                raise ActivationError("a2a_invalid_ttl")
            ttl = float(raw_ttl) if not isinstance(raw_ttl, str) else float(raw_ttl.strip())
        except (TypeError, ValueError):
            raise ActivationError("a2a_invalid_ttl") from None
        if ttl < 1.0 or ttl > 86_400.0:
            raise ActivationError("a2a_ttl_out_of_bounds")

    result: Dict[str, Any] = {
        CFG_ENABLED: ENABLED_TOKEN,
        CFG_PARENT_CHANNEL_ID: parent_s,
        CFG_THREAD_ID: thread_s,
        # Mirror thread as channel_id for runtime exact-message-channel field.
        CFG_CHANNEL_ID: thread_s,
        CFG_LOCAL_BOT_ID: local_s,
        CFG_SEADOG_BOT_ID: seadog_s,
        CFG_DECKHAND_BOT_ID: deckhand_s,
        CFG_ALLOWED_HUMAN_STARTER_IDS: ",".join(humans),
    }
    if ttl is not None:
        result[CFG_TASK_TTL_SECONDS] = str(ttl)
    return result


def runtime_mapping_from_validated(validated: Mapping[str, Any]) -> Dict[str, Any]:
    """Build a mapping suitable for :func:`parse_runtime_config`."""
    humans = parse_human_starter_ids(validated.get(CFG_ALLOWED_HUMAN_STARTER_IDS))
    thread_s = validated[CFG_THREAD_ID]
    out: Dict[str, Any] = {
        CFG_ENABLED: True,
        CFG_PARENT_CHANNEL_ID: validated[CFG_PARENT_CHANNEL_ID],
        CFG_THREAD_ID: thread_s,
        CFG_CHANNEL_ID: thread_s,
        CFG_LOCAL_BOT_ID: validated[CFG_LOCAL_BOT_ID],
        CFG_SEADOG_BOT_ID: validated[CFG_SEADOG_BOT_ID],
        CFG_DECKHAND_BOT_ID: validated[CFG_DECKHAND_BOT_ID],
        CFG_ALLOWED_HUMAN_STARTER_IDS: list(humans or ()),
    }
    if CFG_TASK_TTL_SECONDS in validated:
        out[CFG_TASK_TTL_SECONDS] = validated[CFG_TASK_TTL_SECONDS]
    return out


# ---------------------------------------------------------------------------
# Bootstrap side effects (opt-in only; tests may call with fakes)
# ---------------------------------------------------------------------------


def default_adapter_path() -> Path:
    return Path("/opt/hermes/plugins/platforms/discord/adapter.py")


def default_staging_plugins() -> Path:
    return Path("/etc/hermes-staging/plugins")


def default_staging_root() -> Path:
    return Path("/etc/hermes-staging")


def install_a2a_plugin_only(
    *,
    staging_plugins: Path,
    hermes_plugins: Path,
) -> bool:
    """Copy only the water_cooler_a2a plugin directory. Returns True if installed."""
    src = Path(staging_plugins) / PLUGIN_DIR_NAME
    if not src.is_dir():
        raise ActivationError("a2a_plugin_source_missing")
    dest_root = Path(hermes_plugins)
    dest_root.mkdir(parents=True, exist_ok=True)
    dest = dest_root / PLUGIN_DIR_NAME
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(src, dest)
    return True


def merge_a2a_into_config_yaml(config_path: Path) -> None:
    """Ensure toolsets + plugins.enabled list the A2A plugin (idempotent).

    Minimal text merge: does not parse full YAML. Fails closed if file missing.
    """
    path = Path(config_path)
    if not path.is_file():
        raise ActivationError("a2a_config_yaml_missing")
    text = path.read_text(encoding="utf-8")

    if TOOLSET_NAME not in text:
        # Append toolsets block or extend.
        if re.search(r"(?m)^toolsets:\s*$", text):
            text = re.sub(
                r"(?m)^toolsets:\s*$",
                f"toolsets:\n  - {TOOLSET_NAME}",
                text,
                count=1,
            )
        else:
            text = text.rstrip() + f"\ntoolsets:\n  - {TOOLSET_NAME}\n"

    if PLUGIN_ENABLED_NAME not in text:
        if re.search(r"(?m)^plugins:\s*$", text) or re.search(
            r"(?m)^plugins:\n  enabled:\s*$", text
        ):
            if "enabled:" in text and "plugins:" in text:
                # Ensure enabled list contains plugin.
                if re.search(r"(?m)^  enabled:\s*$", text):
                    text = re.sub(
                        r"(?m)^  enabled:\s*$",
                        f"  enabled:\n    - {PLUGIN_ENABLED_NAME}",
                        text,
                        count=1,
                    )
                elif f"- {PLUGIN_ENABLED_NAME}" not in text:
                    text = re.sub(
                        r"(?m)^(  enabled:\n)",
                        rf"\1    - {PLUGIN_ENABLED_NAME}\n",
                        text,
                        count=1,
                    )
            else:
                text = text.rstrip() + (
                    f"\nplugins:\n  enabled:\n    - {PLUGIN_ENABLED_NAME}\n"
                )
        else:
            text = text.rstrip() + (
                f"\nplugins:\n  enabled:\n    - {PLUGIN_ENABLED_NAME}\n"
            )

    # Final belt: if still missing, append clean block.
    if TOOLSET_NAME not in text:
        text = text.rstrip() + f"\ntoolsets:\n  - {TOOLSET_NAME}\n"
    if PLUGIN_ENABLED_NAME not in text:
        text = text.rstrip() + (
            f"\nplugins:\n  enabled:\n    - {PLUGIN_ENABLED_NAME}\n"
        )

    path.write_text(text, encoding="utf-8")


def apply_adapter_patch_if_present(
    *,
    adapter_path: Path,
    patcher_path: Path,
) -> Dict[str, object]:
    """Apply A2A adapter patch; raise ActivationError on failure."""
    adapter = Path(adapter_path)
    patcher = Path(patcher_path)
    if not adapter.is_file():
        raise ActivationError("a2a_adapter_missing")
    if not patcher.is_file():
        raise ActivationError("a2a_patcher_missing")

    # Load patcher module without ambient side effects.
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "apply_water_cooler_a2a_adapter_patch_boot", patcher
    )
    if spec is None or spec.loader is None:
        raise ActivationError("a2a_patcher_load_failed")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    try:
        result = mod.patch_adapter_file(adapter)
    except Exception as exc:
        # Do not include adapter source or env in message.
        raise ActivationError(
            f"a2a_adapter_patch_failed:{type(exc).__name__}"
        ) from None
    return dict(result) if isinstance(result, dict) else {"result": result}


def emit_a2a_env_lines(validated: Mapping[str, Any]) -> str:
    """Return .env lines for A2A + transport admission. No other secrets."""
    lines = [
        f"{CFG_ENABLED}={ENABLED_TOKEN}",
        f"{CFG_PARENT_CHANNEL_ID}={validated[CFG_PARENT_CHANNEL_ID]}",
        f"{CFG_THREAD_ID}={validated[CFG_THREAD_ID]}",
        # Legacy channel key mirrors thread (exact message channel) only.
        f"{CFG_CHANNEL_ID}={validated[CFG_THREAD_ID]}",
        f"{CFG_LOCAL_BOT_ID}={validated[CFG_LOCAL_BOT_ID]}",
        f"{CFG_SEADOG_BOT_ID}={validated[CFG_SEADOG_BOT_ID]}",
        f"{CFG_DECKHAND_BOT_ID}={validated[CFG_DECKHAND_BOT_ID]}",
        f"{CFG_ALLOWED_HUMAN_STARTER_IDS}={validated[CFG_ALLOWED_HUMAN_STARTER_IDS]}",
        f"DISCORD_ALLOW_BOTS={DISCORD_ALLOW_BOTS_VALUE}",
    ]
    if CFG_TASK_TTL_SECONDS in validated:
        lines.append(f"{CFG_TASK_TTL_SECONDS}={validated[CFG_TASK_TTL_SECONDS]}")
    return "\n".join(lines) + "\n"


def run_bootstrap_activation(
    *,
    role: Optional[str] = None,
    env: Optional[Mapping[str, str]] = None,
    hermes_home: Optional[Path] = None,
    staging_root: Optional[Path] = None,
    adapter_path: Optional[Path] = None,
    apply_patch: bool = True,
    install_plugin: bool = True,
    merge_config: bool = True,
    write_env_file: bool = False,
) -> Dict[str, object]:
    """Full gated bootstrap path for tests and cont-init.

    When gate is closed: no adapter touch, no plugin install, no config merge.
    When open: validate IDs (fail start), optionally patch/install/merge.
    """
    source_env: Mapping[str, str]
    if env is not None:
        source_env = env
    else:
        source_env = os.environ

    role_val = role if role is not None else source_env.get("HERMES_ROLE", "")
    enabled_val = source_env.get(CFG_ENABLED, "")

    meta: Dict[str, object] = {
        "activated": False,
        "role": normalize_role(role_val),
        "patched": False,
        "plugin_installed": False,
        "config_merged": False,
    }

    if not should_activate_a2a(role=role_val, enabled_value=enabled_val):
        return meta

    a2a_map = extract_a2a_env_mapping(source_env)
    # Ensure ENABLED present for validator.
    a2a_map.setdefault(CFG_ENABLED, str(enabled_val))
    validated = validate_activation_ids(role=role_val, mapping=a2a_map)
    meta["activated"] = True
    meta["validated"] = True

    staging = Path(staging_root) if staging_root else default_staging_root()
    home = Path(hermes_home) if hermes_home else Path(
        source_env.get("HERMES_HOME", "/opt/data")
    )

    if install_plugin:
        install_a2a_plugin_only(
            staging_plugins=staging / "plugins",
            hermes_plugins=home / "plugins",
        )
        meta["plugin_installed"] = True

    if merge_config:
        cfg_path = home / "config.yaml"
        merge_a2a_into_config_yaml(cfg_path)
        meta["config_merged"] = True

    if apply_patch:
        adapter = Path(adapter_path) if adapter_path else default_adapter_path()
        patcher = staging / "apply_water_cooler_a2a_adapter_patch.py"
        result = apply_adapter_patch_if_present(
            adapter_path=adapter, patcher_path=patcher
        )
        meta["patched"] = bool(result.get("changed") or result.get("path"))
        meta["patch_result"] = result

    if write_env_file:
        env_path = home / ".env"
        existing = ""
        if env_path.is_file():
            existing = env_path.read_text(encoding="utf-8")
        # Append A2A lines if not already present (idempotent-ish).
        addition = emit_a2a_env_lines(validated)
        if CFG_ENABLED + "=" not in existing:
            with env_path.open("a", encoding="utf-8") as fh:
                if existing and not existing.endswith("\n"):
                    fh.write("\n")
                fh.write(addition)
            meta["env_written"] = True
        elif "DISCORD_ALLOW_BOTS=" not in existing:
            with env_path.open("a", encoding="utf-8") as fh:
                fh.write(f"DISCORD_ALLOW_BOTS={DISCORD_ALLOW_BOTS_VALUE}\n")
            meta["env_written"] = True

    return meta


def main(argv: Optional[Sequence[str]] = None) -> int:
    """CLI for cont-init: gated activation. Exit 0 when inactive or success.

    Exit 1 when explicitly enabled for a target role but validation/patch fails.
    """
    args = list(argv) if argv is not None else sys.argv[1:]
    # Reserved for future flags; currently no flags required.
    _ = args
    role = os.environ.get("HERMES_ROLE", "")
    enabled = os.environ.get(CFG_ENABLED, "")
    if not should_activate_a2a(role=role, enabled_value=enabled):
        # Fail closed / no-op: never touch adapter when disabled or wrong role.
        print({"activated": False, "role": normalize_role(role)})
        return 0
    try:
        meta = run_bootstrap_activation(
            apply_patch=True,
            install_plugin=True,
            merge_config=True,
            write_env_file=True,
        )
        # Do not print validated IDs.
        safe = {
            "activated": meta.get("activated"),
            "role": meta.get("role"),
            "patched": meta.get("patched"),
            "plugin_installed": meta.get("plugin_installed"),
            "config_merged": meta.get("config_merged"),
        }
        print(safe)
        return 0
    except ActivationError as exc:
        print(f"water_cooler_a2a_activation failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(
            f"water_cooler_a2a_activation failed: {type(exc).__name__}",
            file=sys.stderr,
        )
        return 1


__all__ = [
    "A2A_ROLES",
    "CFG_ALLOWED_HUMAN_STARTER_IDS",
    "CFG_CHANNEL_ID",
    "CFG_PARENT_CHANNEL_ID",
    "CFG_THREAD_ID",
    "CFG_DECKHAND_BOT_ID",
    "CFG_ENABLED",
    "CFG_LOCAL_BOT_ID",
    "CFG_SEADOG_BOT_ID",
    "CFG_TASK_TTL_SECONDS",
    "DISCORD_ALLOW_BOTS_VALUE",
    "ENABLED_TOKEN",
    "EXCLUDED_ROLES",
    "PLUGIN_DIR_NAME",
    "PLUGIN_ENABLED_NAME",
    "TOOLSET_NAME",
    "ActivationError",
    "apply_adapter_patch_if_present",
    "emit_a2a_env_lines",
    "extract_a2a_env_mapping",
    "install_a2a_plugin_only",
    "is_a2a_target_role",
    "is_explicitly_enabled",
    "is_snowflake_id",
    "merge_a2a_into_config_yaml",
    "normalize_role",
    "parse_human_starter_ids",
    "run_bootstrap_activation",
    "runtime_mapping_from_validated",
    "should_activate_a2a",
    "validate_activation_ids",
]


if __name__ == "__main__":
    raise SystemExit(main())
