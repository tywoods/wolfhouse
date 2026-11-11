'use strict';

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function bindAddonRequestToGuest(input, guests) {
  const src = input || {};
  const rows = Array.isArray(guests) ? guests : [];
  const id = trimStr(src.booking_guest_id);
  if (id) {
    const hit = rows.find((row) => trimStr(row && row.booking_guest_id) === id);
    if (hit) {
      return {
        booking_guest_id: trimStr(hit.booking_guest_id),
        guest_name: trimStr(hit.guest_name) || null,
        guest_number: hit.guest_number != null ? Number(hit.guest_number) : null,
      };
    }
  }
  const num = Number(src.guest_number);
  if (Number.isInteger(num) && num >= 1) {
    const hit = rows.find((row) => Number(row && row.guest_number) === num);
    if (hit) {
      return {
        booking_guest_id: trimStr(hit.booking_guest_id),
        guest_name: trimStr(hit.guest_name) || null,
        guest_number: num,
      };
    }
  }
  const name = trimStr(src.guest_name).toLowerCase();
  if (!name) return null;
  const hit = rows.find((row) => trimStr(row && row.guest_name).toLowerCase() === name);
  if (!hit) return null;
  return {
    booking_guest_id: trimStr(hit.booking_guest_id),
    guest_name: trimStr(hit.guest_name) || null,
    guest_number: hit.guest_number != null ? Number(hit.guest_number) : null,
  };
}

function addonSavedButLinkFailedReply(input) {
  const src = input || {};
  const who = trimStr(src.guest_name) || 'the guest';
  const kind = trimStr(src.service_type) === 'meal' ? 'meal' : (trimStr(src.service_type) || 'add-on');
  const label = kind === 'yoga' ? 'yoga class' : kind;
  return `I've added ${who}'s ${label}. I'm getting the team to send the payment link.`;
}

function addonCreateResponseAfterWrite(input) {
  const src = input || {};
  const checkout = trimStr(src.checkout_url);
  const writeOk = src.write_performed !== false;
  const linkOk = !!checkout;
  const body = {
    success: writeOk,
    write_performed: writeOk,
    payment_link_created: linkOk,
    checkout_url: checkout || null,
    staff_review_needed: writeOk && !linkOk,
    reply_draft: linkOk
      ? (src.reply_draft || null)
      : addonSavedButLinkFailedReply(src),
  };
  if (!linkOk && src.stripe_error) body.payment_link_error = String(src.stripe_error);
  return { status: writeOk ? 201 : 500, body };
}

function shouldWaitForGuestAnswer(input) {
  const src = input || {};
  if (src.inbound_after === true) return false;
  const text = trimStr(src.last_outbound);
  if (!text) return false;
  return /\?\s*$/m.test(text) || /or would you prefer/i.test(text);
}

module.exports = {
  bindAddonRequestToGuest,
  addonCreateResponseAfterWrite,
  addonSavedButLinkFailedReply,
  shouldWaitForGuestAnswer,
};
