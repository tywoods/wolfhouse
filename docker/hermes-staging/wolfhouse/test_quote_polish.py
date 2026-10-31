"""Classic presentation regressions: synthetic Staff contracts, no guest sends."""
import unittest
import json
from unittest.mock import patch
from copy import deepcopy
from wolfhouse import accepted_quote as owner


class QuotePolishTests(unittest.TestCase):
    def setUp(self):
        self.plan = {
            'check_in': '2027-02-04', 'check_out': '2027-02-07',
            'guest_count': 1, 'room_type': 'shared', 'package_code': 'package_none',
            'guests': [{'name': 'Ari'}], 'payment_choice': 'deposit',
        }
        self.offer = {
            **deepcopy(self.plan), 'currency': 'EUR', 'total_cents': 30000,
            'deposit_required_cents': 10000, 'payment_link_amount_cents': 10000,
            'room_arrangement': [{'bed_code': 'R9-B1', 'room_code': 'R9',
                                  'gender_strategy': 'flexible'}],
            'guest_bed_assignments': [{'guest_index': 0, 'guest_name': 'Ari',
                                       'bed_code': 'R9-B1'}],
            'add_ons': [],
        }

    def test_all_canonical_extras_have_spanish_labels_in_quote(self):
        labels = {
            'surf_lesson_single': 'Clase de surf', 'surf_lesson_multi': 'Clases de surf',
            'yoga_class': 'Clase de yoga', 'meals': 'Comidas',
            'soft_top_rental': 'Alquiler de tabla blanda',
            'hard_board_rental': 'Alquiler de tabla rígida',
            'wetsuit_rental': 'Alquiler de neopreno',
            'wetsuit_soft_top_combo': 'Alquiler de neopreno y tabla blanda',
            'wetsuit_hard_board_combo': 'Alquiler de neopreno y tabla rígida',
        }
        for code, label in labels.items():
            with self.subTest(code=code):
                offer = {**self.offer, 'add_ons': [{'code': code, 'quantity': 2}]}
                text = owner._styled_quote_copy(self.plan, offer, 'es')
                self.assertIn(label, text)
                self.assertNotIn(code.replace('_', ' ').capitalize(), text)


    def test_italian_quote_and_receipt_use_the_observed_locale(self):
        self.assertEqual(owner._guest_language({'guest_language': 'it'}), 'it')
        offer = {**self.offer, 'add_ons': [{'code': 'wetsuit_rental', 'quantity': 1, 'days': 2}]}
        text = owner._styled_quote_copy(self.plan, offer, 'it')
        for phrase in ('Ecco il riepilogo del soggiorno', 'gio 4 feb', 'dormitorio',
                       'Solo pernottamento', 'Noleggio muta', 'per 2 giorni',
                       'Da pagare ora', 'Salvo questa prenotazione?'):
            self.assertIn(phrase, text)
        receipt = owner._styled_booking_receipt_copy(self.plan, offer,
                    {'booking_code': 'TEST-IT', 'amount_due_cents': 10000}, 'it')
        for phrase in ('prenotazione è registrata', 'Prenotazione', '3 notti', 'Da pagare ora'):
            self.assertIn(phrase, receipt)
        for text in (text, receipt):
            self.assertNotIn('**', text)
            self.assertNotIn('Due now', text)

    def test_french_checked_offer_asks_to_save_not_verify(self):
        text = owner._styled_quote_copy(self.plan, self.offer, 'fr')
        self.assertIn("Voulez-vous que j'enregistre cette réservation ?", text)
        self.assertNotIn('vérifie cette offre', text)

    def test_selected_full_payment_omits_quoted_deposit_line(self):
        plan = {**self.plan, 'payment_choice': 'full'}
        offer = {**self.offer, 'payment_choice': 'full',
                 'payment_link_amount_cents': self.offer['total_cents']}
        text = owner._styled_quote_copy(plan, offer, 'it')
        self.assertIn('Da pagare ora:* €300', text)
        self.assertNotIn('(full)', text.casefold())
        self.assertNotIn('Acconto del preventivo', text)

    def test_selected_payment_quote_never_exposes_internal_choice_tags(self):
        cases = (('en', 'full', 30000), ('en', 'deposit', 10000),
                 ('es', 'full', 30000), ('es', 'deposit', 10000))
        for language, choice, due in cases:
            with self.subTest(language=language, choice=choice):
                plan = {**self.plan, 'payment_choice': choice}
                offer = {**self.offer, 'payment_choice': choice,
                         'payment_link_amount_cents': due}
                text = owner._styled_quote_copy(plan, offer, language)
                self.assertNotIn(f'({choice})', text.casefold())
                self.assertIn(owner._guest_money(due, 'EUR'), text)

    def test_declined_shuttle_fields_are_durable_owner_fields(self):
        for field in ('shuttle_needed', 'needs_shuttle', 'shuttle_choice'):
            with self.subTest(field=field):
                self.assertIn(field, owner._FIELDS)
                self.assertIn(field, owner._CARRIED_FIELDS)


    def test_private_allocation_counts_are_not_physical_bed_counts(self):
        plan = {**self.plan, 'guest_count': 2, 'room_type': 'private',
                'guests': [{'name': 'Ari'}, {'name': 'Bea'}]}
        offer = {**self.offer, **plan,
                 'room_arrangement': [
                     {'bed_code': 'P1', 'room_code': 'P', 'gender_strategy': 'flexible'},
                     {'bed_code': 'P2', 'room_code': 'P', 'gender_strategy': 'flexible'}],
                 'guest_bed_assignments': [
                     {'guest_index': 0, 'guest_name': 'Ari', 'bed_code': 'P1'},
                     {'guest_index': 1, 'guest_name': 'Bea', 'bed_code': 'P2'}]}
        for text in (owner._styled_quote_copy(plan, offer, 'es'),
                     owner._styled_booking_receipt_copy(plan, offer,
                         {'booking_code': 'TEST-PRIVATE', 'amount_due_cents': 10000}, 'es')):
            self.assertIn('Habitación privada para Ari y Bea', text)
            self.assertNotIn('dos camas', text)
            # Neither a shared double nor a twin setup exists in this Staff projection.
            self.assertNotIn('cama doble', text)
        split = deepcopy(offer)
        split['room_arrangement'][1]['room_code'] = 'Q'
        lines = owner._guest_room_lines(plan, split, 'es')
        self.assertEqual(len(lines), 2)
        self.assertIn('Ari', lines[0])
        self.assertIn('Bea', lines[1])
        self.assertIn('Otra habitación privada', lines[1])


    def test_staff_pricing_rates_and_arrival_review_are_consumed_without_repricing(self):
        offer = {**self.offer, 'payment_choice': 'pay_on_arrival',
                 'payment_link_amount_cents': 0, 'staff_review_required': True,
                 'stay_deposit_rates': {'short_stay_cents': 12500, 'long_stay_cents': 24500}}
        before = deepcopy(offer)
        for language, words in {
                'en': ('per person', 'staff review'),
                'es': ('por persona', 'revisión del equipo'),
                'it': ('a persona', 'verifica del team'),
                'fr': ('par personne', 'vérification de l’équipe'),
                'de': ('pro Person', 'Prüfung durch das Team')}.items():
            for text in (owner._styled_quote_copy(self.plan, offer, language),
                         owner._styled_booking_receipt_copy(self.plan, offer,
                             {'booking_code': 'TEST-RATES', 'amount_due_cents': 0}, language)):
                with self.subTest(language=language, text=text):
                    self.assertIn('€125', text)
                    self.assertIn('€245', text)
                    for word in words:
                        self.assertIn(word, text)
                    self.assertIn('€0', text)
        self.assertEqual(offer, before)

    def test_absent_or_malformed_rates_have_no_invented_tariff(self):
        for rates in (None, {}, {'short_stay_cents': 12300},
                      {'short_stay_cents': True, 'long_stay_cents': 20000},
                      {'short_stay_cents': -1, 'long_stay_cents': 20000}):
            offer = {**self.offer, 'payment_choice': 'pay_on_arrival',
                     'payment_link_amount_cents': 0, 'stay_deposit_rates': rates}
            for text in (owner._styled_quote_copy(self.plan, offer, 'en'),
                         owner._styled_booking_receipt_copy(self.plan, offer,
                             {'booking_code': 'TEST-FALLBACK', 'amount_due_cents': 0}, 'en')):
                self.assertIn('No payment due now; the deposit follows Staff Pricing.', text)
                self.assertNotIn('per person', text)
                self.assertNotIn('€200', text)
                self.assertNotIn('staff review', text)

    def test_arrival_zero_keeps_the_staff_deposit_visible_without_repricing(self):
        offer = {**self.offer, 'total_cents': 8000, 'deposit_required_cents': 8000,
                 'payment_choice': 'pay_on_arrival', 'payment_link_amount_cents': 0}
        before = deepcopy(offer)
        texts = [owner._styled_quote_copy(self.plan, offer, 'es'),
                 owner._styled_booking_receipt_copy(self.plan, offer,
                     {'booking_code': 'TEST-ARRIVAL', 'amount_due_cents': 0}, 'es')]
        for text in texts:
            self.assertIn('Depósito del presupuesto:* €80', text)
            self.assertIn('A pagar ahora:* €0', text)
            self.assertIn('A pagar a la llegada:* €80', text)
            self.assertNotIn('después de este pago', text)
        self.assertEqual(offer, before)

    def test_deposit_basis_uses_complete_staff_people_not_inferred_rates(self):
        offer = {**self.offer, 'guest_count': 2, 'deposit_required_cents': 20000,
                 'per_person': [
                     {'guest_number': 1, 'deposit_cents': 10000},
                     {'guest_number': 2, 'deposit_cents': 10000}]}
        text = owner._styled_quote_copy(self.plan, offer, 'es', create_ready=False)
        self.assertIn('€100 por persona × 2', text)
        # A changed admin rate must follow Staff rather than a hardcoded 100/200.
        offer['deposit_required_cents'] = 24000
        for row in offer['per_person']:
            row['deposit_cents'] = 12000
        text = owner._styled_quote_copy(self.plan, offer, 'es')
        self.assertIn('€120 por persona × 2', text)
        for people in ([], [{'guest_number': 1, 'deposit_cents': 12000}],
                       [{'guest_number': 1, 'deposit_cents': 12000}] * 2):
            offer['per_person'] = people
            text = owner._styled_quote_copy(self.plan, offer, 'es')
            self.assertNotIn('por persona', text)


    def test_same_turn_create_receipt_survives_a_persisted_handoff(self):
        receipt = {'booking_code': 'TEST-RECEIPT', 'amount_due_cents': 10000,
                   'secure_payment_url': 'https://example.invalid/pay/receipt'}
        create = {'role': 'tool', 'content': json.dumps(
            {'tool': 'create_booking_from_plan', 'success': True, **receipt})}
        handoff = {'role': 'tool', 'content': json.dumps(
            {'tool': 'flag_needs_human', 'success': True, 'needs_human': True,
             'handoff_persisted': True, 'handoff_reason': 'extra_unavailable'})}
        readback = {'role': 'tool', 'content': json.dumps({'tool': 'list_my_bookings',
            'lookup_status': 'unavailable', 'prior_create_receipt': receipt})}
        for tools in ([create, handoff], [handoff, create],
                      [create, readback, handoff], [readback, handoff, create]):
            state = {'status': 'completed', 'plan': deepcopy(self.plan),
                     'checked_offer': deepcopy(self.offer), 'completion': receipt}
            result = {'completed': True, 'final_response': 'Draft', 'messages': [
                {'role': 'user', 'content': 'Book and check an extra'}, *deepcopy(tools),
                {'role': 'assistant', 'content': 'Draft'}]}
            with patch.object(owner, '_transaction', side_effect=lambda fn: fn(state, {'MESSAGE_ID': 'test'})):
                output = owner.finalize_offer_response(result)
            text = output['final_response']
            self.assertIn('TEST-RECEIPT', text)
            self.assertIn(receipt['secure_payment_url'], text)
            self.assertIn('team', text)
            self.assertLess(text.index('TEST-RECEIPT'), text.index('team'))
            self.assertNotIn('extra_unavailable', text)
            self.assertEqual(output['messages'][-1]['content'], text)
            self.assertEqual(result['final_response'], 'Draft')

    def test_pure_handoff_does_not_resurface_an_old_receipt(self):
        state = {'status': 'completed', 'plan': self.plan, 'checked_offer': self.offer,
                 'completion': {'booking_code': 'OLD-BOOKING'}, 'guest_language': 'es'}
        result = {'completed': True, 'final_response': 'Draft', 'messages': [
            {'role': 'tool', 'content': json.dumps({'tool': 'create_booking_from_plan', 'success': True})},
            {'role': 'user', 'content': 'Help with another request'},
            {'role': 'tool', 'content': json.dumps({'tool': 'list_my_bookings',
                'lookup_status': 'unavailable', 'prior_create_receipt': {'booking_code': 'OLD-BOOKING'}})},
            {'role': 'tool', 'content': json.dumps({'tool': 'flag_needs_human', 'success': True,
                'needs_human': True, 'handoff_persisted': True})},
            {'role': 'assistant', 'content': 'Draft'}]}
        with patch.object(owner, '_transaction', side_effect=lambda fn: fn(state, {'MESSAGE_ID': 'test'})):
            output = owner.finalize_offer_response(result)
        self.assertEqual(output['final_response'],
                         'Se lo he pasado al equipo para que lo revise. Ellos se encargarán a partir de aquí.')
        self.assertNotIn('OLD-BOOKING', output['final_response'])


    def test_rental_duration_comes_from_staff_item_not_unlabelled_quantity(self):
        offer = {**self.offer, 'add_ons': [{'code': 'wetsuit_rental', 'quantity': 2}],
                 'included_items': [{'code': 'wetsuit_rental', 'quantity': 2, 'days': 3,
                                     'unit_cents': 1000, 'total_cents': 6000}]}
        plan = {**self.plan, 'add_ons': [{'code': 'wetsuit_rental', 'quantity': 2, 'days': 9}]}
        text = owner._styled_quote_copy(plan, offer, 'es')
        self.assertIn('Alquiler de neopreno × 2 durante 3 días', text)
        self.assertNotIn('9 días', text)
        offer['add_ons'] = [{'code': 'wetsuit_rental', 'days': 3}]
        offer.pop('included_items')
        text = owner._styled_quote_copy(self.plan, offer, 'es')
        self.assertIn('durante 3 días', text)
        self.assertNotIn('neopreno ×3', text)


    def test_emphasis_keeps_url_bytes_and_code_fences_literal(self):
        for literal in ('HTTPS://example.invalid/**token**?x=1',
                        'WWW.example.invalid/**token**', 'ftp://example.invalid/**token**',
                        '`unclosed **literal**', '```text\n**literal**',
                        '~~~text\n**literal**\n~~~', '~~~text\n**literal**',
                        '``code **literal**``', r'\*\*literal\*\*'):
            with self.subTest(literal=literal):
                self.assertEqual(owner._whatsapp_emphasis('**Bold** ' + literal), '*Bold* ' + literal)

    def test_model_prose_bold_is_whatsapp_style_without_editing_history_or_urls(self):
        text = 'Llegada **15:00**, **sí**. https://example.invalid/**token** `**literal**`'
        result = {'completed': True, 'final_response': text, 'messages': [
            {'role': 'user', 'content': '**my words**'},
            {'role': 'tool', 'content': '{"raw":"**unchanged**"}'},
            {'role': 'assistant', 'content': text}]}
        original = deepcopy(result)
        with patch.object(owner, '_transaction', side_effect=lambda fn: fn(
                {'status': 'idle'}, {'MESSAGE_ID': 'test', 'tenant': 'wolfhouse-somo'})):
            output = owner.finalize_offer_response(result)
        expected = 'Llegada *15:00*, *sí*. https://example.invalid/**token** `**literal**`'
        self.assertEqual(output['final_response'], expected)
        self.assertEqual(output['messages'][-1]['content'], expected)
        self.assertEqual(output['messages'][:-1], original['messages'][:-1])
        self.assertEqual(result, original)


if __name__ == '__main__':
    unittest.main()
