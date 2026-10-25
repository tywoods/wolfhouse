#!/usr/bin/env python3
"""Offline structural gates for the Cap runner (never substitutes a live run)."""
import ast, importlib.util, pathlib, unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
RUNNER=ROOT/'scripts/run-luna-v3-rendered-reply-matrix.py'
ROUTE=ROOT/'docker/hermes-luna-v3/runtime/simulator_route.py'
PLUGIN=ROOT/'docker/hermes-luna-v3/plugins/luna_v3_staff_api/__init__.py'
class Gates(unittest.TestCase):
 def test_sources_parse(self):
  for p in (RUNNER,ROUTE,PLUGIN): ast.parse(p.read_text())
 def test_no_caller_inventory_or_retry(self):
  s=RUNNER.read_text(); self.assertNotIn('LUNA_MATRIX_INVENTORY',s); self.assertIn('"no_retries":True',s); self.assertIn('REPS=3',s)
 def test_artifact_and_verdict_contract(self):
  s=RUNNER.read_text()
  for x in ('manifest.json','results.json','SHA256SUMS','reply_equals_final_response','staff_fields_rendered_exactly','no_hold_or_booking_for_quote','one_prepare_per_turn','first_refusal_then_success'): self.assertIn(x,s)
 def test_harness_gates_and_fault_isolation(self):
  route=ROUTE.read_text(); plugin=PLUGIN.read_text()
  self.assertIn('_harness_trace_allowed(request)',route); self.assertIn('trace_allowed else ""',route)
  self.assertIn('A genuine authenticated Staff response has crossed the boundary',plugin)
  for x in ('non-json','malformed','timeout'): self.assertIn(x,route); self.assertIn(x,plugin)
 def test_continuation_is_opaque_bound_and_one_use(self):
  s=ROUTE.read_text(); self.assertIn('token_urlsafe(32)',s); self.assertIn('_CONTINUATIONS.pop',s); self.assertIn('captured["phone"] != phone',s)
 def test_pins_and_preflight(self):
  s=ROUTE.read_text()
  for x in ('image_digest','base_image_digest','instruction_sha256','plugin_sha256','contract_sha256','fallback_possible'): self.assertIn(x,s)
if __name__=='__main__': unittest.main(verbosity=2)
