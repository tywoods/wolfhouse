import unittest
from guest_copy import load,language,money,day
class GuestCopyTest(unittest.TestCase):
 def test_complete(self):
  expected={'stay_summary','save_confirm_solo','save_confirm_group','payment_split','name_ask','handoff','apology','fallback'}
  self.assertEqual(set(load()),{'en','de','fr','it','es'})
  for value in load().values(): self.assertEqual(set(value),expected)
 def test_formats(self): self.assertEqual(language(' de-DE '),'de');self.assertEqual(money(76850,'de'),'768,50 €');self.assertEqual(day('2026-12-14','de'),'14. Dezember')
if __name__=='__main__': unittest.main()
