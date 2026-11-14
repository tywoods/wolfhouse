'use strict';

// Real Staff handlers write the supervisor completion from the database
// receipt. Route requests carry no before/after. A pair planted on the
// completion payload must not become the audit row.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');
const { createRequire } = require('node:module');
const {
  createMemorySupervisorStore,
  normalizeSupervisorCompletionReceipt,
  shouldRecordSupervisorCompletion,
  supervisorAuditIdentity,
  retainFailedSupervisorAudit,
  projectSupervisorAudit,
} = require('./lib/staff-supervisor-events');
const { handleContactIdentity } = require('./lib/luna-contact-identity');

const apiPath = path.join(__dirname, 'staff-query-api.js');
const api = fs.readFileSync(apiPath, 'utf8');
const ast = acorn.parse(api, { ecmaVersion: 'latest', sourceType: 'script' });
const SUPERVISOR_ID = '11111111-1111-4111-8111-111111111111';
const CONV = '33333333-3333-4333-8333-333333333333';
const INCIDENT = '22222222-2222-4222-8222-222222222222';
const BOOKING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RECORD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
process.env.LUNA_SUPERVISOR_STAFF_USER_ID = SUPERVISOR_ID;

function extract(name) {
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' && node.id && node.id.name === name) {
      return api.slice(node.start, node.end);
    }
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        if (decl.id && decl.id.name === name) return `const ${api.slice(decl.start, decl.end)};`;
      }
    }
  }
  throw new Error(`missing ${name}`);
}

function response() {
  return { statusCode: 0, body: null };
}

function supervisorUser() {
  return {
    staff_user_id: SUPERVISOR_ID,
    role: 'admin',
    client_slug: 'wolfhouse-somo',
    email: 'supervisor@wolfhouse.test',
  };
}

function completionSandbox(logs, store) {
  const sendJSON = (res, status, body) => {
    res.statusCode = status;
    res.body = body;
    return body;
  };
  const context = vm.createContext({
    console,
    Date,
    process,
    require: createRequire(apiPath),
    normalizeSupervisorCompletionReceipt,
    shouldRecordSupervisorCompletion,
    supervisorAuditIdentity,
    retainFailedSupervisorAudit,
    projectSupervisorAudit,
    withPgClient: async (fn) => fn({}),
    appendAuditLog: (entry) => {
      logs.push(entry);
      return { ok: true };
    },
    supervisorRoutes: { createPgSupervisorStore: () => store },
    sendJSON,
    send400: (res, error) => sendJSON(res, 400, { success: false, error }),
  });
  vm.runInContext(
    ['SUPERVISOR_AUDIT_ACTION', 'auditLogHasIdentity', 'retainSupervisorAuditFailure', 'projectRetainedSupervisorAudit', 'applySupervisorCompletion', 'sendSupervisorCompleted']
      .map(extract).join('\n'),
    context,
  );
  return context;
}

function admit(action) {
  return async (req, res, user) => {
    if (!req.supervisor) return { ok: true, skipped: true };
    res._supervisorAudit = {
      user,
      action,
      extra: { incidentId: INCIDENT, conversationId: CONV, bookingRef: 'WH-42' },
    };
    user.supervisor_operation_key = `op-${action}`;
    return { ok: true, operation_key: user.supervisor_operation_key };
  };
}

(async () => {
  const store = createMemorySupervisorStore();
  const logs = [];
  const sandbox = completionSandbox(logs, store);
  const planted = { guest_name: 'PLANTED' };
  const direct = await sandbox.applySupervisorCompletion({
    _supervisorAudit: {
      user: supervisorUser(),
      action: 'booking_edit',
      extra: { incidentId: INCIDENT, conversationId: CONV },
    },
  }, {
    effect: 'mutated',
    booking_code: 'WH-42',
    before: { guest_name: 'Ana' },
    after: { guest_name: 'Bea' },
  }, {
    success: true,
    before: planted,
    after: planted,
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].staff_user_id, SUPERVISOR_ID);
  assert.equal(logs[0].intent, 'action:supervisor:booking_edit');
  assert.equal(logs[0].conversation_id, CONV);
  assert.equal(logs[0].booking_ref, 'WH-42');
  assert.deepEqual(logs[0].before, { guest_name: 'Ana' });
  assert.deepEqual(logs[0].after, { guest_name: 'Bea' });
  assert.deepEqual(direct.before, planted, 'the HTTP body keeps its own fields');
  assert.doesNotMatch(extract('applySupervisorCompletion'), /payload\.before|payload\.after/);

  const removeContext = vm.createContext({
    ...sandbox,
    DEFAULT_CLIENT: 'wolfhouse-somo',
    SQL_INJECT_RE: /[;]/,
    UUID_VALIDATE_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    readBody: async (req) => JSON.stringify(req.body),
    bookingStatusIsCancelled: (status) => status === 'cancelled' || status === 'expired',
    isMissingBookingServiceRecordsTable: () => false,
    rebalanceBookingWetsuitBoardCombo: async () => null,
    admitSupervisorBodyWrite: admit('add_on_remove'),
    withPgClient: async (fn) => fn({
      query: async (sql) => {
        const text = String(sql);
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
        if (/FROM booking_service_records sr/.test(text)) {
          return { rows: [{ id: RECORD_ID, booking_id: BOOKING_ID, service_type: 'surf_lesson', quantity: 1, amount_due_cents: 2500 }] };
        }
        if (/DELETE FROM booking_service_records/.test(text)) {
          return { rows: [{ service_record_id: RECORD_ID, service_type: 'surf_lesson', quantity: 1, amount_due_cents: 2500 }] };
        }
        if (/SELECT id::text AS id/.test(text)) return { rows: [] };
        return { rows: [{ booking_id: BOOKING_ID, booking_code: 'WH-42', status: 'confirmed' }] };
      },
    }),
  });
  vm.runInContext(['EDIT_PREVIEW_BOOKING_BY_ID_SQL', 'EDIT_PREVIEW_BOOKING_BY_CODE_SQL', 'handleBookingRemoveService'].map(extract).join('\n'), removeContext);
  const removeRes = response();
  await removeContext.handleBookingRemoveService({
    supervisor: true,
    body: {
      client_slug: 'wolfhouse-somo',
      booking_id: BOOKING_ID,
      booking_service_record_id: RECORD_ID,
      idempotency_key: 'client-key',
    },
  }, removeRes, supervisorUser());
  assert.equal(removeRes.statusCode, 200);
  assert.equal(removeRes.body.removed, true);
  assert.equal(Object.hasOwn(removeRes.body, 'before'), false);
  const removeAudit = logs.at(-1);
  assert.equal(removeAudit.intent, 'action:supervisor:add_on_remove');
  assert.equal(removeAudit.staff_user_id, SUPERVISOR_ID);
  assert.equal(removeAudit.conversation_id, CONV);
  assert.equal(removeAudit.booking_ref, BOOKING_ID);
  assert.deepEqual(removeAudit.before, {
    service_records: [{ id: RECORD_ID, booking_id: BOOKING_ID, service_type: 'surf_lesson', quantity: 1, amount_due_cents: 2500 }],
  });
  assert.deepEqual(removeAudit.after, { service_records: [] });

  const supervisorAudits = () => logs.filter((entry) => String(entry.intent || '').startsWith('action:supervisor:')).length;
  const humanAudits = supervisorAudits();
  const humanRes = response();
  await removeContext.handleBookingRemoveService({
    supervisor: false,
    body: {
      client_slug: 'wolfhouse-somo',
      booking_id: BOOKING_ID,
      booking_service_record_id: RECORD_ID,
      idempotency_key: 'human-key',
    },
  }, humanRes, { staff_user_id: '44444444-4444-4444-8444-444444444444', role: 'admin', client_slug: 'wolfhouse-somo' });
  assert.equal(humanRes.statusCode, 200);
  assert.equal(humanRes.body.removed, true);
  assert.equal(humanRes.body.success, true);
  assert.equal(supervisorAudits(), humanAudits, 'a human staff remove does not write a supervisor audit');

  const contactContext = vm.createContext({
    ...sandbox,
    DEFAULT_CLIENT: 'wolfhouse-somo',
    SQL_INJECT_RE: /[;]/,
    readBody: async (req) => JSON.stringify(req.body),
    resolveBotHandlerTrustedClientSlug: () => 'wolfhouse-somo',
    editPreviewLightNameOk: () => true,
    editPreviewLightEmailOk: () => true,
    editPreviewLightPhoneOk: () => true,
    admitSupervisorBodyWrite: admit('booking_contact_update'),
    withPgClient: async (fn) => fn({
      query: async (sql, params) => {
        const text = String(sql);
        if (/UPDATE bookings/.test(text)) {
          return { rows: [{ booking_id: BOOKING_ID, booking_code: 'WH-42', guest_name: params[2], phone: params[3], email: params[4], saved_at: '2026-11-13T00:00:00.000Z' }] };
        }
        return { rows: [{ booking_id: BOOKING_ID, booking_code: 'WH-42', guest_name: 'Ana', phone: '+34111', email: 'old@example.com' }] };
      },
    }),
  });
  vm.runInContext(['EDIT_PREVIEW_BOOKING_BY_CODE_SQL', 'EDIT_WRITE_CONTACT_UPDATE_SQL', 'editWriteContactSnapshot', 'editWriteMergeContactFields', 'editWriteContactBookingSummary', 'handleBotUpdateContact'].map(extract).join('\n'), contactContext);
  const contactRes = response();
  await contactContext.handleBotUpdateContact({
    supervisor: true,
    body: {
      booking_code: 'WH-42',
      email: 'new@example.com',
    },
  }, contactRes, supervisorUser(), 'offline');
  assert.equal(contactRes.statusCode, 200);
  assert.equal(contactRes.body.write_performed, true);
  assert.equal(contactRes.body.booking.email, 'new@example.com');
  assert.equal(Object.hasOwn(contactRes.body, 'before'), false);
  const contactAudit = logs.at(-1);
  assert.equal(contactAudit.intent, 'action:supervisor:booking_contact_update');
  assert.equal(contactAudit.booking_ref, BOOKING_ID);
  assert.deepEqual(contactAudit.before, { guest_name: 'Ana', phone: '+34111', email: 'old@example.com' });
  assert.deepEqual(contactAudit.after, { guest_name: 'Ana', phone: '+34111', email: 'new@example.com' });

  const identityContext = vm.createContext({
    ...sandbox,
    handleContactIdentity,
    withPgClient: async (fn) => fn({
      query: async (sql) => {
        const text = String(sql);
        if (/SELECT c\.full_name/.test(text)) return { rows: [{ full_name: 'Ana García' }] };
        if (/INSERT INTO customers/.test(text)) return { rows: [{ full_name: 'Bea Luna' }] };
        throw new Error(text);
      },
    }),
  });
  vm.runInContext(extract('respondContactIdentity'), identityContext);
  const identityRes = response();
  identityRes._supervisorAudit = {
    user: supervisorUser(),
    action: 'contact_identity_update',
    extra: { incidentId: INCIDENT, conversationId: CONV },
  };
  await identityContext.respondContactIdentity(identityRes, {
    query: async (sql) => {
      const text = String(sql);
      if (/SELECT c\.full_name/.test(text)) return { rows: [{ full_name: 'Ana García' }] };
      if (/INSERT INTO customers/.test(text)) return { rows: [{ full_name: 'Bea Luna' }] };
      throw new Error(text);
    },
  }, {
    clientSlug: 'wolfhouse-somo',
    phone: '+34600000001',
    body: { full_name: 'Bea Luna', phone: 'attacker' },
  });
  assert.equal(identityRes.statusCode, 200);
  assert.deepEqual(identityRes.body, { success: true, saved: true, full_name: 'Bea Luna' });
  const identityAudit = logs.at(-1);
  assert.equal(identityAudit.intent, 'action:supervisor:contact_identity_update');
  assert.equal(identityAudit.staff_user_id, SUPERVISOR_ID);
  assert.equal(identityAudit.conversation_id, CONV);
  assert.deepEqual(identityAudit.before, { full_name: 'Ana García' });
  assert.deepEqual(identityAudit.after, { full_name: 'Bea Luna' });

  assert.match(api, /respondContactIdentity\(res, pg,/);
  assert.match(extract('handleBookingRemoveService'), /sendSupervisorCompleted\(/);
  assert.match(extract('handleBotUpdateContact'), /sendSupervisorCompleted\(/);
  console.log('PASS supervisor completion uses the database receipt, not a planted body');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
