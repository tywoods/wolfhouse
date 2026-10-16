"""Baseline copied-Hermes gateway ingress bytes for output-guard upgrade regression."""


def copied_gateway_ingress(message_text, history, source, agent_result, response):
    try:
        from wolfhouse.output_guard import guard_turn_response as _wh_guard_turn
        response = _wh_guard_turn(response, agent_result, history, getattr(source, "platform", None))
    except Exception:
        pass
    return response
