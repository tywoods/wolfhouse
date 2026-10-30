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
                "Just to confirm, are guests 1 and 2 women?",
                "The requested women-only room is not compatible with the guest details for guests 1 and 2. Would you like to see other room options?",
            ),
            "es": (
                "Solo para confirmar, ¿las personas 1 y 2 son mujeres?",
                "La habitación solicitada solo para mujeres no es compatible con los datos de las personas 1 y 2. ¿Quieres ver otras opciones de habitación?",
            ),
            "fr": (
                "Juste pour confirmer, les personnes 1 et 2 sont-elles des femmes ?",
                "La chambre demandée réservée aux femmes n’est pas compatible avec les informations des personnes 1 et 2. Voulez-vous voir d’autres options de chambre ?",
            ),
            "de": (
                "Nur zur Bestätigung: Sind Gäste 1 und 2 Frauen?",
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
            ["Two beds in the same mixed room."],
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
        self.assertEqual(["Two beds in the same shared room."], lines)
        self.assertNotIn("Alex:", "\n".join(lines))

    def test_partially_named_party_uses_neutral_room_copy_for_same_and_split_rooms(self):
        expected = {
            "en": ("Two beds in the same mixed room.", "Beds in two separate mixed rooms."),
            "es": ("Dos camas en la misma habitación mixta.", "Camas en dos habitaciones mixtas separadas."),
            "fr": ("Deux lits dans la même chambre mixte.", "Lits dans deux chambres mixtes séparées."),
            "de": ("Zwei Betten im selben gemischten Zimmer.", "Betten in zwei getrennten gemischten Zimmern."),
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
            ["Beds in three separate mixed rooms."],
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
            "en": "Jonas and Felix have beds in two separate mixed rooms.",
            "es": "Jonas y Felix tienen camas en dos habitaciones mixtas separadas.",
            "fr": "Jonas et Felix ont des lits dans deux chambres mixtes séparées.",
            "de": "Jonas und Felix haben Betten in zwei getrennten gemischten Zimmern.",
        }
        for language, phrase in expected.items():
            with self.subTest(language=language):
                rendered = "\n".join(owner._guest_room_lines(plan, offer, language))
                self.assertIn(phrase, rendered)
                self.assertNotIn("R4", rendered)
                self.assertNotIn("R5", rendered)
                self.assertNotIn("B1", rendered)

    def test_quote_final_copy_api_is_removed(self):
        self.assertFalse(hasattr(owner, "_final_copy"))

    def test_unresolved_eligibility_refusal_is_localized(self):
        for language in ("en", "es", "fr", "de"):
            with self.subTest(language=language):
                self.assertIsNone(owner._blocked_clarification_copy(
                    {"unavailable": True}, {}, language))

        structured = {"status": "unsure", "requested_room_preference": "female_only",
                      "affected_guest_indices": [1],
                      "question_kind": "confirm_room_eligibility"}
        plan = {"guests": [{"name": "Ana"}, {"name": "Bea"}]}
        expected = {
            "en": "Just to confirm, is Bea a woman?",
            "es": "Solo para confirmar, ¿Bea es mujer?",
            "fr": "Juste pour confirmer, Bea est-elle une femme ?",
            "de": "Nur zur Bestätigung: Ist Bea eine Frau?",
        }
        for language, phrase in expected.items():
            with self.subTest(language=language):
                self.assertEqual(phrase, owner._structured_eligibility_copy(
                    structured, plan, language))
        all_party = {**structured, "affected_guest_indices": [0, 1]}
        self.assertEqual(
            "Just to confirm, are Ana and Bea women?",
            owner._structured_eligibility_copy(all_party, plan, "en"),
        )


if __name__ == "__main__":
    unittest.main()
