#!/usr/bin/env python3
"""Fix admin portal: time regex, pack form name, rental dropdown width, lesson kind on save."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
API = ROOT / 'scripts' / 'staff-query-api.js'

api = API.read_text(encoding='utf-8')
changed = []

# --- 1) adminParseTimeHm: RegExp constructor (\\d breaks in embedded /staff/ui bundle) ---
TIME_PARSE_OLD = re.compile(
    r"function adminParseTimeHm\(text\)\{\s*"
    r"var t = String\(text \|\| ''\)\.trim\(\);\s*"
    r"if \(!/\^\(\[01\][\\]?d\|2\[0-3\]\):\[0-5\][\\]?d\$/.test\(t\)\)[^}]+\}\s*"
    r"return \{ ok: true, value: t \};\s*\}",
    re.MULTILINE,
)
TIME_PARSE_NEW = """var ADMIN_TIME_HM_RE = new RegExp('^([01]\\\\d|2[0-3]):[0-5]\\\\d$');
function adminParseTimeHm(text){
  var t = String(text || '').trim();
  if (!ADMIN_TIME_HM_RE.test(t)) return { ok: false, error: portalT('admin.edit.timeInvalid') };
  return { ok: true, value: t };
}"""

if 'var ADMIN_TIME_HM_RE' not in api:
    m = TIME_PARSE_OLD.search(api)
    if m:
        api = api[:m.start()] + TIME_PARSE_NEW + api[m.end():]
        changed.append('adminParseTimeHm RegExp fix')
    else:
        raise SystemExit('adminParseTimeHm block not found')

# --- 2) Pack edit form: calls must match adminRenderPackEditForm definition ---
if 'renderAdminPackEditForm(' in api:
    api = api.replace('renderAdminPackEditForm(', 'adminRenderPackEditForm(')
    changed.append('renderAdminPackEditForm call rename')

if 'function renderAdminPackEditForm(' in api and 'function adminRenderPackEditForm(' not in api:
    api = api.replace('function renderAdminPackEditForm(', 'function adminRenderPackEditForm(', 1)
    changed.append('renderAdminPackEditForm def rename')

# --- 3) save-time: read kind from select when present ---
SAVE_TIME_KIND_OLD = "        kind: 'lesson',\n        age_band: ageInput"
SAVE_TIME_KIND_NEW = "        kind: (el('admin-time-kind') ? String(el('admin-time-kind').value || 'lesson') : 'lesson'),\n        age_band: ageInput"
if SAVE_TIME_KIND_OLD in api and SAVE_TIME_KIND_NEW not in api:
    api = api.replace(SAVE_TIME_KIND_OLD, SAVE_TIME_KIND_NEW, 1)
    changed.append('save-time kind input')

# --- 4) save-new-time: accept 200 or 201 ---
api = api.replace(
    "if (res.status !== 201 || !res.data || res.data.success !== true){",
    "if ((res.status !== 201 && res.status !== 200) || !res.data || res.data.success !== true){",
)
if 'save-new-time' in api:
    changed.append('save-new-time status codes')

# --- 5) Rental edit dropdown width: constrain select inside price cards ---
CSS_ANCHOR = '.portal-admin-price-card-edit select,.portal-admin-price-card-edit input{width:100%;'
CSS_NEW = '.portal-admin-price-card,.portal-admin-price-card.is-editing{overflow:hidden;min-width:0}.portal-admin-price-card-edit select,.portal-admin-price-card-edit input{width:100%;max-width:100%;min-width:0;'
if CSS_ANCHOR in api and 'portal-admin-price-card,.portal-admin-price-card.is-editing' not in api:
    api = api.replace(CSS_ANCHOR, CSS_NEW, 1)
    changed.append('rental dropdown CSS')

# Also tighten card grid min width for rental cards
api = api.replace(
    'grid-template-columns:repeat(auto-fill,minmax(148px,1fr))',
    'grid-template-columns:repeat(auto-fill,minmax(132px,1fr))',
)

# Mark editing cards
if 'portal-admin-price-card.is-editing' not in api and "html += '<article class=\"portal-admin-price-card\"" in api:
    api = api.replace(
        "html += '<article class=\"portal-admin-price-card\" data-admin-price-card=\"' + escHtml(pid) + '\">';",
        "html += '<article class=\"portal-admin-price-card' + (groupEditing && pid ? ' is-editing' : '') + '\" data-admin-price-card=\"' + escHtml(pid) + '\">';",
        1,
    )
    changed.append('price card is-editing class')

API.write_text(api, encoding='utf-8')
print('OK', API)
for c in changed:
    print(' -', c)
