#!/usr/bin/env python3
"""Fix admin interactivity: browser pack defaults, price ids, remove section title."""
from pathlib import Path

ROOT = Path('/opt/wolfhouse/WH')
api = (ROOT / 'scripts/staff-query-api.js').read_text(encoding='utf-8')
tbc = (ROOT / 'scripts/lib/tenant-business-config.js').read_text(encoding='utf-8')

# ── Remove "Packs and Lessons" section header ────────────────────────────────
api = api.replace(
    """    <section class="portal-admin-section" id="admin-sec-times">
      <div class="portal-admin-section-hdr" data-i18n="admin.section.lessonTimes">Packs and Lessons</div>
      <div class="portal-admin-section-body" id="admin-times-body"></div>
    </section>""",
    """    <section class="portal-admin-section" id="admin-sec-times">
      <div class="portal-admin-section-body" id="admin-times-body"></div>
    </section>""",
    1,
)

# ── Browser-side pack defaults (server require not available in /staff/ui JS) ─
BROWSER_PACK_DEFAULTS = """
var ADMIN_DEFAULT_PRICE_TIERS = [
  { key: '1_week', label: 'Price for 1 week (10 hours)', hours: 10, amount_cents: 18000 },
  { key: '2_weeks', label: 'Price for 2 weeks (20 hours)', hours: 20, amount_cents: 33500 },
  { key: '3_weeks', label: 'Price for 3 weeks (30 hours)', hours: 30, amount_cents: 48000 },
  { key: '4_weeks', label: 'Price for 4 weeks (40 hours)', hours: 40, amount_cents: 60000 },
  { key: 'single_class', label: 'Price for 1 single class (2 hours)', hours: 2, amount_cents: 4000 },
];
function adminDefaultPackConfigSeed(){
  return {
    age_band: '12_and_up',
    group_size: 16,
    beaches: ['el_sardinero', 'liencres', 'somo'],
    weekly: 'mon_fri',
    schedules: ['0930_1130', '1215_1415'],
    price_tiers: ADMIN_DEFAULT_PRICE_TIERS.map(function(t){ return Object.assign({}, t); }),
  };
}
"""

if 'ADMIN_DEFAULT_PRICE_TIERS' not in api.split('function adminDefaultPackSeed')[0][-3000:]:
    api = api.replace('function adminDefaultPackSeed(){', BROWSER_PACK_DEFAULTS + '\nfunction adminDefaultPackSeed(){', 1)
    print('OK browser pack defaults')

api = api.replace('  var d = defaultPackConfig();', '  var d = adminDefaultPackConfigSeed();', 1)
api = api.replace('adminRenderPackTierFields(p.price_tiers || DEFAULT_PRICE_TIERS, prefix)',
                  'adminRenderPackTierFields(p.price_tiers || ADMIN_DEFAULT_PRICE_TIERS, prefix)', 1)
api = api.replace('  var tiers = (DEFAULT_PRICE_TIERS || []).map(function(t, idx){',
                  '  var tiers = (ADMIN_DEFAULT_PRICE_TIERS || []).map(function(t, idx){', 1)

# ── Stable price row ids for config-sourced rentals ───────────────────────────
PRICE_ID_FN = """
function adminPriceRowId(p){
  if (p && p.id) return String(p.id);
  var parsed = adminParsePriceRow(p);
  var loc = getClient() === 'sunset' ? getSunsetLocation() : 'default';
  var cat = String((p && p.category) || 'rental');
  var offering = String((p && (p.offering_key || parsed.offeringKey)) || '');
  var unit = String((p && p.unit) || parsed.periodWindow || '');
  return 'cfg:' + loc + ':' + cat + '|' + offering + '|' + unit;
}
"""

if 'function adminPriceRowId' not in api:
    api = api.replace('function adminParsePriceRow(p){', PRICE_ID_FN + '\nfunction adminParsePriceRow(p){', 1)
    print('OK adminPriceRowId')

api = api.replace(
    "        var pid = p.id ? String(p.id) : '';",
    "        var pid = adminPriceRowId(p);",
    1,
)

# Show edit forms whenever group is in edit mode (pid always set via adminPriceRowId)
api = api.replace(
    "        if (groupEditing && pid){",
    "        if (groupEditing){",
    1,
)

# Lesson + pack row ids
api = api.replace(
    "    var sid = s.slot_id ? String(s.slot_id) : '';",
    "    var sid = (s.id || s.slot_id) ? String(s.id || s.slot_id) : '';",
    1,
)
api = api.replace(
    "    var pid = p.pack_id ? String(p.pack_id) : '';",
    "    var pid = (p.pack_id || p.id) ? String(p.pack_id || p.id) : '';",
    1,
)

# Guard renderAdminFromConfig so one section error does not blank the tab
OLD_RENDER = """function renderAdminFromConfig(cfg){
  renderAdminSectionBusinessInfoFromConfig(cfg);
  renderAdminSectionLessonTimesFromConfig(cfg);
  renderAdminSectionPricesFromConfig(cfg);
  renderAdminSectionChangeHistoryFromConfig(cfg);
}"""

NEW_RENDER = """function renderAdminFromConfig(cfg){
  try { renderAdminSectionBusinessInfoFromConfig(cfg); } catch (err) { console.error('admin business render failed', err); }
  try { renderAdminSectionLessonTimesFromConfig(cfg); } catch (err) { console.error('admin lessons render failed', err); }
  try { renderAdminSectionPricesFromConfig(cfg); } catch (err) { console.error('admin prices render failed', err); }
  try { renderAdminSectionChangeHistoryFromConfig(cfg); } catch (err) { console.error('admin history render failed', err); }
}"""

if OLD_RENDER in api:
    api = api.replace(OLD_RENDER, NEW_RENDER, 1)
    print('OK render guards')

(ROOT / 'scripts/staff-query-api.js').write_text(api, encoding='utf-8')

# ── Always attach cfg: price ids in admin config reads ───────────────────────
if 'priceIdFromParts' not in tbc:
    tbc = tbc.replace(
        "const locationStore = require('./sunset-admin-location-store');",
        "const locationStore = require('./sunset-admin-location-store');\nconst { priceIdFromParts } = require('./sunset-admin-location-store');",
    )

OLD_META = """function withLocationMeta(config, locationId) {
  const loc = normalizeSunsetLocationId(locationId);
  return {
    ...config,
    location_id: loc,
    location_label: locationStore.resolveLocationLabel(loc),
  };
}"""

NEW_META = """function withLocationMeta(config, locationId) {
  const loc = normalizeSunsetLocationId(locationId);
  const next = {
    ...config,
    location_id: loc,
    location_label: locationStore.resolveLocationLabel(loc),
  };
  if (next.prices && Array.isArray(next.prices)) {
    next.prices = next.prices.map((p) => {
      if (!p || p.id) return p;
      const category = p.category || 'rental';
      const offeringKey = p.offering_key || p.item_code || '';
      const unit = p.unit || '';
      if (!offeringKey || !unit) return p;
      return { ...p, id: priceIdFromParts(loc, category, offeringKey, unit) };
    });
  }
  return next;
}"""

if 'if (!p || p.id) return p;' not in tbc:
    tbc = tbc.replace(OLD_META, NEW_META, 1)
    print('OK withLocationMeta price ids')

(ROOT / 'scripts/lib/tenant-business-config.js').write_text(tbc, encoding='utf-8')
print('DONE')
