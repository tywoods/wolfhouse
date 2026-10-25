'use strict';
const crypto = require('node:crypto');
const { normalizeQuoteRequest: buildCanonicalQuoteInput, refusalEnvelope } = require('./staff-request-contract');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function digest(value, length = 32) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('base64url').slice(0, length);
}
function operationKey(context, action, input) {
  return `one-try:${action}:${digest({ session: context.sessionId, turn: context.turnId, input }, 40)}`;
}
function replyShowsPrice(reply, totalCents, currency) {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) return false;
  const text = String(reply || '');
  const code = String(currency || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return false;
  const numbers = /\d+(?:[.,]\d{1,2})?/g;
  for (const match of text.matchAll(numbers)) {
    const shown = Number(match[0].replace(',', '.'));
    if (!Number.isFinite(shown) || Math.round(shown * 100) !== totalCents) continue;
    const before = text.slice(Math.max(0, match.index - 8), match.index).trimEnd();
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 8).trimStart();
    const hasCurrency = code === 'EUR'
      ? before.endsWith('€') || /\bEUR$/i.test(before) || after.startsWith('€') || /^EUR\b/i.test(after)
      : new RegExp(`(?:\\b${code}$|^${code}\\b)`, 'i').test(`${before}|${after}`);
    if (hasCurrency) return true;
  }
  return false;
}
function replyShowsAuthoritativeTerms(reply, quote) {
  const text = String(reply || '');
  const lower = text.toLowerCase();
  if (/\b(?:not|is not|isn't|excluding)\b[^.!?]{0,40}(?:€|eur|total|deposit)/i.test(text)) return false;
  const labelledPrice = (label, otherLabel, cents) => {
    const labels = new RegExp(`\\b${label}\\b`, 'ig');
    const observed = [];
    for (const match of text.matchAll(labels)) {
      let start = Math.max(0, match.index - 32);
      let end = Math.min(text.length, match.index + match[0].length + 32);
      const before = text.slice(start, match.index);
      const after = text.slice(match.index + match[0].length, end);
      const priorOther = [...before.matchAll(new RegExp(`\\b${otherLabel}\\b`, 'ig'))].at(-1);
      const nextOther = after.search(new RegExp(`\\b${otherLabel}\\b`, 'i'));
      if (priorOther) start += priorOther.index + priorOther[0].length;
      if (nextOther >= 0) end = match.index + match[0].length + nextOther;
      const segment = text.slice(start, end);
      const amounts = [];
      for (const amount of segment.matchAll(/(?:€\s*\d+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?\s*(?:€|EUR\b)|EUR\s*\d+(?:[.,]\d{1,2})?)/ig)) {
        const number = amount[0].match(/\d+(?:[.,]\d{1,2})?/);
        if (!number) continue;
        const amountStart = start + amount.index;
        const amountEnd = amountStart + amount[0].length;
        const labelStart = match.index;
        const labelEnd = match.index + match[0].length;
        amounts.push({
          cents: Math.round(Number(number[0].replace(',', '.')) * 100),
          distance: amountEnd <= labelStart ? labelStart - amountEnd : amountStart >= labelEnd ? amountStart - labelEnd : 0,
        });
      }
      amounts.sort((a, b) => a.distance - b.distance);
      if (amounts[0]) observed.push(amounts[0].cents);
    }
    return observed.length > 0 && observed.every((value) => value === cents);
  };
  if (!labelledPrice('total', 'deposit', quote.totalCents)
      || !labelledPrice('deposit', 'total', quote.depositCents)) return false;
  const q = quote.quoteInput || {};
  const explicitlyExcludes = (value) => {
    const escaped = String(value || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!escaped) return false;
    const patterns = [
      `\\bwithout\\b[^.!?]{0,32}\\b${escaped}\\b`,
      `\\b(?:excluding|excluded)\\b[^.!?]{0,32}\\b${escaped}\\b`,
      `\\bnot\\s+including\\b[^.!?]{0,32}\\b${escaped}\\b`,
      `\\bno\\s+(?:the\\s+)?${escaped}\\b`,
      `\\b${escaped}\\b[^.!?]{0,32}\\b(?:excluded|not included)\\b`,
      `\\b(?:does not|doesn't)\\s+include\\b[^.!?]{0,32}\\b${escaped}\\b`,
    ];
    return patterns.some((pattern) => new RegExp(pattern, 'i').test(lower));
  };
  for (const addOn of q.add_ons || []) {
    const code = String(addOn.code || '').trim();
    const quantity = Number.isSafeInteger(addOn.quantity) ? addOn.quantity : 1;
    if (!code) return false;
    if (explicitlyExcludes(code)) return false;
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const clauses = [...text.matchAll(new RegExp(`\\b${escaped}\\b([^.;!?]{0,64})`, 'ig'))];
    const observedQuantities = clauses.flatMap((claim) => [...claim[1].matchAll(/\bquantity\s*(\d+)\b/ig)]
      .map((match) => Number(match[1])));
    if (!observedQuantities.length || observedQuantities.some((value) => value !== quantity)) return false;
  }
  const inclusions = quote.packageDetails && Array.isArray(quote.packageDetails.includes)
    ? quote.packageDetails.includes.map((value) => String(value).trim().toLowerCase()).filter(Boolean) : [];
  const selectedPackages = [...(q.guest_packages || []).map((value) => value.package_code), q.package_id, quote.packageCode]
    .map((value) => String(value || '').trim().toLowerCase()).filter((value) => value && value !== 'package_none');
  if (selectedPackages.some(explicitlyExcludes)) return false;
  if (inclusions.length) {
    for (const value of inclusions) {
      if (explicitlyExcludes(value)) return false;
    }
    const inclusionClaims = [...lower.matchAll(/\bincludes?\b([^.;!?]*)/ig)];
    for (const includesClaim of inclusionClaims) {
      if (inclusions.some((value) => !includesClaim[1].includes(value))) return false;
      let residue = includesClaim[1];
      for (const value of [...inclusions].sort((a, b) => b.length - a.length)) residue = residue.replaceAll(value, ' ');
      residue = residue.replace(/\b(?:and|the|a|an|also)\b|[,/&+]/g, ' ').replace(/\s+/g, ' ').trim();
      if (residue) return false;
    }
  }
  const terms = [q.check_in, q.check_out,
    ...(q.guests || []).map((g) => g.name),
    ...((q.selection && q.selection.selected_bed_codes) || []),
    ...(q.guest_packages || []).map((p) => p.package_code), q.package_id,
    ...(q.add_ons || []).flatMap((a) => [a.code, ...(a.dates || [])])].filter(Boolean);
  return terms.every((term) => lower.includes(String(term).toLowerCase()));
}
function publicFailure(result) {
  const code = result && (result.code || result.reason) || 'unknown';
  return { ...refusalEnvelope({ code, classification: result && result.classification,
    message: result && result.message, path: result && result.path, fieldMessage: result && result.fieldMessage,
    field_errors: result && result.field_errors, next_step: result && result.next_step,
    retry_allowed: result && result.retry_allowed },
    { correlationId: result && result.correlation_id }),
  ...(result && result.pricing_failure ? { pricing_failure: result.pricing_failure } : {}), reason: code };
}
function guestRows(input, privateQuoteLabels = false) {
  return input.guests.map((guest, index) => ({
    name: guest.name || (privateQuoteLabels ? `Quote guest ${index + 1}` : undefined),
    explicit_gender: guest.explicit_gender || guest.gender || null,
  }));
}
function buildAvailabilityInput(input, privateQuoteLabels = false) {
  const room = input.room || {};
  return {
    room_type: room.kind === 'private' ? 'double' : room.kind === 'women_only' ? 'female' : room.kind === 'shared' ? 'dorm' : undefined,
    room_preference: room.kind === 'private' ? 'private' : room.name || undefined,
    keep_together: room.together === 'required' ? true : room.together === 'not_required' ? false : undefined,
    group_gender: room.kind === 'women_only' ? 'female' : undefined,
    guests: guestRows(input, privateQuoteLabels),
  };
}
function selectCatalogBeds(input, rooms) {
  const wantedName = String(input.room && input.room.name || '').trim().toLowerCase();
  const candidates = rooms.rooms || [];
  const named = wantedName ? candidates.find((room) => [room.roomId, room.roomCode, room.roomName, room.name]
    .some((value) => String(value || '').trim().toLowerCase() === wantedName)) : null;
  // A named private/exact request is a constraint, never a hint that may fall
  // back to a different room. Explicit bed codes must belong to that room too.
  if (wantedName && input.room && ['private', 'exact'].includes(input.room.kind) && !named) return [];
  const exact = input.room && Array.isArray(input.room.beds) ? input.room.beds : [];
  if (exact.length) {
    if (named) {
      const namedCodes = new Set((named.bedOptions || []).map((bed) => String(bed.code)));
      if (exact.some((code) => !namedCodes.has(String(code)))) return [];
    }
    return exact;
  }
  if (rooms.splitSelection && Array.isArray(rooms.splitSelection.selectedBedCodes)) return rooms.splitSelection.selectedBedCodes;
  const candidate = named || candidates[0];
  return candidate ? candidate.bedOptions.slice(0, input.guests.length).map((bed) => bed.code) : [];
}
function selectedPackageDetails(input, catalog, assignments) {
  const codes = [...new Set((assignments || []).map((row) => row.package_code || row.packageCode).filter((code) => code && code !== 'package_none'))];
  const items = (catalog.items || []).filter((item) => item.item_type === 'package' && codes.includes(item.item_code));
  if (items.length !== 1) return items.map((item) => ({ code: item.item_code, name: item.label, description: item.description || null, includes: Array.isArray(item.metadata && item.metadata.includes) ? item.metadata.includes : [] }));
  const item = items[0];
  return { code: item.item_code, name: item.label, description: item.description || null, includes: Array.isArray(item.metadata && item.metadata.includes) ? item.metadata.includes : [] };
}
function publicOffer(held, quote, input, reference, catalog) {
  const assignments = held.assignments || [];
  return {
    ok: true, state: 'offer', reason: 'held_offer_ready', message: 'This option is temporarily held.', next_step: 'present_offer',
    retry_allowed: false, operation_reference: reference, offer_reference: reference, held: true, booked: false,
    expires_at: held.expiresAt, check_in: input.check_in, check_out: input.check_out,
    guests: input.guests.map((guest, index) => ({ position: index + 1, name: guest.name,
      bed: assignments[index] && (assignments[index].bed_code || assignments[index].bedCode),
      package: assignments[index] && (assignments[index].package_code || assignments[index].packageCode) })),
    quote: { totalCents: quote.totalCents, depositCents: quote.depositCents, remainingCents: quote.remainingCents,
      currency: quote.currency, lineItems: quote.lineItems, perPerson: quote.perPerson },
    package_details: quote.packageDetails !== undefined
      ? quote.packageDetails : selectedPackageDetails(input, catalog || {}, assignments),
    payment_arrangement: input.payment && input.payment.arrangement,
  };
}

function publicQuote(quote, input, beds, packages, catalog) {
  const assignments = input.guests.map((guest, index) => ({
    bed_code: beds[index],
    package_code: packages.guest_packages
      ? (packages.guest_packages.find((row) => row.guest_number === index + 1) || {}).package_code
      : packages.package_id,
  }));
  return {
    ok: true, state: 'quote', reason: 'authoritative_quote_ready', message: 'Staff priced this stay without holding it.',
    next_step: 'present_quote', retry_allowed: false, held: false, booked: false,
    check_in: input.check_in, check_out: input.check_out,
    guests: input.guests.map((guest, index) => ({ position: index + 1,
      ...(guest.name ? { name: guest.name } : {}),
      bed: assignments[index].bed_code, package: assignments[index].package_code })),
    quote: { totalCents: quote.totalCents, depositCents: quote.depositCents, remainingCents: quote.remainingCents,
      currency: quote.currency, lineItems: quote.lineItems, perPerson: quote.perPerson },
    package_details: selectedPackageDetails(input, catalog || {}, assignments),
  };
}

function createCheckQuoteBook(deps) {
  async function recordPresented(pg, input, context) {
    if (!context || context.trustedPresentationRecorder !== true) return publicFailure({ code: 'trusted_recorder_required' });
    const offer = (await pg.query(`SELECT sel.quote,h.state,h.expires_at FROM luna_v3_holds h
      JOIN luna_v3_offer_turns ot ON ot.hold_id=h.id JOIN luna_v3_sessions s ON s.id=h.session_id
      JOIN clients c ON c.id=h.client_id JOIN luna_v3_selections sel ON sel.id=h.selection_id
      WHERE c.slug='wolfhouse-somo' AND s.session_key=$1 AND s.principal_id=$2 AND h.offer_reference=$3`,
    [context.sessionId, context.principalId, input.offer_reference])).rows[0];
    const quote = offer && offer.quote;
    if (!offer || offer.state !== 'active' || new Date(offer.expires_at).getTime() <= Date.now()) return publicFailure({ code: 'offer_not_found' });
    if (!Number.isSafeInteger(quote && quote.depositCents) || quote.depositCents <= 0
        || !replyShowsAuthoritativeTerms(input.assistant_reply, quote))
      return publicFailure({ code: 'complete_offer_presentation_required' });
    const authoritativeTerms = { quoteRevision: quote.quoteRevision, totalCents: quote.totalCents,
      depositCents: quote.depositCents, remainingCents: quote.remainingCents, currency: quote.currency,
      checkIn: quote.quoteInput && quote.quoteInput.check_in, checkOut: quote.quoteInput && quote.quoteInput.check_out,
      guests: quote.quoteInput && quote.quoteInput.guests, selection: quote.quoteInput && quote.quoteInput.selection,
      packageId: quote.packageCode, addOns: quote.addOns || [] };
    const recorded = await pg.query(`UPDATE luna_v3_offer_turns ot
      SET presented_turn_id=$4,presented_at=now(),assistant_event_id=$5,authoritative_terms=$6::jsonb
      FROM clients c,luna_v3_sessions s,luna_v3_holds h,luna_v3_runtime_events ae
      WHERE c.slug='wolfhouse-somo' AND s.client_id=c.id AND s.session_key=$1 AND s.principal_id=$2
        AND h.id=ot.hold_id AND ot.session_id=s.id AND h.offer_reference=$3 AND ot.presented_at IS NULL
        AND ae.id::text=$5 AND ae.client_id=c.id AND ae.session_id=s.id AND ae.principal_id=s.principal_id
        AND ae.direction='assistant_outbound' RETURNING h.id`,
    [context.sessionId, context.principalId, input.offer_reference, context.turnId, input.assistant_event_id, JSON.stringify(authoritativeTerms)]);
    return recorded.rows[0] ? { ok: true, recorded: true } : publicFailure({ code: 'offer_already_presented' });
  }
  async function checkQuoteBook(pg, input, context) {
    if (!context || !context.turnId) return publicFailure({ code: 'trusted_turn_required' });
    if (input.action === 'prepare') {
      const inboundEvent = String(context.authenticatedInboundEventId || '').trim();
      if (!inboundEvent) return publicFailure({ code: 'trusted_inbound_event_required', classification: 'authorization' });
      const requestFingerprint = crypto.createHash('sha256').update(JSON.stringify(stable(input))).digest('hex');
      // Reserve in autocommit before validation/business work.  This row therefore
      // survives every later rollback and the unique event key serializes parallel calls.
      const reserved = await pg.query(`INSERT INTO luna_v3_prepare_attempts(client_id,session_id,inbound_event_id,request_fingerprint)
        SELECT s.client_id,s.id,e.id,$4 FROM luna_v3_sessions s JOIN clients c ON c.id=s.client_id
        JOIN luna_v3_runtime_events e ON e.client_id=c.id AND e.session_id=s.id
        WHERE c.slug='wolfhouse-somo' AND s.session_key=$1 AND s.principal_id=$2
          AND e.id=$3::uuid AND e.direction='inbound'
        ON CONFLICT(client_id,session_id,inbound_event_id) DO NOTHING
        RETURNING id,request_fingerprint,outcome,receipt`,
      [context.sessionId, context.principalId, inboundEvent, requestFingerprint]);
      let attempt = reserved.rows[0];
      if (!attempt) {
        attempt = (await pg.query(`SELECT a.id,a.request_fingerprint,a.outcome,a.receipt
          FROM luna_v3_prepare_attempts a JOIN luna_v3_sessions s ON s.id=a.session_id JOIN clients c ON c.id=a.client_id
          WHERE c.slug='wolfhouse-somo' AND s.session_key=$1 AND s.principal_id=$2 AND a.inbound_event_id=$3::uuid`,
        [context.sessionId, context.principalId, inboundEvent])).rows[0];
        if (!attempt) return publicFailure({ code: 'trusted_inbound_event_required', classification: 'authorization' });
        if (attempt.request_fingerprint !== requestFingerprint)
          return publicFailure({ code: 'prepare_event_payload_mismatch', classification: 'conflict', next_step: 'wait_for_new_guest_message' });
        if (attempt.receipt) return attempt.receipt;
        return publicFailure({ code: 'prepare_event_in_progress', classification: 'conflict', next_step: 'wait_for_verified_result' });
      }
      const finish = async (receipt, outcome) => {
        const saved = { ...receipt, outcome };
        await pg.query(`UPDATE luna_v3_prepare_attempts SET receipt=$2::jsonb,outcome=$3,completed_at=now()
          WHERE id=$1 AND outcome='started'`, [attempt.id, JSON.stringify(saved), outcome]);
        return saved;
      };
      await pg.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      try {
        const snapshotContext = { ...context, callerManagedTransaction: true, ignoreOwnHolds: true };
        const reject = async (failure) => { await pg.query('ROLLBACK'); return finish(publicFailure(failure), 'rejected'); };
        // A turn is the idempotency boundary for preparation. Replaying the
        // same input in that turn returns the same offer, while a later turn
        // starts a new lifecycle even when the guest returns A→B→A.
        const replayReference = `offer_${digest({ session: context.sessionId, turn: context.turnId }, 36)}`;
        if (input.purpose === 'offer') {
          const replay = (await pg.query(`SELECT h.expires_at,h.state,sel.quote,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('bed_code',hb.bed_code,'package_code',hb.package_code) ORDER BY hb.guest_ordinal) FROM luna_v3_hold_beds hb WHERE hb.hold_id=h.id),'[]') assignments
            FROM luna_v3_holds h JOIN luna_v3_sessions s ON s.id=h.session_id JOIN luna_v3_selections sel ON sel.id=h.selection_id
            WHERE s.session_key=$1 AND s.principal_id=$2 AND h.offer_reference=$3`,
          [context.sessionId, context.principalId, replayReference])).rows[0];
          if (replay && replay.state === 'active' && new Date(replay.expires_at).getTime() > Date.now()) {
            await pg.query('COMMIT');
            return finish(publicOffer({ assignments: replay.assignments, expiresAt: replay.expires_at }, replay.quote, input, replayReference), 'applied');
          }
        }
        const catalog = await deps.getPricingCatalog(pg, { check_in: input.check_in, check_out: input.check_out }, snapshotContext);
        if (!catalog.ok) return reject(catalog);

        const count = input.guests.length;
        const quoteOnly = input.purpose === 'quote';
        const preferences = buildAvailabilityInput(input, quoteOnly);
        const rooms = await deps.findRooms(pg, { check_in: input.check_in, check_out: input.check_out, party_size: count, preferences }, snapshotContext);
        if (!rooms.ok) return reject(rooms);
        const beds = selectCatalogBeds(input, rooms);
        if (beds.length !== count) return reject({ code: 'requested_room_unavailable' });
        const built = buildCanonicalQuoteInput(input, catalog, beds, context);
        if (!built.ok) return reject(built);
        const quoteInput = { ...built.value, operation_key: `one-try:prepare:${digest({ session: context.sessionId, inboundEvent }, 40)}` };
        const packages = { package_id: quoteInput.package_id, guest_packages: quoteInput.guest_packages };
        const quote = await deps.quote(pg, quoteInput, snapshotContext);
        if (!quote.ok) return reject(quote);
        if (input.purpose === 'quote') {
          const result = publicQuote(quote, input, beds, packages, catalog);
          await pg.query('COMMIT');
          return finish(result, 'applied');
        }
        const session = (await pg.query(`SELECT s.id,s.client_id FROM luna_v3_sessions s JOIN clients c ON c.id=s.client_id WHERE c.slug='wolfhouse-somo' AND s.session_key=$1 AND s.principal_id=$2 FOR UPDATE`, [context.sessionId, context.principalId])).rows[0];
        await pg.query(`UPDATE luna_v3_holds SET state='released',updated_at=now() WHERE client_id=$1 AND session_id=$2 AND state='active'`, [session.client_id, session.id]);
        const hold = await deps.holdBeds(pg, { operation_key: operationKey(context, 'prepare-hold', input), ...quote.holdInput }, snapshotContext);
        if (!hold.ok) return reject(hold);
        const reference = replayReference;
        const updated = await pg.query(`UPDATE luna_v3_holds SET offer_reference=$1 WHERE id=$2 AND client_id=$3 AND session_id=$4 AND state='active' RETURNING id`, [reference, hold.holdId, session.client_id, session.id]);
        if (!updated.rows[0]) throw new Error('offer_scope_changed');
        await pg.query(`INSERT INTO luna_v3_offer_turns(client_id,session_id,hold_id,offer_reference,prepared_turn_id) VALUES($1,$2,$3,$4,$5)`, [session.client_id, session.id, hold.holdId, reference, context.turnId]);
        const quoteWithPresentation = { ...quote, packageDetails: selectedPackageDetails(input, catalog, hold.assignments || []) };
        await pg.query(`UPDATE luna_v3_selections sel SET quote=jsonb_set(sel.quote,'{packageDetails}',$1::jsonb,true)
          FROM luna_v3_holds h WHERE h.selection_id=sel.id AND h.id=$2 AND h.client_id=$3 AND h.session_id=$4`,
        [JSON.stringify(quoteWithPresentation.packageDetails), hold.holdId, session.client_id, session.id]);
        const result = publicOffer(hold, quoteWithPresentation, input, reference, catalog);
        await pg.query('COMMIT');
        return finish(result, 'applied');
      } catch (error) {
        await pg.query('ROLLBACK');
        return finish(publicFailure({ code: 'prepare_outcome_unknown', classification: 'internal',
          message: 'Staff could not verify the outcome of this prepare attempt.', next_step: 'wait_for_verified_result' }), 'unknown');
      }
    }
    const row = (await pg.query(`SELECT h.id,h.state,h.expires_at,ot.presented_at,ot.assistant_event_id,ot.accepted_at,
      ae.preceding_inbound_event_id::text AS presented_inbound_event_id,ae.created_at AS assistant_event_at
      FROM luna_v3_holds h JOIN luna_v3_offer_turns ot ON ot.hold_id=h.id
      JOIN luna_v3_sessions s ON s.id=h.session_id JOIN clients c ON c.id=h.client_id
      LEFT JOIN luna_v3_runtime_events ae ON ae.id::text=ot.assistant_event_id AND ae.client_id=h.client_id
        AND ae.session_id=s.id AND ae.principal_id=s.principal_id AND ae.direction='assistant_outbound'
      WHERE c.slug='wolfhouse-somo' AND s.session_key=$1 AND s.principal_id=$2 AND h.offer_reference=$3`,
    [context.sessionId, context.principalId, input.offer_reference])).rows[0];
    if (!row) return publicFailure({ code: 'offer_not_found' });
    if (input.action === 'decline') {
      const released = await deps.releaseHold(pg, { operation_key: operationKey(context, 'decline', input), hold_id: row.id }, context);
      return released.ok ? { ok: true, state: 'released', reason: 'offer_released', message: 'The temporary hold was released.', next_step: 'report_release', retry_allowed: false, operation_reference: input.offer_reference } : publicFailure(released);
    }
    const inboundEvent = context.authenticatedInboundEventId;
    if (!row.accepted_at && (row.state !== 'active' || new Date(row.expires_at).getTime() <= Date.now())) return publicFailure({ code: 'offer_superseded' });
    let acceptedInbound = null;
    if (!row.accepted_at && inboundEvent) {
      acceptedInbound = (await pg.query(`SELECT e.id::text FROM luna_v3_runtime_events e
        JOIN luna_v3_sessions s ON s.id=e.session_id JOIN clients c ON c.id=e.client_id
        WHERE c.slug='wolfhouse-somo' AND s.session_key=$1 AND s.principal_id=$2
          AND e.id=$3::uuid AND e.direction='inbound' AND e.created_at > $4::timestamptz`,
      [context.sessionId, context.principalId, inboundEvent, row.assistant_event_at])).rows[0];
    }
    if (!row.presented_at || !row.assistant_event_id || !row.assistant_event_at
        || (!row.accepted_at && (!acceptedInbound || row.presented_inbound_event_id === inboundEvent)))
      return publicFailure({ code: 'acceptance_required' });
    if (!row.accepted_at) {
      const accepted = await pg.query(`UPDATE luna_v3_offer_turns SET accepted_turn_id=$2,accepted_at=now(),accepted_inbound_event_id=$3
        WHERE offer_reference=$1 AND accepted_at IS NULL AND presented_at IS NOT NULL RETURNING hold_id`,
      [input.offer_reference, context.turnId, inboundEvent]);
      if (!accepted.rows[0]) return publicFailure({ code: 'acceptance_required' });
    }
    const confirmKey = `one-try:confirm:${digest({ session: context.sessionId, offer: input.offer_reference }, 40)}`;
    const booked = await deps.book(pg, { operation_key: confirmKey, hold_id: row.id }, context);
    if (!booked.ok) return publicFailure(booked);
    return { ok: true, state: 'booked', reason: 'accepted_offer_confirmed', message: 'The booking is confirmed.', next_step: 'report_booking', retry_allowed: false, operation_reference: input.offer_reference, booking_reference: booked.bookingCode, status: 'confirmed', payment_state: 'unpaid' };
  }
  checkQuoteBook.recordPresented = recordPresented;
  return checkQuoteBook;
}
module.exports = { createCheckQuoteBook, publicFailure, operationKey, replyShowsPrice, replyShowsAuthoritativeTerms };
