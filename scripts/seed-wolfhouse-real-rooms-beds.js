/**
 * Stage 29room-a — Seed real Wolfhouse rooms/beds into local/staging PG.
 *
 * Sources (auto): Airtable API when configured, else Airtable CSV exports in database/.
 * Idempotent upsert by room_code / bed_code. Does not touch bookings, payments, or WhatsApp.
 *
 * Usage:
 *   node scripts/seed-wolfhouse-real-rooms-beds.js --client wolfhouse-somo
 *   node scripts/seed-wolfhouse-real-rooms-beds.js --client wolfhouse-somo --dry-run
 *   node scripts/seed-wolfhouse-real-rooms-beds.js --source csv
 */

'use strict';

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const { withPgClient } = require('./lib/pg-connect');
const {
  assertNotProductionDb,
  defaultConnectionString,
  trimStr,
} = require('./lib/open-demo-playground-common');

const ROOT = path.join(__dirname, '..');
const DEFAULT_CLIENT = 'wolfhouse-somo';
const ROOMS_CSV = path.join(ROOT, 'database', 'Rooms-Grid view.csv');
const BEDS_CSV = path.join(ROOT, 'database', 'Beds-Grid view.csv');
const EXAMPLE_FIXTURE = path.join(ROOT, 'fixtures', 'wolfhouse-real-rooms-beds.example.json');

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'appOCWIN47Bui9CSS';
const AIRTABLE_ROOMS_TABLE = process.env.AIRTABLE_ROOMS_TABLE_ID || 'tblrNdFnxdQvEnPuj';
const AIRTABLE_BEDS_TABLE = process.env.AIRTABLE_BEDS_TABLE_ID || 'tblEkF4SG4TLaNmW4';

function parseArgs(argv) {
  const opts = {
    client: DEFAULT_CLIENT,
    dryRun: false,
    source: 'auto',
    dbUrl: null,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--client') opts.client = argv[++i];
    else if (a === '--source') opts.source = argv[++i];
    else if (a === '--db-url') opts.dbUrl = argv[++i];
    else if (a.startsWith('--client=')) opts.client = a.slice('--client='.length);
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

function usage() {
  console.log(`Usage: node scripts/seed-wolfhouse-real-rooms-beds.js [options]

Options:
  --client <slug>   Client slug (default wolfhouse-somo)
  --source auto|airtable|csv   Data source (default auto)
  --dry-run         Parse + validate only; no DB writes
  --db-url <url>    Override database URL
  --help            Show help`);
}

function loadAirtableToken() {
  if (process.env.AIRTABLE_API_TOKEN) return process.env.AIRTABLE_API_TOKEN.trim();
  const envPath = path.join(ROOT, 'infra', '.env');
  if (!fs.existsSync(envPath)) return null;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^#?\s*AIRTABLE_API_TOKEN=(.+)$/);
    if (m) return m[1].trim();
  }
  return null;
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cols = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { cols.push(cur); cur = ''; }
      else cur += ch;
    }
    cols.push(cur);
    const row = {};
    headers.forEach((h, i) => { row[h.trim()] = (cols[i] || '').trim(); });
    return row;
  });
}

function boolChecked(v) {
  return v === 'checked' || v === true || v === 'true';
}

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function mapRoomFromCsv(row) {
  const roomCode = trimStr(row['Room ID']);
  if (!roomCode) return null;
  return {
    airtable_record_id: null,
    room_code: roomCode,
    name: trimStr(row['Room Name']) || null,
    house: trimStr(row.House) || null,
    room_type: trimStr(row['Room Type']) || null,
    capacity: numOr(row.Capacity, 0),
    fill_priority: numOr(row['Fill Priority'], 50),
    private_priority: numOr(row['Private Priority'], 50),
    gender_strategy: trimStr(row['Gender Strategy']) || 'Flexible',
    can_be_matrimonial: boolChecked(row['Can be Matrimonial']),
    often_used_by_operator: boolChecked(row['Often used By Operator']),
    sort_order: row['Room Sort / Round Robin Order'] ? numOr(row['Room Sort / Round Robin Order'], null) : null,
    avoid_until_needed: boolChecked(row['Avoid Until Needed']),
    active: boolChecked(row.Active),
    notes: trimStr(row.Notes) || null,
  };
}

function mapBedFromCsv(row) {
  const bedCode = trimStr(row['Bed ID']);
  const roomCode = trimStr(row['Room ID']);
  if (!bedCode || !roomCode) return null;
  const sellable = boolChecked(row.Sellable)
    || (bedCode === 'R3-B1' && boolChecked(row.Active));
  return {
    airtable_record_id: null,
    bed_code: bedCode,
    room_code: roomCode,
    bed_number: row['Bed Number'] ? numOr(row['Bed Number'], null) : null,
    bed_label: trimStr(row['Bed Label']) || null,
    planning_row_label: trimStr(row['Planning Row Label']) || null,
    active: boolChecked(row.Active),
    sellable,
    notes: trimStr(row.Notes) || null,
  };
}

function mapRoomFromAirtable(rec) {
  const f = rec.fields || {};
  const roomCode = trimStr(f['Room ID']);
  if (!roomCode) return null;
  return {
    airtable_record_id: rec.id,
    room_code: roomCode,
    name: trimStr(f['Room Name']) || null,
    house: trimStr(f.House) || null,
    room_type: trimStr(f['Room Type']) || null,
    capacity: numOr(f.Capacity, 0),
    fill_priority: numOr(f['Fill Priority'], 50),
    private_priority: numOr(f['Private Priority'], 50),
    gender_strategy: trimStr(f['Gender Strategy']) || 'Flexible',
    can_be_matrimonial: boolChecked(f['Can be Matrimonial']),
    often_used_by_operator: boolChecked(f['Often used By Operator']),
    sort_order: f['Room Sort / Round Robin Order'] != null
      ? numOr(f['Room Sort / Round Robin Order'], null) : null,
    avoid_until_needed: boolChecked(f['Avoid Until Needed']),
    active: boolChecked(f.Active),
    notes: trimStr(f.Notes) || null,
  };
}

function mapBedFromAirtable(rec) {
  const f = rec.fields || {};
  const bedCode = trimStr(f['Bed ID']);
  const roomCode = trimStr(f['Room ID']);
  if (!bedCode || !roomCode) return null;
  const sellable = boolChecked(f.Sellable)
    || (bedCode === 'R3-B1' && boolChecked(f.Active));
  return {
    airtable_record_id: rec.id,
    bed_code: bedCode,
    room_code: roomCode,
    bed_number: f['Bed Number'] != null ? numOr(f['Bed Number'], null) : null,
    bed_label: trimStr(f['Bed Label']) || null,
    planning_row_label: trimStr(f['Planning Row Label']) || null,
    active: boolChecked(f.Active),
    sellable,
    notes: trimStr(f.Notes) || null,
  };
}

async function fetchAirtableTable(tableId, token) {
  const records = [];
  let offset = null;
  do {
    const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableId}`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error?.message || res.statusText);
      err.status = res.status;
      throw err;
    }
    records.push(...(body.records || []));
    offset = body.offset || null;
  } while (offset);
  return records;
}

async function loadSourceData(opts) {
  const skipped = [];
  let source = opts.source;
  const token = loadAirtableToken();

  if (source === 'auto' || source === 'airtable') {
    if (token) {
      try {
        const roomRecs = await fetchAirtableTable(AIRTABLE_ROOMS_TABLE, token);
        const bedRecs = await fetchAirtableTable(AIRTABLE_BEDS_TABLE, token);
        const rooms = roomRecs.map(mapRoomFromAirtable).filter(Boolean);
        const beds = bedRecs.map(mapBedFromAirtable).filter(Boolean);
        return {
          source: 'airtable',
          rooms,
          beds,
          skipped,
          airtable_access: true,
          fields_mapped: [
            'Room ID', 'Room Name', 'House', 'Room Type', 'Capacity',
            'Fill Priority', 'Private Priority', 'Gender Strategy',
            'Can be Matrimonial', 'Often used By Operator', 'Active',
            'Room Sort / Round Robin Order', 'Avoid Until Needed',
            'Bed ID', 'Bed Number', 'Bed Label', 'Active', 'Sellable',
            'Planning Row Label',
          ],
        };
      } catch (err) {
        if (source === 'airtable') throw err;
        skipped.push(`airtable_fetch_failed: ${err.message}`);
      }
    } else {
      skipped.push('AIRTABLE_API_TOKEN_missing');
      if (source === 'airtable') {
        return {
          source: 'none',
          rooms: [],
          beds: [],
          skipped,
          airtable_access: false,
          partial_env: ['AIRTABLE_API_TOKEN', 'AIRTABLE_BASE_ID', 'AIRTABLE_ROOMS_TABLE_ID', 'AIRTABLE_BEDS_TABLE_ID'],
        };
      }
    }
  }

  if (fs.existsSync(ROOMS_CSV) && fs.existsSync(BEDS_CSV)) {
    const rooms = parseCsv(fs.readFileSync(ROOMS_CSV, 'utf8')).map(mapRoomFromCsv).filter(Boolean);
    const beds = parseCsv(fs.readFileSync(BEDS_CSV, 'utf8')).map(mapBedFromCsv).filter(Boolean);
    return {
      source: 'csv_export',
      rooms,
      beds,
      skipped,
      airtable_access: !!token,
      fields_mapped: [
        'Room ID', 'Fill Priority', 'Private Priority', 'Gender Strategy',
        'Often used By Operator', 'Active', 'Bed ID', 'Sellable',
      ],
    };
  }

  skipped.push('csv_exports_missing');
  return {
    source: 'none',
    rooms: [],
    beds: [],
    skipped,
    airtable_access: false,
    partial_env: ['AIRTABLE_API_TOKEN or database/Rooms-Grid view.csv + Beds-Grid view.csv'],
  };
}

async function upsertRooms(pg, clientId, rooms) {
  let upserted = 0;
  for (const room of rooms) {
    await pg.query(
      `INSERT INTO rooms (
         client_id, airtable_record_id, room_code, name, house, room_type,
         capacity, fill_priority, private_priority, gender_strategy,
         can_be_matrimonial, often_used_by_operator, sort_order,
         avoid_until_needed, active, notes
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $11, $12, $13,
         $14, $15, $16
       )
       ON CONFLICT (client_id, room_code) DO UPDATE SET
         airtable_record_id = COALESCE(EXCLUDED.airtable_record_id, rooms.airtable_record_id),
         name = EXCLUDED.name,
         house = EXCLUDED.house,
         room_type = EXCLUDED.room_type,
         capacity = EXCLUDED.capacity,
         fill_priority = EXCLUDED.fill_priority,
         private_priority = EXCLUDED.private_priority,
         gender_strategy = EXCLUDED.gender_strategy,
         can_be_matrimonial = EXCLUDED.can_be_matrimonial,
         often_used_by_operator = EXCLUDED.often_used_by_operator,
         sort_order = EXCLUDED.sort_order,
         avoid_until_needed = EXCLUDED.avoid_until_needed,
         active = EXCLUDED.active,
         notes = EXCLUDED.notes,
         updated_at = NOW()`,
      [
        clientId,
        room.airtable_record_id,
        room.room_code,
        room.name,
        room.house,
        room.room_type,
        room.capacity,
        room.fill_priority,
        room.private_priority,
        room.gender_strategy,
        room.can_be_matrimonial,
        room.often_used_by_operator,
        room.sort_order,
        room.avoid_until_needed,
        room.active,
        room.notes,
      ],
    );
    upserted++;
  }
  return upserted;
}

async function upsertBeds(pg, clientId, beds) {
  let upserted = 0;
  const skipped = [];
  for (const bed of beds) {
    const roomRes = await pg.query(
      `SELECT id FROM rooms WHERE client_id = $1 AND room_code = $2`,
      [clientId, bed.room_code],
    );
    if (!roomRes.rows[0]) {
      skipped.push({ bed_code: bed.bed_code, reason: `room_not_found:${bed.room_code}` });
      continue;
    }
    await pg.query(
      `INSERT INTO beds (
         client_id, room_id, airtable_record_id, bed_code, bed_number,
         bed_label, planning_row_label, active, sellable, notes
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9, $10
       )
       ON CONFLICT (client_id, bed_code) DO UPDATE SET
         room_id = EXCLUDED.room_id,
         airtable_record_id = COALESCE(EXCLUDED.airtable_record_id, beds.airtable_record_id),
         bed_number = EXCLUDED.bed_number,
         bed_label = EXCLUDED.bed_label,
         planning_row_label = EXCLUDED.planning_row_label,
         active = EXCLUDED.active,
         sellable = EXCLUDED.sellable,
         notes = EXCLUDED.notes,
         updated_at = NOW()`,
      [
        clientId,
        roomRes.rows[0].id,
        bed.airtable_record_id,
        bed.bed_code,
        bed.bed_number,
        bed.bed_label,
        bed.planning_row_label,
        bed.active,
        bed.sellable,
        bed.notes,
      ],
    );
    upserted++;
  }
  return { upserted, skipped };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    usage();
    process.exit(0);
  }

  const dbUrl = opts.dbUrl || defaultConnectionString();
  try {
    assertNotProductionDb(dbUrl);
  } catch (err) {
    console.error(`FAIL — ${err.message}`);
    process.exit(1);
  }

  const clientExplicit = process.argv.some((a) => a === '--client' || a.startsWith('--client='));
  if (opts.client !== DEFAULT_CLIENT && !clientExplicit) {
    console.error(`FAIL — client slug must be ${DEFAULT_CLIENT} unless --client is explicitly passed`);
    process.exit(1);
  }

  const data = await loadSourceData(opts);
  const operatorRooms = data.rooms.filter((r) => r.often_used_by_operator).map((r) => r.room_code);
  const priorities = data.rooms.map((r) => r.fill_priority).filter((n) => Number.isFinite(n));
  const priorityRange = priorities.length
    ? { min: Math.min(...priorities), max: Math.max(...priorities) }
    : null;

  const summary = {
    result: data.rooms.length ? 'PASS' : 'PARTIAL',
    client: opts.client,
    source: data.source,
    airtable_access: data.airtable_access === true,
    fields_mapped: data.fields_mapped || [],
    rooms_upserted: 0,
    beds_upserted: 0,
    operator_blocked_rooms: operatorRooms,
    operator_blocked_beds_count: data.beds.filter((b) => operatorRooms.includes(b.room_code)).length,
    fill_priority_range: priorityRange,
    skipped: data.skipped,
    bed_skipped: [],
    dry_run: opts.dryRun,
  };

  if (!data.rooms.length) {
    console.log(JSON.stringify(summary, null, 2));
    console.error('\nPARTIAL — no room/bed source data. Configure AIRTABLE_API_TOKEN or commit CSV exports.');
    if (fs.existsSync(EXAMPLE_FIXTURE)) {
      console.error(`See template: ${path.relative(ROOT, EXAMPLE_FIXTURE)}`);
    }
    process.exit(0);
  }

  if (opts.dryRun) {
    summary.rooms_upserted = data.rooms.length;
    summary.beds_upserted = data.beds.length;
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }

  await withPgClient(async (pg) => {
    const clientRes = await pg.query('SELECT id::text FROM clients WHERE slug = $1', [opts.client]);
    if (!clientRes.rows[0]) {
      throw new Error(`client_not_found:${opts.client}`);
    }
    const clientId = clientRes.rows[0].id;
    summary.rooms_upserted = await upsertRooms(pg, clientId, data.rooms);
    const bedOut = await upsertBeds(pg, clientId, data.beds);
    summary.beds_upserted = bedOut.upserted;
    summary.bed_skipped = bedOut.skipped;
  }, { connectionString: dbUrl });

  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nSeeded ${summary.rooms_upserted} rooms, ${summary.beds_upserted} beds (${summary.source})`);
  if (summary.operator_blocked_rooms.length) {
    console.log(`Operator-often rooms: ${summary.operator_blocked_rooms.join(', ')}`);
  }
  if (summary.fill_priority_range) {
    console.log(`Fill priority range: ${summary.fill_priority_range.min}–${summary.fill_priority_range.max}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
