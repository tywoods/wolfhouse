/**
 * Local E2E prep for 3b.2c — reset one test booking in Airtable for assign webhook.
 * Does NOT touch hosted n8n. Requires AIRTABLE_API_TOKEN (env or commented line in infra/.env).
 *
 * Usage:
 *   node scripts/prep-assign-e2e-airtable.js --record-id=recSyn7QcPdVrYa1D
 */
const fs = require('fs');
const path = require('path');

const BASE_ID = process.env.AIRTABLE_BASE_ID || 'appOCWIN47Bui9CSS';
const BOOKINGS_TABLE = 'tblYWm3zKFafe4qu7';
const BOOKING_BEDS_TABLE = 'tblO1ByvTMXS4SalB';

function loadAirtableToken() {
  if (process.env.AIRTABLE_API_TOKEN) return process.env.AIRTABLE_API_TOKEN.trim();
  const envPath = path.join(__dirname, '..', 'infra', '.env');
  if (!fs.existsSync(envPath)) return null;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^#?\s*AIRTABLE_API_TOKEN=(.+)$/);
    if (m) return m[1].trim();
  }
  return null;
}

function parseArgs(argv) {
  let recordId = '';
  let guestCount = null;
  let keepBookingBeds = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--record-id=')) recordId = arg.slice('--record-id='.length).trim();
    else if (arg === '--record-id' && argv[i + 1]) {
      recordId = argv[++i].trim();
    } else if (arg.startsWith('--guest-count=')) {
      guestCount = Number(arg.slice('--guest-count='.length));
    } else if (arg === '--keep-booking-beds') {
      keepBookingBeds = true;
    }
  }
  if (recordId.startsWith('WH-')) recordId = recordId.slice(3);
  return { recordId, guestCount, keepBookingBeds };
}

async function atFetch(url, token, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error?.message || res.statusText);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function listBookingBeds(recordId, token) {
  const formula = encodeURIComponent(`FIND("${recordId}", ARRAYJOIN({Booking}))`);
  const url = `https://api.airtable.com/v0/${BASE_ID}/${BOOKING_BEDS_TABLE}?filterByFormula=${formula}`;
  const rows = [];
  let offset;
  do {
    const pageUrl = offset ? `${url}&offset=${offset}` : url;
    const data = await atFetch(pageUrl, token);
    rows.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return rows;
}

async function main() {
  const { recordId, guestCount, keepBookingBeds } = parseArgs(process.argv.slice(2));
  if (!recordId || !recordId.startsWith('rec')) {
    console.error('Usage: node scripts/prep-assign-e2e-airtable.js --record-id=rec...');
    process.exit(1);
  }
  const token = loadAirtableToken();
  if (!token) {
    console.error('AIRTABLE_API_TOKEN not set (env or infra/.env commented line).');
    process.exit(1);
  }

  const bookingUrl = `https://api.airtable.com/v0/${BASE_ID}/${BOOKINGS_TABLE}/${recordId}`;
  const before = await atFetch(bookingUrl, token);
  const f = before.fields || {};
  console.log('Booking before:', {
    id: recordId,
    'Booking ID': f['Booking ID'],
    Status: f.Status,
    'Assignment Status': f['Assignment Status'],
    'Availability Check Status': f['Availability Check Status'],
    'Guest Count': f['Guest Count'],
    'Check In': f['Check In'],
    'Check Out': f['Check Out'],
  });

  const beds = await listBookingBeds(recordId, token);
  if (keepBookingBeds) {
    console.log(`Keeping ${beds.length} Airtable Booking Bed row(s) (status-only prep).`);
  } else {
    console.log(`Deleting ${beds.length} Airtable Booking Bed row(s)...`);
    for (const bed of beds) {
      await atFetch(
        `https://api.airtable.com/v0/${BASE_ID}/${BOOKING_BEDS_TABLE}/${bed.id}`,
        token,
        { method: 'DELETE' }
      );
      console.log(`  deleted ${bed.id}`);
    }
  }

  const patchFields = {
    'Assignment Status': 'Unassigned',
    'Availability Check Status': 'Not Checked',
  };
  if (guestCount != null && guestCount > 0) patchFields['Guest Count'] = guestCount;
  const patch = await atFetch(bookingUrl, token, {
    method: 'PATCH',
    body: JSON.stringify({ fields: patchFields }),
  });
  const after = patch.fields || {};
  console.log('Booking after:', {
    'Assignment Status': after['Assignment Status'],
    'Availability Check Status': after['Availability Check Status'],
    'Booking Beds': (after['Booking Beds'] || []).length,
  });
  console.log('Ready for assign webhook E2E.');
}

main().catch((err) => {
  console.error(err.message || err);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
