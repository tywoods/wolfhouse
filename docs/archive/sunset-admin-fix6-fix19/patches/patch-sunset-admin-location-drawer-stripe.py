#!/usr/bin/env python3
"""Pass school location into admin config resolver from drawer/stripe."""
from pathlib import Path

ROOT = Path('/opt/wolfhouse/WH')

for rel, old, new in [
    (
        'scripts/lib/sunset-schedule-booking-drawer.js',
        '  const adminCfg = await resolveTenantBusinessConfigAsync(clientSlug, { pgClient: pg });',
        '  const adminCfg = await resolveTenantBusinessConfigAsync(clientSlug, { pgClient: pg, locationId: activeLocationId });',
    ),
    (
        'scripts/lib/sunset-stripe-payment-links.js',
        """async function priceSunsetBookingServices(pg, clientSlug, bookingId) {
  const adminCfg = await resolveTenantBusinessConfigAsync(clientSlug, { pgClient: pg });""",
        """async function priceSunsetBookingServices(pg, clientSlug, bookingId) {
  const bookingLocRes = await pg.query(
    `SELECT metadata FROM bookings b INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND b.id = $2::uuid LIMIT 1`,
    [clientSlug, bookingId],
  );
  const bookingMeta = bookingLocRes.rows[0] && bookingLocRes.rows[0].metadata
    ? (typeof bookingLocRes.rows[0].metadata === 'object'
      ? bookingLocRes.rows[0].metadata
      : JSON.parse(bookingLocRes.rows[0].metadata))
    : {};
  const { normalizeSunsetLocationId, resolveRecordLocationId } = require('./sunset-school-locations');
  const locationId = resolveRecordLocationId({}, bookingMeta);
  const adminCfg = await resolveTenantBusinessConfigAsync(clientSlug, { pgClient: pg, locationId });""",
    ),
]:
    p = ROOT / rel
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'anchor missing in {rel}')
    p.write_text(text.replace(old, new, 1))
    print(f'OK {rel}')
