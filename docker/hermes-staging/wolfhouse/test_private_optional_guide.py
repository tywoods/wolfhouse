"""Offline source contracts for 11-rooms.md, not live/model behavior proof."""
from pathlib import Path
import re
import unittest


GUIDE = Path(__file__).resolve().parents[1] / "soul-guides" / "11-rooms.md"


class PrivateOptionalGuideTests(unittest.TestCase):
    def setUp(self):
        self.text = " ".join(GUIDE.read_text(encoding="utf-8").split())

    def assert_clauses(self, *clauses):
        for clause in clauses:
            with self.subTest(clause=clause):
                self.assertTrue(clause in self.text, f"Missing guide contract: {clause}")

    def test_canonical_soul_room_section_matches_room_guide(self):
        soul = (GUIDE.parents[1] / "SOUL.md").read_text(encoding="utf-8")
        start = soul.index("## Room preference\n")
        end = soul.index("\n## Changing an existing booking\n", start)
        self.assertEqual(soul[start:end].rstrip(), GUIDE.read_text(encoding="utf-8").rstrip())

    def test_private_selection_uses_staff_inventory_for_any_fitting_party(self):
        self.assert_clauses(
            "Any fitting party, including a solo guest",
            "Private-optional room",
            "whole room is free for every night",
            'room_preference: "private"',
            'selected_selling_mode: "private"',
            "Staff-selected room and beds",
            "protected-room, operator and maintenance restrictions",
            "dedicated-private capacity rules",
            "Never silently substitute shared accommodation",
            "not a promise of R6 or a double bed",
            '**Proactively** suggest it ONLY to a **mixed-gender couple**',
            "Do not proactively suggest a private room to a solo guest",
        )
        for obsolete in (
            "the dedicated private room R6 is free",
            "The private couples room is a 2-guest room",
            "Staff handoff is only when R6 is unavailable",
        ):
            with self.subTest(obsolete=obsolete):
                self.assertNotIn(obsolete, self.text)

    def test_double_and_private_share_staff_tariff_and_exclusive_booking_path(self):
        self.assert_clauses(
            '`double` and `private` use the same canonical private tariff',
            "same private booking path and whole-room blocking",
            "not a double-bed guarantee",
            "once per room/night",
            "real guests only",
            "Never charge fictitious occupants or multiply the supplement by blocked beds",
            "Missing or unreadable private pricing refuses the private quote",
            "explicitly configured zero",
            "successful booking creation, not at quotation",
            "unused beds have no guest invoice, deposit or payment link",
        )

    def test_private_offer_uses_first_yes_without_stale_or_implied_consent(self):
        self.assert_clauses(
            "first explicit acceptance of the displayed, checked private offer",
            "call `create_booking_from_plan` directly",
            "no second save/confirm question",
            "changed room, private/shared mode, price or dates",
            "fresh displayed offer even if the total is unchanged",
            "private-price decline retains the previous shared alternative",
            "does not accept or book either offer",
            "not approval and cannot authorize create or payment",
            "For an explicit private request, skip shared-room gender/composition questions",
        )
        self.assertNotIn('approved the current private re-quote / `couple_private`', self.text)

    def test_room_copy_uses_authoritative_number_and_type_in_lunas_own_words(self):
        self.assert_clauses(
            "Room N",
            "authoritative room type",
            "Luna's own words",
            "shared room",
            "Staff guest ID/number and room identity",
            "keep the room name unknown",
            "never invent room names, bed layout",
        )
        self.assertIsNone(re.search(r"\bdorm(?:s)?\b", self.text, re.I))

    def test_private_only_and_shared_eligibility_remain_distinct(self):
        self.assert_clauses(
            "Private-only rooms never sell spare beds to unrelated guests",
            "Private-optional rooms still sell individual shared beds normally",
            "existing occupants prevent a private sale",
            "Never create or pass name-based gender hints",
            "An accepted mixed/shared room does not require a composition answer",
            "Unknown composition can never become an all-girls or all-guys offer",
            "Never derive or store gender from a name",
            "including a gendered or numbered room request",
            "Do not infer a couple or romantic relationship from two names",
            "If `room_decision` excludes a room, do not offer it",
            "shared default never overrides an explicit room preference",
        )


if __name__ == "__main__":
    unittest.main()
