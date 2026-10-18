"""Dependency-free Sim19 proof for deterministic localized finalizer helpers."""
import unittest

from wolfhouse import accepted_quote as owner


class Sim19LocalizedFinalizerHelperTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
