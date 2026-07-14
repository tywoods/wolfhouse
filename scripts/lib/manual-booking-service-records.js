'use strict';

/**
 * Stage 8.8.16 / 26j.2 — Manual booking create → booking_service_records rows.
 * Amounts from quote line_items; combos and individual rentals are independent.
 */

/** Map priced add-on codes to operational service_type values. */
const MANUAL_BOOKING_ADDON_SERVICE_MAP = {
  wetsuit_rental: 'wetsuit',
  soft_top_rental: 'surfboard',
  hard_board_rental: 'surfboard',
  wetsuit_soft_top_combo: null,
  wetsuit_hard_board_combo: null,
  surf_lesson_single: 'surf_lesson',
  surf_lesson_multi: 'surf_lesson',
  yoga_class: 'yoga',
  meals: 'meal',
};

function quoteLineItemAmount(quote, code) {
  const items = (quote && Array.isArray(quote.line_items)) ? quote.line_items : [];
  const li = items.find((x) => x.code === code);
  if (!li || li.total_cents == null) return null;
  return Number(li.total_cents);
}

function quoteLineItemUnitCents(quote, code, days) {
  const items = (quote && Array.isArray(quote.line_items)) ? quote.line_items : [];
  const li = items.find((x) => x.code === code);
  if (!li) return null;
  if (li.unit_cents != null) return Number(li.unit_cents);
  if (li.total_cents != null && days > 0) return Math.round(Number(li.total_cents) / days);
  return null;
}

function boardVariantForAddonCode(code) {
  if (code === 'soft_top_rental' || code === 'wetsuit_soft_top_combo') return 'soft';
  if (code === 'hard_board_rental' || code === 'wetsuit_hard_board_combo') return 'hard';
  return null;
}

function staffUiTypeForAddonCode(code) {
  if (code === 'soft_top_rental') return 'soft_board';
  if (code === 'hard_board_rental') return 'hard_board';
  if (code === 'meals') return 'meal';
  return null;
}

/**
 * Build booking_service_records rows for manual booking create.
 */
function buildManualBookingServiceRecordRows({
  addOns, quote, clientSlug, bookingId, bookingCode, guestName, checkIn, guestCount,
  source = 'staff_manual',
}) {
  void checkIn;
  void guestCount;
  const rows = [];
  const addOnList = Array.isArray(addOns) ? addOns : [];
  if (addOnList.length === 0) return rows;

  function servicePaymentStatus(amountDueCents) {
    return Number(amountDueCents) > 0 ? 'pending' : 'not_requested';
  }

  function pushRow({
    serviceType, quantity, amountDueCents, sourceAddonCode, metadataExtra,
  }) {
    const meta = {
      source_addon_code: sourceAddonCode,
      ...(metadataExtra || {}),
    };
    const amt = Math.max(0, Number(amountDueCents) || 0);
    rows.push({
      client_slug:        clientSlug,
      booking_id:         bookingId,
      booking_code:       bookingCode,
      guest_name:         guestName,
      service_type:       serviceType,
      service_date:       null,
      quantity:           Math.max(1, Number(quantity) || 1),
      status:             'confirmed',
      amount_due_cents:   amt,
      amount_paid_cents:  0,
      payment_status:     servicePaymentStatus(amt),
      source:             source,
      notes:              null,
      metadata:           meta,
    });
  }

  // Combo add-ons → wetsuit + surfboard rows (amount on quote line; rows track gear parts)
  for (const addon of addOnList) {
    if (addon.code !== 'wetsuit_soft_top_combo' && addon.code !== 'wetsuit_hard_board_combo') continue;
    const days = Math.max(1, parseInt(addon.days, 10) || 1);
    const people = Math.max(1, parseInt(addon.quantity, 10) || parseInt(addon.people, 10) || Math.max(1, Number(guestCount) || 1));
    const liAmt = quoteLineItemAmount(quote, addon.code);
    const boardVariant = boardVariantForAddonCode(addon.code);
    const comboMeta = {
      rental_days: days,
      rental_people: people,
      source_quote_line_code: addon.code,
      board_variant: boardVariant,
    };
    pushRow({
      serviceType: 'wetsuit',
      quantity: days,
      amountDueCents: 0,
      sourceAddonCode: addon.code,
      metadataExtra: {
        ...comboMeta,
        combo_part: 'wetsuit',
        unit_cents: 0,
        pricing_addon_code: addon.code,
      },
    });
    const boardUnit = quoteLineItemUnitCents(quote, addon.code, days * people);
    pushRow({
      serviceType: 'surfboard',
      quantity: days,
      amountDueCents: liAmt != null ? liAmt : 0,
      sourceAddonCode: addon.code,
      metadataExtra: {
        ...comboMeta,
        combo_part: 'surfboard',
        staff_ui_service_type: boardVariant === 'soft' ? 'soft_board' : 'hard_board',
        unit_cents: boardUnit,
        pricing_addon_code: addon.code,
        ...(liAmt == null ? { quote_line_not_matched: true } : {}),
      },
    });
  }

  // Individual rental add-ons (independent of combos — 26j.2)
  for (const addon of addOnList) {
    if (addon.code === 'wetsuit_soft_top_combo' || addon.code === 'wetsuit_hard_board_combo') continue;
    if (addon.code === 'surf_lesson_single' || addon.code === 'surf_lesson_multi') continue;
    if (addon.code === 'yoga_class') continue;
    if (addon.code === 'meals' || addon.code === 'meal') continue;

    const serviceType = MANUAL_BOOKING_ADDON_SERVICE_MAP[addon.code];
    if (!serviceType) continue;

    const days = Math.max(1, parseInt(addon.days, 10) || 1);
    const people = Math.max(1, parseInt(addon.quantity, 10) || parseInt(addon.people, 10) || Math.max(1, Number(guestCount) || 1));
    const liAmt = quoteLineItemAmount(quote, addon.code);
    const unitCents = quoteLineItemUnitCents(quote, addon.code, days * people);
    const boardVariant = boardVariantForAddonCode(addon.code);
    const staffUi = staffUiTypeForAddonCode(addon.code);
    pushRow({
      serviceType,
      quantity: days,
      amountDueCents: liAmt != null ? liAmt : 0,
      sourceAddonCode: addon.code,
      metadataExtra: {
        rental_days: days,
        rental_people: people,
        source_quote_line_code: addon.code,
        pricing_addon_code: addon.code,
        unit_cents: unitCents,
        ...(boardVariant ? { board_variant: boardVariant } : {}),
        ...(staffUi ? { staff_ui_service_type: staffUi } : {}),
        ...(liAmt == null ? { quote_line_not_matched: true } : {}),
      },
    });
  }

  // Surf lessons — pooled quantity (matches quote calculator)
  let totalLessons = 0;
  for (const addon of addOnList) {
    if (addon.code === 'surf_lesson_single' || addon.code === 'surf_lesson_multi') {
      totalLessons += Math.max(1, parseInt(addon.quantity, 10) || 1);
    }
  }
  if (totalLessons > 0) {
    const lessonCode = totalLessons === 1 ? 'surf_lesson_single' : 'surf_lesson_multi';
    const liAmt = quoteLineItemAmount(quote, lessonCode);
    pushRow({
      serviceType: 'surf_lesson',
      quantity: totalLessons,
      amountDueCents: liAmt != null ? liAmt : 0,
      sourceAddonCode: lessonCode,
      metadataExtra: {
        source_quote_line_code: lessonCode,
        needs_scheduling: true,
        ...(liAmt == null ? { quote_line_not_matched: true } : {}),
      },
    });
  }

  // Yoga classes
  for (const addon of addOnList) {
    if (addon.code !== 'yoga_class') continue;
    const qty = Math.max(1, parseInt(addon.quantity, 10) || 1);
    const liAmt = quoteLineItemAmount(quote, 'yoga_class');
    pushRow({
      serviceType: 'yoga',
      quantity: qty,
      amountDueCents: liAmt != null ? liAmt : 0,
      sourceAddonCode: 'yoga_class',
      metadataExtra: {
        source_quote_line_code: 'yoga_class',
        needs_scheduling: true,
        ...(liAmt == null ? { quote_line_not_matched: true } : {}),
      },
    });
  }

  // Meals (26j.2)
  for (const addon of addOnList) {
    if (addon.code !== 'meals' && addon.code !== 'meal') continue;
    const qty = Math.max(1, parseInt(addon.quantity, 10) || 1);
    const liAmt = quoteLineItemAmount(quote, 'meals');
    pushRow({
      serviceType: 'meal',
      quantity: qty,
      amountDueCents: liAmt != null ? liAmt : 0,
      sourceAddonCode: 'meals',
      metadataExtra: {
        source_quote_line_code: 'meals',
        staff_ui_service_type: 'meal',
        ...(liAmt == null ? { quote_line_not_matched: true, missing_price: true } : {}),
      },
    });
  }

  return rows;
}

/** Stage 8.8.14 — safe when migration 010 not applied yet. */
function isMissingBookingServiceRecordsTable(err) {
  if (!err) return false;
  if (err.code === '42P01') return true;
  const msg = String(err.message || '');
  return /booking_service_records/.test(msg) && /does not exist|undefined table/i.test(msg);
}

async function insertManualBookingServiceRecords(pg, rows) {
  if (!rows.length) return { created: 0, available: true, warning: null };
  let created = 0;
  for (const row of rows) {
    await pg.query(
      `INSERT INTO booking_service_records (
         client_slug, booking_id, booking_code, guest_name,
         service_type, service_date, quantity, status,
         amount_due_cents, amount_paid_cents, payment_status,
         source, notes, metadata
       ) VALUES (
         $1, $2::uuid, $3, $4,
         $5, $6::date, $7, $8,
         $9, $10, $11,
         $12, $13, $14::jsonb
       )`,
      [
        row.client_slug,
        row.booking_id,
        row.booking_code,
        row.guest_name,
        row.service_type,
        row.service_date,
        row.quantity,
        row.status,
        row.amount_due_cents,
        row.amount_paid_cents,
        row.payment_status,
        row.source,
        row.notes,
        JSON.stringify(row.metadata || {}),
      ]
    );
    created++;
  }
  return { created, available: true, warning: null };
}

async function tryInsertManualBookingServiceRecords(pg, rows) {
  if (!rows.length) return { created: 0, available: true, warning: null };
  try {
    return await insertManualBookingServiceRecords(pg, rows);
  } catch (err) {
    if (isMissingBookingServiceRecordsTable(err)) {
      return {
        created:  0,
        available: false,
        warning:  'booking_service_records table not available — service records skipped',
      };
    }
    throw err;
  }
}

module.exports = {
  buildManualBookingServiceRecordRows,
  MANUAL_BOOKING_ADDON_SERVICE_MAP,
  quoteLineItemAmount,
  quoteLineItemUnitCents,
  isMissingBookingServiceRecordsTable,
  insertManualBookingServiceRecords,
  tryInsertManualBookingServiceRecords,
};
