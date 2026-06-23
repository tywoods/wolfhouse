#!/usr/bin/env python3
from pathlib import Path
p = Path('/opt/wolfhouse/WH/scripts/lib/sunset-admin-location-store.js')
text = p.read_text(encoding='utf-8')
if 'deactivateConfigPrice' in text:
    print('already has fn')
    raise SystemExit(0)
fn = """
function deactivateConfigPrice(locationId, category, offeringKey, unit) {
  const loc = normalizeSunsetLocationId(locationId);
  const store = readStoreSync();
  const bucket = ensureLocationBucket(store, loc);
  const key = stablePriceKey(category, offeringKey, unit);
  if (bucket.prices && bucket.prices[key]) {
    bucket.prices[key].active = false;
    writeStoreSync(store);
  }
  return { ok: true, body: { price_rule: { id: priceIdFromParts(loc, category, offeringKey, unit), active: false } } };
}
"""
anchor = 'module.exports = {'
if anchor not in text:
    raise SystemExit('anchor missing')
text = text.replace(anchor, fn + anchor, 1)
text = text.replace('  parseConfigPriceId,', '  parseConfigPriceId,\n  deactivateConfigPrice,', 1)
p.write_text(text, encoding='utf-8')
print('OK added deactivateConfigPrice cleanly')
