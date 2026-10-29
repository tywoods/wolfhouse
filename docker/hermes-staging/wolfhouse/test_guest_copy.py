import unittest
from guest_copy import load,language,money
class GuestCopyTest(unittest.TestCase):
 def test_complete(self): self.assertEqual(set(load()),{'en','de','fr','it','es'})
 def test_formats(self): self.assertEqual(language(' de-DE '),'de');self.assertEqual(money(76850,'de'),'768,50 €')
if __name__=='__main__': unittest.main()
