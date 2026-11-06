"""Question descriptors are context, never text-derived booking authority.

Localized decisions below are scripted model decisions, not language-model
quality proof. Real owner observation/diagnostics/prepare boundaries are used.
"""
from copy import deepcopy
import json
import unittest

from wolfhouse import accepted_quote as ledger
from wolfhouse import pending_question
from wolfhouse import test_first_yes_owner as owner_fixtures


class ClearGoAheadAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.case = owner_fixtures.FirstYesOwnerTests(
            methodName="test_only_owner_final_question_authorizes_contextual_yes")
        self.case.setUp()
        self.addCleanup(self.case.tearDown)

    def rows(self):
        with self.case.db._lock:
            return [tuple(row) for row in self.case.db._conn.execute(
                "SELECT key,value FROM state_meta "
                "WHERE key LIKE 'wolfhouse.accepted_quote.%' ORDER BY key")]

    def state(self):
        states = [json.loads(value) for _, value in self.rows()]
        return next(state for state in states
                    if state['scope']['ID'] == self.case.agent.session_id)

    def show(self, plan=None, response=None):
        ledger.record_quote(plan or self.case.plan, response or self.case.response)
        shown = owner_fixtures.offline_quote_result(
            {'completed': True, 'final_response': 'scripted model quote'})
        self.assertTrue(shown['completed'], shown)
        self.assertTrue(self.state().get('presentation'))

    def diagnostic(self, payload):
        before = self.rows()
        for _ in range(2):
            result = ledger.interpret_owner_turn(payload)
            self.assertTrue(result['diagnostic_only'])
            self.assertNotIn('accepted', result)
            self.assertNotIn('create_ready', result)
            self.assertEqual(self.rows(), before)
        return result

    def test_supported_localized_clear_acceptance(self):
        # No supported-language acceptance grammar: every string is provenance
        # only. The explicit create decision, not a diagnostic, selects the offer.
        self.show()
        for index, text in enumerate(('Yes', 'Yes, save it.', 'Sí', 'Sí, guárdala.',
                                     'Ja', 'Ja, bitte speichern.', 'Sì, salvala.',
                                     'Oui, réservez-la.')):
            with self.subTest(text=text):
                self.case.turn('localized-' + str(index), text)
                before = self.state()
                self.diagnostic({'action': 'accept', 'action_evidence': text})
                self.assertEqual(self.state()['status'], before['status'])
                self.assertEqual(self.state().get('operation_key'), before.get('operation_key'))
        # Model-selected action after the final localized turn. Fresh Staff
        # validation is required; this does not claim dispatch or persistence.
        create = ledger.prepare_create({})
        self.assertTrue(create.revalidation)
        self.assertEqual(create['payment_choice'], self.case.plan['payment_choice'])
        self.assertEqual(self.state()['status'], 'accepted')
        accepted = self.rows()
        # Legacy reject/decline diagnostics cannot revoke explicit create intent,
        # rotate operation identity, or undo pending fresh Staff revalidation.
        self.diagnostic({'action': 'reject', 'decline_scope': 'whole_offer'})
        self.diagnostic({'action': 'malformed', 'completions': {'guests': 'not-an-array'}})
        for malformed in (None, [], 'reject'):
            with self.assertRaisesRegex(ledger.QuoteBoundaryError, 'quote_diagnostic_schema_invalid'):
                ledger.interpret_owner_turn(malformed)
            self.assertEqual(self.rows(), accepted)

    def test_stale_payment_question_requires_owner_rendered_final_save(self):
        # Historical test name retained. A typed descriptor is NOT proof that a
        # priced offer was shown; neither text nor diagnostic can manufacture it.
        ledger.record_quote(self.case.plan, self.case.response)
        self.case.turn('unshown-save', 'Sí, guárdala.')
        self.diagnostic({'action': 'accept', 'pending_question': {'kind': 'go_ahead'}})
        with self.assertRaisesRegex(ledger.QuoteBoundaryError, 'presented_offer_required'):
            ledger.prepare_create({})
        self.show()
        self.case.turn('shown-save', 'Sí, guárdala.')
        self.diagnostic({'action': 'accept'})
        self.assertTrue(ledger.prepare_create({}).revalidation)

    def test_yes_to_non_save_question_never_becomes_booking_authority(self):
        for kind, options in (('add_on', None),
                              ('payment_choice', ['together', 'separate'])):
            with self.subTest(kind=kind):
                state = {'plan': {'guest_count': 2, 'payment_choice': 'deposit'}}
                pending_question.persist(state, kind, options)
                before = deepcopy(state)
                self.assertEqual(pending_question.question_intent(kind, options),
                                 state['pending_question'])
                self.assertEqual(state, before)
                self.assertNotIn('accepted', state)
                self.case.turn('non-save-' + kind, 'Yes')
                self.diagnostic({'action': 'accept', 'completions': {'shuttle_choice': 'accepted'}})
                self.assertFalse(self.state().get('presentation'))
                self.assertFalse(self.state().get('operation_key'))
                with self.assertRaises(ledger.QuoteBoundaryError):
                    ledger.prepare_create({})

    def test_combined_distribution_and_side_question_keeps_explicit_choice(self):
        self.show()
        raw = 'Separate links, and what time is check-in?'
        self.case.turn('distribution-side-question', raw)
        self.diagnostic({'action': 'clarify', 'action_evidence': raw,
                         'completions': {'payment_link_distribution': 'separate'}})
        # Explicit model-selected typed quote input; no text parser/binder.
        prepared = ledger.prepare_quote({'payment_link_distribution': 'separate'})
        self.assertEqual(prepared['payment_link_distribution'], 'separate')
        self.assertIs(prepared['per_guest_payment_links'], True)
        self.assertEqual(prepared['payment_choice'], self.case.plan['payment_choice'])
        self.assertNotEqual(self.state()['status'], 'accepted')

    def test_deposit_or_full_selection_is_single_create_consent(self):
        for choice in ('deposit', 'full'):
            with self.subTest(choice=choice):
                self.case.agent.session_id = 'pending-amount-' + choice
                self.case.db.create_session(self.case.agent.session_id, source='whatsapp')
                self.case.turn('quote-' + choice, 'Show the options')
                plan = {**self.case.plan, 'payment_link_distribution': 'separate',
                        'per_guest_payment_links': True, 'shuttle_choice': 'declined'}
                plan.pop('payment_choice')
                response = self.case._checked_offer(
                    {**plan, 'payment_choice': 'deposit'},
                    self.case.response['offer_revision']['room_arrangement'])
                response.update(payment_choice_needed=True, missing_fields=['payment_choice'])
                self.show(plan, response)
                self.case.turn('choice-' + choice, choice)
                self.diagnostic({'action': 'accept', 'payment_choice': choice})
                create = ledger.prepare_create({'payment_choice': choice})
                self.assertTrue(create.revalidation)
                self.assertEqual(create['payment_choice'], choice)
                self.assertEqual(create['payment_link_distribution'], 'separate')
                self.assertIs(create['per_guest_payment_links'], True)

    def test_names_descriptor_survives_reopen(self):
        for stale in ({'kind': 'payment_choice', 'options': ['deposit', 'full']},
                      {'kind': 'add_on'}):
            with self.subTest(stale=stale):
                state = {'pending_question': stale}
                pending_question.persist(state, 'names', [])
                reopened = json.loads(json.dumps(state))
                self.assertEqual(reopened['pending_question'], {'kind': 'names'})
                self.assertEqual(pending_question.question_intent('names', []), {'kind': 'names'})
                self.assertNotIn('accepted', reopened)
        self.case.turn('names-yes', 'Yes')
        self.diagnostic({'action': 'accept', 'pending_question': {'kind': 'names'}})
        self.assertFalse(self.state().get('operation_key'))
        self.assertFalse(self.state().get('presentation'))

    def test_conditions_changes_and_negatives_are_not_clear_acceptance(self):
        self.show()
        for index, text in enumerate(('No', 'Maybe', 'Yes, if breakfast is included',
                                     'Sí, pero cambia las fechas', 'Ja, aber später')):
            with self.subTest(text=text):
                prior = self.state()
                self.case.turn('condition-' + str(index), text)
                self.diagnostic({'action': 'reject', 'conditional': True,
                                 'material_changes': [{'field': 'check_out', 'value': '2026-11-09'}]})
                self.assertEqual(self.state()['presentation'], prior['presentation'])
                self.assertEqual(self.state()['plan'], prior['plan'])
                self.assertNotEqual(self.state()['status'], 'accepted')
        # Model elects clarification: no quote/create/update is selected, so no
        # conditional name/date/payment fragment may mutate the draft.
        before = self.rows()
        for malformed in (None, [], 'accept'):
            with self.subTest(malformed=malformed):
                with self.assertRaisesRegex(ledger.QuoteBoundaryError, 'quote_diagnostic_schema_invalid'):
                    ledger.interpret_owner_turn(malformed)
                self.assertEqual(self.rows(), before)


if __name__ == '__main__':
    unittest.main()
