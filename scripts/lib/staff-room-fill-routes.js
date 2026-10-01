'use strict';

/**
 * Staff-only room-fill settings and preview routes.
 * Auth stays in the router. Tenant is the authenticated principal.
 * Save touches only clients.settings.luna_room_fill_policy.
 * Preview is read-only and is not a reservation.
 */

const {
  ACTIVATION_STATUS,
  SETTINGS_KEY,
  SUPPORTED_CLIENT_SLUG,
  catalogRevisionFor,
  parseStoredPolicy,
  projectCatalogueRows,
  projectRoom,
  reviewState,
  settingsRevisionFor,
  suggestedPolicy,
  validatePolicyShape,
  numericRoomOrder,
} = require('./staff-room-fill-policy');
const { previewRoomFill } = require('./staff-room-fill-preview');

const ROOM_FILL_PATH = '/staff/luna-intelligence/room-fill';
const ROOM_FILL_PREVIEW_PATH = '/staff/luna-intelligence/room-fill/preview';

const CLIENT_SQL = `
SELECT id::text AS id, slug, settings
FROM clients
WHERE id = $1::uuid
LIMIT 1
/* room-fill-client */
`;
const CATALOGUE_SQL = `
SELECT
  r.id::text AS room_id,
  r.room_code,
  r.name AS room_name,
  r.house,
  r.room_type,
  r.capacity,
  r.active AS room_active,
  r.gender_strategy,
  r.can_be_matrimonial,
  r.often_used_by_operator,
  bd.id::text AS bed_id,
  bd.bed_code,
  bd.bed_number,
  bd.active AS bed_active,
  bd.sellable AS bed_sellable
FROM rooms r
INNER JOIN clients c ON c.id = r.client_id
LEFT JOIN beds bd ON bd.room_id = r.id AND bd.client_id = r.client_id
WHERE c.id = $1::uuid
  AND r.room_code NOT LIKE 'DEMO-%'
/* room-fill-catalogue */
`;
const OCCUPANCY_SQL = `
SELECT
  bd.id::text AS bed_id,
  r.id::text AS room_id,
  r.room_code,
  bb.assignment_start_date::text AS assignment_start_date,
  bb.assignment_end_date::text AS assignment_end_date,
  lower(COALESCE(bb.assignment_type, '')) AS assignment_type
FROM booking_beds bb
INNER JOIN beds bd ON bd.id = bb.bed_id
INNER JOIN rooms r ON r.id = bd.room_id
INNER JOIN bookings b ON b.id = bb.booking_id
INNER JOIN clients c ON c.id = r.client_id
WHERE c.id = $1::uuid
  AND bb.assignment_start_date < $3::date
  AND bb.assignment_end_date > $2::date
  AND b.status NOT IN ('cancelled', 'expired')
  AND r.room_code NOT LIKE 'DEMO-%'
/* room-fill-occupancy */
`;
const SAVE_SQL = `
UPDATE clients
SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{luna_room_fill_policy}', $2::jsonb, true)
WHERE id = $1::uuid
RETURNING id::text AS id, slug, settings
/* room-fill-save */
`;

function createRoomFillRoutes({ sendJSON, readBody, withPgClient, appendAuditLog }) {
  function fail(res, status, error) {
    return sendJSON(res, status, { success: false, error, activationStatus: ACTIVATION_STATUS });
  }

  function originProblem(req) {
    const headers = req && req.headers ? req.headers : {};
    const origin = headers.origin || headers.Origin;
    if (!origin) return null;
    const host = headers.host || headers.Host;
    try {
      const parsed = new URL(origin);
      if (!host || parsed.host !== String(host)) return 'forbidden_origin';
    } catch (_) {
      return 'forbidden_origin';
    }
    return null;
  }

  async function loadTenant(user) {
    if (!user || !user.client_id) return { error: { status: 401, error: 'authentication_required' } };
    const result = await withPgClient((pg) => pg.query(CLIENT_SQL, [user.client_id]));
    const row = result.rows && result.rows[0];
    if (!row) return { error: { status: 404, error: 'client_not_found' } };
    if (user.client_slug && row.slug !== user.client_slug) {
      return { error: { status: 403, error: 'unsupported_tenant' } };
    }
    if (row.slug !== SUPPORTED_CLIENT_SLUG) {
      return { error: { status: 403, error: 'unsupported_tenant' } };
    }
    return { row };
  }

  async function loadCatalogue(clientId) {
    const result = await withPgClient((pg) => pg.query(CATALOGUE_SQL, [clientId]));
    return projectCatalogueRows(result.rows || []);
  }

  function envelope(row, rooms, storedResult) {
    const catalogRevision = catalogRevisionFor(rooms);
    const stored = storedResult && storedResult.ok ? storedResult.policy : null;
    const review = reviewState(stored, rooms);
    const numeric = numericRoomOrder(rooms);
    const ranked = stored && !review.requiresReview ? stored.roomPriority : numeric;
    const rankOf = new Map(ranked.map((id, index) => [id, index + 1]));
    return {
      success: true,
      activationStatus: ACTIVATION_STATUS,
      configured: !!stored && storedResult.ok,
      policyStatus: storedResult && !storedResult.ok ? 'invalid' : (stored ? 'saved' : 'not_configured'),
      invalidReason: storedResult && !storedResult.ok ? storedResult.error : null,
      policy: stored,
      suggestedPolicy: suggestedPolicy(rooms),
      settingsRevision: stored ? settingsRevisionFor(stored) : null,
      catalogRevision,
      requiresReview: review.requiresReview,
      removedRoomIds: review.removedRoomIds,
      unrankedRoomIds: review.unrankedRoomIds,
      catalogue: rooms
        .slice()
        .sort((a, b) => (rankOf.get(a.roomId) || 9999) - (rankOf.get(b.roomId) || 9999))
        .map((room) => projectRoom(room, rankOf.get(room.roomId) || null)),
      legacyNote: 'This order is not the current booking allocator and is not connected to booking placement.',
    };
  }

  async function handleRoomFillGet(query, _req, res, user) {
    if (Object.keys(query || {}).length) return fail(res, 400, 'caller_parameters_rejected');
    try {
      const tenant = await loadTenant(user);
      if (tenant.error) return fail(res, tenant.error.status, tenant.error.error);
      const catalogue = await loadCatalogue(tenant.row.id);
      if (!catalogue.ok) return fail(res, catalogue.status, catalogue.error);
      const stored = parseStoredPolicy(tenant.row.settings && tenant.row.settings[SETTINGS_KEY]);
      return sendJSON(res, 200, envelope(tenant.row, catalogue.rooms, stored.ok ? stored : stored));
    } catch (_) {
      return fail(res, 503, 'inventory_unavailable');
    }
  }

  async function readJson(req) {
    try {
      return { ok: true, body: JSON.parse(await readBody(req)) };
    } catch (_) {
      return { ok: false };
    }
  }

  function extraKeys(body, allowed) {
    return Object.keys(body || {}).some((key) => !allowed.includes(key));
  }

  async function handleRoomFillPut(query, req, res, user) {
    if (Object.keys(query || {}).length) return fail(res, 400, 'caller_parameters_rejected');
    const origin = originProblem(req);
    if (origin) return fail(res, 403, origin);
    const parsed = await readJson(req);
    if (!parsed.ok || !parsed.body || Array.isArray(parsed.body)) return fail(res, 400, 'invalid_json');
    const body = parsed.body;
    if (extraKeys(body, ['contractVersion', 'fillMode', 'roomPriority', 'roomPrioritySource', 'expectedSettingsRevision', 'expectedCatalogRevision'])) {
      return fail(res, 400, 'invalid_policy');
    }
    if (!('expectedCatalogRevision' in body)) return fail(res, 400, 'missing_catalog_revision');
    try {
      let savedBody = null;
      let unchanged = false;
      await withPgClient(async (pg) => {
        await pg.query('BEGIN');
        try {
          const clientResult = await pg.query(CLIENT_SQL.replace('LIMIT 1', 'LIMIT 1 FOR UPDATE'), [user.client_id]);
          const row = clientResult.rows && clientResult.rows[0];
          if (!row) {
            await pg.query('ROLLBACK');
            savedBody = { status: 404, error: 'client_not_found' };
            return;
          }
          if (row.slug !== SUPPORTED_CLIENT_SLUG || (user.client_slug && row.slug !== user.client_slug)) {
            await pg.query('ROLLBACK');
            savedBody = { status: 403, error: 'unsupported_tenant' };
            return;
          }
          const catalogueResult = await pg.query(CATALOGUE_SQL, [row.id]);
          const catalogue = projectCatalogueRows(catalogueResult.rows || []);
          if (!catalogue.ok) {
            await pg.query('ROLLBACK');
            savedBody = { status: catalogue.status, error: catalogue.error };
            return;
          }
          const catalogRevision = catalogRevisionFor(catalogue.rooms);
          if (body.expectedCatalogRevision !== catalogRevision) {
            await pg.query('ROLLBACK');
            savedBody = { status: 409, error: 'catalogue_changed' };
            return;
          }
          const validated = validatePolicyShape(body, catalogue.rooms);
          if (!validated.ok) {
            await pg.query('ROLLBACK');
            savedBody = { status: validated.status, error: validated.error };
            return;
          }
          const stored = parseStoredPolicy(row.settings && row.settings[SETTINGS_KEY]);
          const currentRevision = stored.ok && stored.policy ? settingsRevisionFor(stored.policy) : null;
          const nextRevision = settingsRevisionFor(validated.policy);
          const same = stored.ok && stored.policy && currentRevision === nextRevision;
          if (same) {
            await pg.query('COMMIT');
            unchanged = true;
            savedBody = { status: 200, row, rooms: catalogue.rooms, stored };
            return;
          }
          if (body.expectedSettingsRevision !== currentRevision) {
            await pg.query('ROLLBACK');
            savedBody = { status: 409, error: 'settings_conflict' };
            return;
          }
          const updated = await pg.query(SAVE_SQL, [row.id, JSON.stringify(validated.policy)]);
          const saved = updated.rows && updated.rows[0];
          await pg.query('COMMIT');
          if (typeof appendAuditLog === 'function') {
            appendAuditLog({
              at: new Date().toISOString(),
              action: 'luna_room_fill_policy_save',
              staff_user_id: user.staff_user_id || null,
              client_id: row.id,
              old_digest: currentRevision,
              new_digest: nextRevision,
              fill_mode: validated.policy.fillMode,
            });
          }
          savedBody = {
            status: 200,
            row: saved || row,
            rooms: catalogue.rooms,
            stored: { ok: true, policy: validated.policy },
          };
        } catch (err) {
          try { await pg.query('ROLLBACK'); } catch (_) { /* already closed */ }
          throw err;
        }
      });
      if (!savedBody) return fail(res, 503, 'inventory_unavailable');
      if (savedBody.error) return fail(res, savedBody.status, savedBody.error);
      return sendJSON(res, 200, { ...envelope(savedBody.row, savedBody.rooms, savedBody.stored), unchanged });
    } catch (_) {
      return fail(res, 503, 'inventory_unavailable');
    }
  }

  async function handleRoomFillPreview(query, req, res, user) {
    if (Object.keys(query || {}).length) return fail(res, 400, 'caller_parameters_rejected');
    const origin = originProblem(req);
    if (origin) return fail(res, 403, origin);
    const parsed = await readJson(req);
    if (!parsed.ok || !parsed.body || Array.isArray(parsed.body)) return fail(res, 400, 'invalid_json');
    const body = parsed.body;
    const allowed = ['expectedCatalogRevision', 'expectedSettingsRevision', 'policySource', 'draftPolicy', 'checkIn', 'checkOut', 'partySize', 'groupGender', 'roomPreference', 'splitPermission'];
    if (extraKeys(body, allowed)) return fail(res, 400, 'invalid_preview');
    if (body.policySource !== 'saved' && body.policySource !== 'draft') return fail(res, 400, 'invalid_preview');
    try {
      const tenant = await loadTenant(user);
      if (tenant.error) return fail(res, tenant.error.status, tenant.error.error);
      const catalogue = await loadCatalogue(tenant.row.id);
      if (!catalogue.ok) return fail(res, catalogue.status, catalogue.error);
      const catalogRevision = catalogRevisionFor(catalogue.rooms);
      if (body.expectedCatalogRevision !== catalogRevision) return fail(res, 409, 'catalogue_changed');
      const stored = parseStoredPolicy(tenant.row.settings && tenant.row.settings[SETTINGS_KEY]);
      let policy;
      let source;
      if (body.policySource === 'draft') {
        const validated = validatePolicyShape(body.draftPolicy, catalogue.rooms);
        if (!validated.ok) return fail(res, validated.status, validated.error);
        policy = validated.policy;
        source = 'draft';
      } else {
        if (!stored.ok) return fail(res, 409, stored.error || 'unsupported_contract_version');
        if (!stored.policy) return fail(res, 422, 'policy_not_configured');
        if (body.expectedSettingsRevision !== settingsRevisionFor(stored.policy)) {
          return fail(res, 409, 'settings_conflict');
        }
        const review = reviewState(stored.policy, catalogue.rooms);
        if (review.requiresReview) return fail(res, 409, 'catalogue_changed');
        policy = stored.policy;
        source = 'saved';
      }
      const occupancyResult = await withPgClient((pg) => pg.query(OCCUPANCY_SQL, [tenant.row.id, body.checkIn, body.checkOut]));
      const occupancy = (occupancyResult.rows || []).map((row) => ({
        bedId: row.bed_id,
        roomId: row.room_id,
        roomCode: row.room_code,
        start: row.assignment_start_date,
        end: row.assignment_end_date,
        assignmentType: row.assignment_type,
      }));
      const preview = previewRoomFill({
        catalogue: catalogue.rooms,
        occupancy,
        policy,
        request: {
          checkIn: body.checkIn,
          checkOut: body.checkOut,
          partySize: body.partySize,
          groupGender: body.groupGender,
          roomPreference: body.roomPreference,
          splitPermission: body.splitPermission,
        },
      });
      if (!preview.ok) return fail(res, preview.status, preview.error);
      return sendJSON(res, 200, {
        success: true,
        activationStatus: ACTIVATION_STATUS,
        mode: policy.fillMode,
        source,
        policyRevision: settingsRevisionFor(policy),
        catalogRevision,
        reservationCreated: false,
        decision: preview.decision,
      });
    } catch (_) {
      return fail(res, 503, 'inventory_unavailable');
    }
  }

  return { handleRoomFillGet, handleRoomFillPut, handleRoomFillPreview };
}

module.exports = {
  ROOM_FILL_PATH,
  ROOM_FILL_PREVIEW_PATH,
  createRoomFillRoutes,
};
