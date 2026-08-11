/**
 * Staff Customers CRM routes — extracted from staff-query-api.js.
 *
 * Slice 3 of Staff API route decomposition (DI factory; mixed per-route roles).
 *
 * Auth is NOT enforced here. The Staff API router must call requireAuth with the
 * exact minRole from CUSTOMER_ROUTE_TABLE / routes[] before dispatching.
 *
 * Shared query helpers: scripts/lib/staff-customer-queries.js (and sibling libs).
 * Do not duplicate DB logic here.
 *
 * @module staff-customers-routes
 */

'use strict';

const {
  buildCustomerListParams,
  buildCustomerDisplayTags,
  buildLastSetupSummary,
  normalizeCustomerPhone,
  isOpaqueEmailIdentityPhone,
  isDigitMangledPlaceholderPhone,
  isReusableEmailLinkedCustomerPhone,
  normalizeCustomerEmail,
  getCustomerContextQuery,
  getCustomerChannelConversationsQuery,
  buildCustomerChannelConversationsLookup,
  getCustomerBookingsQuery,
  getCustomerServiceRecordsQuery,
  getCustomerHandoffsQuery,
  getCustomerMessagesQuery,
  loadCustomerCrmTagsMerged,
  createOrMergeManualCustomer,
  parseCustomerTagsUpdateBody,
  updateCustomerCrmTags,
  updateCustomerProfile,
  createCustomerConversation,
  upsertCustomerFromEmailInboundTouch,
  buildCustomerByIdPhoneLookup,
} = require('./staff-customer-queries');
const { parseCustomerDeleteBody, deleteCustomerProfiles } = require('./staff-customer-profile-delete');
const {
  listCustomerMessageTemplates,
  createCustomerMessageTemplate,
  updateCustomerMessageTemplate,
  deactivateCustomerMessageTemplate,
  isMissingTemplatesTable,
} = require('./staff-customer-message-templates');
const { generateCustomerOutreachDraft } = require('./staff-customer-outreach-draft-generate');
const { executeCustomerOutreachSend } = require('./staff-customer-outreach-send');
const {
  SUNSET_CLIENT_SLUG,
  normalizeSunsetLocationId,
  isSunsetLocationId,
} = require('./sunset-school-locations');
const { attachConversationChannelMetadata } = require('./sunset-inbox-channel-config');
const { updateSunsetCustomerProfile } = require('./sunset-customer-profile-writes');

const CUSTOMERS_COLLECTION_PATH = '/staff/customers';
const CUSTOMERS_BULK_DELETE_PATH = '/staff/customers/bulk-delete';
const CUSTOMERS_MESSAGE_TEMPLATES_PATH = '/staff/customers/message-templates';
const CUSTOMERS_MESSAGE_TEMPLATES_GENERATE_PATH = '/staff/customers/message-templates/generate';
const CUSTOMERS_OUTREACH_SEND_PATH = '/staff/customers/outreach/send';
const CUSTOMERS_BY_EMAIL_CONTEXT_PATH = '/staff/customers/by-email/context';
const CUSTOMER_BY_ID_CONTEXT_RE = /^\/staff\/customers\/by-id\/([0-9a-f-]{36})\/context$/i;

const CUSTOMER_CONTEXT_RE = /^\/staff\/customers\/([^/]+)\/context$/i;
const CUSTOMER_TAGS_RE = /^\/staff\/customers\/([^/]+)\/tags$/i;
const CUSTOMER_CREATE_CONVERSATION_RE = /^\/staff\/customers\/([^/]+)\/create-conversation$/i;
const CUSTOMER_MESSAGE_TEMPLATE_RE = /^\/staff\/customers\/message-templates\/([0-9a-f-]{36})$/i;
const CUSTOMER_PHONE_RE = /^\/staff\/customers\/([^/]+)$/i;

/**
 * Canonical route table — minRole must match router requireAuth exactly.
 * Auth stays in staff-query-api.js; this table is the contract for the harness.
 */
const CUSTOMER_ROUTE_TABLE = Object.freeze([
  { id: 'list', method: 'GET', path: CUSTOMERS_COLLECTION_PATH, match: 'exact', minRole: 'viewer' },
  { id: 'context', method: 'GET', path: '/staff/customers/:phone/context', match: 'context', minRole: 'viewer' },
  { id: 'by_email_context', method: 'GET', path: CUSTOMERS_BY_EMAIL_CONTEXT_PATH, match: 'exact', minRole: 'viewer' },
  { id: 'by_id_context', method: 'GET', path: '/staff/customers/by-id/:id/context', match: 'by_id_context', minRole: 'viewer' },
  { id: 'templates_list', method: 'GET', path: CUSTOMERS_MESSAGE_TEMPLATES_PATH, match: 'exact', minRole: 'viewer' },
  { id: 'create', method: 'POST', path: CUSTOMERS_COLLECTION_PATH, match: 'exact', minRole: 'operator' },
  { id: 'bulk_delete', method: 'POST', path: CUSTOMERS_BULK_DELETE_PATH, match: 'exact', minRole: 'operator' },
  { id: 'tags', method: 'PATCH', path: '/staff/customers/:phone/tags', match: 'tags', minRole: 'operator' },
  { id: 'create_conversation', method: 'POST', path: '/staff/customers/:phone/create-conversation', match: 'create_conversation', minRole: 'operator' },
  { id: 'template_create', method: 'POST', path: CUSTOMERS_MESSAGE_TEMPLATES_PATH, match: 'exact', minRole: 'operator' },
  { id: 'template_generate', method: 'POST', path: CUSTOMERS_MESSAGE_TEMPLATES_GENERATE_PATH, match: 'exact', minRole: 'operator' },
  { id: 'outreach_send', method: 'POST', path: CUSTOMERS_OUTREACH_SEND_PATH, match: 'exact', minRole: 'operator' },
  { id: 'template_update', method: 'PATCH', path: '/staff/customers/message-templates/:id', match: 'template', minRole: 'operator' },
  { id: 'template_delete', method: 'DELETE', path: '/staff/customers/message-templates/:id', match: 'template', minRole: 'operator' },
  { id: 'update', method: 'PATCH', path: '/staff/customers/:phone', match: 'phone', minRole: 'operator' },
]);

/**
 * @param {object} deps
 */
function createCustomersRoutes(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new Error('createCustomersRoutes: deps required');
  }
  const {
    sendJSON,
    send400,
    readBody,
    assertStaffClientAccess,
    appendAuditLog,
    withPgClient,
    DEFAULT_CLIENT,
    SQL_INJECT_RE,
    STAFF_ACTIONS_ENABLED,
    CUSTOMER_OUTREACH_WHATSAPP_ENABLED,
  } = deps;

  function mapCustomerListRow(row) {
    const serviceType = row.last_service_type || '';
    const tagBundle = buildCustomerDisplayTags(row);
    let lastServiceSummary = null;
    if (serviceType) {
      const qty = row.last_service_quantity != null ? row.last_service_quantity : 1;
      const label = serviceType.replace(/_/g, ' ');
      lastServiceSummary = qty + ' ' + label;
    }
    return {
      phone: isOpaqueEmailIdentityPhone(row.phone) ? row.phone : (normalizeCustomerPhone(row.phone) || row.phone),
      conversation_id: row.conversation_id || null,
      display_name: row.display_name || null,
      email: row.email || null,
      language: row.language || null,
      last_contact_at: row.last_contact_at || null,
      needs_human: !!row.needs_human,
      conversation_stage: row.conversation_stage || null,
      booking_count: row.booking_count || 0,
      service_count: row.service_count || 0,
      last_service_summary: lastServiceSummary,
      last_check_in: row.last_check_in || null,
      last_service_date: row.last_service_date || row.last_service_date_detail || null,
      has_open_handoff: !!row.has_open_handoff,
      is_booked: !!row.is_booked,
      checked_in_now: !!row.checked_in_now,
      crm_tags: tagBundle.crm_tags,
      auto_tags: tagBundle.auto_tags,
      display_tags: tagBundle.display_tags,
      last_message_preview: row.last_message_preview || null,
    };
  }

  async function handleCustomerList(query, res, user) {
    const started = Date.now();
    const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
    if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
    if (!assertStaffClientAccess(user, clientSlug, res)) return;

    const built = buildCustomerListParams(clientSlug, query);
    const auditBase = {
      ts: new Date().toISOString(),
      intent: 'api:customers.list',
      category: 'customer_api',
      client_slug: clientSlug,
      filter: built.filter,
      staff_user_id: user ? user.staff_user_id : null,
    };

    let rows;
    try {
      rows = await withPgClient(async (pg) => {
        const r = await pg.query(built.sql, built.params);
        return r.rows;
      });
    } catch (err) {
      appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
      return sendJSON(res, 500, { success: false, error: 'query failed' });
    }

    const customers = rows.map(mapCustomerListRow);
    const elapsed = Date.now() - started;
    appendAuditLog({ ...auditBase, success: true, row_count: customers.length, elapsed_ms: elapsed });
    return sendJSON(res, 200, {
      success: true,
      customers,
      count: customers.length,
      filter: built.filter,
      limit: built.limit,
      offset: built.offset,
      elapsed_ms: elapsed,
    });
  }

  async function handleCustomerContext(phoneRaw, query, res, user) {
    const started = Date.now();
    const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
    let phone;
    try {
      const rawPhone = decodeURIComponent(String(phoneRaw || '').trim());
      // emailcust1: identity keys must stay opaque — never digit-normalize to +dddd…
      phone = isOpaqueEmailIdentityPhone(rawPhone)
        ? rawPhone.slice(0, 200)
        : normalizeCustomerPhone(rawPhone);
    } catch (_) {
      return send400(res, 'invalid phone encoding');
    }
    if (!phone || SQL_INJECT_RE.test(clientSlug)) {
      return send400(res, 'invalid client or phone');
    }
    if (!assertStaffClientAccess(user, clientSlug, res)) return;

    const auditBase = {
      ts: new Date().toISOString(),
      intent: 'api:customers.context',
      category: 'customer_api',
      client_slug: clientSlug,
      phone,
      staff_user_id: user ? user.staff_user_id : null,
    };

    try {
      const data = await withPgClient(async (pg) => {
        const identity = (await pg.query(
          getCustomerContextQuery({ exactPhone: isOpaqueEmailIdentityPhone(phone) }),
          [clientSlug, phone],
        )).rows[0] || null;
        const emailForLookup = identity && identity.email ? String(identity.email) : '';
        const channelLookup = buildCustomerChannelConversationsLookup(
          clientSlug,
          phone,
          emailForLookup,
          query.location,
        );
        const channelRow = channelLookup.reject
          ? channelLookup.empty
          : ((await pg.query(channelLookup.sql, channelLookup.params)).rows[0] || channelLookup.empty);
        const mergedCrmTags = await loadCustomerCrmTagsMerged(pg, clientSlug, phone);
        const bookings = (await pg.query(getCustomerBookingsQuery(), [clientSlug, phone])).rows;
        const service_records = (await pg.query(getCustomerServiceRecordsQuery(), [clientSlug, phone])).rows;
        const handoffs = (await pg.query(getCustomerHandoffsQuery(), [clientSlug, phone])).rows;
        const messages = (await pg.query(getCustomerMessagesQuery(), [clientSlug, phone])).rows;
        return {
          identity,
          channel_conversations: {
            whatsapp_conversation_id: channelRow.whatsapp_conversation_id || null,
            email_conversation_id: channelRow.email_conversation_id || null,
          },
          channel_location_id: channelLookup.locationId,
          mergedCrmTags,
          bookings,
          service_records,
          handoffs,
          messages,
        };
      });

      const lastSetup = buildLastSetupSummary(data.service_records);
      const openHandoffs = (data.handoffs || []).filter((h) => {
        const st = String(h.handoff_status || '').toLowerCase();
        return st === 'open' || st === 'assigned' || st === 'waiting_guest';
      });
      const identityBase = data.identity ? {
        ...data.identity,
        crm_tags: data.mergedCrmTags,
      } : {
        phone,
        display_name: null,
        email: null,
        crm_tags: data.mergedCrmTags,
      };
      const tagBundle = buildCustomerDisplayTags({
        identity: identityBase,
        bookings: data.bookings,
        service_records: data.service_records,
        open_handoffs: openHandoffs,
      });
      const identity = {
        ...identityBase,
        crm_tags: tagBundle.crm_tags,
        auto_tags: tagBundle.auto_tags,
        display_tags: tagBundle.display_tags,
      };

      // Waiver form links for the booking creator's bookings (Sunset only).
      // Best-effort: a missing waiver table or query error never breaks the card.
      let waivers = [];
      if (clientSlug === SUNSET_CLIENT_SLUG && data.bookings && data.bookings.length) {
        try {
          const bkIds = data.bookings.map((b) => b.booking_id).filter(Boolean);
          if (bkIds.length) {
            const wrows = (await withPgClient((pg) => pg.query(
              `SELECT wr.booking_id::text AS booking_id, wr.public_id,
                      wr.status::text AS status, wr.participant_key, wr.created_at
                 FROM waiver_form_requests wr
                WHERE wr.booking_id = ANY($1::uuid[])
                ORDER BY wr.created_at ASC`,
              [bkIds],
            ))).rows;
            const codeById = {};
            data.bookings.forEach((b) => { if (b.booking_id) codeById[b.booking_id] = b.booking_code; });
            waivers = wrows.map((w) => ({ ...w, booking_code: codeById[w.booking_id] || null }));
          }
        } catch (_) { waivers = []; }
      }

      const elapsed = Date.now() - started;
      appendAuditLog({ ...auditBase, success: true, elapsed_ms: elapsed });
      return sendJSON(res, 200, {
        success: true,
        phone,
        identity,
        waivers,
        conversation_summary: data.identity ? {
          conversation_id: data.identity.conversation_id,
          last_message_preview: data.identity.last_message_preview,
          needs_human: data.identity.needs_human,
          conversation_stage: data.identity.conversation_stage,
          last_contact_at: data.identity.last_contact_at,
        } : null,
        channel_conversations: data.channel_conversations || {
          whatsapp_conversation_id: null,
          email_conversation_id: null,
        },
        bookings: data.bookings || [],
        service_records: data.service_records || [],
        handoffs: data.handoffs || [],
        open_handoffs: openHandoffs,
        messages: data.messages || [],
        notes: {
          human_notes: data.identity && data.identity.human_notes ? data.identity.human_notes : null,
          internal_staff_notes: data.identity && data.identity.internal_staff_notes ? data.identity.internal_staff_notes : null,
        },
        last_setup_summary: lastSetup,
        elapsed_ms: elapsed,
      });
    } catch (err) {
      appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
      return sendJSON(res, 500, { success: false, error: 'query failed' });
    }
  }


  async function handleCustomerCreate(query, req, res, user) {
    const started = Date.now();
    const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
    if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
    if (!assertStaffClientAccess(user, clientSlug, res)) return;

    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (_) { return send400(res, 'invalid json body'); }

    const locationId = (clientSlug === SUNSET_CLIENT_SLUG && query.location)
      ? normalizeSunsetLocationId(query.location)
      : null;

    const auditBase = {
      ts: new Date().toISOString(),
      intent: 'api:customers.create',
      category: 'customer_api',
      client_slug: clientSlug,
      staff_user_id: user ? user.staff_user_id : null,
    };

    try {
      const result = await withPgClient((pg) => createOrMergeManualCustomer(pg, clientSlug, body, {
        location_id: locationId,
      }));
      const elapsed = Date.now() - started;
      appendAuditLog({
        ...auditBase,
        success: result.ok,
        created: result.body && result.body.created,
        duplicate: result.body && result.body.duplicate,
        phone: result.body && result.body.phone,
        elapsed_ms: elapsed,
      });
      if (!result.ok) return sendJSON(res, result.status, { ...result.body, elapsed_ms: elapsed });
      return sendJSON(res, result.status, { ...result.body, elapsed_ms: elapsed });
    } catch (err) {
      appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
      return sendJSON(res, 500, { success: false, error: 'create failed' });
    }
  }

  async function handleCustomerBulkDelete(query, req, res, user) {
    const clientSlug = String(query.client || DEFAULT_CLIENT).trim();
    if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
    if (!assertStaffClientAccess(user, clientSlug, res)) return;
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (_) { return send400(res, 'invalid json body'); }
    const parsed = parseCustomerDeleteBody(body);
    if (!parsed.ok) return send400(res, parsed.error);
    try {
      const result = await withPgClient((pg) => deleteCustomerProfiles(pg, clientSlug, parsed.phones));
      appendAuditLog({ ts: new Date().toISOString(), intent: 'api:customers.delete', category: 'customer_api', client_slug: clientSlug,
        staff_user_id: user && user.staff_user_id, deleted_count: result.deleted_count, success: true });
      return sendJSON(res, 200, { success: true, ...result });
    } catch (err) {
      appendAuditLog({ ts: new Date().toISOString(), intent: 'api:customers.delete', category: 'customer_api', client_slug: clientSlug,
        staff_user_id: user && user.staff_user_id, success: false, error: err.message });
      return sendJSON(res, 500, { success: false, error: 'customer profile deletion failed' });
    }
  }

  async function handleCustomerTagsUpdate(phoneRaw, query, req, res, user) {
    const started = Date.now();
    const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
    let phone;
    try { phone = normalizeCustomerPhone(decodeURIComponent(String(phoneRaw || '').trim())); } catch (_) { return send400(res, 'invalid phone encoding'); }
    if (!phone || SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client or phone');
    if (!assertStaffClientAccess(user, clientSlug, res)) return;

    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (_) { return send400(res, 'invalid json body'); }
    const parsed = parseCustomerTagsUpdateBody(body);
    if (!parsed.ok) return send400(res, parsed.error || 'invalid tags body');

    const auditBase = {
      ts: new Date().toISOString(),
      intent: 'api:customers.tags',
      category: 'customer_api',
      client_slug: clientSlug,
      phone,
      staff_user_id: user ? user.staff_user_id : null,
    };

    try {
      const result = await withPgClient((pg) => updateCustomerCrmTags(pg, clientSlug, phone, parsed.tags));
      const elapsed = Date.now() - started;
      appendAuditLog({ ...auditBase, success: result.ok, elapsed_ms: elapsed });
      if (!result.ok) return sendJSON(res, result.status, { ...result.body, elapsed_ms: elapsed });
      return sendJSON(res, result.status, { ...result.body, elapsed_ms: elapsed });
    } catch (err) {
      appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
      return sendJSON(res, 500, { success: false, error: 'tags update failed' });
    }
  }

  async function handleCustomerMessageTemplatesList(query, res, user) {
    const started = Date.now();
    const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
    if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
    if (!assertStaffClientAccess(user, clientSlug, res)) return;

    const auditBase = {
      ts: new Date().toISOString(),
      intent: 'api:customers.message_templates.list',
      category: 'customer_api',
      client_slug: clientSlug,
      staff_user_id: user ? user.staff_user_id : null,
    };

    try {
      const templates = await withPgClient((pg) => listCustomerMessageTemplates(pg, clientSlug));
      const elapsed = Date.now() - started;
      appendAuditLog({ ...auditBase, success: true, count: templates.length, elapsed_ms: elapsed });
      return sendJSON(res, 200, { success: true, templates, count: templates.length, elapsed_ms: elapsed });
    } catch (err) {
      if (isMissingTemplatesTable(err)) {
        return sendJSON(res, 503, { success: false, error: 'templates_schema_missing' });
      }
      appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
      return sendJSON(res, 500, { success: false, error: 'query failed' });
    }
  }

  async function handleCustomerMessageTemplateCreate(query, req, res, user) {
    const started = Date.now();
    const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
    if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
    if (!assertStaffClientAccess(user, clientSlug, res)) return;

    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (_) { return send400(res, 'invalid json body'); }

    const auditBase = {
      ts: new Date().toISOString(),
      intent: 'api:customers.message_templates.create',
      category: 'customer_api',
      client_slug: clientSlug,
      staff_user_id: user ? user.staff_user_id : null,
    };

    try {
      const result = await withPgClient((pg) => createCustomerMessageTemplate(pg, clientSlug, body));
      const elapsed = Date.now() - started;
      appendAuditLog({ ...auditBase, success: result.ok, elapsed_ms: elapsed });
      if (!result.ok) return sendJSON(res, result.status, { ...result.body, elapsed_ms: elapsed });
      return sendJSON(res, result.status, { ...result.body, elapsed_ms: elapsed });
    } catch (err) {
      if (isMissingTemplatesTable(err)) {
        return sendJSON(res, 503, { success: false, error: 'templates_schema_missing' });
      }
      appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
      return sendJSON(res, 500, { success: false, error: 'create failed' });
    }
  }

  async function handleCustomerMessageTemplateUpdate(templateId, query, req, res, user) {
    const started = Date.now();
    const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
    if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
    if (!assertStaffClientAccess(user, clientSlug, res)) return;

    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (_) { return send400(res, 'invalid json body'); }

    const auditBase = {
      ts: new Date().toISOString(),
      intent: 'api:customers.message_templates.update',
      category: 'customer_api',
      client_slug: clientSlug,
      template_id: templateId,
      staff_user_id: user ? user.staff_user_id : null,
    };

    try {
      const result = await withPgClient((pg) => updateCustomerMessageTemplate(pg, clientSlug, templateId, body));
      const elapsed = Date.now() - started;
      appendAuditLog({ ...auditBase, success: result.ok, elapsed_ms: elapsed });
      if (!result.ok) return sendJSON(res, result.status, { ...result.body, elapsed_ms: elapsed });
      return sendJSON(res, result.status, { ...result.body, elapsed_ms: elapsed });
    } catch (err) {
      if (isMissingTemplatesTable(err)) {
        return sendJSON(res, 503, { success: false, error: 'templates_schema_missing' });
      }
      appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
      return sendJSON(res, 500, { success: false, error: 'update failed' });
    }
  }

  async function handleCustomerMessageTemplateDelete(templateId, query, res, user) {
    const started = Date.now();
    const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
    if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
    if (!assertStaffClientAccess(user, clientSlug, res)) return;

    const auditBase = {
      ts: new Date().toISOString(),
      intent: 'api:customers.message_templates.delete',
      category: 'customer_api',
      client_slug: clientSlug,
      template_id: templateId,
      staff_user_id: user ? user.staff_user_id : null,
    };

    try {
      const result = await withPgClient((pg) => deactivateCustomerMessageTemplate(pg, clientSlug, templateId));
      const elapsed = Date.now() - started;
      appendAuditLog({ ...auditBase, success: result.ok, elapsed_ms: elapsed });
      if (!result.ok) return sendJSON(res, result.status, { ...result.body, elapsed_ms: elapsed });
      return sendJSON(res, result.status, { ...result.body, elapsed_ms: elapsed });
    } catch (err) {
      if (isMissingTemplatesTable(err)) {
        return sendJSON(res, 503, { success: false, error: 'templates_schema_missing' });
      }
      appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
      return sendJSON(res, 500, { success: false, error: 'delete failed' });
    }
  }

  async function handleCustomerMessageTemplateGenerate(query, req, res, user) {
    const started = Date.now();
    const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
    if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
    if (!assertStaffClientAccess(user, clientSlug, res)) return;

    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (_) { return send400(res, 'invalid json body'); }

    const auditBase = {
      ts: new Date().toISOString(),
      intent: 'api:customers.message_templates.generate',
      category: 'customer_api',
      client_slug: clientSlug,
      staff_user_id: user ? user.staff_user_id : null,
    };

    try {
      const result = await generateCustomerOutreachDraft(clientSlug, body);
      const elapsed = Date.now() - started;
      if (!result.ok) {
        appendAuditLog({ ...auditBase, success: false, error: result.error, elapsed_ms: elapsed });
        return sendJSON(res, result.status, {
          success: false,
          error: result.error,
          detail: result.detail,
          sends_whatsapp: false,
          elapsed_ms: elapsed,
        });
      }
      appendAuditLog({ ...auditBase, success: true, body_chars: result.body.length, elapsed_ms: elapsed });
      return sendJSON(res, 200, {
        success: true,
        body: result.body,
        voice: result.voice,
        sends_whatsapp: false,
        elapsed_ms: elapsed,
      });
    } catch (err) {
      appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
      return sendJSON(res, 500, { success: false, error: 'generation failed', sends_whatsapp: false });
    }
  }

  async function handleCustomerOutreachSend(query, req, res, user) {
    if (!STAFF_ACTIONS_ENABLED) {
      return sendJSON(res, 403, {
        success: false,
        error: 'staff_actions_disabled',
        detail: 'Staff write actions are disabled. Set STAFF_ACTIONS_ENABLED=true to enable.',
        sends_whatsapp: false,
      });
    }
    if (!CUSTOMER_OUTREACH_WHATSAPP_ENABLED) {
      return sendJSON(res, 403, {
        success: false,
        error: 'customer_outreach_disabled',
        detail: 'Customer CRM WhatsApp outreach is disabled. Set CUSTOMER_OUTREACH_WHATSAPP_ENABLED=true to enable.',
        sends_whatsapp: false,
      });
    }

    const started = Date.now();
    const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
    if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
    if (!assertStaffClientAccess(user, clientSlug, res)) return;

    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (_) { return send400(res, 'invalid json body'); }

    const auditBase = {
      ts: new Date().toISOString(),
      intent: 'api:customers.outreach.send',
      category: 'customer_api',
      client_slug: clientSlug,
      staff_user_id: user ? user.staff_user_id : null,
    };

    try {
      const result = await withPgClient((pg) => executeCustomerOutreachSend(pg, clientSlug, body, {
        env: process.env,
        onRecipientAudit: (row) => {
          appendAuditLog({
            ...auditBase,
            intent: 'api:customers.outreach.send.recipient',
            recipient_phone: row.phone,
            recipient_status: row.status,
            recipient_reason: row.reason || null,
            success: row.status === 'sent',
          });
        },
      }));

      const elapsed = Date.now() - started;
      if (!result.ok) {
        appendAuditLog({ ...auditBase, success: false, error: result.error, elapsed_ms: elapsed });
        return sendJSON(res, result.status || 400, {
          success: false,
          error: result.error,
          sends_whatsapp: false,
          elapsed_ms: elapsed,
        });
      }

      appendAuditLog({
        ...auditBase,
        success: true,
        summary: result.summary,
        sends_whatsapp: result.sends_whatsapp === true,
        elapsed_ms: elapsed,
      });

      return sendJSON(res, 200, {
        success: true,
        results: result.results,
        summary: result.summary,
        message_preview: result.message_preview,
        sends_whatsapp: result.sends_whatsapp === true,
        elapsed_ms: elapsed,
      });
    } catch (err) {
      appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
      return sendJSON(res, 500, { success: false, error: 'send failed', sends_whatsapp: false });
    }
  }

  async function handleCustomerUpdate(phoneRaw, query, req, res, user) {
    const started = Date.now();
    const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
    let phone;
    try { phone = normalizeCustomerPhone(decodeURIComponent(String(phoneRaw || '').trim())); } catch (_) { return send400(res, 'invalid phone encoding'); }
    if (!phone || SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client or phone');
    if (!assertStaffClientAccess(user, clientSlug, res)) return;

    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (_) { return send400(res, 'invalid json body'); }

    const auditBase = {
      ts: new Date().toISOString(),
      intent: 'api:customers.update',
      category: 'customer_api',
      client_slug: clientSlug,
      phone,
      staff_user_id: user ? user.staff_user_id : null,
    };

    try {
      const result = await withPgClient((pg) => (
        clientSlug === SUNSET_CLIENT_SLUG
          ? updateSunsetCustomerProfile(pg, clientSlug, phone, body, { actor: user })
          : updateCustomerProfile(pg, clientSlug, phone, body)
      ));
      const elapsed = Date.now() - started;
      appendAuditLog({ ...auditBase, success: result.ok, elapsed_ms: elapsed });
      if (!result.ok) return sendJSON(res, result.status, result.body);
      return sendJSON(res, result.status, { ...result.body, elapsed_ms: elapsed });
    } catch (err) {
      appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
      return sendJSON(res, 500, { success: false, error: 'update failed', detail: err.message });
    }
  }

  async function handleCustomerCreateConversation(phoneRaw, query, req, res, user) {
    const started = Date.now();
    const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
    let phone;
    try { phone = decodeURIComponent(String(phoneRaw || '').trim()); } catch (_) { return send400(res, 'invalid phone encoding'); }
    if (!phone || SQL_INJECT_RE.test(clientSlug) || SQL_INJECT_RE.test(phone)) return send400(res, 'invalid client or phone');
    if (!assertStaffClientAccess(user, clientSlug, res)) return;

    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (_) { return send400(res, 'invalid json body'); }

    const idempotencyKey = String(body.idempotency_key || '').trim()
      || `customer-profile-${phone}`;
    const reason = body.reason != null ? String(body.reason).trim().slice(0, 500) : 'Created from customer profile';

    let metadata = {
      source: 'staff_manual',
      channel: 'manual',
      idempotency_key: idempotencyKey,
      reason,
      created_from: 'customer_profile',
    };
    const sessionState = { source: 'staff_manual', channel: 'manual' };
    if (clientSlug === SUNSET_CLIENT_SLUG) {
      const locationId = normalizeSunsetLocationId(query.location || body.location_id || body.location);
      metadata = attachConversationChannelMetadata(metadata, locationId);
      sessionState.location_id = metadata.location_id;
    }

    const auditBase = {
      ts: new Date().toISOString(),
      intent: 'api:customers.create_conversation',
      category: 'customer_api',
      client_slug: clientSlug,
      phone,
      staff_user_id: user ? user.staff_user_id : null,
    };

    try {
      const result = await withPgClient((pg) => createCustomerConversation(pg, clientSlug, phone, {
        idempotency_key: idempotencyKey,
        reason,
        metadata,
        session_state: sessionState,
      }));
      const elapsed = Date.now() - started;
      appendAuditLog({
        ...auditBase,
        success: result.ok,
        conversation_id: result.body && result.body.conversation_id,
        created: result.body && result.body.created,
        elapsed_ms: elapsed,
      });
      if (!result.ok) return sendJSON(res, result.status, { ...result.body, elapsed_ms: elapsed });
      return sendJSON(res, result.status, { ...result.body, elapsed_ms: elapsed });
    } catch (err) {
      appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
      return sendJSON(res, 500, { success: false, error: 'conversation create failed' });
    }
  }


  async function resolvePhoneThenContext(phone, query, res, user) {
    return handleCustomerContext(phone, query, res, user);
  }

  async function handleCustomerContextByEmail(query, res, user) {
    const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
    const email = normalizeCustomerEmail(query.email);
    if (!email || SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client or email');
    if (!assertStaffClientAccess(user, clientSlug, res)) return;
    // Sunset requires canonical active school — fail closed if missing/invalid.
    let locationId = '';
    if (clientSlug === SUNSET_CLIENT_SLUG) {
      const rawLoc = query.location == null ? '' : String(query.location).trim();
      if (!isSunsetLocationId(rawLoc)) {
        return sendJSON(res, 404, { success: false, error: 'customer_not_found' });
      }
      locationId = rawLoc;
    }
    try {
      const row = await withPgClient(async (pg) => {
        const clientRes = await pg.query('SELECT id FROM clients WHERE slug = $1 LIMIT 1', [clientSlug]);
        if (!clientRes.rows.length) return null;
        const clientId = clientRes.rows[0].id;
        const params = [clientId, email];
        // Skip digit-mangled +dddd… placeholders; prefer emailcust1 then real E.164.
        let sql = `SELECT cu.phone
          FROM customers cu
         WHERE cu.client_id = $1::uuid
           AND lower(btrim(COALESCE(cu.email, ''))) = $2
           AND (
             cu.phone LIKE 'emailcust1:%'
             OR (
               length(regexp_replace(COALESCE(cu.phone, ''), '[^0-9]', '', 'g')) BETWEEN 10 AND 15
               AND regexp_replace(COALESCE(cu.phone, ''), '[^0-9+]', '', 'g') ~ '^\\+?[0-9]+$'
             )
           )`;
        if (clientSlug === SUNSET_CLIENT_SLUG) {
          sql += ` AND COALESCE(cu.location_id, '') = $3`;
          params.push(locationId);
        }
        sql += ` ORDER BY CASE WHEN cu.phone LIKE 'emailcust1:%' THEN 0 ELSE 1 END, cu.updated_at DESC NULLS LAST LIMIT 1`;
        const r = await pg.query(sql, params);
        return r.rows[0] || null;
      });
      // Heal: no reusable row (or only poison) → upsert emailcust1 and open that.
      if (!row || !row.phone || !isReusableEmailLinkedCustomerPhone(row.phone)) {
        if (clientSlug === SUNSET_CLIENT_SLUG && locationId) {
          const created = await withPgClient((pg) => upsertCustomerFromEmailInboundTouch(pg, {
            client_slug: clientSlug,
            email,
            display_name: null,
            location_id: locationId,
          }));
          if (created && created.ok && created.phone) {
            return handleCustomerContext(created.phone, query, res, user);
          }
        }
        return sendJSON(res, 404, { success: false, error: 'customer_not_found' });
      }
      return handleCustomerContext(row.phone, query, res, user);
    } catch (err) {
      return sendJSON(res, 500, { success: false, error: 'query failed' });
    }
  }

  async function handleCustomerContextById(customerIdRaw, query, res, user) {
    const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
    const customerId = String(customerIdRaw || '').trim();
    if (!customerId || SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client or customer id');
    if (!assertStaffClientAccess(user, clientSlug, res)) return;
    const lookup = buildCustomerByIdPhoneLookup(clientSlug, customerId, query.location);
    if (lookup.reject) {
      // Missing/invalid Sunset location → no disclosure.
      return sendJSON(res, 404, { success: false, error: 'customer_not_found' });
    }
    try {
      const row = await withPgClient(async (pg) => {
        const r = await pg.query(
          // Include email so we can heal poison phones without disclosing other schools.
          lookup.sql.replace(
            'SELECT cu.phone',
            'SELECT cu.phone, cu.email, cu.full_name, cu.location_id',
          ),
          lookup.params,
        );
        return r.rows[0] || null;
      });
      if (!row || !row.phone) {
        return sendJSON(res, 404, { success: false, error: 'customer_not_found' });
      }
      // Heal legacy poison customer_id (digit-mangled +dddd…) via email → emailcust1.
      if (isDigitMangledPlaceholderPhone(row.phone)) {
        const email = normalizeCustomerEmail(row.email);
        const loc = clientSlug === SUNSET_CLIENT_SLUG
          ? (lookup.locationId || '')
          : (row.location_id || null);
        if (email && (clientSlug !== SUNSET_CLIENT_SLUG || loc)) {
          const healed = await withPgClient((pg) => upsertCustomerFromEmailInboundTouch(pg, {
            client_slug: clientSlug,
            email,
            display_name: row.full_name || null,
            location_id: loc,
            // Do not force-link conversation here; open path may pass conversation later.
          }));
          if (healed && healed.ok && healed.phone && !isDigitMangledPlaceholderPhone(healed.phone)) {
            return handleCustomerContext(healed.phone, query, res, user);
          }
        }
        return sendJSON(res, 404, { success: false, error: 'customer_not_found' });
      }
      return handleCustomerContext(row.phone, query, res, user);
    } catch (err) {
      return sendJSON(res, 500, { success: false, error: 'query failed' });
    }
  }

  const handlers = Object.freeze({
    list: handleCustomerList,
    context: handleCustomerContext,
    by_email_context: handleCustomerContextByEmail,
    by_id_context: handleCustomerContextById,
    create: handleCustomerCreate,
    bulk_delete: handleCustomerBulkDelete,
    tags: handleCustomerTagsUpdate,
    templates_list: handleCustomerMessageTemplatesList,
    template_create: handleCustomerMessageTemplateCreate,
    template_update: handleCustomerMessageTemplateUpdate,
    template_delete: handleCustomerMessageTemplateDelete,
    template_generate: handleCustomerMessageTemplateGenerate,
    outreach_send: handleCustomerOutreachSend,
    update: handleCustomerUpdate,
    create_conversation: handleCustomerCreateConversation,
  });

  const routes = Object.freeze(CUSTOMER_ROUTE_TABLE.map((row) => ({
    ...row,
    handler: handlers[row.id],
  })));

  return {
    CUSTOMERS_COLLECTION_PATH,
    CUSTOMERS_BULK_DELETE_PATH,
    CUSTOMERS_MESSAGE_TEMPLATES_PATH,
    CUSTOMERS_MESSAGE_TEMPLATES_GENERATE_PATH,
    CUSTOMERS_OUTREACH_SEND_PATH,
    CUSTOMERS_BY_EMAIL_CONTEXT_PATH,
    CUSTOMER_BY_ID_CONTEXT_RE,
    CUSTOMER_CONTEXT_RE,
    CUSTOMER_TAGS_RE,
    CUSTOMER_CREATE_CONVERSATION_RE,
    CUSTOMER_MESSAGE_TEMPLATE_RE,
    CUSTOMER_PHONE_RE,
    CUSTOMER_ROUTE_TABLE,
    handlers,
    routes,
    mapCustomerListRow,
    handleCustomerList,
    handleCustomerContext,
    handleCustomerCreate,
    handleCustomerBulkDelete,
    handleCustomerTagsUpdate,
    handleCustomerMessageTemplatesList,
    handleCustomerMessageTemplateCreate,
    handleCustomerMessageTemplateUpdate,
    handleCustomerMessageTemplateDelete,
    handleCustomerMessageTemplateGenerate,
    handleCustomerOutreachSend,
    handleCustomerUpdate,
    handleCustomerCreateConversation,
  };
}

module.exports = {
  CUSTOMERS_COLLECTION_PATH,
  CUSTOMERS_BULK_DELETE_PATH,
  CUSTOMERS_MESSAGE_TEMPLATES_PATH,
  CUSTOMERS_MESSAGE_TEMPLATES_GENERATE_PATH,
  CUSTOMERS_OUTREACH_SEND_PATH,
  CUSTOMER_CONTEXT_RE,
  CUSTOMER_TAGS_RE,
  CUSTOMER_CREATE_CONVERSATION_RE,
  CUSTOMER_MESSAGE_TEMPLATE_RE,
  CUSTOMER_PHONE_RE,
  CUSTOMER_ROUTE_TABLE,
  createCustomersRoutes,
};
