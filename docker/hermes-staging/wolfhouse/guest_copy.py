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
MONTHS={'en':['January','February','March','April','May','June','July','August','September','October','November','December'],'de':['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'],'fr':['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'],'it':['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'],'es':['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre']}
def day(value,locale):
 try:
  d=date.fromisoformat(value); l=language(locale); return f'{d.day}. {MONTHS[l][d.month-1]}' if l=='de' else f'{d.day} de {MONTHS[l][d.month-1]}' if l=='es' else f'{d.day} {MONTHS[l][d.month-1]}'
 except (TypeError,ValueError): return ''
