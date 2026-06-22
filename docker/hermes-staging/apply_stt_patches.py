#!/usr/bin/env python3
"""Apply Wolfhouse staging patches for Hermes STT provider resolution."""

from __future__ import annotations

import importlib.util
import py_compile
import sys
from pathlib import Path

STT_PATCH_TAG = "env_provider = os.getenv(\"STT_PROVIDER\""
CONFIG_STT_MIGRATE_TAG = "Wolfhouse: preserve/seed stt block"

STT_PROVIDER_RESOLVE_OLD = """    explicit = "provider" in stt_config
    provider = stt_config.get("provider", DEFAULT_PROVIDER)"""

STT_PROVIDER_RESOLVE_NEW = """    env_provider = os.getenv("STT_PROVIDER", "").strip()
    if env_provider:
        provider = env_provider
        explicit = True
    else:
        explicit = "provider" in stt_config
        provider = stt_config.get("provider", DEFAULT_PROVIDER)"""

STT_DOC_OLD = """    When ``stt.provider`` is explicitly set in config, that choice is
    honoured — no silent cloud fallback.  When no provider is configured,
    auto-detect tries: local > groq (free) > openai (paid)."""

STT_DOC_NEW = """    Provider resolution order: ``STT_PROVIDER`` env var, then
    ``stt.provider`` in config, then ``DEFAULT_PROVIDER`` / auto-detect.

    When a provider is explicitly chosen (env or config), that choice is
    honoured — no silent cloud fallback.  When no provider is configured,
    auto-detect tries: local > groq (free) > openai (paid)."""

KNOWN_ROOT_KEYS_OLD = """    "sessions", "streaming", "updates", "mcp_servers",
}"""

KNOWN_ROOT_KEYS_NEW = """    "sessions", "streaming", "updates", "mcp_servers",
    "stt", "tts", "voice", "human_delay", "plugins", "skills", "curator",
    "timezone", "model_catalog", "hooks", "security", "kanban", "cron",
}"""

MIGRATE_STT_ANCHOR = "    # ── Post-migration: disable exfiltration-shaped MCP stdio entries ──"
MIGRATE_STT_INSERT = """    # ── Wolfhouse: preserve/seed stt block (gateway reads stt; bootstrap configs omit it) ──
    config = read_raw_config()
    _stt_raw = config.get("stt")
    if not isinstance(_stt_raw, dict):
        config["stt"] = copy.deepcopy(DEFAULT_CONFIG.get("stt", {}))
        _env_stt = os.getenv("STT_PROVIDER", "").strip()
        if _env_stt:
            config["stt"]["provider"] = _env_stt
        save_config(config)
        results["config_added"].append("stt (seeded defaults)")
        if not quiet:
            print("  ✓ Seeded stt defaults in config.yaml")

    """


def _compile_check(path: Path) -> None:
    py_compile.compile(str(path), doraise=True)


def _norm_lines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def apply_transcription_tools_patch(path: Path) -> dict:
    text = _norm_lines(path.read_text(encoding="utf-8"))
    if STT_PATCH_TAG in text:
        return {"ok": True, "path": str(path), "already_patched": True}

    if STT_PROVIDER_RESOLVE_OLD not in text:
        raise RuntimeError("transcription_tools STT provider anchor not found")

    text = text.replace(STT_PROVIDER_RESOLVE_OLD, STT_PROVIDER_RESOLVE_NEW, 1)
    if STT_DOC_OLD in text:
        text = text.replace(STT_DOC_OLD, STT_DOC_NEW, 1)

    path.write_text(text, encoding="utf-8")
    _compile_check(path)
    return {"ok": True, "path": str(path), "stt_provider_env": True}


def apply_config_migrate_patch(path: Path) -> dict:
    text = _norm_lines(path.read_text(encoding="utf-8"))
    result = {"ok": True, "path": str(path), "known_root_keys": False, "stt_migrate_seed": False}

    if '"stt", "tts", "voice"' not in text:
        if KNOWN_ROOT_KEYS_OLD not in text:
            raise RuntimeError("hermes_cli.config _KNOWN_ROOT_KEYS anchor not found")
        text = text.replace(KNOWN_ROOT_KEYS_OLD, KNOWN_ROOT_KEYS_NEW, 1)
        result["known_root_keys"] = True

    if CONFIG_STT_MIGRATE_TAG not in text:
        if MIGRATE_STT_ANCHOR not in text:
            raise RuntimeError("hermes_cli.config migrate MCP anchor not found")
        text = text.replace(MIGRATE_STT_ANCHOR, MIGRATE_STT_INSERT + MIGRATE_STT_ANCHOR, 1)
        result["stt_migrate_seed"] = True

    if result["known_root_keys"] or result["stt_migrate_seed"]:
        path.write_text(text, encoding="utf-8")
        _compile_check(path)
    else:
        result["already_patched"] = True

    return result


def main() -> int:
    transcription_spec = importlib.util.find_spec("tools.transcription_tools")
    config_spec = importlib.util.find_spec("hermes_cli.config")
    if not transcription_spec or not transcription_spec.origin:
        print("tools.transcription_tools not found", file=sys.stderr)
        return 1
    if not config_spec or not config_spec.origin:
        print("hermes_cli.config not found", file=sys.stderr)
        return 1

    transcription_path = Path(transcription_spec.origin)
    config_path = Path(config_spec.origin)
    try:
        result = {
            "transcription_tools": apply_transcription_tools_patch(transcription_path),
            "config_migrate": apply_config_migrate_patch(config_path),
        }
    except Exception as exc:
        print(f"apply_stt_patches failed: {exc}", file=sys.stderr)
        return 1

    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
