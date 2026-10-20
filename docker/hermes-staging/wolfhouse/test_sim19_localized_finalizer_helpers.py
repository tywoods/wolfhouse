"""Dependency-free Sim19 proof for deterministic localized finalizer helpers."""
import unittest

from wolfhouse import accepted_quote as owner
from wolfhouse import output_guard


class Sim19LocalizedFinalizerHelperTests(unittest.TestCase):
    def test_partial_multi_guest_eligibility_uses_plural_localized_scope(self):
        eligibility = {
            "requested_room_preference": "female_only",
            "affected_guest_indices": [0, 1],
            "question_kind": "confirm_room_eligibility",
        }
        plan = {"guests": [{"name": ""}, {"name": ""}, {"name": "Cara"}]}
        expected = {
            "en": (
                "Are guests 1 and 2 eligible for the requested women-only room?",
                "The requested women-only room is not compatible with the guest details for guests 1 and 2. Would you like to see other room options?",
            ),
            "es": (
                "¿Pueden las personas 1 y 2 alojarse en la habitación solicitada solo para mujeres?",
                "La habitación solicitada solo para mujeres no es compatible con los datos de las personas 1 y 2. ¿Quieres ver otras opciones de habitación?",
            ),
            "fr": (
                "Les personnes 1 et 2 peuvent-elles séjourner dans la chambre demandée réservée aux femmes ?",
                "La chambre demandée réservée aux femmes n’est pas compatible avec les informations des personnes 1 et 2. Voulez-vous voir d’autres options de chambre ?",
            ),
            "de": (
                "Können Gäste 1 und 2 im gewünschten Frauenzimmer übernachten?",
                "Das gewünschte Frauenzimmer ist mit den Angaben zu den Gästen 1 und 2 nicht vereinbar. Möchten Sie andere Zimmeroptionen sehen?",
            ),
        }
        for language, copies in expected.items():
            for status, text in zip(("unsure", "no"), copies):
                with self.subTest(language=language, status=status):
                    eligibility["status"] = status
                    self.assertEqual(text, owner._structured_eligibility_copy(eligibility, plan, language))

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
        self.assertEqual(["two beds in the same shared room."], lines)
        self.assertNotIn("Alex:", "\n".join(lines))

    def test_partially_named_party_uses_neutral_room_copy_for_same_and_split_rooms(self):
        expected = {
            "en": ("two beds in the same mixed room.", "beds in two separate mixed rooms."),
            "es": ("dos camas en la misma habitación mixta.", "camas en dos habitaciones mixtas separadas."),
            "fr": ("deux lits dans la même chambre mixte.", "lits dans deux chambres mixtes séparées."),
            "de": ("zwei Betten im selben gemischten Zimmer.", "Betten in zwei getrennten gemischten Zimmern."),
        }
        for language, (same_copy, split_copy) in expected.items():
            for split, phrase in ((False, same_copy), (True, split_copy)):
                with self.subTest(language=language, split=split):
                    plan = {"guests": [{"name": "Alex"}, {"name": ""}]}
                    offer = {
                        "room_arrangement": [
                            {"bed_code": "M1", "room_code": "M1" if split else "M", "room_type": "shared", "gender_strategy": "mixed"},
                            {"bed_code": "M2", "room_code": "M2" if split else "M", "room_type": "shared", "gender_strategy": "mixed"},
                        ],
                        "guest_bed_assignments": [
                            {"guest_index": 0, "guest_name": "Alex", "bed_code": "M1"},
                            {"guest_index": 1, "guest_name": "", "bed_code": "M2"},
                        ],
                    }
                    rendered = owner._guest_room_lines(plan, offer, language)
                    self.assertEqual([phrase], rendered)
                    self.assertNotIn("Alex", "\n".join(rendered))

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

        structured = {"status": "unsure", "requested_room_preference": "female_only",
                      "affected_guest_indices": [1],
                      "question_kind": "confirm_room_eligibility"}
        plan = {"guests": [{"name": "Ana"}, {"name": "Bea"}]}
        expected = {
            "en": "Is Bea eligible for the requested women-only room?",
            "es": "¿Puede Bea alojarse en la habitación solicitada solo para mujeres?",
            "fr": "Est-ce que Bea peut séjourner dans la chambre demandée réservée aux femmes ?",
            "de": "Kann Bea im gewünschten Frauenzimmer übernachten?",
        }
        for language, phrase in expected.items():
            with self.subTest(language=language):
                self.assertEqual(phrase, owner._structured_eligibility_copy(
                    structured, plan, language))
        all_party = {**structured, "affected_guest_indices": [0, 1]}
        self.assertEqual(
            "Are all guests eligible for the requested women-only room?",
            owner._structured_eligibility_copy(all_party, plan, "en"),
        )


if __name__ == "__main__":
    unittest.main()
