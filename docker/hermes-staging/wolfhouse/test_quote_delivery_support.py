"""TEST ONLY: explicitly simulate successful offline WhatsApp quote transport.

These fixtures are not evidence of a live provider send. The real finalizer and
send-ticket/acknowledgement guards remain in charge of presentation authority.
"""
from wolfhouse import accepted_quote as ledger, quote_delivery


def offline_send_result(result):
    """Acknowledge only this completed reply's new, matching priced presentation.

    Failed/unpriced replies, FAQ followups, previously sent presentations and
    missing owner bindings are no-ops, never synthesized presentation state.
    """
    if (not isinstance(result, dict) or not result.get('completed')
            or result.get('failed') or result.get('interrupted')):
        return result
    text = result.get('final_response')
    ingress = ledger._current.get()
    if not isinstance(text, str) or not text or ingress is None or not ingress.binding:
        return result
    ticket = quote_delivery.prepare(ingress.binding[1:], text)
    if ticket is not None:
        # A deliberately fake provider ID, confined to offline SessionDB fixtures.
        message_id = f'offline-whatsapp-{ticket.epoch}-{ticket.digest}'
        if not quote_delivery.acknowledge(ticket, text, message_id):
            raise AssertionError('Offline quote transport acknowledgement was rejected')
    return result


def offline_finalize_and_send(*args, **kwargs):
    """Exercise the actual finalizer, then simulate provider acceptance."""
    return offline_send_result(ledger.finalize_offer_response(*args, **kwargs))
