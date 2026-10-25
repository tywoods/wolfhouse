#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { Client } = require('pg');

const iso = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const monthDay = d => (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
const inRange = (md, r) => {
  const start = Number(r.start_month) * 100 + Number(r.start_day);
  const end = Number(r.end_month) * 100 + Number(r.end_day);
  return start <= end ? md >= start && md <= end : md >= start || md <= end;
};

async function main() {
  const url = process.env.LUNA_CAP_FIXTURE_DATABASE_URL;
  const output = process.env.LUNA_CAP_FIXTURE_METADATA;
  const anchorText = process.env.LUNA_CAP_DATE_ANCHOR;
  if (!url || !/^postgres(?:ql)?:\/\/[^@]+@(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/wh_mig_[a-z0-9_]+$/i.test(url)) throw new Error('fixture refuses non-loopback or non-ephemeral database URL');
  if (!output || !anchorText || !Number.isFinite(Date.parse(anchorText))) throw new Error('metadata path and deterministic date anchor required');
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query(fs.readFileSync('database/seeds/001_wolfhouse_seed.sql', 'utf8'));
    const seasonRows = (await db.query(`
      SELECT s.code,s.label,s.priority,r.start_month,r.start_day,r.end_month,r.end_day
      FROM wh_pricing_seasons s JOIN wh_pricing_season_ranges r ON r.season_id=s.id
      WHERE s.client_slug=$1 AND r.client_slug=$1 AND s.active AND s.bookable
      ORDER BY s.priority DESC,r.sort_order,s.code`, ['wolfhouse-somo'])).rows;
    const rules = (await db.query(`SELECT item_type,item_code,season_code,unit,amount_cents,currency FROM wh_pricing_rules WHERE client_slug=$1 AND active ORDER BY item_type,item_code,season_code NULLS FIRST`, ['wolfhouse-somo'])).rows;
    const items = (await db.query(`SELECT item_type,item_code,label,metadata FROM wh_pricing_items WHERE client_slug=$1 AND active ORDER BY item_type,item_code`, ['wolfhouse-somo'])).rows;
    if (!seasonRows.length || !rules.length) throw new Error('canonical seed did not create active Staff season ranges and pricing rules');
    const minimums = items.filter(x => x.item_type === 'package').map(x => Number(x.metadata?.minimum_nights || x.metadata?.min_nights || 0)).filter(Number.isFinite);
    const minimumNights = Math.max(2, ...minimums);
    let checkIn = new Date(Date.parse(anchorText));
    checkIn = new Date(Date.UTC(checkIn.getUTCFullYear() + 1, checkIn.getUTCMonth(), checkIn.getUTCDate()));
    let selected;
    for (let offset = 0; offset < 732; offset += 1) {
      const candidate = addDays(checkIn, offset);
      const out = addDays(candidate, minimumNights);
      const season = seasonRows.find(r => inRange(monthDay(candidate), r) && inRange(monthDay(addDays(out, -1)), r));
      const priced = season && rules.some(r => r.item_type === 'package' && (!r.season_code || r.season_code === season.code));
      if (priced) { selected = { candidate, out, season }; break; }
    }
    if (!selected) throw new Error('could not derive a valid quote interval from Staff season ranges/pricing rules');
    const invalidOut = addDays(selected.candidate, minimumNights - 1);
    const metadata = {
      schema: 'luna-v3-cap-fixture/v2', tenant: 'wolfhouse-somo', anchor: anchorText,
      derivation: {
        source: 'Staff canonical seed queried after migrations',
        rule: 'first future interval wholly inside the highest-priority active bookable season with an active package price; refusal is one night below Staff package minimum',
        season_code: selected.season.code, season_label: selected.season.label, minimum_nights: minimumNights,
        queried_tables: ['wh_pricing_seasons','wh_pricing_season_ranges','wh_pricing_items','wh_pricing_rules']
      },
      valid_dates: { check_in: iso(selected.candidate), check_out: iso(selected.out), nights: minimumNights },
      invalid_dates: { check_in: iso(selected.candidate), check_out: iso(invalidOut), nights: minimumNights - 1 },
      active_item_counts: Object.fromEntries([...new Set(items.map(x => x.item_type))].sort().map(k => [k, items.filter(x => x.item_type === k).length])),
      pricing_rule_count: rules.length
    };
    fs.writeFileSync(output, JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
  } finally { await db.end(); }
}
main().catch(e => { console.error(e.stack || e); process.exit(1); });
