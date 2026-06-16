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
    const liAmt = quoteLineItemAmount(quote, addon.code);
    const boardVariant = boardVariantForAddonCode(addon.code);
    const comboMeta = {
      rental_days: days,
      source_quote_line_code: addon.code,
      board_variant: boardVariant,
    };
    pushRow({
      serviceType: 'wetsuit',
      quantity: days,
      amountDueCents: 0,
      sourceAddonCode: addon.code,
      metadataExtra: { ...comboMeta, combo_part: 'wetsuit' },
    });
    pushRow({
      serviceType: 'surfboard',
      quantity: days,
      amountDueCents: liAmt != null ? liAmt : 0,
      sourceAddonCode: addon.code,
      metadataExtra: {
        ...comboMeta,
        combo_part: 'surfboard',
        staff_ui_service_type: boardVariant === 'soft' ? 'soft_board' : 'hard_board',
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
    const liAmt = quoteLineItemAmount(quote, addon.code);
    const boardVariant = boardVariantForAddonCode(addon.code);
    const staffUi = staffUiTypeForAddonCode(addon.code);
    pushRow({
      serviceType,
      quantity: days,
      amountDueCents: liAmt != null ? liAmt : 0,
      sourceAddonCode: addon.code,
      metadataExtra: {
        rental_days: days,
        source_quote_line_code: addon.code,
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

module.exports = {
  buildManualBookingServiceRecordRows,
  MANUAL_BOOKING_ADDON_SERVICE_MAP,
  quoteLineItemAmount,
};
