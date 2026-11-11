'use strict';
// Offline regression for the lifecycle POST: malformed kinds never reach INSERT.
const assert = require('node:assert/strict');
const { createStaffSupervisorRoutes } = require('./lib/staff-supervisor-routes');
const { LIFECYCLE_STATES } = require('./lib/luna-supervisor-audit');
const actorId = '00000000-0000-4000-8000-000000000001';
const eventId = '00000000-0000-4000-8000-000000000002';
const conversationId = '00000000-0000-4000-8000-000000000003';
const before = process.env.LUNA_SUPERVISOR_STAFF_USER_ID;
process.env.LUNA_SUPERVISOR_STAFF_USER_ID = actorId;
(async () => {
  const inserts = [], audits = [];
  const routes = createStaffSupervisorRoutes({
    supervisorStaffUserId: actorId,
    sendJSON: (res, status, body) => Object.assign(res, { status, body }),
    appendAuditLog: entry => audits.push(entry),
    withPgClient: fn => fn({ query: async (sql, values) => {
      if (/INSERT INTO supervisor_lifecycle/.test(sql)) {
        assert.ok(LIFECYCLE_STATES.has(values[1]), 'invalid kind reached INSERT');
        inserts.push(values);
        return { rows: [], rowCount: 1 };
      }
      assert.match(sql, /SELECT .*supervisor_events/s);
      return { rows: [{ id: eventId, conversation_id: conversationId }], rowCount: 1 };
    } }),
  });
  const user = { staff_user_id: actorId, role: 'admin', client_slug: 'wolfhouse-somo' };
  for (const kind of [undefined, null, '', 'handed_to_human']) {
    const res = {};
    await routes.handleLifecycle({}, res, user, eventId, { kind, payload: {} });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.recorded, false);
    assert.equal(res.body.error, 'invalid_lifecycle_kind');
  }
  assert.equal(inserts.length, 0);
  assert.equal(audits.length, 0);
  for (const kind of LIFECYCLE_STATES) {
    const res = {};
    await routes.handleLifecycle({}, res, user, eventId, { kind, payload: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.recorded, true);
    assert.equal(inserts.at(-1)[1], kind);
  }
  assert.equal(inserts.length, LIFECYCLE_STATES.size);
  assert.equal(audits.length, LIFECYCLE_STATES.size);
  console.log('PASS item5: lifecycle route rejects missing/invalid kinds before INSERT; supported kinds still record and audit');
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => {
  if (before === undefined) delete process.env.LUNA_SUPERVISOR_STAFF_USER_ID;
  else process.env.LUNA_SUPERVISOR_STAFF_USER_ID = before;
});
