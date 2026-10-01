'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const {
  catalogRevisionFor,
  projectCatalogueRows,
  settingsRevisionFor,
  suggestedPolicy,
} = require('./lib/staff-room-fill-policy');
const { createRoomFillRoutes } = require('./lib/staff-room-fill-routes');

const ROOT = path.resolve(__dirname, '..');
const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const B1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01';
const B2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02';
const B3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccc01';

function catalogueRows() {
  return [
    row(R1, 'R1', B1, 1),
    row(R1, 'R1', B2, 2),
    row(R2, 'R2', B3, 1),
  ];
}

function row(roomId, code, bedId, bedNumber) {
  return {
    room_id: roomId,
    room_code: code,
    room_name: code,
    house: 'somo',
    room_type: 'mixed',
    capacity: 2,
    room_active: true,
    gender_strategy: 'mixed',
    can_be_matrimonial: false,
    often_used_by_operator: false,
    bed_id: bedId,
    bed_code: `${code}-B${bedNumber}`,
    bed_number: bedNumber,
    bed_active: true,
    bed_sellable: true,
  };
}

function makeState() {
  return {
    slug: 'wolfhouse-somo',
    settings: { luna_intelligence: false, other_flag: 'keep-me' },
    catalogue: catalogueRows(),
    occupancy: [],
    writes: [],
    sql: [],
  };
}

function pgFor(state) {
  return {
    async query(sql, params) {
      const text = String(sql);
      state.sql.push(text);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('room-fill-client')) {
        if (params[0] !== CLIENT) return { rows: [] };
        return { rows: [{ id: CLIENT, slug: state.slug, settings: state.settings }] };
      }
      if (text.includes('room-fill-catalogue')) {
        return { rows: state.catalogue };
      }
      if (text.includes('room-fill-occupancy')) {
        return { rows: state.occupancy };
      }
      if (text.includes('room-fill-save')) {
        const policy = JSON.parse(params[1]);
        state.settings = { ...state.settings, luna_room_fill_policy: policy };
        state.writes.push(text);
        return { rows: [{ id: CLIENT, slug: state.slug, settings: state.settings }] };
      }
      throw new Error(`unexpected sql: ${text.slice(0, 80)}`);
    },
  };
}

function harness(state) {
  const sent = [];
  const routes = createRoomFillRoutes({
    sendJSON(_res, status, body) {
      sent.push({ status, body });
      return { status, body };
    },
    readBody(req) {
      return Promise.resolve(req.bodyText || '');
    },
    withPgClient(fn) {
      return fn(pgFor(state));
    },
    appendAuditLog(entry) {
      state.audit = entry;
    },
  });
  return { routes, sent };
}

const wolf = { client_id: CLIENT, client_slug: 'wolfhouse-somo', staff_user_id: 'staff-1' };
const sunset = { client_id: CLIENT, client_slug: 'sunset', staff_user_id: 'staff-2' };

function roomsFrom(state) {
  return projectCatalogueRows(state.catalogue).rooms;
}

test('sunset is refused and the research flag is not read as a hotel control', async () => {
  const state = makeState();
  state.slug = 'sunset';
  const { routes, sent } = harness(state);
  await routes.handleRoomFillGet({}, {}, {}, sunset);
  assert.equal(sent[0].status, 403);
  assert.equal(sent[0].body.error, 'unsupported_tenant');
  assert.equal(sent[0].body.activationStatus, 'not_connected');
  assert.equal(state.writes.length, 0);
  assert.equal(state.sql.some((sql) => sql.includes('room-fill-catalogue')), false);
});

test('get returns a suggested order and does not invent a saved policy', async () => {
  const state = makeState();
  const { routes, sent } = harness(state);
  await routes.handleRoomFillGet({}, {}, {}, wolf);
  assert.equal(sent[0].status, 200);
  assert.equal(sent[0].body.activationStatus, 'not_connected');
  assert.equal(sent[0].body.policyStatus, 'not_configured');
  assert.equal(sent[0].body.policy, null);
  assert.deepEqual(sent[0].body.suggestedPolicy.roomPriority, [R1, R2]);
  assert.equal(state.settings.luna_intelligence, false);
});

test('save writes only the room-fill key and leaves research untouched', async () => {
  const state = makeState();
  const rooms = roomsFrom(state);
  const policy = { ...suggestedPolicy(rooms), fillMode: 'room', roomPrioritySource: 'custom', roomPriority: [R2, R1] };
  const { routes, sent } = harness(state);
  await routes.handleRoomFillPut({}, {
    headers: { host: 'staff.test', origin: 'https://staff.test' },
    bodyText: JSON.stringify({
      ...policy,
      expectedSettingsRevision: null,
      expectedCatalogRevision: catalogRevisionFor(rooms),
    }),
  }, {}, wolf);
  assert.equal(sent[0].status, 200);
  assert.equal(sent[0].body.policy.fillMode, 'room');
  assert.equal(state.settings.luna_intelligence, false);
  assert.equal(state.settings.other_flag, 'keep-me');
  assert.equal(state.settings.luna_room_fill_policy.fillMode, 'room');
  assert.equal(state.writes.length, 1);
  assert.match(state.writes[0], /jsonb_set\(COALESCE\(settings, '\{\}'::jsonb\), '\{luna_room_fill_policy\}'/);
  assert.equal(state.audit.action, 'luna_room_fill_policy_save');
  assert.equal(state.sql.some((sql) => /INSERT|DELETE|booking_beds|UPDATE bookings/i.test(sql) && !sql.includes('room-fill-save')), false);
});

test('a stale revision does not write', async () => {
  const state = makeState();
  const rooms = roomsFrom(state);
  const policy = suggestedPolicy(rooms);
  state.settings.luna_room_fill_policy = policy;
  const { routes, sent } = harness(state);
  await routes.handleRoomFillPut({}, {
    headers: { host: 'staff.test', origin: 'https://staff.test' },
    bodyText: JSON.stringify({
      ...policy,
      fillMode: 'room',
      roomPrioritySource: 'custom',
      expectedSettingsRevision: 'stale',
      expectedCatalogRevision: catalogRevisionFor(rooms),
    }),
  }, {}, wolf);
  assert.equal(sent[0].status, 409);
  assert.equal(sent[0].body.error, 'settings_conflict');
  assert.equal(state.writes.length, 0);
  assert.equal(state.settings.luna_room_fill_policy.fillMode, 'house');
});

test('preview is read-only and does not create a reservation', async () => {
  const state = makeState();
  const rooms = roomsFrom(state);
  const draft = { ...suggestedPolicy(rooms), fillMode: 'room', roomPrioritySource: 'custom', roomPriority: [R2, R1] };
  const { routes, sent } = harness(state);
  await routes.handleRoomFillPreview({}, {
    headers: { host: 'staff.test', origin: 'https://staff.test' },
    bodyText: JSON.stringify({
      policySource: 'draft',
      expectedCatalogRevision: catalogRevisionFor(rooms),
      draftPolicy: draft,
      checkIn: '2026-10-10',
      checkOut: '2026-10-11',
      partySize: 1,
      groupGender: 'unknown',
    }),
  }, {}, wolf);
  assert.equal(sent[0].status, 200);
  assert.equal(sent[0].body.reservationCreated, false);
  assert.equal(sent[0].body.decision.reservationCreated, false);
  assert.equal(sent[0].body.decision.selected[0].roomId, R2);
  assert.equal(sent[0].body.activationStatus, 'not_connected');
  assert.equal(state.writes.length, 0);
  assert.equal(state.settings.luna_room_fill_policy, undefined);
});

test('saved preview refuses a missing policy and a foreign origin', async () => {
  const state = makeState();
  const rooms = roomsFrom(state);
  const { routes, sent } = harness(state);
  await routes.handleRoomFillPreview({}, {
    headers: { host: 'staff.test', origin: 'https://evil.test' },
    bodyText: JSON.stringify({ policySource: 'saved', expectedCatalogRevision: catalogRevisionFor(rooms) }),
  }, {}, wolf);
  assert.equal(sent[0].status, 403);
  assert.equal(sent[0].body.error, 'forbidden_origin');
  await routes.handleRoomFillPreview({}, {
    headers: { host: 'staff.test', origin: 'https://staff.test' },
    bodyText: JSON.stringify({
      policySource: 'saved',
      expectedCatalogRevision: catalogRevisionFor(rooms),
      expectedSettingsRevision: null,
    }),
  }, {}, wolf);
  assert.equal(sent[1].status, 422);
  assert.equal(sent[1].body.error, 'policy_not_configured');
});

test('router keeps research auth and does not let the caller name a tenant', () => {
  const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  const preview = api.indexOf("pathname === ROOM_FILL_PREVIEW_PATH && method === 'POST'");
  const put = api.indexOf("pathname === ROOM_FILL_PATH && method === 'PUT'");
  const get = api.indexOf("pathname === ROOM_FILL_PATH && method === 'GET'");
  assert.ok(preview > 0 && put > preview && get > put);
  for (const start of [preview, put, get]) {
    const slice = api.slice(start, start + 280);
    assert.match(slice, /requireAuth\(req, res, 'operator'\)/);
    assert.doesNotMatch(slice, /parsed\.query\.client|body\.client_id|body\.slug/);
  }
  assert.match(api, /pathname === LUNA_INTELLIGENCE_PATH && method === 'PUT'/);
  assert.match(api, /id="staff-luna-intelligence-toggle"/);
  assert.match(api, /id="staff-room-fill" hidden/);
  assert.match(api, /\/\* INJECT:staff-room-fill \*\//);
  const browser = fs.readFileSync(path.join(__dirname, 'browser', 'staff-room-fill.js'), 'utf8');
  assert.match(browser, /Settings and preview only — not connected to booking placement\./);
  assert.doesNotMatch(browser, />\s*(Book|Reserve)\s*</);
  assert.doesNotMatch(browser, /textContent = ['"]Book['"]|textContent = ['"]Reserve['"]/);
  const diff = execFileSync('git', ['diff', '--unified=0', 'github/master', '--', 'scripts/lib/luna-bed-allocator.js'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.match(diff, /^\+  roomEligibleForGroup,$/m);
  assert.equal((diff.match(/^\+[^+]/gm) || []).length, 1);
  assert.equal(settingsRevisionFor(suggestedPolicy(roomsFrom(makeState()))).length, 64);
});
