"""Model-owned acknowledgement on the existing ordinary-turn send boundary.

No outbound exception: the normal adapter still enforces human pause, draft,
kill-switch and tenant controls. Persistence remains with explicit_human_handoff.
"""
import asyncio
import os
import re
import threading

WARM_NOTES = {
    'en': 'A staff member will help you from here — someone from the team will write to you shortly.',
    'es': 'Una persona del equipo te va a ayudar — enseguida te escriben.',
    'it': 'Una persona del team ti aiuterà — ti scrivono a breve.',
    'de': 'Ein Teammitglied hilft dir weiter — jemand schreibt dir gleich.',
    'fr': "Un membre de l'equipe va t'aider — quelqu'un t'ecrira tout de suite.",
}


def _staff_name(raw):
    name = ' '.join(str(raw or '').replace('\r', ' ').replace('\n', ' ').replace('\t', ' ').split())
    return name[:60] if name else ''


def default_guest_note(language=None, staff_name=None):
    lang = str(language or '').strip().lower()[:2]
    empty = WARM_NOTES.get(lang) or WARM_NOTES['en']
    name = _staff_name(staff_name)
    if not name:
        return empty
    named = {
        'en': f'{name} from the team will help you from here — someone from the team will write to you shortly.',
        'es': f'{name} del equipo te va a ayudar — enseguida te escriben.',
        'it': f'{name} del team ti aiuterà — ti scrivono a breve.',
        'de': f'{name} vom Team hilft dir weiter — jemand schreibt dir gleich.',
        'fr': f"{name} de l'equipe va t'aider — quelqu'un t'ecrira tout de suite.",
    }
    return named.get(lang) or named['en']


def send_before_handoff(payload, guest_note):
    from wolfhouse import explicit_human_handoff as owner
    from wolfhouse.luna_personality_isolation import deny_tool_if_isolated

    turn = owner._ORDINARY_TURN.get()
    reason = str(payload.get('reason') or '')
    note = guest_note.strip() if isinstance(guest_note, str) and guest_note.strip() else ''
    if not note:
        src = payload or {}
        note = default_guest_note(src.get('language') or src.get('guest_language'), src.get('staff_member_name') or src.get('staff_name'))
    if (turn is None or not note or len(note) > 500
            or reason == owner.PAYMENT_REPORTED_UNRESOLVED
            or re.fullmatch(r'business_tool_error: \w+ payment operation failed', reason)):
        return

    def authorized():
        return (not turn.closed and turn.task is not None and not turn.task.cancelling()
                and turn.tenant == os.getenv('LUNA_CLIENT_SLUG', '')
                and turn.origin == os.getenv('WOLFHOUSE_STAFF_API_BASE_URL', '')
                and owner._digits(payload.get('phone')) == owner._digits(turn.phone))

    async def send():
        if not authorized():
            return False
        token = owner._SENDING_ACK.set(True)
        try:
            receipt = await turn.adapter.send(
                turn.phone, note, metadata={'wolfhouse_guest_reply': True})
            raw = getattr(receipt, 'raw_response', None) or {}
            return bool(getattr(receipt, 'success', False)
                        and getattr(receipt, 'message_id', None)
                        and not any(str(k).startswith('suppressed_') and v for k, v in raw.items()))
        finally:
            owner._SENDING_ACK.reset(token)

    # Share the owner's one-attempt latch and lock: concurrent flag calls cannot
    # persist while this note is in flight, or send a second acknowledgement.
    with turn.lock:
        if (not authorized() or turn.ack_attempted
                or deny_tool_if_isolated('flag_needs_human', payload)):
            return
        turn.requested = True
        turn.ack_attempted = True
        if threading.get_ident() == turn.thread:
            return  # synchronous tool on adapter loop: never deadlock
        future = asyncio.run_coroutine_threadsafe(asyncio.wait_for(send(), 8), turn.loop)
        try:
            turn.ack_sent = bool(future.result(timeout=10))
        except Exception:
            future.cancel()
            turn.ack_sent = False
        if not authorized():
            if turn.ack_sent:
                owner.mark_local_automation_blocked(turn.phone)
            return {'success': False, 'needs_human': False, 'error': 'handoff_scope_closed',
                    'ack_sent': turn.ack_sent, 'ack_send_failed': not turn.ack_sent,
                    'local_fail_closed': turn.ack_sent,
                    'needs_operator_reconciliation': turn.ack_sent}
        # The existing persistence owner records receipt truth and fails closed
        # if Staff persistence fails; it never resumes booking automation.
