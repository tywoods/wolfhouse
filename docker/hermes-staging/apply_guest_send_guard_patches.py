#!/usr/bin/env python3
"""Build-time patches: only agent-composed replies reach Luna guest WhatsApp."""

from __future__ import annotations

import importlib.util
import py_compile
import sys
from pathlib import Path

PATCH_TAG = "wolfhouse_guest_reply"
GUEST_SEND_GUARD_IN_SEND = "suppress_guest_whatsapp_text_send"

BASE_SEND_RETRY_ANCHOR = """        result = await self.send(
            chat_id=chat_id,
            content=content,
            reply_to=reply_to,
            metadata=metadata,
        )

        if result.success:
            return result"""

BASE_SEND_RETRY_PATCH = """        try:
            from wolfhouse.guest_send_guard import mark_agent_reply_metadata
            metadata = mark_agent_reply_metadata(metadata, getattr(self, "platform", None))
        except Exception:
            pass

        result = await self.send(
            chat_id=chat_id,
            content=content,
            reply_to=reply_to,
            metadata=metadata,
        )

        if result.success:
            return result"""

STREAM_META_ANCHOR = """        if final:
            meta["notify"] = True
        return meta or None"""

STREAM_META_PATCH = """        if final:
            meta["notify"] = True
        try:
            from wolfhouse.guest_send_guard import mark_agent_reply_metadata, is_luna_guest_whatsapp
            if is_luna_guest_whatsapp(adapter=self.adapter):
                meta = mark_agent_reply_metadata(meta, getattr(getattr(self.adapter, "platform", None), "value", None))
        except Exception:
            pass
        return meta or None"""

WHATSAPP_SEND_GUARD = """
        try:
            from wolfhouse.guest_send_guard import suppress_guest_whatsapp_text_send
            if suppress_guest_whatsapp_text_send(content, metadata):
                return SendResult(success=True, message_id=None, raw_response={"suppressed_guest_system_send": True})
        except Exception:
            pass
"""

WHATSAPP_EXEC_APPROVAL_ANCHOR = '        if self._http_client is None:\n            return SendResult(success=False, error="Not connected")\n\n        # WhatsApp body caps at 1024 chars'
WHATSAPP_EXEC_APPROVAL_PATCH = """        if self._http_client is None:
            return SendResult(success=False, error="Not connected")
        try:
            from wolfhouse.guest_send_guard import suppress_guest_interactive_send
            if suppress_guest_interactive_send("exec_approval"):
                return SendResult(success=True, message_id=None, raw_response={"suppressed_guest_system_send": True})
        except Exception:
            pass

        # WhatsApp body caps at 1024 chars"""

WHATSAPP_SLASH_CONFIRM_ANCHOR = '        if self._http_client is None:\n            return SendResult(success=False, error="Not connected")\n\n        body_text = self._truncate_body(f"*{title}*'
WHATSAPP_SLASH_CONFIRM_PATCH = """        if self._http_client is None:
            return SendResult(success=False, error="Not connected")
        try:
            from wolfhouse.guest_send_guard import suppress_guest_interactive_send
            if suppress_guest_interactive_send("slash_confirm"):
                return SendResult(success=True, message_id=None, raw_response={"suppressed_guest_system_send": True})
        except Exception:
            pass

        body_text = self._truncate_body(f"*{title}*"""

STT_ECHO_BLOCK_OLD = """                if _successful_transcripts:
                    _echo_adapter = self.adapters.get(source.platform)
                    _echo_meta = self._thread_metadata_for_source(source, self._reply_anchor_for_event(event))
                    if _echo_adapter:
                        for _tx in _successful_transcripts:
                            try:
                                await _echo_adapter.send(
                                    source.chat_id,
                                    f'🎙️ "{_tx}"',
                                    metadata=_echo_meta,
                                )
                            except Exception as _echo_exc:
                                logger.debug(
                                    "Transcript echo failed (non-fatal): %s", _echo_exc,
                                )"""

STT_ECHO_BLOCK_NEW = """                if _successful_transcripts:
                    try:
                        from wolfhouse.guest_send_guard import guest_stt_echo_enabled
                        _wh_echo = guest_stt_echo_enabled(source=source)
                    except Exception:
                        _wh_echo = False
                    if _wh_echo:
                        _echo_adapter = self.adapters.get(source.platform)
                        _echo_meta = self._thread_metadata_for_source(source, self._reply_anchor_for_event(event))
                        if _echo_adapter:
                            for _tx in _successful_transcripts:
                                try:
                                    await _echo_adapter.send(
                                        source.chat_id,
                                        f'🎙️ "{_tx}"',
                                        metadata=_echo_meta,
                                    )
                                except Exception as _echo_exc:
                                    logger.debug(
                                        "Transcript echo failed (non-fatal): %s", _echo_exc,
                                    )"""

STT_FAIL_SEND_BLOCK_OLD = r"""                if any(marker in message_text for marker in _stt_fail_markers):
                    _stt_adapter = self.adapters.get(source.platform)
                    _stt_meta = self._thread_metadata_for_source(source, self._reply_anchor_for_event(event))
                    if _stt_adapter:
                        try:
                            _stt_msg = (
                                "🎤 I received your voice message but can't transcribe it — "
                                "no speech-to-text provider is configured.\n\n"
                                "To enable voice: install faster-whisper "
                                "(`uv pip install faster-whisper` in the Hermes venv; "
                                "`pip install faster-whisper` also works if pip is on PATH) "
                                "and set `stt.enabled: true` in config.yaml, "
                                "then /restart the gateway."
                            )
                            if self._has_setup_skill():
                                _stt_msg += "\n\nFor full setup instructions, type: `/skill hermes-agent-setup`"
                            await _stt_adapter.send(
                                source.chat_id,
                                _stt_msg,
                                metadata=_stt_meta,
                            )
                        except Exception:
                            pass"""

STT_FAIL_SEND_BLOCK_NEW = """                if any(marker in message_text for marker in _stt_fail_markers):
                    logger.info(
                        "Wolfhouse: STT unavailable for voice message on %s — agent will reply; no setup text to guest",
                        getattr(source, "platform", "?"),
                    )
                    try:
                        from wolfhouse.guest_send_guard import is_guest_facing_platform, stt_dev_hints_enabled
                        if (not is_guest_facing_platform(getattr(source, "platform", None))) or stt_dev_hints_enabled():
                            _stt_adapter = self.adapters.get(source.platform)
                            _stt_meta = self._thread_metadata_for_source(source, self._reply_anchor_for_event(event))
                            if _stt_adapter:
                                _stt_msg = (
                                    "🎤 I received your voice message but can't transcribe it — "
                                    "no speech-to-text provider is configured."
                                )
                                if stt_dev_hints_enabled():
                                    _stt_msg += (
                                        "\\n\\nTo enable voice: install faster-whisper and set stt.enabled in config.yaml."
                                    )
                                try:
                                    await _stt_adapter.send(source.chat_id, _stt_msg, metadata=_stt_meta)
                                except Exception:
                                    pass
                    except Exception:
                        pass"""

STT_AGENT_NOTE_OLD = """                        _no_stt_note = (
                            "[The user sent a voice message but I can't listen "
                            "to it right now — no STT provider is configured. "
                            "A direct message has already been sent to the user "
                            "with setup instructions."
                        )
                        if self._has_setup_skill():
                            _no_stt_note += (
                                " You have a skill called hermes-agent-setup "
                                "that can help users configure Hermes features "
                                "including voice, tools, and more."
                            )
                        _no_stt_note += "]\""""

STT_AGENT_NOTE_NEW = """                        _no_stt_note = (
                            "[The user sent a voice message but STT is unavailable. "
                            "Reply warmly and ask them to type their message instead. "
                            "Do not mention installs, config.yaml, faster-whisper, or internal setup.]"
                        )"""

FOOTER_APPEND_OLD = (
    '            if _footer_line and response and not agent_result.get("already_sent") and not _intentional_silence:\n'
    '                response = f"{response}\\n\\n{_footer_line}"'
)

FOOTER_APPEND_NEW = (
    '            if _footer_line and response and not agent_result.get("already_sent") and not _intentional_silence:\n'
    '                try:\n'
    '                    from wolfhouse.guest_send_guard import is_guest_facing_platform\n'
    '                    if is_guest_facing_platform(source.platform):\n'
    '                        _footer_line = ""\n'
    '                except Exception:\n'
    '                    pass\n'
    '                if _footer_line:\n'
    '                    response = f"{response}\\n\\n{_footer_line}"'
)

FOOTER_TRAILING_OLD = """                if _footer_line:
                    try:
                        _foot_adapter = self.adapters.get(source.platform)
                        if _foot_adapter:
                            await _foot_adapter.send(
                                source.chat_id,
                                _footer_line,
                                metadata=self._thread_metadata_for_source(source, self._reply_anchor_for_event(event)),
                            )
                    except Exception as _e:
                        logger.debug("trailing footer send failed: %s", _e)"""

FOOTER_TRAILING_NEW = """                if _footer_line:
                    try:
                        from wolfhouse.guest_send_guard import is_guest_facing_platform
                        if is_guest_facing_platform(source.platform):
                            _footer_line = ""
                    except Exception:
                        pass
                    if _footer_line:
                        try:
                            _foot_adapter = self.adapters.get(source.platform)
                            if _foot_adapter:
                                await _foot_adapter.send(
                                    source.chat_id,
                                    _footer_line,
                                    metadata=self._thread_metadata_for_source(source, self._reply_anchor_for_event(event)),
                                )
                        except Exception as _e:
                            logger.debug("trailing footer send failed: %s", _e)"""

APPROVAL_GUARD_OLD = """                cmd = approval_data.get("command", "")
                desc = approval_data.get("description", "dangerous command")

                # Prefer button-based approval when the adapter supports it."""

APPROVAL_GUARD_NEW = """                cmd = approval_data.get("command", "")
                desc = approval_data.get("description", "dangerous command")

                try:
                    from wolfhouse.guest_send_guard import is_luna_guest_whatsapp
                    if is_luna_guest_whatsapp(adapter=_status_adapter):
                        logger.info(
                            "Wolfhouse: suppressed exec approval prompt for guest WhatsApp (cmd=%s)",
                            (cmd or "")[:120],
                        )
                        return
                except Exception:
                    pass

                # Prefer button-based approval when the adapter supports it."""


def _compile_check(path: Path) -> None:
    py_compile.compile(str(path), doraise=True)


def _norm_lines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _patch_once(text: str, old: str, new: str, label: str) -> tuple[str, bool]:
    text_n = _norm_lines(text)
    old_n = _norm_lines(old)
    new_n = _norm_lines(new)
    if new_n in text_n:
        return text_n, False
    if old_n not in text_n:
        raise RuntimeError(f"{label}: anchor not found")
    patched = text_n.replace(old_n, new_n, 1)
    return patched, True


def _inject_whatsapp_send_guard(text: str) -> tuple[str, bool]:
    if GUEST_SEND_GUARD_IN_SEND in text:
        return text, False
    anchor = "        formatted = self.format_message(content)"
    text_n = _norm_lines(text)
    if anchor not in text_n:
        raise RuntimeError("whatsapp_cloud send format anchor not found")
    patched = text_n.replace(anchor, _norm_lines(WHATSAPP_SEND_GUARD) + anchor, 1)
    return patched, True


def apply_base_platform_patch(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    text, changed = _patch_once(text, BASE_SEND_RETRY_ANCHOR, BASE_SEND_RETRY_PATCH, "base._send_with_retry")
    if changed:
        path.write_text(text, encoding="utf-8")
        _compile_check(path)
    return {"path": str(path), "send_with_retry_tagged": PATCH_TAG in text}


def apply_stream_consumer_patch(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    text, changed = _patch_once(text, STREAM_META_ANCHOR, STREAM_META_PATCH, "stream._metadata_for_send")
    if changed:
        path.write_text(text, encoding="utf-8")
        _compile_check(path)
    return {"path": str(path), "stream_metadata_tagged": PATCH_TAG in text}


def apply_whatsapp_cloud_patch(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    text, send_changed = _inject_whatsapp_send_guard(text)
    text, approval_changed = _patch_once(
        text, WHATSAPP_EXEC_APPROVAL_ANCHOR, WHATSAPP_EXEC_APPROVAL_PATCH, "whatsapp.send_exec_approval",
    )
    text, confirm_changed = _patch_once(
        text, WHATSAPP_SLASH_CONFIRM_ANCHOR, WHATSAPP_SLASH_CONFIRM_PATCH, "whatsapp.send_slash_confirm",
    )
    if send_changed or approval_changed or confirm_changed:
        path.write_text(text, encoding="utf-8")
        _compile_check(path)
    return {
        "path": str(path),
        "send_guard": GUEST_SEND_GUARD_IN_SEND in text,
        "exec_approval_guard": "suppress_guest_interactive_send" in text,
    }


def apply_run_patch(path: Path) -> dict:
    text = _norm_lines(path.read_text(encoding="utf-8"))
    results = {}
    for key, old, new in (
        ("stt_echo", STT_ECHO_BLOCK_OLD, STT_ECHO_BLOCK_NEW),
        ("stt_fail_send", STT_FAIL_SEND_BLOCK_OLD, STT_FAIL_SEND_BLOCK_NEW),
        ("stt_agent_note", STT_AGENT_NOTE_OLD, STT_AGENT_NOTE_NEW),
        ("footer_append", FOOTER_APPEND_OLD, FOOTER_APPEND_NEW),
        ("footer_trailing", FOOTER_TRAILING_OLD, FOOTER_TRAILING_NEW),
        ("approval_guard", APPROVAL_GUARD_OLD, APPROVAL_GUARD_NEW),
    ):
        text, changed = _patch_once(text, old, new, f"run.{key}")
        results[key] = changed or (new in text)
    path.write_text(text, encoding="utf-8")
    _compile_check(path)
    results["path"] = str(path)
    return results


def patch_runtime_whatsapp_wrapper(gateway_patches_path: Path) -> dict:
    text = _norm_lines(gateway_patches_path.read_text(encoding="utf-8"))
    if "suppress_guest_whatsapp_text_send" in text and "suppressed_guest_system_send" in text:
        return {"path": str(gateway_patches_path), "runtime_send_guard": True, "already_patched": True}
    needle = "async def _patched_whatsapp_cloud_send(self, chat_id, content, reply_to=None, metadata=None):"
    insert = """
    try:
        from wolfhouse.guest_send_guard import suppress_guest_whatsapp_text_send
        if suppress_guest_whatsapp_text_send(content, metadata):
            try:
                from gateway.platforms.base import SendResult
                return SendResult(success=True, message_id=None, raw_response={"suppressed_guest_system_send": True})
            except Exception:
                return None
    except Exception:
        pass"""
    if needle not in text:
        raise RuntimeError("apply_gateway_patches _patched_whatsapp_cloud_send anchor not found")
    text = text.replace(needle, needle + insert, 1)
    gateway_patches_path.write_text(text, encoding="utf-8")
    _compile_check(gateway_patches_path)
    return {"path": str(gateway_patches_path), "runtime_send_guard": True}


def reapply_plain_reply_patches(
    base_path: Path,
    stream_path: Path,
    whatsapp_path: Path,
    run_path: Path,
) -> dict:
    """Re-apply Luna plain-reply gateway patches after guest send guard (order-independent)."""
    gateway_script = Path(__file__).resolve().parent / "apply_gateway_patches.py"
    spec = importlib.util.spec_from_file_location("apply_gateway_patches", gateway_script)
    if not spec or not spec.loader:
        raise RuntimeError("apply_gateway_patches.py not found for plain-reply reapply")
    gw = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gw)
    return {
        "base_platform": gw.apply_base_platform_patch(base_path),
        "whatsapp_cloud": gw.apply_whatsapp_cloud_patch(whatsapp_path),
        "stream_consumer": gw.apply_stream_consumer_patch(stream_path),
        "gateway_run": gw.apply_patches(run_path),
    }


def main() -> int:
    specs = {
        "base": importlib.util.find_spec("gateway.platforms.base"),
        "stream": importlib.util.find_spec("gateway.stream_consumer"),
        "whatsapp": importlib.util.find_spec("gateway.platforms.whatsapp_cloud"),
        "run": importlib.util.find_spec("gateway.run"),
    }
    missing = [name for name, spec in specs.items() if not spec or not spec.origin]
    if missing:
        print(f"Missing modules: {', '.join(missing)}", file=sys.stderr)
        return 1

    gateway_patches = Path(__file__).resolve().parent / "apply_gateway_patches.py"
    try:
        base_path = Path(specs["base"].origin)
        stream_path = Path(specs["stream"].origin)
        whatsapp_path = Path(specs["whatsapp"].origin)
        run_path = Path(specs["run"].origin)
        result = {
            "base_platform": apply_base_platform_patch(base_path),
            "stream_consumer": apply_stream_consumer_patch(stream_path),
            "whatsapp_cloud": apply_whatsapp_cloud_patch(whatsapp_path),
            "gateway_run": apply_run_patch(run_path),
            "runtime_wrapper": patch_runtime_whatsapp_wrapper(gateway_patches),
        }
        result["plain_reply_reapply"] = reapply_plain_reply_patches(
            base_path, stream_path, whatsapp_path, run_path,
        )
    except Exception as exc:
        print(f"apply_guest_send_guard_patches failed: {exc}", file=sys.stderr)
        return 1

    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
