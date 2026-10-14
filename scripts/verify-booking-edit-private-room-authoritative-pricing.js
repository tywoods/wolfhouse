'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('./staff-query-api'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert(start >= 0, `${name} exists`);
  const body = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escape = false;
  for (let i = body; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function responseRecorder() {
  return { status: null, body: null };
}

async function runCase({ currentEnabled, requestedEnabled, loaderError = null }) {
  const res = responseRecorder();
  const booking = {
    booking_id: 'booking-1', booking_code: 'WH-TEST', guest_count: 2,
    check_in: '2027-06-01', check_out: '2027-06-08', package_code: 'malibu',
    total_amount_cents: 60000, amount_paid_cents: 0, metadata: {},
  };
  let pgPass = 0;
  let loaderCalls = 0;
  let writeQueries = 0;
  let resolveCalls = 0;
  const pg = {
    async query(sql) {
      const text = String(sql);
      if (text === 'BOOKING') return { rows: [booking] };
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text === 'UPDATE_PRIVATE') {
        writeQueries += 1;
        return { rows: [{ ...booking, total_amount_cents: requestedEnabled ? 67000 : 60000 }] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
  const sandbox = {
    EDIT_PREVIEW_BOOKING_BY_ID_SQL: 'BOOKING',
    EDIT_PREVIEW_BOOKING_BY_CODE_SQL: 'BOOKING',
    EDIT_WRITE_PRIVATE_ROOM_UPDATE_SQL: 'UPDATE_PRIVATE',
    withPgClient: async (fn) => { pgPass += 1; return fn(pg); },
    loadBookingServiceRecords: async () => ({ rows: [] }),
    bookingPrivateRoomEnabled: () => currentEnabled,
    editWritePrivateRoomSnapshot: () => ({ private_room_enabled: currentEnabled }),
    editWritePrivateRoomBookingSummary: (row) => row,
    editWriteInvoiceImpactFromPreview: () => ({}),
    editWriteAttachAuthoritativeQuoteConfig: async (row) => {
      loaderCalls += 1;
      if (loaderError) throw loaderError;
      row._quote_config = { seasons: [{ code: 'summer' }] };
    },
    editWriteResolvePrivateRoomTotals: (row) => {
      resolveCalls += 1;
      assert(row._quote_config, 'changed repricing receives authoritative config');
      return {
        quote: { success: true }, totalCents: requestedEnabled ? 67000 : 60000,
        balanceDue: requestedEnabled ? 67000 : 60000, depositRequired: 10000,
        roomPreference: requestedEnabled ? 'private' : 'shared', requestedRoomType: requestedEnabled ? 'double' : 'shared',
        needsRefund: false,
      };
    },
    editWriteSyncPrivateRoomBedBlocks: async () => ({ blocked_beds: [], removed_blocks: [] }),
    editWritePrivateRoomBedBlockUserMessage: () => null,
    appendAuditLog: () => {},
    send400: (_res, error) => { res.status = 400; res.body = { error }; return res.body; },
    sendJSON: (_res, status, body) => { res.status = status; res.body = body; return body; },
    Date,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction('handleBookingEditWritePrivateRoom')}; this.handler = handleBookingEditWritePrivateRoom;`, sandbox);
  await sandbox.handler(
    res, { private_room_enabled: requestedEnabled },
    { reason: 'test', idempotency_key: 'test-key' }, Date.now(), 'tester',
    'wolfhouse-somo', 'booking-1', 'WH-TEST',
  );
  return { res, loaderCalls, writeQueries, resolveCalls, pgPass };
}

(async () => {
  const unchanged = await runCase({ currentEnabled: true, requestedEnabled: true });
  assert.equal(unchanged.res.status, 200);
  assert.equal(unchanged.res.body.idempotent, true);
  assert.equal(unchanged.loaderCalls, 0, 'idempotent shortcut performs no Pricing read');
  assert.equal(unchanged.writeQueries, 0);

  for (const [currentEnabled, requestedEnabled] of [[false, true], [true, false]]) {
    const changed = await runCase({ currentEnabled, requestedEnabled });
    assert.equal(changed.res.status, 200, JSON.stringify(changed.res.body));
    assert.equal(changed.loaderCalls, 1, 'changed private-room write loads Pricing once');
    assert.equal(changed.resolveCalls, 1);
    assert.equal(changed.writeQueries, 1);
  }

  const unavailable = await runCase({
    currentEnabled: false,
    requestedEnabled: true,
    loaderError: new Error('synthetic Pricing outage'),
  });
  assert.equal(unavailable.loaderCalls, 1);
  assert.equal(unavailable.writeQueries, 0, 'Pricing failure performs no booking write');
  assert.equal(unavailable.resolveCalls, 0, 'Pricing failure cannot reprice from bundled config');
  assert.equal(unavailable.res.body.updated, false);

  console.log('booking edit private-room authoritative Pricing: idempotent, enable, disable, failure/no-write PASS');
})().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
