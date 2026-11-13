'use strict';

/**
 * Persist an accepted included airport shuttle after a booking save.
 *
 * The free shuttle is only for a full-stay package guest. Full stay is the
 * package's current default_nights from Staff config, never a fixed night count.
 * A failed transfer write never fails or rolls back the booking.
 */

const { computeStayNights, isAccommodationOnlyIntent } = require('./wolfhouse-package-night-rules');
const { getTransferRules, getClientAirportOption } = require('./client-transfer-config');

const ACCEPTED = new Set(['accepted', 'yes', 'wanted', 'requested', 'needed']);
const DECLINED = new Set(['declined', 'no', 'none', 'not_needed']);

function trimStr(value) {
  if (value == null) return '';
  return String(value).trim();
}

function shuttleDecision(body) {
  const src = body && typeof body === 'object' ? body : {};
  const choice = trimStr(src.shuttle_choice).toLowerCase();
  if (DECLINED.has(choice) || src.shuttle_needed === false || src.needs_shuttle === false) {
    return 'declined';
  }
  if (ACCEPTED.has(choice) || src.shuttle_needed === true || src.needs_shuttle === true) {
    return 'accepted';
  }
  return 'unresolved';
}

function packageCodeFromBody(body) {
  const guests = Array.isArray(body && body.guest_packages) ? body.guest_packages : [];
  const counts = new Map();
  for (const item of guests) {
    const code = trimStr(item && item.package_code).toLowerCase();
    if (!code) continue;
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [code, count] of counts) {
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }
  return best || trimStr(body && body.package_code).toLowerCase();
}

function packageRecord(config, code) {
  const wanted = trimStr(code).toLowerCase();
  if (!wanted || !config || !config.packages) return null;
  const list = config.packages;
  if (Array.isArray(list)) {
    return list.find((row) => row && trimStr(row.code).toLowerCase() === wanted) || null;
  }
  if (typeof list === 'object') return list[wanted] || null;
  return null;
}

/**
 * A current Admin default_nights. Only a positive integer already stored on
 * the package. No coercion and no seeded or hard-coded stand-in.
 */
function validatedCurrentDefaultNights(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  if (!Object.prototype.hasOwnProperty.call(metadata, 'default_nights')) return null;
  const nights = metadata.default_nights;
  if (typeof nights !== 'number' || !Number.isSafeInteger(nights) || nights < 1) return null;
  return nights;
}

/** Current Staff default nights only. Missing means unknown, not a fixed 6. */
function currentDefaultNights(pkg) {
  if (!pkg || !Object.prototype.hasOwnProperty.call(pkg, 'default_nights')) return null;
  return validatedCurrentDefaultNights({ default_nights: pkg.default_nights });
}

/**
 * Package rows for the shuttle check. default_nights is copied only when the
 * current item metadata has a valid one. The quote overlay's fallback of 6
 * is never applied here.
 */
function packagesFromCurrentItemMetadata(items) {
  const packages = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.active === false) continue;
    if (String(item.item_type || 'package') !== 'package') continue;
    const code = trimStr(item.item_code || item.code);
    if (!code || code.startsWith('_')) continue;
    const nights = validatedCurrentDefaultNights(item.metadata);
    packages.push(nights == null ? { code } : { code, default_nights: nights });
  }
  return { packages };
}

function includedShuttleAirport(clientSlug, transferConfig) {
  const rules = getTransferRules(clientSlug, transferConfig || undefined).filter((rule) => (
    rule && rule.included_when_package === true && trimStr(rule.airport_code)
  ));
  if (rules.length !== 1) return null;
  const airportCode = trimStr(rules[0].airport_code).toUpperCase();
  const airport = getClientAirportOption(clientSlug, airportCode, transferConfig || undefined);
  return {
    airport_code: airportCode,
    label: trimStr(airport && airport.label) || airportCode,
  };
}

/**
 * Decide whether an accepted shuttle should become a transfer row.
 *
 * @returns {{ save: boolean, warn: boolean, reason: string, entry?: object, message?: string }}
 */
function qualifyIncludedShuttleSave(body, packageConfig, clientSlug, transferConfig) {
  const decision = shuttleDecision(body);
  if (decision !== 'accepted') {
    return { save: false, warn: false, reason: decision === 'declined' ? 'declined' : 'unresolved' };
  }
  const packageCode = packageCodeFromBody(body);
  if (!packageCode || packageCode === 'none' || isAccommodationOnlyIntent(packageCode)) {
    return { save: false, warn: false, reason: 'not_package' };
  }
  const nights = computeStayNights(body && body.check_in, body && body.check_out);
  const pkg = packageRecord(packageConfig, packageCode);
  const defaultNights = currentDefaultNights(pkg);
  if (nights == null || defaultNights == null) {
    return {
      save: false,
      warn: true,
      reason: 'default_nights_unknown',
      message: 'Included airport shuttle was accepted, but the package default nights could not be read. Booking kept; shuttle was not saved.',
    };
  }
  if (nights < defaultNights) {
    return { save: false, warn: false, reason: 'short_stay' };
  }
  const airport = includedShuttleAirport(clientSlug, transferConfig);
  if (!airport) {
    return {
      save: false,
      warn: true,
      reason: 'included_airport_unknown',
      message: 'Included airport shuttle was accepted, but no single included airport is configured. Booking kept; shuttle was not saved.',
    };
  }
  return {
    save: true,
    warn: false,
    reason: 'full_stay_package',
    entry: {
      direction: 'arrival',
      airport_code: airport.airport_code,
      notes: `Included ${airport.label} airport shuttle accepted during booking. Flight time and flight number are still to collect.`,
    },
  };
}

async function recordStaffShuttleWarning(ctx, clientSlug, bookingId, message) {
  console.warn(`[luna.included-shuttle] ${message}`);
  if (!ctx || typeof ctx.withPgClient !== 'function' || !bookingId || !clientSlug) return;
  try {
    await ctx.withPgClient((pg) => pg.query(
      `UPDATE bookings
          SET staff_notes = CASE
                WHEN staff_notes IS NULL OR BTRIM(staff_notes) = '' THEN $1
                WHEN position($1 in staff_notes) > 0 THEN staff_notes
                ELSE staff_notes || E'\\n' || $1
              END
        WHERE id = $2::uuid
          AND client_id = (SELECT id FROM clients WHERE slug = $3 LIMIT 1)`,
      [`[Luna shuttle] ${message}`, bookingId, clientSlug],
    ));
  } catch (_err) {
    console.warn('[luna.included-shuttle] staff note not saved');
  }
}

/**
 * Best-effort transfer write. Never changes booking success.
 */
async function persistAcceptedIncludedShuttle(body, bridgeResult, ctx) {
  const result = bridgeResult && typeof bridgeResult === 'object' ? bridgeResult : {};
  const bookingSaved = result.success === true && !!result.booking_id
    && (result.write_performed === true || result.duplicate === true);
  if (!bookingSaved) {
    return { attempted: false, saved: false, reason: 'booking_not_saved' };
  }
  const clientSlug = trimStr(
    (ctx && ctx.boundClientSlug)
    || (body && body.client_slug)
    || result.client_slug
    || (ctx && ctx.DEFAULT_CLIENT),
  );
  if (shuttleDecision(body) !== 'accepted') {
    const skipped = qualifyIncludedShuttleSave(body, null, clientSlug);
    return { attempted: false, saved: false, reason: skipped.reason };
  }
  let packageConfig = null;
  if (ctx && typeof ctx.loadQuoteConfig === 'function') {
    try {
      packageConfig = await ctx.loadQuoteConfig();
    } catch (_err) {
      packageConfig = null;
    }
  }
  let transferConfig = null;
  let transferUnreadable = false;
  if (ctx && typeof ctx.loadTransferConfig === 'function') {
    try {
      transferConfig = await ctx.loadTransferConfig(clientSlug);
    } catch (_err) {
      transferUnreadable = true;
    }
  }
  if (transferUnreadable) {
    const message = 'Included airport shuttle was accepted, but the current transfer settings could not be read. Booking kept; shuttle was not saved.';
    result.staff_shuttle_warning = message;
    await recordStaffShuttleWarning(ctx, clientSlug, result.booking_id, message);
    return { attempted: false, saved: false, reason: 'transfer_config_unreadable' };
  }
  const decision = qualifyIncludedShuttleSave(body, packageConfig, clientSlug, transferConfig);
  if (!decision.save) {
    if (decision.warn && decision.message) {
      result.staff_shuttle_warning = decision.message;
      await recordStaffShuttleWarning(ctx, clientSlug, result.booking_id, decision.message);
    }
    return { attempted: false, saved: false, reason: decision.reason };
  }
  if (!ctx || typeof ctx.writeIncludedShuttle !== 'function') {
    const message = 'Included airport shuttle was accepted, but the transfer writer is unavailable. Booking kept; shuttle was not saved.';
    result.staff_shuttle_warning = message;
    await recordStaffShuttleWarning(ctx, clientSlug, result.booking_id, message);
    return { attempted: false, saved: false, reason: 'writer_unavailable' };
  }
  let out;
  try {
    out = await ctx.writeIncludedShuttle(decision.entry);
  } catch (_err) {
    out = { write_performed: false, success: false, error: 'transfer_write_failed' };
    console.warn('[luna.included-shuttle] transfer write threw');
  }
  out = out && typeof out === 'object' ? out : {};
  const row = {
    direction: decision.entry.direction,
    airport_code: decision.entry.airport_code,
    write_performed: out.write_performed === true,
    success: out.success === true,
    error: out.error || null,
    included_shuttle: true,
  };
  result.transfer_save_results = Array.isArray(result.transfer_save_results)
    ? result.transfer_save_results.concat([row])
    : [row];
  if (row.write_performed) {
    result.transfers_saved = Array.isArray(result.transfers_saved)
      ? result.transfers_saved.concat([row])
      : [row];
    return { attempted: true, saved: true, reason: 'saved' };
  }
  const message = 'Included airport shuttle was accepted, but saving the transfer failed. Booking kept; staff should add the shuttle.';
  result.staff_shuttle_warning = message;
  await recordStaffShuttleWarning(ctx, clientSlug, result.booking_id, message);
  return { attempted: true, saved: false, reason: 'write_failed' };
}

module.exports = {
  shuttleDecision,
  packageCodeFromBody,
  currentDefaultNights,
  validatedCurrentDefaultNights,
  packagesFromCurrentItemMetadata,
  qualifyIncludedShuttleSave,
  persistAcceptedIncludedShuttle,
  recordStaffShuttleWarning,
};
