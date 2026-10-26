import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PLUGIN = ROOT / "__init__.py"


class PublicOneTrySelectionTests(unittest.TestCase):
    def plugin(self):
        spec = importlib.util.spec_from_file_location("luna_v3_staff_api_b1", PLUGIN)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def schemas(self):
        rows = {}
        self.plugin().register(type("Context", (), {"register_tool": lambda _self, **kw: rows.__setitem__(kw["name"], kw["schema"])})())
        return rows

    def test_retired_booking_and_recovery_tools_are_not_registered(self):
        schemas = self.schemas()
        self.assertIn("check_quote_book", schemas)
        for retired in ("check_availability", "find_rooms", "get_pricing_catalog", "quote", "hold_beds", "book", "release_hold", "recover_operation"):
            self.assertNotIn(retired, schemas)

    def test_one_try_schema_keeps_internal_identifiers_out(self):
        params = self.schemas()["check_quote_book"]["parameters"]
        self.assertEqual(["action"], params["required"])
        self.assertEqual(["prepare", "confirm", "decline"], params["properties"]["action"]["enum"])
        for internal in ("operation_key", "hold_id", "booking_id", "room_id", "bed_ids"):
            self.assertNotIn(internal, params["properties"])

    def test_soul_requires_one_prepare_and_one_distinct_confirm(self):
        soul = (ROOT.parent.parent / "SOUL.md").read_text()
        for phrase in (
            "`check_quote_book` is the only model-visible booking transaction path",
            "call `check_quote_book` once with `action=prepare`",
            "presented in a prior assistant turn",
            "call `check_quote_book` once with `action=confirm`",
            "Do not retry, repair, recover",
            "price, total or quote",
            "purpose=quote",
            "does not create a hold",
            "asks to book and all offer facts are complete",
            "create the held offer",
            "ask once for explicit confirmation",
            "Staff capability snapshot",
        ):
            self.assertIn(phrase, soul)


if __name__ == "__main__":
    unittest.main()
