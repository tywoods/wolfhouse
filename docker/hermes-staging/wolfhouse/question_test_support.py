"""Migrate raw-consent fixtures through real SQLite question + ingress binding.

A raw 'full' string is no longer authority. Keep business assertions unchanged,
but obtain answer state from the same commit/observer used by the runtime.
"""
from copy import deepcopy
from contextlib import contextmanager
from wolfhouse import accepted_quote as owner


@contextmanager
def persisted_state(state):
    from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
    case = FirstYesOwnerTests('test_only_owner_final_question_authorizes_contextual_yes')
    case.setUp()
    try:
        owner._transaction(lambda s, _: s.update(deepcopy(state)))
        serial = 0
        def answer(raw, options=None):
            nonlocal serial
            serial += 1
            options = options or ['deposit', 'full']
            owner.commit_question_outbound(' / '.join(options) + '?', 'payment_choice', options)
            case.turn('persisted-answer-' + str(serial), raw)
        yield answer
    finally:
        case.tearDown()
        case.doCleanups()


def persisted_answer(state, answer, options=None):
    from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
    case = FirstYesOwnerTests('test_only_owner_final_question_authorizes_contextual_yes')
    case.setUp()
    try:
        owner._transaction(lambda s, _: s.update(deepcopy(state)))
        options = options or ['deposit', 'full']
        owner.commit_question_outbound(' / '.join(options) + '?', 'payment_choice', options)
        case.turn('answer-' + str(state.get('question_serial', 0)), answer)
        updated = owner._read_owner_state(lambda s, _: deepcopy(s))
        # Do not leak this ephemeral fixture's scope into another ephemeral DB.
        for key in ('scope', 'incarnation', 'seen', 'epoch', 'version', 'status'):
            updated.pop(key, None)
        state.update(updated)
        return state
    finally:
        case.tearDown()
        case.doCleanups()
