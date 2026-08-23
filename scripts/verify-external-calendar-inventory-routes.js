'use strict';

const http = require('http');
const extCalRoutes = require('./lib/external-calendar-inventory-routes');

function ok(label, cond, detail) {
  if (!cond) {
    console.error('FAIL', label, detail || '');
    throw new Error(label);
  }
  console.log('  PASS ', label);
}

function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    writeHead(code) { this.statusCode = code; },
    end(s) { this.body = s ? JSON.parse(s) : null; },
  };
}

async function main() {
  console.log('verify-external-calendar-inventory-routes');

  ok('sunset refused', extCalRoutes.refuseClient('sunset').error === 'calendar_bridge_client_not_allowed');
  ok('flag off refuses wolfhouse', extCalRoutes.refuseClient('wolfhouse-somo').error === 'calendar_bridge_disabled');

  process.env.EXTERNAL_CALENDAR_INGEST_ENABLED = 'true';
  ok('flag on allows wolfhouse', extCalRoutes.refuseClient('wolfhouse-somo').ok === true);
  ok('sunset still refused with flag on', extCalRoutes.refuseClient('sunset').ok === false);

  ok('rejects caller maps', extCalRoutes.rejectCallerAuthority({ maps: { a: 1 } }).error === 'caller_authority_rejected');
  ok('rejects caller occupancy', extCalRoutes.rejectCallerAuthority({ occupancy: {} }).error === 'caller_authority_rejected');
  ok('rejects caller connection_id', extCalRoutes.rejectCallerAuthority({ connection_id: 'x' }).error === 'caller_authority_rejected');
  ok('accepts body without authority fields', extCalRoutes.rejectCallerAuthority({ rows: [] }) === null);

  const probe = extCalRoutes.handleProbeFromState(
    { maps: { R1: 'bed' }, rows: [['unit_key', 'start_date', 'end_date', 'status', 'external_uid']] },
    { ok: true, maps: {}, occupancy: {}, connection: { id: 'c1', status: 'pending' } }
  );
  ok('probe rejects caller maps even if dbState present', probe.error === 'caller_authority_rejected');

  const empty = extCalRoutes.handleProbeFromState(
    { rows: [['unit_key', 'start_date', 'end_date', 'status', 'external_uid']] },
    { ok: true, maps: { R1A: 'bed-a' }, occupancy: {}, connection: { id: 'c1', status: 'pending' } }
  );
  ok('empty sheet does not become healthy', empty.next_status === 'pending');
  ok('empty sheet ok but empty', empty.ok === true && empty.empty === true);

  const conflict = extCalRoutes.handleProbeFromState(
    { rows: [
      ['unit_key', 'start_date', 'end_date', 'status', 'external_uid'],
      ['R1A', '2026-09-10', '2026-09-12', 'busy', 'uid-1'],
    ] },
    {
      ok: true,
      maps: { R1A: 'bed-a' },
      occupancy: {
        'bed-a': [{
          assignment_type: 'manual',
          assignment_start_date: '2026-09-10',
          assignment_end_date: '2026-09-12',
          status: 'confirmed',
        }],
      },
      connection: { id: 'c1', status: 'pending' },
    }
  );
  ok('overlap conflict fails whole probe', conflict.ok === false && conflict.keep_last_blocks === true);

  delete process.env.EXTERNAL_CALENDAR_INGEST_ENABLED;
  console.log('\nverify-external-calendar-inventory-routes: ALL CHECKS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
