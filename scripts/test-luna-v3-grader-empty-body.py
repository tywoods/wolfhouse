#!/usr/bin/env python3
"""Ruling #6: empty HTTP entity bytes are present evidence, not absent capture."""
import copy,json,pathlib,sys,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts/lib'))
from luna_v3_grader_test_support import produce
from luna_v3_receipt_binding import boundary_consistent

class EmptyBodyRuling(unittest.TestCase):
 def test_already_invalid_originals_cross_actual_plugin_and_remain_bound(self):
  authority={'tenant_id':'wolfhouse-somo','session_id':'luna-v3:ruling','external_send_allowed':False,'staff_alert_allowed':False}
  for status in (200,422,500):
   for original in (b'',b'{broken',b'null',b'[]',b'0'):
    with self.subTest(status=status,original=original):
     call,result,exchange=produce({'action':'prepare'},raw=original,status=status,event_id='ruling-event',session=authority['session_id'],fault='timeout')
     self.assertEqual(exchange['original_response_hex'],original.hex())
     self.assertEqual(exchange['raw_response_hex'],original.hex())
     self.assertTrue(boundary_consistent(call,result,exchange,'ruling-event',authority))
     for field in ('original_response_hex','raw_response_hex'):
      absent=copy.deepcopy(exchange);absent.pop(field)
      self.assertFalse(boundary_consistent(call,result,absent,'ruling-event',authority),field)
     for mutant in ({**result,'ok':True},{**result,'booked':True},{**result,'paid':True}):
      self.assertFalse(boundary_consistent(call,mutant,exchange,'ruling-event',authority))
 def test_empty_original_and_nonempty_effective_timeout_is_impossible(self):
  call,result,exchange=produce({'action':'prepare'},raw=b'',event_id='ruling-event',fault='timeout')
  exchange['raw_response_hex']=b'{}'.hex()
  self.assertFalse(boundary_consistent(call,result,exchange,'ruling-event'))

if __name__=='__main__':unittest.main(verbosity=2)
