'use strict';

/**
 * Staff automated notifications — CRUD, validation, dry-run runner + audit events.
 * No WhatsApp sends in this module (live send is a future slice).
 *
 * Recipients must reference active rows in wolfhouse_staff_whatsapp_numbers for the
 * same client_slug. All reads/writes are scoped by client_slug + COALESCE(location_id,'').
 */

const TABLE = 'staff_automated_notifications';
const EVENTS_TABLE = 'staff_automated_notification_events';
const STAFF_NUMBERS_TABLE = 'wolfhouse_staff_whatsapp_numbers';

const DEFAULT_TIMEZONE = 'Europe/Madrid';
const TITLE_MAX = 120;
const PROMPT_MAX = 2000;
const MIN_RECIPIENTS = 1;
const MAX_RECIPIENTS = 10;
const TIMEZONE_MAX = 64;
const LOCAL_TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const ANSWER_PREVIEW_MAX = 500;
const WEEKDAY_TO_CUSTOM = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function normalizeLocationId(v) {
  const s = trimStr(v);
  return s || null;
}

function scopeLocationParam(locationId) {
  return normalizeLocationId(locationId);
}

function actorLabel(actor) {
  if (!actor) return null;
  const id = trimStr(actor.staff_user_id);
  if (id) return id;
  return trimStr(actor.email) || null;
}

function isMissingAutomatedNotificationsTable(err) {
  if (!err) return false;
  if (err.code === '42P01') return true;
  const msg = String(err.message || '');
  return /staff_automated_notifications/i.test(msg) && /does not exist|undefined table/i.test(msg);
}

function formatLocalTime(raw) {
  if (raw == null) return null;
  const s = String(raw);
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return s;
  return `${String(m[1]).padStart(2, '0')}:${m[2]}`;
}

function rowToPublic(row) {
  return {
    id: row.id,
    client_slug: row.client_slug,
    location_id: row.location_id,
    title: row.title,
    prompt: row.prompt,
    enabled: row.enabled === true,
    recipients: Array.isArray(row.recipients) ? row.recipients : [],
    days_of_week: Array.isArray(row.days_of_week) ? row.days_of_week : [],
    local_time: formatLocalTime(row.local_time),
    timezone: row.timezone || DEFAULT_TIMEZONE,
    last_run_at: row.last_run_at || null,
    last_status: row.last_status || null,
    last_error: row.last_error || null,
    created_by: row.created_by || null,
    updated_by: row.updated_by || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function validateLocalTime(raw) {
  const s = trimStr(raw);
  if (!s) return { ok: false, error: 'local_time required' };
  if (!LOCAL_TIME_RE.test(s)) return { ok: false, error: 'local_time must be HH:MM' };
  const parts = s.split(':');
  const hh = parseInt(parts[0], 10);
  const mm = parseInt(parts[1], 10);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return { ok: false, error: 'local_time must be HH:MM' };
  }
  return { ok: true, local_time: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` };
}

function validateDaysOfWeek(raw) {
  if (!Array.isArray(raw) || !raw.length) {
    return { ok: false, error: 'days_of_week required' };
  }
  const days = [];
  for (const item of raw) {
    const n = Number(item);
    if (!Number.isInteger(n) || n < 0 || n > 6) {
      return { ok: false, error: 'days_of_week must be unique integers 0-6' };
    }
    if (days.includes(n)) {
      return { ok: false, error: 'days_of_week must be unique' };
    }
    days.push(n);
  }
  days.sort((a, b) => a - b);
  return { ok: true, days_of_week: days };
}

function validateTimezone(raw) {
  const tz = trimStr(raw) || DEFAULT_TIMEZONE;
  if (tz.length > TIMEZONE_MAX) return { ok: false, error: 'timezone too long' };
  return { ok: true, timezone: tz };
}

function validateAutomatedNotificationInput(raw, { partial = false } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};

  if (!partial || src.title !== undefined) {
    const title = trimStr(src.title);
    if (!title) return { ok: false, error: 'title required' };
    if (title.length > TITLE_MAX) return { ok: false, error: `title max ${TITLE_MAX} chars` };
    out.title = title;
  }

  if (!partial || src.prompt !== undefined) {
    const prompt = String(src.prompt == null ? '' : src.prompt);
    if (!prompt.trim()) return { ok: false, error: 'prompt required' };
    if (prompt.length > PROMPT_MAX) return { ok: false, error: `prompt max ${PROMPT_MAX} chars` };
    out.prompt = prompt;
  }

  if (!partial || src.enabled !== undefined) {
    out.enabled = src.enabled !== false;
  }

  if (!partial || src.days_of_week !== undefined) {
    const days = validateDaysOfWeek(src.days_of_week);
    if (!days.ok) return days;
    out.days_of_week = days.days_of_week;
  }

  if (!partial || src.local_time !== undefined) {
    const time = validateLocalTime(src.local_time);
    if (!time.ok) return time;
    out.local_time = time.local_time;
  }

  if (!partial || src.timezone !== undefined) {
    const tz = validateTimezone(src.timezone);
    if (!tz.ok) return tz;
    out.timezone = tz.timezone;
  }

  if (!partial || src.recipients !== undefined) {
    out._recipients_raw = Array.isArray(src.recipients) ? src.recipients : null;
    if (!Array.isArray(src.recipients)) {
      return { ok: false, error: 'recipients must be an array' };
    }
    if (src.recipients.length < MIN_RECIPIENTS) {
      return { ok: false, error: `recipients required (${MIN_RECIPIENTS}-${MAX_RECIPIENTS})` };
    }
    if (src.recipients.length > MAX_RECIPIENTS) {
      return { ok: false, error: `recipients max ${MAX_RECIPIENTS}` };
    }
  }

  return { ok: true, input: out };
}

async function resolveRecipientsFromStaffNumbers(pg, clientSlug, rawRecipients) {
  if (!Array.isArray(rawRecipients)) {
    return { ok: false, error: 'recipients must be an array' };
  }
  if (rawRecipients.length < MIN_RECIPIENTS) {
    return { ok: false, error: `recipients required (${MIN_RECIPIENTS}-${MAX_RECIPIENTS})` };
  }
  if (rawRecipients.length > MAX_RECIPIENTS) {
    return { ok: false, error: `recipients max ${MAX_RECIPIENTS}` };
  }

  const ids = [];
  for (const item of rawRecipients) {
    const src = item && typeof item === 'object' ? item : {};
    const id = trimStr(src.staff_number_id || src.id);
    if (!id) return { ok: false, error: 'recipient staff_number_id required' };
    if (ids.includes(id)) return { ok: false, error: 'duplicate recipient' };
    ids.push(id);
  }

  const slug = trimStr(clientSlug);
  if (!slug) return { ok: false, error: 'client_slug required' };

  const res = await pg.query(
    `SELECT id, phone, permission_group, display_name
       FROM ${STAFF_NUMBERS_TABLE}
      WHERE client_slug = $1
        AND active = TRUE
        AND id = ANY($2::uuid[])`,
    [slug, ids],
  );

  if (res.rows.length !== ids.length) {
    return {
      ok: false,
      error: 'each recipient must match an active wolfhouse_staff_whatsapp_numbers row for this client',
    };
  }

  const byId = new Map(res.rows.map((row) => [String(row.id), row]));
  const recipients = ids.map((id) => {
    const row = byId.get(id);
    return {
      staff_number_id: row.id,
      name: trimStr(row.display_name) || null,
      phone: row.phone,
      permission_group: row.permission_group,
    };
  });

  return { ok: true, recipients };
}

async function ensureStaffAutomatedNotificationsTables(pg) {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_slug   TEXT NOT NULL,
      location_id   TEXT NULL,
      title         TEXT NOT NULL,
      prompt        TEXT NOT NULL,
      enabled       BOOLEAN NOT NULL DEFAULT TRUE,
      recipients    JSONB NOT NULL DEFAULT '[]'::jsonb,
      days_of_week  INT[] NOT NULL,
      local_time    TIME NOT NULL,
      timezone      TEXT NOT NULL DEFAULT 'Europe/Madrid',
      last_run_at   TIMESTAMPTZ NULL,
      last_status   TEXT NULL CHECK (last_status IS NULL OR last_status IN ('sent', 'dry_run', 'failed', 'skipped')),
      last_error    TEXT NULL,
      created_by    TEXT NULL,
      updated_by    TEXT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pg.query(`
    CREATE INDEX IF NOT EXISTS idx_staff_automated_notifications_client_location
      ON ${TABLE} (client_slug, COALESCE(location_id, ''))`);
  await pg.query(`
    CREATE INDEX IF NOT EXISTS idx_staff_automated_notifications_enabled_time
      ON ${TABLE} (client_slug, COALESCE(location_id, ''), enabled, local_time)
      WHERE enabled = TRUE`);
  await pg.query(`
    CREATE INDEX IF NOT EXISTS idx_staff_automated_notifications_client_updated
      ON ${TABLE} (client_slug, updated_at DESC)`);
  await pg.query(`
    CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      automation_id    UUID NOT NULL,
      client_slug      TEXT NOT NULL,
      location_id      TEXT NULL,
      due_local_date   DATE NOT NULL,
      due_local_time   TIME NOT NULL,
      dedupe_key       TEXT NOT NULL,
      recipient_phone  TEXT NOT NULL,
      recipient_name   TEXT NULL,
      status           TEXT NOT NULL CHECK (status IN ('dry_run', 'sent', 'failed', 'skipped')),
      question         TEXT NULL,
      answer_preview   TEXT NULL,
      error            TEXT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pg.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_automated_notification_events_dedupe
      ON ${EVENTS_TABLE} (dedupe_key, recipient_phone)`);
  await pg.query(`
    CREATE INDEX IF NOT EXISTS idx_staff_automated_notification_events_client_created
      ON ${EVENTS_TABLE} (client_slug, COALESCE(location_id, ''), created_at DESC)`);
}

function parseTimeToMinutes(raw) {
  const formatted = formatLocalTime(raw);
  if (!formatted) return null;
  const parts = formatted.split(':');
  const hh = parseInt(parts[0], 10);
  const mm = parseInt(parts[1], 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return hh * 60 + mm;
}

function getAutomationLocalParts(now, timezone) {
  const tz = trimStr(timezone) || DEFAULT_TIMEZONE;
  const date = now instanceof Date ? now : new Date(now);
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const map = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const weekday = WEEKDAY_TO_CUSTOM[map.weekday];
  const hour = parseInt(map.hour, 10);
  const minute = parseInt(map.minute, 10);
  return {
    localDate: `${map.year}-${map.month}-${map.day}`,
    weekday: Number.isInteger(weekday) ? weekday : -1,
    hour,
    minute,
    localTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

function isAutomationDueNow(automation, now, windowMinutes = 0) {
  if (!automation || automation.enabled === false) return null;
  const days = Array.isArray(automation.days_of_week) ? automation.days_of_week : [];
  if (!days.length) return null;
  const local = getAutomationLocalParts(now, automation.timezone || DEFAULT_TIMEZONE);
  if (!days.includes(local.weekday)) return null;
  const scheduledMinutes = parseTimeToMinutes(automation.local_time);
  if (scheduledMinutes == null) return null;
  const nowMinutes = local.hour * 60 + local.minute;
  const win = Math.max(0, Number(windowMinutes) || 0);
  if (win === 0) {
    if (nowMinutes !== scheduledMinutes) return null;
  } else if (nowMinutes < scheduledMinutes || nowMinutes > scheduledMinutes + win) {
    return null;
  }
  return {
    due_local_date: local.localDate,
    due_local_time: formatLocalTime(automation.local_time),
    local,
  };
}

function buildStaffAutomatedNotificationDedupeKey(automation, dueDate, dueTime) {
  const id = trimStr(automation && automation.id);
  const slug = trimStr(automation && automation.client_slug);
  const loc = normalizeLocationId(automation && automation.location_id) || '';
  const date = trimStr(dueDate);
  const time = formatLocalTime(dueTime) || trimStr(dueTime);
  return [id, slug, loc, date, time].join('::');
}

function truncateAnswerPreview(answer) {
  const text = String(answer == null ? '' : answer);
  if (text.length <= ANSWER_PREVIEW_MAX) return text;
  return text.slice(0, ANSWER_PREVIEW_MAX);
}

async function listDueStaffAutomatedNotifications(pg, {
  now = new Date(),
  clientSlug,
  locationId,
  windowMinutes = 0,
} = {}) {
  await ensureStaffAutomatedNotificationsTables(pg);
  const params = [];
  let sql = `SELECT id, client_slug, location_id, title, prompt, enabled, recipients, days_of_week,
                    local_time, timezone, last_run_at, last_status, last_error,
                    created_by, updated_by, created_at, updated_at
               FROM ${TABLE}
              WHERE enabled = TRUE`;
  const slug = trimStr(clientSlug);
  if (slug) {
    params.push(slug);
    sql += ` AND client_slug = $${params.length}`;
  }
  if (locationId !== undefined && locationId !== null && String(locationId).trim() !== '') {
    params.push(scopeLocationParam(locationId));
    sql += ` AND COALESCE(location_id, '') = COALESCE($${params.length}::text, '')`;
  }
  sql += ' ORDER BY client_slug, COALESCE(location_id, \'\'), local_time';
  const res = await pg.query(sql, params);
  const due = [];
  for (const row of res.rows) {
    const automation = rowToPublic(row);
    const slot = isAutomationDueNow(automation, now, windowMinutes);
    if (!slot) continue;
    due.push({
      automation,
      due_local_date: slot.due_local_date,
      due_local_time: slot.due_local_time,
    });
  }
  return due;
}

async function recordStaffAutomatedNotificationEvent(pg, row) {
  await ensureStaffAutomatedNotificationsTables(pg);
  const src = row || {};
  try {
    const res = await pg.query(
      `INSERT INTO ${EVENTS_TABLE} (
         automation_id, client_slug, location_id, due_local_date, due_local_time,
         dedupe_key, recipient_phone, recipient_name, status, question, answer_preview, error
       ) VALUES ($1::uuid, $2, $3, $4::date, $5::time, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, status`,
      [
        src.automation_id,
        src.client_slug,
        scopeLocationParam(src.location_id),
        src.due_local_date,
        src.due_local_time,
        src.dedupe_key,
        src.recipient_phone,
        src.recipient_name || null,
        src.status,
        src.question || null,
        src.answer_preview || null,
        src.error || null,
      ],
    );
    return { ok: true, duplicate: false, id: res.rows[0].id, status: res.rows[0].status };
  } catch (err) {
    if (err && err.code === '23505') return { ok: true, duplicate: true };
    throw err;
  }
}

async function updateStaffAutomatedNotificationLastRun(pg, automationId, {
  lastRunAt,
  lastStatus,
  lastError,
}) {
  await pg.query(
    `UPDATE ${TABLE}
        SET last_run_at = $2,
            last_status = $3,
            last_error = $4,
            updated_at = NOW()
      WHERE id = $1::uuid`,
    [automationId, lastRunAt || new Date(), lastStatus || null, lastError || null],
  );
}

async function runDueStaffAutomatedNotificationsDryRun(pg, {
  now = new Date(),
  clientSlug,
  locationId,
  windowMinutes = 0,
  executeQuestion,
} = {}) {
  if (typeof executeQuestion !== 'function') {
    throw new Error('executeQuestion callback is required');
  }
  const dueItems = await listDueStaffAutomatedNotifications(pg, {
    now,
    clientSlug,
    locationId,
    windowMinutes,
  });
  const summary = {
    due_count: dueItems.length,
    event_count: 0,
    dry_run_count: 0,
    failed_count: 0,
    skipped_count: 0,
  };

  for (const item of dueItems) {
    const { automation, due_local_date, due_local_time } = item;
    const dedupeKey = buildStaffAutomatedNotificationDedupeKey(automation, due_local_date, due_local_time);
    const recipients = Array.isArray(automation.recipients) ? automation.recipients : [];
    if (!recipients.length) continue;

    let answerPreview = null;
    let questionError = null;
    try {
      const askResult = await executeQuestion({
        client_slug: automation.client_slug,
        location_id: automation.location_id,
        question: automation.prompt,
        source: 'staff_automated_notification_dry_run',
        staff_access: 'automated',
      });
      if (askResult && askResult.success !== false && askResult.answer) {
        answerPreview = truncateAnswerPreview(askResult.answer);
      } else {
        questionError = (askResult && (askResult.error || askResult.detail)) || 'ask_luna_failed';
      }
    } catch (err) {
      questionError = (err && err.message) || 'ask_luna_error';
    }

    let wroteEvent = false;
    let automationStatus = questionError ? 'failed' : 'dry_run';

    for (const recipient of recipients) {
      const phone = trimStr(recipient && recipient.phone);
      if (!phone) continue;
      const evt = await recordStaffAutomatedNotificationEvent(pg, {
        automation_id: automation.id,
        client_slug: automation.client_slug,
        location_id: automation.location_id,
        due_local_date,
        due_local_time,
        dedupe_key: dedupeKey,
        recipient_phone: phone,
        recipient_name: recipient.name || null,
        status: questionError ? 'failed' : 'dry_run',
        question: automation.prompt,
        answer_preview: answerPreview,
        error: questionError,
      });
      if (evt.duplicate) {
        summary.skipped_count += 1;
        continue;
      }
      wroteEvent = true;
      summary.event_count += 1;
      if (questionError) summary.failed_count += 1;
      else summary.dry_run_count += 1;
    }

    if (wroteEvent) {
      await updateStaffAutomatedNotificationLastRun(pg, automation.id, {
        lastRunAt: now,
        lastStatus: automationStatus,
        lastError: questionError,
      });
    }
  }

  return summary;
}

async function listStaffAutomatedNotifications(pg, { clientSlug, locationId }) {
  await ensureStaffAutomatedNotificationsTables(pg);
  const slug = trimStr(clientSlug);
  if (!slug) return [];
  const loc = scopeLocationParam(locationId);

  try {
    const res = await pg.query(
      `SELECT id, client_slug, location_id, title, prompt, enabled, recipients, days_of_week,
              local_time, timezone, last_run_at, last_status, last_error,
              created_by, updated_by, created_at, updated_at
         FROM ${TABLE}
        WHERE client_slug = $1
          AND COALESCE(location_id, '') = COALESCE($2::text, '')
        ORDER BY updated_at DESC, created_at DESC`,
      [slug, loc],
    );
    return res.rows.map(rowToPublic);
  } catch (err) {
    if (isMissingAutomatedNotificationsTable(err)) return [];
    throw err;
  }
}

async function createStaffAutomatedNotification(pg, { clientSlug, locationId, input, actor }) {
  const slug = trimStr(clientSlug);
  if (!slug) return { ok: false, status: 400, error: 'client_slug required' };

  const v = validateAutomatedNotificationInput(input || {});
  if (!v.ok) return { ok: false, status: 400, error: v.error };

  await ensureStaffAutomatedNotificationsTables(pg);
  const loc = scopeLocationParam(locationId);
  const recipientsResolved = await resolveRecipientsFromStaffNumbers(pg, slug, input.recipients);
  if (!recipientsResolved.ok) return { ok: false, status: 400, error: recipientsResolved.error };

  const actorName = actorLabel(actor);
  const payload = v.input;

  try {
    const res = await pg.query(
      `INSERT INTO ${TABLE} (
         client_slug, location_id, title, prompt, enabled, recipients, days_of_week,
         local_time, timezone, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::int[], $8::time, $9, $10, $11)
       RETURNING id, client_slug, location_id, title, prompt, enabled, recipients, days_of_week,
                 local_time, timezone, last_run_at, last_status, last_error,
                 created_by, updated_by, created_at, updated_at`,
      [
        slug,
        loc,
        payload.title,
        payload.prompt,
        payload.enabled !== false,
        JSON.stringify(recipientsResolved.recipients),
        payload.days_of_week,
        payload.local_time,
        payload.timezone || DEFAULT_TIMEZONE,
        actorName,
        actorName,
      ],
    );
    return { ok: true, notification: rowToPublic(res.rows[0]) };
  } catch (err) {
    if (isMissingAutomatedNotificationsTable(err)) {
      return { ok: false, status: 503, error: 'table_missing' };
    }
    throw err;
  }
}

async function updateStaffAutomatedNotification(pg, { clientSlug, locationId, id, input, actor }) {
  const slug = trimStr(clientSlug);
  const rowId = trimStr(id);
  if (!slug) return { ok: false, status: 400, error: 'client_slug required' };
  if (!rowId) return { ok: false, status: 400, error: 'id required' };

  const v = validateAutomatedNotificationInput(input || {}, { partial: true });
  if (!v.ok) return { ok: false, status: 400, error: v.error };

  await ensureStaffAutomatedNotificationsTables(pg);
  const loc = scopeLocationParam(locationId);
  const payload = v.input;
  const sets = [];
  const params = [slug, loc, rowId];
  let idx = 4;

  if (payload.title !== undefined) {
    sets.push(`title = $${idx++}`);
    params.push(payload.title);
  }
  if (payload.prompt !== undefined) {
    sets.push(`prompt = $${idx++}`);
    params.push(payload.prompt);
  }
  if (payload.enabled !== undefined) {
    sets.push(`enabled = $${idx++}`);
    params.push(payload.enabled === true);
  }
  if (payload.days_of_week !== undefined) {
    sets.push(`days_of_week = $${idx++}::int[]`);
    params.push(payload.days_of_week);
  }
  if (payload.local_time !== undefined) {
    sets.push(`local_time = $${idx++}::time`);
    params.push(payload.local_time);
  }
  if (payload.timezone !== undefined) {
    sets.push(`timezone = $${idx++}`);
    params.push(payload.timezone);
  }
  if (input && input.recipients !== undefined) {
    const recipientsResolved = await resolveRecipientsFromStaffNumbers(pg, slug, input.recipients);
    if (!recipientsResolved.ok) return { ok: false, status: 400, error: recipientsResolved.error };
    sets.push(`recipients = $${idx++}::jsonb`);
    params.push(JSON.stringify(recipientsResolved.recipients));
  }

  if (!sets.length) return { ok: false, status: 400, error: 'no fields to update' };

  const actorName = actorLabel(actor);
  sets.push(`updated_by = $${idx++}`);
  params.push(actorName);
  sets.push('updated_at = NOW()');

  try {
    const res = await pg.query(
      `UPDATE ${TABLE}
          SET ${sets.join(', ')}
        WHERE client_slug = $1
          AND COALESCE(location_id, '') = COALESCE($2::text, '')
          AND id = $3::uuid
      RETURNING id, client_slug, location_id, title, prompt, enabled, recipients, days_of_week,
                local_time, timezone, last_run_at, last_status, last_error,
                created_by, updated_by, created_at, updated_at`,
      params,
    );
    if (!res.rowCount) return { ok: false, status: 404, error: 'not_found' };
    return { ok: true, notification: rowToPublic(res.rows[0]) };
  } catch (err) {
    if (isMissingAutomatedNotificationsTable(err)) {
      return { ok: false, status: 503, error: 'table_missing' };
    }
    throw err;
  }
}

async function deleteStaffAutomatedNotification(pg, { clientSlug, locationId, id }) {
  const slug = trimStr(clientSlug);
  const rowId = trimStr(id);
  if (!slug) return { ok: false, status: 400, error: 'client_slug required' };
  if (!rowId) return { ok: false, status: 400, error: 'id required' };

  await ensureStaffAutomatedNotificationsTables(pg);
  const loc = scopeLocationParam(locationId);

  try {
    const res = await pg.query(
      `DELETE FROM ${TABLE}
        WHERE client_slug = $1
          AND COALESCE(location_id, '') = COALESCE($2::text, '')
          AND id = $3::uuid
      RETURNING id`,
      [slug, loc, rowId],
    );
    return { ok: true, deleted: res.rowCount > 0 };
  } catch (err) {
    if (isMissingAutomatedNotificationsTable(err)) {
      return { ok: false, status: 503, error: 'table_missing', deleted: false };
    }
    throw err;
  }
}

module.exports = {
  TABLE,
  EVENTS_TABLE,
  STAFF_NUMBERS_TABLE,
  DEFAULT_TIMEZONE,
  TITLE_MAX,
  PROMPT_MAX,
  ANSWER_PREVIEW_MAX,
  validateLocalTime,
  validateDaysOfWeek,
  validateTimezone,
  validateAutomatedNotificationInput,
  resolveRecipientsFromStaffNumbers,
  ensureStaffAutomatedNotificationsTables,
  listStaffAutomatedNotifications,
  createStaffAutomatedNotification,
  updateStaffAutomatedNotification,
  deleteStaffAutomatedNotification,
  getAutomationLocalParts,
  isAutomationDueNow,
  buildStaffAutomatedNotificationDedupeKey,
  listDueStaffAutomatedNotifications,
  recordStaffAutomatedNotificationEvent,
  runDueStaffAutomatedNotificationsDryRun,
};
