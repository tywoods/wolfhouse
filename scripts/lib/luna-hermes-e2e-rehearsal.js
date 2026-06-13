'use strict';

/**
 * Stage 57c — deterministic end-to-end rehearsal harness for Hermes-hosted Luna.
 *
 * This is deliberately not the production brain. It is a safety harness that drives
 * the desired happy path through the same Staff API wrapper Hermes will use, while
 * keeping all external side effects mocked by the caller.
 */

const { extractLunaGuestMessageIntake } = require('./luna-guest-message-intake');
const { buildWhatsAppPackageLines } = require('./luna-guest-package-explainer');
const { resolveLunaDepositCents } = require('./luna-hermes-staff-api-tools');

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function formatEur(cents) {
  const n = Number(cents || 0);
  const eur = n / 100;
  return n % 100 === 0 ? `€${eur}` : `€${eur.toFixed(2)}`;
}

function lower(text) {
  return trimStr(text).toLowerCase();
}

function detectPackage(text) {
  const t = lower(text);
  if (/\bwaimea\b/.test(t)) return 'waimea';
  if (/\buluwatu\b/.test(t)) return 'uluwatu';
  if (/\bmalibu\b/.test(t)) return 'malibu';
  return null;
}

function detectPaymentChoice(text) {
  const t = lower(text);
  if (/\b(full|all|entire)\b/.test(t)) return 'full';
  if (/\b(deposit|dep[oó]sito|deposito)\b/.test(t)) return 'deposit';
  return null;
}

function detectPaidClaim(text) {
  return /\b(i\s+paid|paid|payment\s+done|just\s+paid|deposit\s+paid)\b/i.test(trimStr(text));
}

function detectTransfer(text) {
  const t = trimStr(text);
  if (!/\b(flight|lands?|arriv|santander|bilbao|airport|FR\s?\d+)/i.test(t)) return null;
  const airport = /bilbao/i.test(t) ? 'bilbao' : (/santander/i.test(t) ? 'santander' : null);
  const flight = (t.match(/\b([A-Z]{2}\s?\d{2,5})\b/i) || [])[1];
  const time = (t.match(/\b(\d{1,2}:\d{2})\b/) || [])[1];
  return {
    direction: 'arrival',
    airport_code: airport,
    airport,
    flight_number: flight ? flight.replace(/\s+/g, '').toUpperCase() : null,
    scheduled_time: time || null,
  };
}

function mergeFields(state, extracted) {
  const ex = extracted || {};
  if (ex.check_in) state.check_in = ex.check_in;
  if (ex.check_out) state.check_out = ex.check_out;
  if (ex.guests != null) state.guest_count = Number(ex.guests);
  if (ex.package_code) state.package_code = ex.package_code;
  if (ex.guest_name) state.guest_name = ex.guest_name;
}

async function runHermesLunaE2ERehearsal(input) {
  const opts = input || {};
  const tools = opts.staffApiTools;
  if (!tools) throw new Error('staffApiTools_required');
  const turns = Array.isArray(opts.turns) ? opts.turns : [];
  const clientSlug = trimStr(opts.client_slug) || 'wolfhouse-somo';
  const state = {
    client_slug: clientSlug,
    guest_phone: opts.guest_phone || null,
    guest_name: opts.contact_name || null,
    language: 'en',
    stage: 'new',
  };
  const transcript = [];
  const outTurns = [];

  for (const message of turns) {
    const text = trimStr(message);
    let reply = '';
    const toolCalls = [];

    const transfer = detectTransfer(text);
    if (state.booking_id && transfer) {
      const payload = {
        client_slug: clientSlug,
        booking_id: state.booking_id,
        direction: transfer.direction,
        airport_code: transfer.airport_code,
        airport: transfer.airport,
        flight_number: transfer.flight_number,
        notes: transfer.scheduled_time ? `Guest said landing time ${transfer.scheduled_time}` : undefined,
        confirm_transfer_write: true,
      };
      const saved = await tools.saveTransfer(payload);
      toolCalls.push({ tool: 'saveTransfer', payload, result: saved });
      state.transfer = saved.transfer || transfer;
      if (!state.transfer.flight_number && transfer.flight_number) state.transfer.flight_number = transfer.flight_number;
      reply = `Perfect, I added your Santander transfer details${transfer.flight_number ? ` for flight ${transfer.flight_number}` : ''} 😊`;
    } else if (detectPaidClaim(text) && state.payment_id) {
      const payload = { client_slug: clientSlug, payment_id: state.payment_id, booking_id: state.booking_id };
      const payment = await tools.getPaymentStatus(payload);
      toolCalls.push({ tool: 'getPaymentStatus', payload, result: payment });
      const status = payment.latest_payment && payment.latest_payment.payment_status;
      state.payment_status = status || 'unknown';
      if (/^(paid|deposit_paid|fully_paid)$/.test(String(status || ''))) {
        state.stage = 'confirmed';
        reply = `Yesss, payment received — your Wolfhouse booking ${state.booking_code || ''} is confirmed 🎉`;
      } else {
        reply = `I’m checking the payment truth now 😊 I don’t see it as paid yet, so I won’t confirm until it lands safely.`;
      }
    } else if (detectPaymentChoice(text) && state.quote && state.package_code) {
      const choice = detectPaymentChoice(text);
      state.payment_choice = choice;
      const createPayload = {
        client_slug: clientSlug,
        confirm: true,
        guest_phone: state.guest_phone,
        guest_name: state.guest_name,
        check_in: state.check_in,
        check_out: state.check_out,
        guest_count: state.guest_count,
        package_code: state.package_code,
        payment_choice: choice,
        deposit_required_cents: resolveLunaDepositCents(state),
      };
      const booking = await tools.createBookingFromPlan(createPayload);
      toolCalls.push({ tool: 'createBookingFromPlan', payload: createPayload, result: booking });
      state.booking_id = booking.booking_id;
      state.booking_code = booking.booking_code;
      state.payment_id = booking.payment_id;
      const linkPayload = { payment_id: state.payment_id, payment_choice: choice };
      const link = await tools.createPaymentLink(linkPayload);
      toolCalls.push({ tool: 'createPaymentLink', payload: linkPayload, result: link });
      state.payment_link = link.checkout_url;
      state.payment_status = link.payment_status || 'checkout_created';
      state.stage = 'payment_pending';
      reply = `Amazing, here’s your secure ${choice === 'deposit' ? 'deposit' : 'payment'} link 😊\n${link.checkout_url}\n\nOnce the payment comes through, I’ll confirm everything for you.`;
    } else {
      const extraction = extractLunaGuestMessageIntake({
        client_slug: clientSlug,
        message_text: text,
        guest_phone: state.guest_phone,
        guest_name: state.guest_name,
        channel: 'whatsapp',
      }, { reference_date: opts.reference_date || '2026-06-01', env: opts.env || process.env });
      mergeFields(state, extraction);
      const pkg = detectPackage(text);
      if (pkg) state.package_code = pkg;

      if (/^(hi|hello|hey|ciao|hola)\b/i.test(text) && state.stage === 'new') {
        state.stage = 'welcomed';
        reply = `Ciao!! Welcome to Wolfhouse ☀️🌊 Are you thinking about coming to stay with us, or just looking for some info for now?`;
      } else if (state.check_in && state.check_out && state.guest_count && !state.availability) {
        const payload = {
          client_slug: clientSlug,
          check_in: state.check_in,
          check_out: state.check_out,
          guest_count: state.guest_count,
        };
        const availability = await tools.checkAvailability(payload);
        toolCalls.push({ tool: 'checkAvailability', payload, result: availability });
        state.availability = availability;
        state.stage = 'package_selection';
        const packageLines = buildWhatsAppPackageLines('en');
        reply = [
          `Yesss, we have space for those dates ☀️`,
          `Since you’re staying a full Wolfhouse week, you can choose one of these:`,
          ...(Array.isArray(packageLines) ? packageLines : [packageLines.malibu, packageLines.uluwatu, packageLines.waimea]),
          `Which one feels most like your trip?`,
        ].filter(Boolean).join('\n\n');
      } else if (state.package_code && state.check_in && state.check_out && state.guest_count && !state.quote) {
        const deposit = resolveLunaDepositCents(state);
        const payload = {
          client_slug: clientSlug,
          check_in: state.check_in,
          check_out: state.check_out,
          guest_count: state.guest_count,
          package_code: state.package_code,
          deposit_required_cents: deposit,
        };
        const quote = await tools.quoteBooking(payload);
        toolCalls.push({ tool: 'quoteBooking', payload, result: quote });
        state.quote = quote;
        state.stage = 'quote_ready';
        reply = `Cute, ${state.package_code[0].toUpperCase()}${state.package_code.slice(1)} it is 🌊\n\nTotal: ${formatEur(quote.quote_total_cents)}\nDeposit to hold it: ${formatEur(quote.deposit_required_cents || deposit)}\n\nWould you like to pay the deposit or the full amount?`;
      } else if (!state.check_in || !state.check_out) {
        state.stage = 'collecting_dates';
        reply = `Amazinggg 😍 What dates are you thinking?`;
      } else if (!state.guest_count) {
        state.stage = 'collecting_guests';
        reply = `Perfect, and how many beautiful humans are coming? 😊`;
      } else {
        reply = `Perfect 😊 I’ve got that. Let’s keep going from where we were.`;
      }
    }

    transcript.push({ role: 'guest', text });
    transcript.push({ role: 'assistant', text: reply });
    outTurns.push({ message: text, reply, tool_calls: toolCalls, state: { ...state } });
  }

  return {
    turns: outTurns,
    state,
    transcript,
    safety: {
      dry_run: true,
      no_live_whatsapp: true,
      mocked_staff_api: true,
      no_real_staff_api_required: true,
    },
  };
}

module.exports = { runHermesLunaE2ERehearsal };
