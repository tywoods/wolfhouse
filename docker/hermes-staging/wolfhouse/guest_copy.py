import json
from datetime import date
from pathlib import Path
ROOT=Path(__file__).parent
def load():
 d=json.loads((ROOT/'guest_copy.json').read_text()); required=json.loads((ROOT/'guest_copy_manifest.json').read_text())['required_keys']
 for locale,copy in d['locales'].items():
  if set(copy)!=set(required): raise ValueError(f'incomplete guest copy: {locale}')
 return d['locales']
def language(value):
 key=str(value or '').strip().lower().replace('_','-').split('-')[0]; return key if key in load() else 'en'
def copy(value): return load()[language(value)]
def money(cents,locale):
 if type(cents) is not int: return ''
 amount=str(cents//100) if cents%100==0 else f'{cents/100:.2f}'; return f'€{amount}' if language(locale)=='en' else f"{amount.replace('.', ',')} €"
def day(value,locale):
 try: return date.fromisoformat(value).strftime('%-d. %B' if language(locale)=='de' else '%B %-d')
 except (TypeError,ValueError): return ''
