import unittest
from guest_copy import load,language,money,day
from pathlib import Path
import json
class GuestCopyTest(unittest.TestCase):
 def test_complete(self):
  expected=set(json.loads((Path(__file__).with_name('guest_copy_manifest.json')).read_text())['required_keys'])
  required={'confirmation_hello_named','confirmation_nights_one','confirmation_room_mixed','confirmation_paid_headline','quote_final_create','quote_style_save','pending_payment_amount_question','pending_go_ahead_question'}
  self.assertTrue(required <= expected)
  self.assertEqual(set(load()),{'en','de','fr','it','es'})
  for value in load().values(): self.assertEqual(set(value),expected)
  self.assertIn('{name}',load()['en']['confirmation_hello_named'])
 def test_formats(self): self.assertEqual(language(' de-DE '),'de');self.assertEqual(money(76850,'de'),'768,50 €');self.assertEqual(day('2026-12-14','de'),'14. Dezember')
if __name__=='__main__': unittest.main()
