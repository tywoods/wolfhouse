"use strict";
const crypto = require("node:crypto");
const {
  buildWolfhouseBookingCreateCommand,
  executeWolfhouseBookingCreate,
  BOOKING_CREATE_CHANNELS,
} = require("../luna-front-desk-accommodation-booking-create-service");
const {
  executeGuestUnpaidCancellationBoundary,
} = require("../guest-unpaid-cancellation");
const { getHouseNotes } = require("../tenant-house-notes");
const { upsertBookingTransfer } = require("../booking-transfers");
const { loadStaffTransferConfig } = require("../staff-transfer-pricing");
const TENANT = "wolfhouse-somo";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
function fingerprint(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
function madridWallTime(date, time) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  const clock = /^(\d{2}):(\d{2})$/.exec(String(time || ""));
  if (!match || !clock)
    throw Object.assign(new Error("invalid transfer local time"), {
      code: "invalid_transfer_local_time",
    });
  const [year, month, day, hour, minute] = [
    ...match.slice(1),
    ...clock.slice(1),
  ].map(Number);
  if (hour > 23 || minute > 59)
    throw Object.assign(new Error("invalid transfer local time"), {
      code: "invalid_transfer_local_time",
    });
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const wanted = `${match[1]}-${match[2]}-${match[3]} ${clock[1]}:${clock[2]}`;
  const candidates = [];
  for (const offsetMinutes of [60, 120]) {
    const instant = new Date(
      Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes * 60000,
    );
    const p = Object.fromEntries(
      formatter
        .formatToParts(instant)
        .filter((x) => x.type !== "literal")
        .map((x) => [x.type, x.value]),
    );
    if (`${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` === wanted)
      candidates.push({ instant, offsetMinutes });
  }
  if (candidates.length !== 1)
    throw Object.assign(
      new Error(
        candidates.length
          ? "ambiguous transfer local time"
          : "nonexistent transfer local time",
      ),
      {
        code: candidates.length
          ? "ambiguous_transfer_local_time"
          : "nonexistent_transfer_local_time",
      },
    );
  const offset = candidates[0].offsetMinutes;
  return `${date}T${time}:00+${String(Math.floor(offset / 60)).padStart(2, "0")}:${String(offset % 60).padStart(2, "0")}`;
}
function fail(code, status = 409, extra = {}) {
  return { ok: false, outcome: "rejected", code, status, ...extra };
}
async function initializeFreshV3UnpaidEvidence(pg, bookingId) {
  const booking = await pg.query(
    `UPDATE bookings
       SET amount_paid_cents=0,
           deposit_paid_cents=0,
           payment_status='waiting_payment',
           metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('luna_v3_provenance','fresh_one_try')
     WHERE id=$1
       AND COALESCE(amount_paid_cents,0)=0
       AND COALESCE(deposit_paid_cents,0)=0
       AND LOWER(COALESCE(payment_status::text,'waiting_payment')) IN ('not_requested','waiting_payment','pending','created','open','draft','unpaid')
     RETURNING id`,
    [bookingId],
  );
  if (booking.rows.length !== 1) {
    throw Object.assign(new Error("fresh v3 money evidence was not pristine"), {
      code: "fresh_v3_money_not_pristine",
    });
  }
  await pg.query(
    `UPDATE booking_guests
       SET amount_paid_cents=0,payment_status='waiting_payment'
     WHERE booking_id=$1 AND amount_paid_cents IS NULL`,
    [bookingId],
  );
}
async function session(pg, context, write = false) {
  if (
    !context ||
    context.tenantId !== TENANT ||
    !context.authenticated ||
    !context.sessionId ||
    !context.principalId
  )
    throw Object.assign(new Error("trusted session context required"), {
      status: 403,
    });
  const r = await pg.query(
    `SELECT s.*,c.slug FROM luna_v3_sessions s JOIN clients c ON c.id=s.client_id WHERE c.slug=$1 AND s.session_key=$2 AND s.principal_id=$3`,
    [TENANT, context.sessionId, context.principalId],
  );
  if (!r.rows[0])
    throw Object.assign(new Error("session ownership denied"), { status: 403 });
  if (
    write &&
    (context.writeAllowed !== true || r.rows[0].write_admitted !== true)
  )
    throw Object.assign(new Error("write admission denied"), { status: 403 });
  return r.rows[0];
}
async function beginOperation(pg, s, tool, key, input) {
  const fp = fingerprint(input);
  const r = await pg.query(
    `INSERT INTO luna_v3_operations(client_id,session_id,tool,operation_key,request_fingerprint) VALUES($1,$2,$3,$4,$5) ON CONFLICT(client_id,session_id,tool,operation_key) DO NOTHING RETURNING *`,
    [s.client_id, s.id, tool, key, fp],
  );
  const row =
    r.rows[0] ||
    (
      await pg.query(
        `SELECT * FROM luna_v3_operations WHERE client_id=$1 AND session_id=$2 AND tool=$3 AND operation_key=$4 FOR UPDATE`,
        [s.client_id, s.id, tool, key],
      )
    ).rows[0];
  if (row.request_fingerprint !== fp)
    return { conflict: fail("operation_key_payload_mismatch") };
  if (row.receipt) return { replay: row.receipt };
  return { row, fp };
}
async function finish(pg, id, receipt, ids = {}) {
  await pg.query(
    `UPDATE luna_v3_operations SET receipt=$2::jsonb,outcome=$3,booking_id=COALESCE($4,booking_id),hold_id=COALESCE($5,hold_id),completed_at=now() WHERE id=$1`,
    [
      id,
      JSON.stringify(receipt),
      receipt.outcome || "applied",
      ids.bookingId || null,
      ids.holdId || null,
    ],
  );
  return receipt;
}
async function rejectKnown(pg, op, receipt) {
  await pg.query("ROLLBACK TO SAVEPOINT luna_v3_business");
  await finish(pg, op.row.id, { ...receipt, outcome: "rejected" });
  await pg.query("COMMIT");
  return { ...receipt, outcome: "rejected" };
}

async function revalidateSelection(pg, selection, context) {
  const quoteInput = selection.quote && selection.quote.quoteInput;
  if (!quoteInput) return fail("fresh_agreement_required", 409);
  const fresh = await require("./index").quote(pg, quoteInput, {
    ...context,
    revalidationOnly: true,
  });
  if (!fresh || fresh.ok !== true)
    return fail(
      (fresh && fresh.code) || "selection_no_longer_available",
      (fresh && fresh.status) || 409,
    );
  if (fresh.quoteRevision !== selection.quote_revision)
    return fail("fresh_agreement_required", 409, {
      currentQuoteRevision: fresh.quoteRevision,
    });
  return { ok: true };
}

async function holdBeds(pg, input, context) {
  const s = await session(pg, context, true);
  const ownsTransaction = !(context && context.callerManagedTransaction);
  if (ownsTransaction) await pg.query("BEGIN");
  try {
    const op = await beginOperation(
      pg,
      s,
      "hold_beds",
      input.operation_key,
      input,
    );
    if (op.conflict) {
      if (ownsTransaction) await pg.query("ROLLBACK");
      return op.conflict;
    }
    if (op.replay) {
      if (ownsTransaction) await pg.query("COMMIT");
      return op.replay;
    }
    await pg.query("SAVEPOINT luna_v3_business");
    const reject = (receipt) => rejectKnown(pg, op, receipt);
    const assignments = input.assignments || [];
    if (!assignments.length) return reject(fail("assignments_required", 400));
    const sel = (
      await pg.query(
        `SELECT * FROM luna_v3_selections WHERE client_id=$1 AND session_id=$2 AND quote_revision=$3 FOR UPDATE`,
        [s.client_id, s.id, input.quoted_selection],
      )
    ).rows[0];
    if (!sel) return reject(fail("quoted_selection_not_found", 404));
    const same = (a, b) =>
      JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
    const dateOnly = (v) =>
      v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
    if (
      dateOnly(sel.check_in) !== dateOnly(input.check_in) ||
      dateOnly(sel.check_out) !== dateOnly(input.check_out) ||
      !same(sel.guests, input.guests) ||
      !same(sel.assignments, assignments)
    )
      return reject(fail("quoted_selection_mismatch"));
    const codes = assignments.map((a) => a.bed_code);
    if (new Set(codes).size !== codes.length)
      return reject(fail("duplicate_bed"));
    // Lock deterministic inventory rows before the final eligibility observation.
    const beds = (
      await pg.query(
        `SELECT b.id,b.bed_code,b.room_id FROM beds b JOIN clients c ON c.id=b.client_id WHERE c.slug=$1 AND b.bed_code=ANY($2::text[]) ORDER BY b.id FOR UPDATE OF b`,
        [TENANT, codes],
      )
    ).rows;
    if (beds.length !== codes.length)
      return reject(fail("exact_beds_unavailable"));
    const roomIds = [...new Set(beds.map((b) => b.room_id))].sort();
    await pg.query(
      `SELECT id FROM rooms WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE`,
      [roomIds],
    );
    for (const b of beds)
      await pg.query(
        `SELECT pg_advisory_xact_lock(booking_occupancy_lock_key('bed',$1))`,
        [b.id],
      );
    const current = await revalidateSelection(pg, sel, context);
    if (!current.ok) return reject(current);
    const eligible = await pg.query(
      `SELECT b.bed_code FROM beds b JOIN rooms r ON r.id=b.room_id AND r.client_id=b.client_id WHERE b.id=ANY($1::uuid[]) AND b.active=true AND COALESCE(b.sellable,true)=true AND r.active=true AND COALESCE(r.selling_mode,'shared') IN ('shared','private','private_optional')`,
      [beds.map((b) => b.id)],
    );
    if (eligible.rows.length !== codes.length)
      return reject(fail("exact_beds_unavailable"));
    const conflicts = await pg.query(
      `SELECT b.bed_code FROM beds b WHERE b.id=ANY($1::uuid[]) AND (EXISTS(SELECT 1 FROM booking_beds bb JOIN bookings bk ON bk.id=bb.booking_id WHERE bb.client_id=$2 AND bb.bed_id=b.id AND bb.assignment_start_date<$4::date AND bb.assignment_end_date>$3::date AND bk.status::text NOT IN ('cancelled','expired')) OR EXISTS(SELECT 1 FROM luna_v3_hold_beds hb JOIN luna_v3_holds h ON h.id=hb.hold_id WHERE hb.client_id=$2 AND hb.bed_id=b.id AND h.state='active' AND h.expires_at>clock_timestamp() AND h.check_in<$4::date AND h.check_out>$3::date))`,
      [beds.map((b) => b.id), s.client_id, sel.check_in, sel.check_out],
    );
    if (conflicts.rows.length)
      return reject(
        fail("exact_beds_unavailable", 409, {
          conflicts: conflicts.rows.map((x) => x.bed_code),
        }),
      );
    const h = (
      await pg.query(
        `INSERT INTO luna_v3_holds(client_id,session_id,selection_id,check_in,check_out,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '15 minutes') RETURNING id,expires_at`,
        [s.client_id, s.id, sel.id, sel.check_in, sel.check_out],
      )
    ).rows[0];
    const byCode = new Map(beds.map((b) => [b.bed_code, b]));
    for (let i = 0; i < assignments.length; i++) {
      const a = assignments[i],
        b = byCode.get(a.bed_code);
      await pg.query(
        `INSERT INTO luna_v3_hold_beds(hold_id,client_id,bed_id,guest_ordinal,bed_code,package_code) VALUES($1,$2,$3,$4,$5,$6)`,
        [h.id, s.client_id, b.id, i + 1, a.bed_code, a.package_code || null],
      );
    }
    const receipt = {
      ok: true,
      outcome: "applied",
      operationKey: input.operation_key,
      held: true,
      holdId: h.id,
      expiresAt: h.expires_at,
      assignments,
      quoteRevision: sel.quote_revision,
    };
    await finish(pg, op.row.id, receipt, { holdId: h.id });
    if (ownsTransaction) await pg.query("COMMIT");
    return receipt;
  } catch (e) {
    if (ownsTransaction) await pg.query("ROLLBACK");
    throw e;
  }
}

async function defaultBookingAuthority(pg, selection, key, context) {
  const guests = selection.guests,
    assignments = selection.assignments,
    q = selection.quote;
  const quoteConfig = await require("./index").loadV3DbOnlyQuoteConfig(pg);
  const built = await buildWolfhouseBookingCreateCommand({
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    trustedClientSlug: TENANT,
    pgClient: pg,
    quoteConfig,
    transportBody: {
      confirm: true,
      check_in: selection.check_in,
      check_out: selection.check_out,
      guest_count: guests.length,
      guests: guests.map((g) => ({
        guest_name: g.name || g.guest_name,
        explicit_gender: g.explicit_gender,
      })),
      guest_name: guests[0].name || guests[0].guest_name,
      phone: q.phone,
      selected_bed_codes: assignments.map((a) => a.bed_code),
      guest_packages: assignments.map((a, i) => ({
        guest_number: i + 1,
        package_code: a.package_code || "package_none",
      })),
      add_ons: q.addOns || [],
      package_code: q.packageCode || "package_none",
      payment_choice: "deposit",
      room_type: q.roomType || "shared",
      keep_together: q.keepTogether === true,
      idempotency_key: key,
    },
  });
  if (!built.ok || !built.command) return built;
  const resolver =
    context.staffAuthorities &&
    context.staffAuthorities.resolveBookingAdmission;
  if (typeof resolver !== "function")
    return fail("booking_policy_unavailable", 503);
  return executeWolfhouseBookingCreate(pg, built.command, {
    callerManagedTransaction: true,
    authorizeAutomaticBooking: () =>
      resolver(pg, {
        client_slug: TENANT,
        conversation_id: context.conversationId || null,
        guest_phone: context.guestPhone || null,
      }),
  });
}
async function book(pg, input, context) {
  const s = await session(pg, context, true);
  await pg.query("BEGIN");
  try {
    const op = await beginOperation(pg, s, "book", input.operation_key, input);
    if (op.conflict) {
      await pg.query("ROLLBACK");
      return op.conflict;
    }
    if (op.replay) {
      await pg.query("COMMIT");
      return op.replay;
    }
    await pg.query("SAVEPOINT luna_v3_business");
    const reject = (receipt) => rejectKnown(pg, op, receipt);
    const h = (
      await pg.query(
        `SELECT h.*,row_to_json(sel.*) selection FROM luna_v3_holds h JOIN luna_v3_selections sel ON sel.id=h.selection_id WHERE h.id=$1 AND h.client_id=$2 AND h.session_id=$3 FOR UPDATE OF h`,
        [input.hold_id, s.client_id, s.id],
      )
    ).rows[0];
    if (!h || h.state !== "active" || new Date(h.expires_at) <= new Date())
      return reject(fail("hold_not_active"));
    await pg.query(
      `UPDATE luna_v3_holds SET state='released',updated_at=now() WHERE id=$1`,
      [h.id],
    );
    const current = await revalidateSelection(pg, h.selection, context);
    if (!current.ok) return reject(current);
    const authorityKey = `v3_${fingerprint({ clientId: s.client_id, sessionId: s.id, tool: "book", rawKey: input.operation_key })}`;
    const created = await defaultBookingAuthority(
      pg,
      h.selection,
      authorityKey,
      context,
    );
    if (!created || created.ok !== true)
      return reject(
        fail(
          (created && created.body?.reason_code) || "booking_refused",
          (created && created.status) || 409,
        ),
      );
    const body = created.body || created;
    const bookingId = body.booking_id || body.bookingId;
    const freshlyCreated = created.status === 201 && body.is_duplicate !== true && body.idempotent !== true;
    if (freshlyCreated) await initializeFreshV3UnpaidEvidence(pg, bookingId);
    await pg.query(
      `UPDATE luna_v3_holds SET state='converted',booking_id=$2,updated_at=now() WHERE id=$1`,
      [h.id, bookingId],
    );
    await pg.query(
      `UPDATE luna_v3_sessions SET selected_booking_id=$2,updated_at=now() WHERE id=$1`,
      [s.id, bookingId],
    );
    const b = (
      await pg.query(
        `SELECT id,booking_code,status::text,payment_status::text,total_amount_cents,deposit_required_cents,amount_paid_cents,balance_due_cents FROM bookings WHERE id=$1`,
        [bookingId],
      )
    ).rows[0];
    const guestMoney = (
      await pg.query(
        `SELECT guest_number,deposit_amount_cents FROM booking_guests WHERE booking_id=$1 ORDER BY guest_number`,
        [bookingId],
      )
    ).rows;
    if (
      b.total_amount_cents !== h.selection.quote.totalCents ||
      b.deposit_required_cents !== h.selection.quote.depositCents ||
      guestMoney.length !== h.selection.quote.perPerson.length ||
      guestMoney.some(
        (g, i) =>
          Number(g.guest_number) !== i + 1 ||
          Number(h.selection.quote.perPerson[i].guest_number) !== i + 1 ||
          Number(g.deposit_amount_cents) !==
            Number(h.selection.quote.perPerson[i].deposit_cents),
      )
    )
      throw new Error("booking_money_drift_from_accepted_offer");
    const receipt = {
      ok: true,
      outcome: "applied",
      operationKey: input.operation_key,
      authorityKey,
      bookingId: b.id,
      bookingCode: b.booking_code,
      consumedHoldId: h.id,
      status: b.status,
      paymentStatus: ["not_requested", "waiting_payment"].includes(
        b.payment_status,
      )
        ? "unpaid"
        : b.payment_status,
      totalCents: b.total_amount_cents,
      depositCents: b.deposit_required_cents,
      paidCents: b.amount_paid_cents || 0,
      owedCents: b.balance_due_cents,
      assignments: h.selection.assignments,
      guests: h.selection.guests,
      addOns: h.selection.quote.addOns || [],
    };
    if (receipt.status !== "confirmed")
      throw new Error("booking authority did not persist confirmed booking");
    await finish(pg, op.row.id, receipt, { bookingId, holdId: h.id });
    await pg.query("COMMIT");
    return receipt;
  } catch (e) {
    await pg.query("ROLLBACK");
    throw e;
  }
}
async function getBooking(pg, input, context) {
  const s = await session(pg, context, false);
  if (!s.selected_booking_id) return fail("booking_not_selected", 404);
  const r = await pg.query(
    `SELECT b.booking_code,b.metadata->'add_ons_at_create' add_ons,b.check_in,b.check_out,b.status::text,payment_status::text,b.total_amount_cents,b.deposit_required_cents,COALESCE(b.amount_paid_cents,0) paid_cents,b.balance_due_cents,b.updated_at,COALESCE((SELECT jsonb_agg(jsonb_build_object('guestNumber',bg.guest_number,'guestName',bg.guest_name,'bedCode',bg.assigned_bed_code,'roomCode',bg.assigned_room_code,'packageCode',COALESCE(bg.metadata->>'package_code',b.metadata->'guest_packages'->(bg.guest_number-1)->>'package_code')) ORDER BY bg.guest_number,bg.id) FROM booking_guests bg WHERE bg.booking_id=b.id AND bg.client_id=b.client_id),'[]') assignments FROM bookings b WHERE b.id=$1 AND b.client_id=$2`,
    [s.selected_booking_id, s.client_id],
  );
  if (!r.rows[0]) return fail("selected_booking_missing", 404);
  const row = r.rows[0];
  if (input.booking_reference && input.booking_reference !== row.booking_code)
    return fail("booking_selector_forbidden", 403);
  return {
    ok: true,
    bookingReference: row.booking_code,
    checkIn: row.check_in,
    checkOut: row.check_out,
    status: row.status,
    totalCents: Number(row.total_amount_cents),
    depositCents: Number(row.deposit_required_cents),
    paidCents: Number(row.paid_cents),
    balanceDueCents: Number(row.balance_due_cents),
    updatedAt: row.updated_at,
    assignments: row.assignments || [],
    addOns: row.add_ons || [],
    paymentStatus: ["not_requested", "waiting_payment"].includes(
      row.payment_status,
    )
      ? "unpaid"
      : row.payment_status,
  };
}
async function recoverOperation(pg, input, context) {
  const s = await session(pg, context, false);
  const r = await pg.query(
    `SELECT tool,operation_key,request_fingerprint,outcome,receipt,booking_id,hold_id FROM luna_v3_operations WHERE client_id=$1 AND session_id=$2 AND tool=$3 AND operation_key=$4`,
    [s.client_id, s.id, input.tool, input.operation_key],
  );
  if (r.rows.length !== 1)
    return {
      ok: false,
      status: 200,
      recoveryStatus: "unknown",
      outcome: "unknown",
      readBack: true,
      tool: input.tool,
      operationKey: input.operation_key,
    };
  const o = r.rows[0];
  const booking = o.booking_id
    ? (
        await pg.query(
          `SELECT id,booking_code,status::text FROM bookings WHERE id=$1 AND client_id=$2`,
          [o.booking_id, s.client_id],
        )
      ).rows[0] || null
    : null;
  const hold = o.hold_id
    ? (
        await pg.query(
          `SELECT id,state,booking_id FROM luna_v3_holds WHERE id=$1 AND client_id=$2 AND session_id=$3`,
          [o.hold_id, s.client_id, s.id],
        )
      ).rows[0] || null
    : null;
  if (
    (o.booking_id && !booking) ||
    (o.hold_id && !hold) ||
    (o.receipt &&
      o.receipt.bookingId &&
      o.receipt.bookingId !== o.booking_id) ||
    (o.receipt && o.receipt.holdId && o.receipt.holdId !== o.hold_id) ||
    (o.receipt &&
      o.receipt.consumedHoldId &&
      o.receipt.consumedHoldId !== o.hold_id)
  )
    return {
      ok: false,
      status: 409,
      recoveryStatus: "inconsistent",
      outcome: "unknown",
      readBack: true,
      requestFingerprint: o.request_fingerprint,
    };
  if (o.receipt)
    return {
      ok: true,
      status: 200,
      recoveryStatus: o.outcome === "rejected" ? "rejected" : "saved",
      outcome: o.outcome,
      readBack: true,
      tool: o.tool,
      operationKey: o.operation_key,
      requestFingerprint: o.request_fingerprint,
      receipt: o.receipt,
      booking,
      hold,
    };
  return {
    ok: false,
    status: 200,
    recoveryStatus: "unknown",
    outcome: "unknown",
    readBack: true,
    tool: o.tool,
    operationKey: o.operation_key,
    requestFingerprint: o.request_fingerprint,
    booking,
    hold,
  };
}
async function releaseHold(pg, input, context) {
  const s = await session(pg, context, true);
  await pg.query("BEGIN");
  try {
    const op = await beginOperation(
      pg,
      s,
      "release_hold",
      input.operation_key,
      input,
    );
    if (op.conflict) {
      await pg.query("ROLLBACK");
      return op.conflict;
    }
    if (op.replay) {
      await pg.query("COMMIT");
      return op.replay;
    }
    await pg.query("SAVEPOINT luna_v3_business");
    const h = (
      await pg.query(
        `SELECT h.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('bed_code',hb.bed_code,'guest_ordinal',hb.guest_ordinal) ORDER BY hb.guest_ordinal) FROM luna_v3_hold_beds hb WHERE hb.hold_id=h.id),'[]') assignments FROM luna_v3_holds h WHERE h.id=$1 AND h.client_id=$2 AND h.session_id=$3 FOR UPDATE OF h`,
        [input.hold_id, s.client_id, s.id],
      )
    ).rows[0];
    if (!h || h.state === "converted")
      return rejectKnown(pg, op, fail("hold_not_releasable", 409));
    const already = h.state === "released";
    if (!already)
      await pg.query(
        `UPDATE luna_v3_holds SET state='released',updated_at=now() WHERE id=$1`,
        [h.id],
      );
    const receipt = {
      ok: true,
      outcome: "applied",
      holdId: h.id,
      released: !already,
      alreadyReleased: already,
      assignments: h.assignments,
    };
    await finish(pg, op.row.id, receipt, { holdId: h.id });
    await pg.query("COMMIT");
    return receipt;
  } catch (e) {
    await pg.query("ROLLBACK");
    throw e;
  }
}
async function persistHandoff(pg, s, input) {
  const op = await beginOperation(
    pg,
    s,
    "handoff_to_human",
    input.operation_key,
    input,
  );
  if (op.conflict) return op.conflict;
  if (op.replay) return op.replay;
  await pg.query("SAVEPOINT luna_v3_business");
  if (input.booking_id && input.booking_id !== s.selected_booking_id)
    return rejectKnown(pg, op, fail("booking_selector_forbidden", 403));
  const h = (
    await pg.query(
      `INSERT INTO luna_v3_handoffs(client_id,session_id,booking_id,reason,context) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id`,
      [
        s.client_id,
        s.id,
        s.selected_booking_id,
        input.reason,
        JSON.stringify(input.context || {}),
      ],
    )
  ).rows[0];
  const receipt = {
    ok: true,
    outcome: "applied",
    operationKey: input.operation_key,
    handoffId: h.id,
    reason: input.reason,
    bookingId: s.selected_booking_id,
    sent: false,
    externalSendAllowed: false,
    staffAlertAllowed: false,
  };
  return finish(pg, op.row.id, receipt, { bookingId: s.selected_booking_id });
}
async function handoffToHuman(pg, input, context) {
  const s = await session(pg, context, true);
  await pg.query("BEGIN");
  try {
    const receipt = await persistHandoff(pg, s, input);
    await pg.query("COMMIT");
    return receipt;
  } catch (e) {
    await pg.query("ROLLBACK");
    throw e;
  }
}

function selected(s, input) {
  if (!s.selected_booking_id) return fail("booking_not_selected", 404);
  if (input.booking_id && input.booking_id !== s.selected_booking_id)
    return fail("booking_selector_forbidden", 403);
  return null;
}
async function selectedByPublicReference(pg, s, input) {
  if (!s.selected_booking_id) return { denied: fail("booking_not_selected", 404) };
  const booking = (await pg.query(
    `SELECT id,booking_code FROM bookings WHERE id=$1 AND client_id=$2`,
    [s.selected_booking_id, s.client_id],
  )).rows[0];
  if (!booking) return { denied: fail("selected_booking_missing", 404) };
  // Public contracts reject internal IDs. Keep this compatibility branch only
  // for trusted direct module callers while every registered tool uses the code.
  if (input.booking_id !== undefined)
    return input.booking_id === s.selected_booking_id ? { booking } : { denied: fail("booking_selector_forbidden", 403) };
  if (String(input.booking_reference || '').trim().toUpperCase() !== String(booking.booking_code).toUpperCase())
    return { denied: fail("booking_selector_forbidden", 403) };
  return { booking };
}
const NATIVE_STAFF_PAYMENT_SOURCES = Object.freeze({
  cash: "staff_cash",
  bank_transfer: "staff_bank_transfer",
  in_store: "staff_in_store",
});

function nativeStaffReceiptHasTrustedProvenance(payment) {
  const metadata = payment && payment.metadata;
  if (!metadata || !Object.prototype.hasOwnProperty.call(NATIVE_STAFF_PAYMENT_SOURCES, metadata.method))
    return false;
  return (
    payment.status === "paid" &&
    payment.amount_paid_cents > 0 &&
    NATIVE_STAFF_PAYMENT_SOURCES[metadata.method] === metadata.source &&
    metadata.staff_portal === true &&
    metadata.payment_scope === "guest" &&
    metadata.booking_guest_id === payment.booking_guest_id &&
    typeof metadata.idempotency_key === "string" &&
    metadata.idempotency_key.length > 0
  );
}

async function getPaymentStatus(pg, input, context) {
  const s = await session(pg, context);
  const selectedPublic = await selectedByPublicReference(pg, s, input);
  if (selectedPublic.denied) return selectedPublic.denied;
  const b = (
    await pg.query(
      `SELECT id,booking_code,status::text booking_status,payment_status::text,total_amount_cents,deposit_required_cents,COALESCE(amount_paid_cents,0) paid_cents,balance_due_cents,updated_at FROM bookings WHERE id=$1 AND client_id=$2`,
      [s.selected_booking_id, s.client_id],
    )
  ).rows[0];
  if (!b) return fail("selected_booking_missing", 404);
  const payments = (
    await pg.query(
      `SELECT to_jsonb(p) row FROM payments p WHERE p.client_id=$1 AND p.booking_id=$2 ORDER BY p.created_at,p.id`,
      [s.client_id, b.id],
    )
  ).rows.map((x) => x.row);
  const guests = (
    await pg.query(
      `SELECT id,guest_number,guest_name,payment_id,payment_status::text,amount_paid_cents,deposit_amount_cents FROM booking_guests WHERE client_id=$1 AND booking_id=$2 ORDER BY guest_number,id`,
      [s.client_id, b.id],
    )
  ).rows;
  const events = (
    await pg.query(
      `SELECT id,payment_id,event_type FROM payment_events WHERE client_id=$1 AND booking_id=$2 ORDER BY id`,
      [s.client_id, b.id],
    )
  ).rows;
  const associations = (
    await pg.query(
      `SELECT booking_guest_id::text,payment_id::text FROM luna_v3_guest_payments WHERE client_id=$1 AND booking_id=$2 UNION SELECT booking_guest_id::text,id::text FROM payments WHERE client_id=$1 AND booking_id=$2 AND booking_guest_id IS NOT NULL ORDER BY payment_id`,
      [s.client_id, b.id],
    )
  ).rows;
  const nums = [
    b.total_amount_cents,
    b.deposit_required_cents,
    b.paid_cents,
    b.balance_due_cents,
  ];
  let evidenceStatus = nums.every(Number.isSafeInteger)
    ? "consistent"
    : "unknown";
  const currencies = [
    ...new Set(
      payments
        .map((p) =>
          String(p.currency || "")
            .trim()
            .toUpperCase(),
        )
        .filter(Boolean),
    ),
  ];
  if (
    !payments.length ||
    payments.some(
      (p) =>
        p.booking_id !== b.id ||
        p.client_id !== s.client_id ||
        !Number.isSafeInteger(p.amount_due_cents) ||
        !Number.isSafeInteger(p.amount_paid_cents),
    )
  )
    evidenceStatus = evidenceStatus === "unknown" ? "unknown" : "inconsistent";
  if (currencies.length !== 1)
    evidenceStatus = currencies.length ? "inconsistent" : "unknown";
  const paymentRowPaid = (p) =>
    /^(paid|succeeded|captured|partial|partially_paid)$/i.test(
      String(p.status || ""),
    );
  const successful = (e) =>
    /^(succeeded|paid|captured|checkout\.session\.(?:completed|async_payment_succeeded))$/i.test(
      String(e.event_type || ""),
    );
  // Native Staff receipts have no provider event. Admit only the exact
  // method/source pairs written by recordStaffManualPayment.
  const nativeStaffReceipt = nativeStaffReceiptHasTrustedProvenance;
  const associationFor = (paymentId) =>
    associations.filter((a) => a.payment_id === paymentId);
  const bookingScoped = (payment) =>
    !payment.booking_guest_id && payment.metadata && payment.metadata.payment_scope === "booking";
  const paidForGuest = (guestId) =>
    payments
      .filter((p) =>
        associationFor(p.id).some((a) => a.booking_guest_id === guestId),
      )
      .reduce((n, p) => n + p.amount_paid_cents, 0);
  const bookingMoneyIsValid =
    !nums.some((n) => n < 0) &&
    b.deposit_required_cents <= b.total_amount_cents &&
    b.paid_cents + b.balance_due_cents === b.total_amount_cents;
  const paymentRowsAreValid = !payments.some(
    (p) =>
      p.amount_due_cents < 0 ||
      p.amount_paid_cents < 0 ||
      p.amount_paid_cents > p.amount_due_cents ||
      (p.amount_paid_cents > 0 && !paymentRowPaid(p)) ||
      (p.amount_paid_cents === 0 && paymentRowPaid(p)),
  );
  const paymentTotalMatches =
    payments.reduce((n, p) => n + p.amount_paid_cents, 0) === b.paid_cents;
  const associationsAreValid =
    !associations.some(
      (a) =>
        !payments.some((p) => p.id === a.payment_id) ||
        !guests.some((g) => g.id === a.booking_guest_id),
    ) &&
    !payments.some((p) => associationFor(p.id).length > 1) &&
    !payments.some((p) => p.amount_paid_cents > 0 && (
      bookingScoped(p) ? associationFor(p.id).length !== 0 : associationFor(p.id).length !== 1
    ));
  const guestRowsAreValid = !guests.some(
    (g) =>
      ![g.amount_paid_cents, g.deposit_amount_cents].every(
        Number.isSafeInteger,
      ) ||
      g.amount_paid_cents < 0 ||
      g.deposit_amount_cents < 0 ||
      g.amount_paid_cents !== paidForGuest(g.id),
  );
  const bookingScopedPaid = payments
    .filter(bookingScoped)
    .reduce((n, p) => n + p.amount_paid_cents, 0);
  const guestTotalMatches =
    guests.reduce((n, g) => n + g.amount_paid_cents, 0) + bookingScopedPaid === b.paid_cents;
  const paidPaymentsHaveEvidence = !payments.some(
    (p) =>
      p.amount_paid_cents > 0 &&
      !nativeStaffReceipt(p) &&
      !events.some((e) => e.payment_id === p.id && successful(e)),
  );
  const eventsAreValid =
    !events.some(
      (e) => e.payment_id && !payments.some((p) => p.id === e.payment_id),
    ) &&
    !events.some(
      (e) =>
        successful(e) &&
        (!e.payment_id ||
          !payments.some(
            (p) => p.id === e.payment_id && p.amount_paid_cents > 0,
          )),
    );
  const statusesMatchAmounts =
    !guests.some(
      (g) =>
        /(deposit_paid|paid)/i.test(g.payment_status || "") &&
        g.amount_paid_cents <= 0,
    ) &&
    !guests.some(
      (g) =>
        g.amount_paid_cents > 0 &&
        !/(deposit_paid|paid)/i.test(g.payment_status || ""),
    ) &&
    (!/(deposit_paid|paid)/i.test(b.payment_status || "") ||
      b.paid_cents > 0) &&
    (b.booking_status !== "cancelled" || b.paid_cents <= 0);
  const consistencyChecks = [
    bookingMoneyIsValid,
    paymentRowsAreValid,
    paymentTotalMatches,
    associationsAreValid,
    guestRowsAreValid,
    guestTotalMatches,
    paidPaymentsHaveEvidence,
    eventsAreValid,
    statusesMatchAmounts,
  ];
  if (evidenceStatus === "consistent" && !consistencyChecks.every(Boolean))
    evidenceStatus = "inconsistent";
  const rev = fingerprint({
    booking: b,
    payments,
    guests,
    events,
    associations,
  });
  return {
    ok: true,
    bookingId: b.id,
    bookingCode: b.booking_code,
    paymentIds: payments.map((p) => p.id),
    payments,
    guests,
    events,
    totalCents: b.total_amount_cents,
    paidCents: b.paid_cents,
    owedCents: b.balance_due_cents,
    depositRequiredCents: b.deposit_required_cents,
    currency: evidenceStatus === "consistent" ? currencies[0] : null,
    evidenceStatus,
    evidenceRevision: rev,
    paymentStatus:
      evidenceStatus === "consistent"
        ? b.paid_cents >= b.total_amount_cents
          ? "paid"
          : b.paid_cents > 0
            ? "partial"
            : "unpaid"
        : "unknown",
  };
}
async function cancelUnpaid(pg, input, context) {
  const s = await session(pg, context, true);
  const selectedPublic = await selectedByPublicReference(pg, s, input);
  if (selectedPublic.denied) return selectedPublic.denied;
  await pg.query("BEGIN");
  try {
    const op = await beginOperation(
      pg,
      s,
      "cancel_unpaid",
      input.operation_key,
      input,
    );
    if (op.conflict) {
      await pg.query("ROLLBACK");
      return op.conflict;
    }
    if (op.replay) {
      await pg.query("COMMIT");
      return op.replay;
    }
    // Prepare is durable before any provider request. Finalization below locks
    // and rechecks all money evidence in a new transaction.
    await pg.query("COMMIT");
    let providerBlock = null;
    const checkoutRows = (await pg.query(`SELECT DISTINCT COALESCE(NULLIF(to_jsonb(p)->>'stripe_checkout_session_id',''),
      NULLIF(p.metadata->>'stripe_checkout_session_id',''),NULLIF(p.metadata->>'stripe_session_id','')) checkout_id
      FROM payments p WHERE p.client_id=$1 AND p.booking_id=$2`, [s.client_id, s.selected_booking_id])).rows
      .map((row) => row.checkout_id).filter(Boolean);
    const authorities = context.staffAuthorities || {};
    if (checkoutRows.length && (typeof authorities.readCancellationCheckout !== 'function'
        || typeof authorities.expireCancellationCheckout !== 'function')) providerBlock = 'provider_reconciliation_unavailable';
    const retiredCheckoutIds = [];
    for (const checkoutId of providerBlock ? [] : checkoutRows) {
      try {
        const before = await authorities.readCancellationCheckout(checkoutId);
        const md = before && before.metadata || {};
        if (!before || before.id !== checkoutId || before.livemode !== false
            || md.client_slug !== TENANT || md.booking_id !== s.selected_booking_id
            || String(before.payment_status).toLowerCase() !== 'unpaid') { providerBlock = 'provider_payment_evidence_unknown'; break; }
        if (before.status === 'open') await authorities.expireCancellationCheckout(checkoutId);
        const after = await authorities.readCancellationCheckout(checkoutId);
        if (!after || after.id !== checkoutId || after.status !== 'expired'
            || String(after.payment_status).toLowerCase() !== 'unpaid') { providerBlock = 'provider_expiration_unverified'; break; }
        retiredCheckoutIds.push(checkoutId);
      } catch (_) { providerBlock = 'provider_reconciliation_unavailable'; break; }
    }
    if (!providerBlock && retiredCheckoutIds.length) {
      await pg.query(`UPDATE payments SET status='expired'::payment_record_status,
        stripe_checkout_session_id=NULL,checkout_url=NULL,
        metadata=(COALESCE(metadata,'{}'::jsonb) - 'stripe_checkout_session_id' - 'stripe_session_id' - 'checkout_url' - 'provider_idempotency_key' - 'idempotency_key' - 'checkout_preparation')
        WHERE client_id=$1 AND booking_id=$2 AND COALESCE(NULLIF(stripe_checkout_session_id,''),NULLIF(metadata->>'stripe_checkout_session_id',''),NULLIF(metadata->>'stripe_session_id',''))=ANY($3::text[])`,
      [s.client_id, s.selected_booking_id, retiredCheckoutIds]);
    }
    await pg.query("BEGIN");
    const currentOp = (await pg.query(`SELECT request_fingerprint,receipt FROM luna_v3_operations WHERE id=$1 FOR UPDATE`, [op.row.id])).rows[0];
    if (!currentOp || currentOp.request_fingerprint !== op.fp) throw new Error('cancel_operation_identity_changed');
    if (currentOp.receipt) { await pg.query('COMMIT'); return currentOp.receipt; }
    const b = (
      await pg.query(
        `SELECT booking_code,phone FROM bookings WHERE id=$1 AND client_id=$2`,
        [s.selected_booking_id, s.client_id],
      )
    ).rows[0];
    if (!b) {
      await pg.query("ROLLBACK");
      return fail("selected_booking_missing", 404);
    }
    const occupiedBefore = (
      await pg.query(
        `SELECT count(*)::int n FROM booking_beds bb JOIN bookings b ON b.id=bb.booking_id AND b.client_id=bb.client_id WHERE b.id=$1 AND b.status::text NOT IN ('cancelled','expired')`,
        [s.selected_booking_id],
      )
    ).rows[0].n;
    const result = providerBlock ? { blocked: true, reason: providerBlock } : await executeGuestUnpaidCancellationBoundary(pg, {
      clientSlug: TENANT,
      bookingCode: b.booking_code,
      phone: b.phone,
    }, { trustedV3: true });
    let receipt;
    if (result.blocked) {
      const handoffInput = {
        operation_key: `cancel-refusal:${op.row.id}`,
        booking_id: s.selected_booking_id,
        reason: "cancel_unpaid_refused",
        context: {
          guest_reason: input.guest_reason,
          refusal: result.reason,
          parent_operation_id: op.row.id,
        },
      };
      const h = await persistHandoff(pg, s, handoffInput);
      if (!h.ok) throw new Error(`cancel refusal handoff failed: ${h.code}`);
      receipt = {
        ok: false,
        outcome: "rejected",
        code: "cancel_unpaid_refused",
        status: 409,
        cancelled: false,
        reason: result.reason,
        requiredHumanHandoff: true,
        handoffId: h.handoffId,
        handoffOperationKey: h.operationKey,
        sent: false,
        externalSendAllowed: false,
        staffAlertAllowed: false,
      };
    } else {
      const occupiedAfter = (
        await pg.query(
          `SELECT count(*)::int n FROM booking_beds bb JOIN bookings b ON b.id=bb.booking_id AND b.client_id=bb.client_id WHERE b.id=$1 AND b.status::text NOT IN ('cancelled','expired')`,
          [s.selected_booking_id],
        )
      ).rows[0].n;
      receipt = {
        ok: true,
        outcome: "applied",
        cancelled: true,
        bookingId: s.selected_booking_id,
        releasedBedCount: occupiedBefore - occupiedAfter,
      };
    }
    await finish(pg, op.row.id, receipt, { bookingId: s.selected_booking_id });
    await pg.query("COMMIT");
    return receipt;
  } catch (e) {
    await pg.query("ROLLBACK");
    throw e;
  }
}
async function readNotes(pg, input, context) {
  const s = await session(pg, context);
  if (input.booking_reference) {
    const selectedPublic = await selectedByPublicReference(pg, s, input);
    if (selectedPublic.denied) return selectedPublic.denied;
  }
  const shared = await getHouseNotes(pg, { clientSlug: TENANT });
  const rows = (
    await pg.query(
      `SELECT id,text,context,version,booking_id,created_at FROM luna_v3_notes WHERE client_id=$1 AND session_id=$2 AND (booking_id IS NULL OR booking_id=$3) AND ($4::text IS NULL OR context->>'topic'=$4) ORDER BY created_at,id`,
      [s.client_id, s.id, s.selected_booking_id, input.topic || null],
    )
  ).rows;
  return {
    ok: true,
    generalNotes: {
      source: "tenant_house_notes",
      readOnly: true,
      available: shared.ok === true && shared.found === true,
      missingReason: shared.ok ? null : shared.reason,
      version: shared.updated_at || null,
      text: shared.notes,
    },
    scopedNotes: rows.map((r) => ({
      ...r,
      scope: r.booking_id ? "selected-booking" : "session",
      source: "luna_v3_notes",
    })),
  };
}
async function writeNote(pg, input, context) {
  const s = await session(pg, context, true);
  if (input.booking_reference) {
    const selectedPublic = await selectedByPublicReference(pg, s, input);
    if (selectedPublic.denied) return selectedPublic.denied;
  }
  await pg.query("BEGIN");
  try {
    const op = await beginOperation(
      pg,
      s,
      "write_note",
      input.operation_key,
      input,
    );
    if (op.conflict) {
      await pg.query("ROLLBACK");
      return op.conflict;
    }
    if (op.replay) {
      await pg.query("COMMIT");
      return op.replay;
    }
    const bookingId = input.booking_reference ? s.selected_booking_id : null;
    const n = (
      await pg.query(
        `INSERT INTO luna_v3_notes(client_id,session_id,booking_id,operation_id,text,context) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id,version`,
        [
          s.client_id,
          s.id,
          bookingId,
          op.row.id,
          input.text,
          JSON.stringify(input.context || {}),
        ],
      )
    ).rows[0];
    const receipt = {
      ok: true,
      outcome: "applied",
      noteId: n.id,
      scope: bookingId ? "selected-booking" : "session",
      source: "luna_v3_notes",
      version: n.version,
      replacedSharedHouseNotes: false,
    };
    await finish(pg, op.row.id, receipt, { bookingId });
    await pg.query("COMMIT");
    return receipt;
  } catch (e) {
    await pg.query("ROLLBACK");
    throw e;
  }
}
async function saveTransferRequest(pg, input, context) {
  const s = await session(pg, context, true);
  const selectedPublic = await selectedByPublicReference(pg, s, input);
  if (selectedPublic.denied) return selectedPublic.denied;
  if (!["requested", "declined"].includes(input.decision))
    return fail("invalid_transfer_decision", 400);
  await pg.query("BEGIN");
  try {
    const op = await beginOperation(
      pg,
      s,
      "save_transfer_request",
      input.operation_key,
      input,
    );
    if (op.conflict) {
      await pg.query("ROLLBACK");
      return op.conflict;
    }
    if (op.replay) {
      await pg.query("COMMIT");
      return op.replay;
    }
    await pg.query("SAVEPOINT luna_v3_business");
    const details = input.travel_details || {};
    let authoritative = null;
    if (input.decision === "requested") {
      const missing = ["airport", "date", "time"].filter(
        (k) => !String(details[k] || "").trim(),
      );
      if (missing.length) {
        const receipt = {
          ok: false,
          outcome: "rejected",
          status: 422,
          code: "transfer_details_incomplete",
          decision: "requested",
          missingFields: missing,
          question: `Please provide ${missing.join(", ")}`,
          sent: false,
          driverConfirmed: false,
        };
        await finish(pg, op.row.id, receipt, {
          bookingId: s.selected_booking_id,
        });
        await pg.query("COMMIT");
        return receipt;
      }
      const booking = (
        await pg.query(
          `SELECT id,guest_count,package_code,check_in,check_out,total_amount_cents,deposit_required_cents,balance_due_cents FROM bookings WHERE id=$1 AND client_id=$2 FOR UPDATE`,
          [s.selected_booking_id, s.client_id],
        )
      ).rows[0];
      if (!booking) {
        await pg.query("ROLLBACK");
        return fail("selected_booking_missing", 404);
      }
      const rawDirection = String(details.direction || "arrival").toLowerCase();
      const direction = ["departure", "dropoff"].includes(rawDirection)
        ? "departure"
        : "arrival";
      let scheduledAt = details.scheduled_at || details.datetime || null;
      if (!scheduledAt && details.date && details.time)
        scheduledAt = madridWallTime(details.date, details.time);
      let transferConfig;
      try {
        transferConfig = await loadStaffTransferConfig(pg, TENANT);
      } catch (e) {
        return rejectKnown(
          pg,
          op,
          fail("staff_transfer_pricing_unavailable", 503),
        );
      }
      authoritative = await upsertBookingTransfer(pg, {
        client_slug: TENANT,
        booking_id: s.selected_booking_id,
        direction,
        booking,
        source: "luna",
        resolvedConfig: transferConfig,
        transfer: {
          status: "requested",
          airport_code: details.airport || details.airport_code || null,
          flight_number: details.flight || details.flight_number || null,
          scheduled_at: scheduledAt,
          guest_count: details.passengers ?? null,
          notes: JSON.stringify(details),
        },
      });
      if (authoritative.price_cents == null)
        return rejectKnown(
          pg,
          op,
          fail("staff_transfer_pricing_unavailable", 422),
        );
    } else {
      const rawDirection = String(details.direction || "arrival").toLowerCase();
      const direction = ["departure", "dropoff"].includes(rawDirection)
        ? "departure"
        : "arrival";
      authoritative =
        (
          await pg.query(
            `UPDATE booking_transfers SET status='declined',updated_at=now() WHERE client_slug=$1 AND booking_id=$2 AND direction=$3 RETURNING id,price_cents,currency`,
            [TENANT, s.selected_booking_id, direction],
          )
        ).rows[0] || null;
      if (!authoritative)
        return rejectKnown(
          pg,
          op,
          fail("authoritative_transfer_not_found", 409),
        );
    }
    const t = (
      await pg.query(
        `INSERT INTO luna_v3_transfer_requests(id,client_id,session_id,booking_id,operation_id,authoritative_transfer_id,decision,travel_details,state) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id`,
        [
          s.client_id,
          s.id,
          s.selected_booking_id,
          op.row.id,
          (authoritative && authoritative.id) || null,
          input.decision,
          JSON.stringify(details),
          input.decision === "declined" ? "declined" : "pending",
        ],
      )
    ).rows[0];
    const receipt = {
      ok: true,
      outcome: "applied",
      transferId: t.id,
      authoritativeTransferId: (authoritative && authoritative.id) || null,
      bookingId: s.selected_booking_id,
      decision: input.decision,
      travelDetails: details,
      state: input.decision === "declined" ? "declined" : "pending",
      pricedCents: (authoritative && authoritative.price_cents) ?? null,
      currency:
        authoritative && authoritative.price_cents != null
          ? authoritative.currency
          : null,
      driverConfirmed: false,
      sent: false,
    };
    await finish(pg, op.row.id, receipt, { bookingId: s.selected_booking_id });
    await pg.query("COMMIT");
    return receipt;
  } catch (e) {
    await pg.query("ROLLBACK");
    throw e;
  }
}
async function sendPaymentLinkAuthoritative(pg, input, context) {
  const s = await session(pg, context, true);
  /* Persist identity before any selector decision or provider call.  This makes
    bounded 403/zero outcomes replayable and makes changed selectors conflict. */
  await pg.query("BEGIN");
  let op;
  try {
    op = await beginOperation(
      pg,
      s,
      "send_payment_link",
      input.operation_key,
      input,
    );
    if (op.conflict) {
      await pg.query("ROLLBACK");
      return op.conflict;
    }
    if (op.replay) {
      await pg.query("COMMIT");
      return op.replay;
    }
    await pg.query("COMMIT");
  } catch (e) {
    await pg.query("ROLLBACK");
    throw e;
  }
  const reject = async (receipt, ids = {}) => {
    await pg.query("BEGIN");
    try {
      const current = (
        await pg.query(
          `SELECT request_fingerprint,receipt FROM luna_v3_operations WHERE id=$1 FOR UPDATE`,
          [op.row.id],
        )
      ).rows[0];
      if (!current || current.request_fingerprint !== op.fp)
        throw new Error("payment_link_operation_identity_changed");
      if (current.receipt) {
        await pg.query("COMMIT");
        return current.receipt;
      }
      const saved = { ...receipt, outcome: "rejected" };
      await finish(pg, op.row.id, saved, ids);
      await pg.query("COMMIT");
      return saved;
    } catch (e) {
      await pg.query("ROLLBACK");
      throw e;
    }
  };
  const selectedPublic = await selectedByPublicReference(pg, s, input);
  if (selectedPublic.denied) return reject(selectedPublic.denied);
  const scope = input.payment_scope || (input.guest_position || input.guest_id ? 'individual' : null);
  if (!["deposit", "full", "balance"].includes(input.payment_choice))
    return reject(fail("unsupported_payment_choice", 400));
  if (!scope) return reject(fail("payment_scope_required", 400));
  if (!['individual', 'booking'].includes(scope)) return reject(fail("unsupported_payment_scope", 400));
  if (scope === 'booking' && (input.guest_position !== undefined || input.guest_id !== undefined)) return reject(fail("guest_selector_forbidden_for_booking_scope", 400));
  if (scope === 'individual' && input.guest_id === undefined && (!Number.isSafeInteger(input.guest_position) || input.guest_position < 1))
    return reject(fail("invalid_guest_position", 400));
  const authorities = context.staffAuthorities || {};
  if (scope === 'booking') {
    if (typeof authorities.createBookingCheckout !== 'function' || typeof authorities.readBookingCheckout !== 'function')
      return reject(fail("staff_payment_link_authority_unavailable", 503));
    let checkout;
    try {
      checkout = await authorities.createBookingCheckout({ bookingId: s.selected_booking_id,
        paymentChoice: input.payment_choice, operationKey: input.operation_key, principalId: context.principalId });
    } catch (e) {
      // A provider timeout is not evidence that creation failed. Recover by the
      // same authoritative operation key before returning an ambiguous result.
      try {
        checkout = await authorities.readBookingCheckout({ bookingId: s.selected_booking_id,
          paymentChoice: input.payment_choice, operationKey: input.operation_key, principalId: context.principalId });
      } catch (_) { /* preserve the original provider uncertainty below */ }
      if (!checkout || !checkout.paymentId || !checkout.checkoutId || !checkout.url) {
        return fail(e.code || e.message || "staff_payment_link_failed", e.httpStatus || 503,
          { recoveryStatus: "ambiguous", operationKey: input.operation_key });
      }
    }
    const provider = checkout && checkout.provider;
    const providerMetadata = provider && provider.metadata || {};
    const providerValid = provider && provider.id === checkout.checkoutId && provider.url === checkout.url
      && provider.livemode === false && provider.status === 'open'
      && String(provider.payment_status || '').toLowerCase() === 'unpaid'
      && Number(provider.expires_at) > Math.floor(Date.now() / 1000)
      && require('../per-guest-checkout').validUrl(provider.url)
      && provider.amount_total === checkout.amountCents
      && String(provider.currency || '').toUpperCase() === String(checkout.currency || '').toUpperCase()
      && providerMetadata.client_slug === TENANT
      && providerMetadata.booking_id === String(s.selected_booking_id)
      && providerMetadata.payment_id === String(checkout.paymentId)
      && providerMetadata.payment_scope === 'booking';
    if (!checkout || !checkout.paymentId || !checkout.checkoutId || !checkout.url
        || checkout.amountCents <= 0 || String(checkout.currency || '').toUpperCase() !== 'EUR'
        || !providerValid)
      return reject(fail('provider_readback_invalid', 503));
    const receipt = { ok: true, outcome: 'applied', operationKey: input.operation_key,
      paymentScope: 'booking', bookingId: s.selected_booking_id, paymentId: checkout.paymentId,
      amountCents: checkout.amountCents, currency: checkout.currency, url: checkout.url,
      checkoutId: checkout.checkoutId, mode: 'test', sent: false,
      externalSendAllowed: false, staffAlertAllowed: false };
    await pg.query('BEGIN');
    try {
      await pg.query(`INSERT INTO luna_v3_payment_links(client_id,session_id,booking_id,operation_id,payment_id,booking_guest_id,payment_scope,payment_choice,amount_cents,currency,provider_checkout_id,provider_url,provider_livemode,provider_readback) VALUES($1,$2,$3,$4,$5,NULL,'booking',$6,$7,$8,$9,$10,false,$11::jsonb) ON CONFLICT(operation_id) DO NOTHING`,
        [s.client_id,s.id,s.selected_booking_id,op.row.id,checkout.paymentId,input.payment_choice,
          checkout.amountCents,checkout.currency,checkout.checkoutId,checkout.url,JSON.stringify(provider)]);
      await finish(pg, op.row.id, receipt, { bookingId: s.selected_booking_id });
      await pg.query('COMMIT');
      return receipt;
    } catch (e) { await pg.query('ROLLBACK'); throw e; }
  }
  const competingGroup = (await pg.query(
    `SELECT EXISTS(
       SELECT 1 FROM payments p
       WHERE p.client_id=$1 AND p.booking_id=$2 AND p.booking_guest_id IS NULL
         AND LOWER(COALESCE(p.status::text,'')) IN ('draft','checkout_created','open','pending')
         AND (
           COALESCE(p.metadata->>'payment_scope','')='booking'
           OR NULLIF(p.metadata->>'checkout_preparation','') IS NOT NULL
           OR NULLIF(p.metadata->>'provider_idempotency_key','') IS NOT NULL
           OR NULLIF(p.metadata->>'idempotency_key','') IS NOT NULL
           OR NULLIF(p.metadata->>'stripe_checkout_session_id','') IS NOT NULL
           OR NULLIF(p.metadata->>'stripe_session_id','') IS NOT NULL
           OR NULLIF(p.metadata->>'checkout_url','') IS NOT NULL
         )
     ) active`,
    [s.client_id, s.selected_booking_id],
  )).rows[0];
  if (competingGroup && competingGroup.active) return reject(fail('booking_payment_group_checkout_active', 409));
  const guest = (
    await pg.query(
      `SELECT bg.id::text,bg.booking_id::text,bg.payment_id::text,bg.guest_number FROM booking_guests bg
       WHERE bg.client_id=$2 AND bg.booking_id=$3 AND (($1::int IS NOT NULL AND bg.guest_number=$1) OR ($4::uuid IS NOT NULL AND bg.id=$4))`,
      [input.guest_position || null, s.client_id, s.selected_booking_id, input.guest_id || null],
    )
  ).rows[0];
  if (!guest) return reject(fail("payment_target_guest_mismatch", 403));
  const authority = authorities.createGuestCheckout;
  if (
    typeof authority !== "function" ||
    typeof authorities.readGuestCheckout !== "function"
  )
    return fail("staff_payment_link_authority_unavailable", 503);
  const target =
    input.payment_choice === "deposit"
      ? "deposit"
      : input.payment_choice === "full"
        ? "full_share"
        : "remaining_share";

  const operationConnectionPid = (await pg.query("SELECT pg_backend_pid() pid"))
    .rows[0].pid;
  let checkout;
  try {
    checkout = await authority({
      guestId: guest.id,
      paymentTarget: target,
      principalId: context.principalId,
      trustedGuestPhone: context.guestPhone,
      operationConnectionPid,
      operationId: op.row.id,
      operationKey: input.operation_key,
      requestFingerprint: op.fp,
    });
  } catch (e) {
    return fail(
      e.code || e.message || "staff_payment_link_failed",
      e.httpStatus || 503,
      { recoveryStatus: "ambiguous", operationKey: input.operation_key },
    );
  }
  if (checkout && checkout.zero)
    return reject(fail("nothing_payable", 422), {
      bookingId: guest.booking_id,
    });
  const finalized = (
    await pg.query(
      `SELECT bg.id::text,bg.booking_id::text,bg.payment_id::text FROM booking_guests bg WHERE bg.id=$1::uuid AND bg.client_id=$2 AND bg.booking_id=$3`,
      [guest.id, s.client_id, s.selected_booking_id],
    )
  ).rows[0];
  if (
    !checkout ||
    checkout.missing ||
    !finalized ||
    !checkout.paymentId ||
    finalized.payment_id !== checkout.paymentId
  )
    return reject(fail("payment_target_guest_mismatch", 403), {
      bookingId: guest.booking_id,
    });
  let provider;
  try {
    provider = await authorities.readGuestCheckout(
      checkout.session && checkout.session.id,
    );
  } catch (e) {
    return fail("provider_readback_unavailable", 503, {
      recoveryStatus: "ambiguous",
      operationKey: input.operation_key,
    });
  }
  const md = (provider && provider.metadata) || {};
  const now = Math.floor(Date.now() / 1000);
  const valid =
    provider &&
    checkout.session &&
    provider.id === checkout.session.id &&
    provider.url === checkout.session.url &&
    provider.livemode === false &&
    provider.status === "open" &&
    String(provider.payment_status).toLowerCase() === "unpaid" &&
    Number(provider.expires_at) > now &&
    require("../per-guest-checkout").validUrl(provider.url) &&
    Number.isSafeInteger(checkout.amount) &&
    checkout.amount > 0 &&
    provider.amount_total === checkout.amount &&
    typeof checkout.currency === "string" &&
    checkout.currency.length > 0 &&
    String(provider.currency).toUpperCase() ===
      checkout.currency.toUpperCase() &&
    md.client_slug === TENANT &&
    md.booking_id === guest.booking_id &&
    md.payment_id === checkout.paymentId &&
    md.booking_guest_id === guest.id;
  if (!valid)
    return fail("provider_readback_mismatch", 409, {
      recoveryStatus: "ambiguous",
      operationKey: input.operation_key,
    });
  const receipt = {
    ok: true,
    outcome: "applied",
    operationKey: input.operation_key,
    bookingId: guest.booking_id,
    guestId: guest.id,
    paymentId: checkout.paymentId,
    amountCents: checkout.amount,
    currency: checkout.currency.toUpperCase(),
    url: provider.url,
    checkoutId: provider.id,
    mode: "test",
    sent: false,
    externalSendAllowed: false,
    staffAlertAllowed: false,
  };
  await pg.query("BEGIN");
  try {
    const current = (
      await pg.query(
        `SELECT request_fingerprint,receipt FROM luna_v3_operations WHERE id=$1 FOR UPDATE`,
        [op.row.id],
      )
    ).rows[0];
    if (!current || current.request_fingerprint !== op.fp)
      throw new Error("payment_link_operation_identity_changed");
    if (current.receipt) {
      await pg.query("COMMIT");
      return current.receipt;
    }
    await pg.query(
      `INSERT INTO luna_v3_payment_links(client_id,session_id,booking_id,operation_id,payment_id,booking_guest_id,payment_choice,amount_cents,currency,provider_checkout_id,provider_url,provider_livemode,provider_readback) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false,$12::jsonb) ON CONFLICT(operation_id) DO NOTHING`,
      [
        s.client_id,
        s.id,
        guest.booking_id,
        op.row.id,
        checkout.paymentId,
        guest.id,
        input.payment_choice,
        checkout.amount,
        receipt.currency,
        provider.id,
        provider.url,
        JSON.stringify(provider),
      ],
    );
    await finish(pg, op.row.id, receipt, { bookingId: guest.booking_id });
    await pg.query("COMMIT");
    return receipt;
  } catch (e) {
    await pg.query("ROLLBACK");
    throw e;
  }
}
module.exports = {
  holdBeds,
  book,
  getBooking,
  recoverOperation,
  releaseHold,
  handoffToHuman,
  getPaymentStatus,
  sendPaymentLink: sendPaymentLinkAuthoritative,
  cancelUnpaid,
  readNotes,
  writeNote,
  saveTransferRequest,
};
Object.defineProperty(module.exports, "nativeStaffReceiptHasTrustedProvenance", {
  value: nativeStaffReceiptHasTrustedProvenance,
  enumerable: false,
});
Object.defineProperty(module.exports, "madridWallTime", {
  value: madridWallTime,
  enumerable: false,
});
