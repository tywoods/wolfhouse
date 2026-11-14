"""Offline Staff wrapper/create and explicit checkout SQL; not owner-turn proof.

The scripted owner yes fixture did not establish checkout admission. These tests
instead exercise real Staff preview/create and explicit checkout with synthetic
incident-shaped terms. No claim of reproducing missing guest financial mapping.
"""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location(
    'incident_finance_proof', ROOT / 'scripts/verify-incident-solo-finance.py')
assert spec is not None and spec.loader is not None
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class IncidentSoloFinanceTests(unittest.TestCase):
    def test_saved_booking_survives_real_helper_projection_sql_failure(self):
        proof.run(1, projection_failure=True)

    def test_solo_staff_create_then_explicit_checkout_sql(self):
        proof.run(1)

    def test_group_staff_create_preserves_financial_mapping_and_draft(self):
        proof.run(3)
