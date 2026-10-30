import unittest
from .guest_copy import load,language,money,day
from pathlib import Path
import json
class GuestCopyTest(unittest.TestCase):
 def test_complete(self):
  expected=set(json.loads((Path(__file__).with_name('guest_copy_manifest.json')).read_text())['required_keys'])
  required={'confirmation_hello_named','confirmation_nights_one','confirmation_room_mixed','confirmation_paid_headline','quote_style_save','quote_style_opener_group','quote_style_deposit_choice_group','quote_style_save_group','quote_style_save_updated_group'}
  self.assertTrue(required <= expected)
  self.assertEqual(set(load()),{'en','de','fr','it','es'})
  for value in load().values(): self.assertEqual(set(value),expected)
  self.assertIn('{name}',load()['en']['confirmation_hello_named'])
 def test_formats(self): self.assertEqual(language(' de-DE '),'de');self.assertEqual(money(76850,'de'),'768,50 €');self.assertEqual(day('2026-12-14','de'),'14. Dezember')
 def test_native_register_contract(self):
  copy=load()
  self.assertEqual(copy['fr']['stay_summary'],'Votre séjour à Somo 🌊')
  self.assertEqual(copy['fr']['confirmation_room_fallback'],'Votre chambre')
  self.assertIn('vous',copy['fr']['fallback'].lower())
  self.assertEqual(copy['de']['quote_style_saved_anon'],'Deine Buchung ist bei uns eingetragen! 🌊')
  self.assertEqual(copy['de']['quote_style_shuttle_choice'],'Ist ein Flughafentransfer gewünscht?')
  for locale in ('de','fr','it','es'):
   self.assertNotRegex(copy[locale]['quote_style_shuttle_choice'],r'\b(du|ihr|hai|avete|necesitas|necesitáis)\b')
  self.assertEqual(copy['de']['quote_style_shuttle_choice_solo'],'Brauchst du einen Flughafentransfer?')
  self.assertEqual(copy['de']['quote_style_shuttle_choice_group'],'Braucht ihr einen Flughafentransfer?')
  self.assertTrue(copy['fr']['save_confirm_solo'].startswith('Est-ce que je confirme votre'))
  self.assertNotIn('reserva está guardada',copy['es']['quote_style_saved'])
  self.assertNotIn('prenotazione è salvata',copy['it']['quote_style_saved'])
  self.assertIn('Potete',copy['it']['quote_style_deposit_choice_group'])
  self.assertIn('Podéis',copy['es']['quote_style_deposit_choice_group'])

  self.assertNotRegex(copy['it']['quote_style_deposit_choice'],r'\b(Puoi|preferisci|tuo)\b')
  self.assertNotRegex(copy['es']['quote_style_deposit_choice'],r'\b(Puedes|prefieres|tu)\b')
  self.assertNotIn('Hier ist euer Aufenthalt',copy['de']['quote_style_opener_group'])
  for locale in copy.values():
   self.assertFalse(any(key.startswith('quote_final_') or key.startswith('pending_') for key in locale))
  self.assertEqual(copy['it']['confirmation_shuttlePickup'],'prelievo previsto il {date}')
if __name__=='__main__': unittest.main()
