/**
 * Local E2E prep for 3b.3b — ensure test booking can pass reassign gate in Airtable.
 * Does NOT touch hosted n8n. Requires AIRTABLE_API_TOKEN (env or commented line in infra/.env).
 *
 * Usage:
 *   node scripts/prep-reassign-e2e-airtable.js --record-id=recBtWzIvmjQ5mmo0 --guest-count=3
 */
const fs = require('fs');
const path = require('path');

const BASE_ID = process.env.AIRTABLE_BASE_ID || 'appOCWIN47Bui9CSS';
const BOOKINGS_TABLE = 'tblYWm3zKFafe4qu7';

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
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--record-id=')) recordId = arg.slice('--record-id='.length).trim();
    else if (arg === '--record-id' && argv[i + 1]) recordId = argv[++i].trim();
    else if (arg.startsWith('--guest-count=')) guestCount = Number(arg.slice('--guest-count='.length));
  }
  if (recordId.startsWith('WH-')) recordId = recordId.slice(3);
  return { recordId, guestCount };
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

async function main() {
  const { recordId, guestCount } = parseArgs(process.argv.slice(2));
  if (!recordId) {
    console.error('Usage: node scripts/prep-reassign-e2e-airtable.js --record-id=rec... [--guest-count=3]');
    process.exit(1);
  }
  const token = loadAirtableToken();
  if (!token) {
    console.error('AIRTABLE_API_TOKEN not found (env or infra/.env commented line)');
    process.exit(1);
  }

  const fields = {
    'Assignment Status': 'Assigned',
    'Availability Check Status': 'Available',
  };
  if (guestCount != null && guestCount > 0) fields['Guest Count'] = guestCount;

  const url = `https://api.airtable.com/v0/${BASE_ID}/${BOOKINGS_TABLE}/${recordId}`;
  const updated = await atFetch(url, token, {
    method: 'PATCH',
    body: JSON.stringify({ fields }),
  });

  console.log(`\nPrep reassign E2E — ${recordId}`);
  console.log(`  Assignment Status: ${updated.fields?.['Assignment Status']}`);
  console.log(`  Guest Count:       ${updated.fields?.['Guest Count']}`);
  console.log('  (Booking Beds unchanged — reassign webhook deletes them)');
  console.log(
    '  Tip: pause AT automation "Assign Beds When Booking Is Unassigned" during E2E (race with chained assign).\n'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
