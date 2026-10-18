"""Dependency-free Sim19 proof for deterministic localized finalizer helpers."""
import unittest

from wolfhouse import accepted_quote as owner
from wolfhouse import output_guard


class Sim19LocalizedFinalizerHelperTests(unittest.TestCase):
    def test_two_unnamed_guests_in_one_room_render_without_crashing(self):
        plan = {
            "guest_count": 2,
            "guests": [{"name": ""}, {"name": ""}],
            "selected_bed_codes": ["R4-B1", "R4-B2"],
        }
        offer = {
            "room_type": "shared",
            "room_arrangement": [
                {"room_code": "R4", "bed_code": "R4-B1", "gender_strategy": "mixed"},
                {"room_code": "R4", "bed_code": "R4-B2", "gender_strategy": "mixed"},
            ],
        }
        self.assertEqual(
            ["two beds in the same mixed room."],
            owner._guest_room_lines(plan, offer, "en"),
        )

    def test_named_guest_discloses_unnamed_guests_bed_without_inventing_a_name(self):
        plan = {"guests": [{"name": "Alex"}, {"name": ""}]}
        offer = {
            "room_arrangement": [
                {"bed_code": "M1", "room_code": "M", "room_type": "mixed"},
                {"bed_code": "M2", "room_code": "M", "room_type": "mixed"},
            ],
            "guest_bed_assignments": [
                {"guest_index": 0, "guest_name": "Alex", "bed_code": "M1"},
                {"guest_index": 1, "guest_name": "", "bed_code": "M2"},
            ],
        }
        lines = owner._guest_room_lines(plan, offer, "en")
        self.assertEqual(["Alex: two beds in the same room."], lines)

    def test_three_unnamed_guests_in_three_rooms_still_render(self):
        plan = {
            "guest_count": 3,
            "guests": [{"name": ""}, {"name": ""}, {"name": ""}],
            "selected_bed_codes": ["R4-B1", "R5-B1", "R6-B1"],
        }
        offer = {
            "room_type": "shared",
            "room_arrangement": [
                {"room_code": code[:2], "bed_code": code, "gender_strategy": "mixed"}
                for code in plan["selected_bed_codes"]
            ],
        }
        self.assertEqual(
            ["beds in three separate mixed rooms."],
            owner._guest_room_lines(plan, offer, "en"),
        )

    def test_reused_language_detector_recognizes_french_german_and_italian(self):
        cases = {
            "Bonjour, je voudrais réserver une chambre pour deux personnes.": "fr",
            "Hallo, ich möchte ein Zimmer für zwei Personen buchen.": "de",
            "Ciao, vorrei prenotare una camera per due persone.": "it",
        }
        for opening, expected in cases.items():
            with self.subTest(language=expected):
                self.assertEqual(
                    expected,
                    output_guard._guest_lang_from_history(
                        [{"role": "user", "content": opening}]
                    ),
                )

    def test_split_room_copy_is_localized_and_hides_internal_codes(self):
        plan = {
            "guest_count": 2,
            "guests": [{"name": "Jonas"}, {"name": "Felix"}],
            "selected_bed_codes": ["R4-B1", "R5-B1"],
        }
        offer = {
            "room_type": "shared",
            "room_arrangement": [
                {"room_code": "R4", "bed_code": "R4-B1", "gender_strategy": "mixed"},
                {"room_code": "R5", "bed_code": "R5-B1", "gender_strategy": "mixed"},
            ],
        }
        expected = {
            "en": "Jonas and Felix: beds in two separate mixed rooms.",
            "es": "Jonas y Felix: camas en dos habitaciones mixtas separadas.",
            "fr": "Jonas et Felix : lits dans deux chambres mixtes séparées.",
            "de": "Jonas und Felix: Betten in zwei getrennten gemischten Zimmern.",
        }
        for language, phrase in expected.items():
            with self.subTest(language=language):
                rendered = "\n".join(owner._guest_room_lines(plan, offer, language))
                self.assertIn(phrase, rendered)
                self.assertNotIn("R4", rendered)
                self.assertNotIn("R5", rendered)
                self.assertNotIn("B1", rendered)

    def test_authoritative_finalizer_labels_are_localized(self):
        expected = {
            "en": ("Total", "Shall I create this booking?"),
            "es": ("Total", "¿Creo esta reserva?"),
            "fr": ("Total", "Voulez-vous que je crée cette réservation ?"),
            "de": ("Gesamtpreis", "Soll ich diese Buchung erstellen?"),
        }
        for language, (total_label, question) in expected.items():
            with self.subTest(language=language):
                self.assertEqual(total_label, owner._final_copy(language, "total"))
                self.assertEqual(question, owner._final_copy(language, "create"))

    def test_unresolved_eligibility_refusal_is_localized(self):
        expected = {
            "en": "I could not verify an eligible bed for this stay yet. Would you like me to check another room option?",
            "es": "No pude verificar aún una cama apta para esta estancia. ¿Quieres que compruebe otra opción de habitación?",
            "fr": "Je n'ai pas encore pu vérifier de lit admissible pour ce séjour. Voulez-vous que je vérifie une autre option de chambre ?",
            "de": "Ich konnte noch kein geeignetes Bett für diesen Aufenthalt bestätigen. Soll ich eine andere Zimmeroption prüfen?",
        }
        for language, phrase in expected.items():
            with self.subTest(language=language):
                self.assertEqual(phrase, owner._final_copy(language, "refusal"))

        cases = {
            "Is the guest a woman?": {
                "en": "Is the guest a woman?",
                "es": "¿Es la huésped una mujer?",
                "fr": "La personne est-elle une femme ?",
                "de": "Ist der Gast eine Frau?",
            },
            "Are both guests women?": {
                "en": "Are both guests women?",
                "es": "¿Son mujeres las dos huéspedes?",
                "fr": "Les deux personnes sont-elles des femmes ?",
                "de": "Sind beide Gäste Frauen?",
            },
            "Are all three guests girls?": {
                "en": "Are all three guests girls?",
                "es": "¿Son mujeres las tres huéspedes?",
                "fr": "Les trois personnes sont-elles des femmes ?",
                "de": "Sind alle drei Gäste Frauen?",
            },
            "Are both guests not women?": {
                "en": "Are both guests not women?",
                "es": "¿No son mujeres las dos huéspedes?",
                "fr": "Les deux personnes ne sont-elles pas des femmes ?",
                "de": "Sind nicht beide Gäste Frauen?",
            },
        }
        for question, translations in cases.items():
            for language, expected in translations.items():
                with self.subTest(question=question, language=language):
                    self.assertEqual(
                        expected,
                        owner._localized_eligibility_question(question, language),
                    )


if __name__ == "__main__":
    unittest.main()
