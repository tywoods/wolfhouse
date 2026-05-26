/**
 * Generates database/seeds/001_wolfhouse_seed.sql from database/*.csv exports.
 * Run: node scripts/generate-seed.js
 */
const fs = require('fs');
const path = require('path');

const dbDir = path.join(__dirname, '..', 'database');
const outPath = path.join(dbDir, 'seeds', '001_wolfhouse_seed.sql');

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cols = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQ = !inQ;
        continue;
      }
      if (ch === ',' && !inQ) {
        cols.push(cur);
        cur = '';
      } else cur += ch;
    }
    cols.push(cur);
    const row = {};
    headers.forEach((h, i) => {
      row[h.trim()] = (cols[i] || '').trim();
    });
    return row;
  });
}

function sqlStr(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function boolChecked(v) {
  return v === 'checked' ? 'TRUE' : 'FALSE';
}

const rooms = parseCsv(fs.readFileSync(path.join(dbDir, 'Rooms-Grid view.csv'), 'utf8'));
const beds = parseCsv(fs.readFileSync(path.join(dbDir, 'Beds-Grid view.csv'), 'utf8'));

const lines = [];
lines.push('-- Wolfhouse Somo seed — generated from Airtable CSV exports');
lines.push('-- Re-run: node scripts/generate-seed.js');
lines.push('BEGIN;');
lines.push('');
lines.push(`INSERT INTO clients (id, slug, name, timezone, currency, settings)`);
lines.push(`VALUES (`);
lines.push(`  'a0000000-0000-4000-8000-000000000001',`);
lines.push(`  'wolfhouse-somo',`);
lines.push(`  'Wolfhouse Surf Camp Somo',`);
lines.push(`  'Europe/Madrid',`);
lines.push(`  'EUR',`);
lines.push(`  '{"website":"https://www.wolf-house.com/surfcampsomo","airtable_base_id":"appOCWIN47Bui9CSS"}'::jsonb`);
lines.push(`) ON CONFLICT (slug) DO NOTHING;`);
lines.push('');
lines.push(`INSERT INTO packages (client_id, code, name, deposit_amount_cents, metadata)`);
lines.push(`SELECT id, v.code, v.name, v.deposit, '{}'::jsonb`);
lines.push(`FROM clients, (VALUES`);
lines.push(`  ('malibu', 'Malibu', 20000),`);
lines.push(`  ('uluwatu', 'Uluwatu', 20000),`);
lines.push(`  ('waimea', 'Waimea', 20000),`);
lines.push(`  ('custom', 'Custom', NULL)`);
lines.push(`) AS v(code, name, deposit)`);
lines.push(`WHERE clients.slug = 'wolfhouse-somo'`);
lines.push(`ON CONFLICT (client_id, code) DO NOTHING;`);
lines.push('');

for (const r of rooms) {
  if (!r['Room ID']) continue;
  lines.push(
    `INSERT INTO rooms (client_id, room_code, capacity, fill_priority, private_priority, gender_strategy, can_be_matrimonial, often_used_by_operator, active, room_type)` +
      ` SELECT id, ${sqlStr(r['Room ID'])}, ${Number(r.Capacity) || 0}, ${Number(r['Fill Priority']) || 50}, ${Number(r['Private Priority']) || 50}, ${sqlStr(r['Gender Strategy'] || 'Flexible')}, ${boolChecked(r['Can be Matrimonial'])}, ${boolChecked(r['Often used By Operator'])}, ${boolChecked(r.Active)}, ${sqlStr(r['Room Type'] || null)}` +
      ` FROM clients WHERE slug = 'wolfhouse-somo' ON CONFLICT (client_id, room_code) DO NOTHING;`
  );
}

lines.push('');

for (const b of beds) {
  if (!b['Bed ID']) continue;
  const sellable =
    b.Sellable === 'checked' ||
    (b['Bed ID'] === 'R3-B1' && b.Active === 'checked');
  lines.push(
    `INSERT INTO beds (client_id, room_id, bed_code, bed_number, bed_label, planning_row_label, active, sellable)` +
      ` SELECT c.id, r.id, ${sqlStr(b['Bed ID'])}, ${Number(b['Bed Number']) || 'NULL'}, ${sqlStr(b['Bed Label'])}, ${sqlStr(b['Planning Row Label'])}, ${boolChecked(b.Active)}, ${sellable ? 'TRUE' : 'FALSE'}` +
      ` FROM clients c JOIN rooms r ON r.client_id = c.id AND r.room_code = ${sqlStr(b['Room ID'])}` +
      ` WHERE c.slug = 'wolfhouse-somo' ON CONFLICT (client_id, bed_code) DO NOTHING;`
  );
}

lines.push('');
lines.push('-- Bookings/conversations/messages: import via db:sync');
lines.push('COMMIT;');
lines.push('');

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join('\n'));
console.log('Wrote', outPath);
