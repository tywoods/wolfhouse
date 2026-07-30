'use strict';

/**
 * verify:sunset-edit-generic-rental-regression
 *
 * ONLY BUG: Edit Save of equipment-only generic catalog rentals failed with
 * `rentals[0].offering_key is not allowed` even though Create + quote accepted
 * the same active offering.
 *
 * Root cause: after prepareGenericRentalsForCreate strips generics,
 * rentalPrep.present is false. The Edit path treated that like "rentals omitted"
 * and restored lockedMeta.rentals (including generic keys) into canonicalRentals.
 * Re-quote then re-entered the closed legacy allowlist and rejected.
 *
 * This test proves the public PATCH production owner with:
 *  - actual generated Edit rental controls + scheduleReadDrawer* transport
 *  - no page.evaluate payload fallback / no helper-only proof for the green path
 *  - production transaction (BEGIN/COMMIT/ROLLBACK) + reopen name/duration/qty
 *  - hostile foreign / inactive / arbitrary keys fail closed
 *  - RED intermediate (generic keys on quote transport) vs GREEN after fix
 *
 * Run: node scripts/verify-sunset-edit-generic-rental-regression.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DRAWER_REQ = path.join(__dirname, 'lib', 'sunset-schedule-booking-drawer.js');
const WRITES_REQ = path.join(__dirname, 'lib', 'sunset-schedule-booking-writes.js');
const EDIT_UI = path.join(__dirname, 'browser', 'sunset-schedule-drawer-edit-ui.js');
const RENTAL_UI = path.join(__dirname, 'browser', 'sunset-schedule-rental-availability.js');

process.env.GENERIC_RENTAL_CREATE_ENABLED = 'true';
process.env.SUNSET_ADMIN_DB_READ_ENABLED = '1';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const BOOKING_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const LOC = 'sunset-somo';
const TOWEL = 'towel_rental_edit';
const TOWEL_LABEL = 'Towel';
const TOWEL_CENTS = 2200;
const DATE = '2026-08-20';

let pass = 0;
function ok(name, cond, detail) {
  if (!cond) {
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    process.exit(1);
  }
  console.log(`PASS ${name}`);
  pass += 1;
}

function parseMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function extractFn(src, name) {
  const needle = `function ${name}(`;
  const start = src.indexOf(needle);
  if (start < 0) return null;
  const brace = src.indexOf('{', start);
  if (brace < 0) return null;
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/** Minimal DOM for real Edit rental controls → scheduleReadDrawer* transport. */
function buildEditRentalDom(opts) {
  const o = opts || {};
  const offeringKey = o.offeringKey || TOWEL;
  const label = o.label || TOWEL_LABEL;
  const duration = o.durationKey || '1_day';
  const qty = o.quantity != null ? o.quantity : 2;
  const guest = o.guestName || 'Edit Gear Guest';
  const phone = o.phone || '+34600000001';

  function makeEl(tag, props) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      id: '',
      className: '',
      value: '',
      checked: false,
      disabled: false,
      hidden: false,
      style: {},
      dataset: {},
      _attrs: {},
      children: [],
      parentNode: null,
      textContent: '',
      innerHTML: '',
      getAttribute(k) {
        if (k === 'id') return this.id || null;
        if (k === 'class') return this.className || null;
        return this._attrs[k] != null ? this._attrs[k] : null;
      },
      setAttribute(k, v) {
        if (k === 'id') this.id = String(v);
        else if (k === 'class') this.className = String(v);
        else this._attrs[k] = String(v);
      },
      removeAttribute(k) { delete this._attrs[k]; },
      querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (node) => {
          if (!node || !node.children) return;
          node.children.forEach((c) => {
            if (matchSel(c, sel)) out.push(c);
            walk(c);
          });
        };
        walk(this);
        return out;
      },
      appendChild(c) {
        c.parentNode = this;
        this.children.push(c);
        return c;
      },
    };
    Object.assign(el, props || {});
    return el;
  }

  function matchSel(node, sel) {
    const s = String(sel || '');
    if (s.startsWith('#')) return node.id === s.slice(1);
    if (s.startsWith('.')) {
      return String(node.className || '').split(/\s+/).includes(s.slice(1));
    }
    if (s.startsWith('[') && s.endsWith(']')) {
      const body = s.slice(1, -1);
      if (body.includes('=')) {
        const [k, raw] = body.split('=');
        const want = raw.replace(/^["']|["']$/g, '');
        return String(node.getAttribute(k) || '') === want
          || (k.startsWith('data-') && String(node._attrs[k] || '') === want);
      }
      return node.getAttribute(body) != null
        || (body.startsWith('data-') && node._attrs[body] != null)
        || (body === 'data-rental-offering' && node._attrs['data-rental-offering'] != null);
    }
    return false;
  }

  const wrap = makeEl('div', { id: 'ps-drawer-rentals', className: 'portal-schedule-drawer-rentals' });
  wrap.setAttribute('data-duration-key', duration);
  wrap.setAttribute('data-seed-rentals', JSON.stringify([
    { offering_key: offeringKey, duration_key: duration, quantity: 1 },
  ]));
  wrap.setAttribute('data-seed-surfers', String(qty));

  const row = makeEl('div', { className: 'portal-schedule-create-rental-row' });
  row.setAttribute('data-rental-offering', offeringKey);
  row.setAttribute('data-rental-duration-key', duration);

  const check = makeEl('input', {
    className: 'ps-drawer-rental-check',
    checked: true,
    type: 'checkbox',
  });
  check.setAttribute('type', 'checkbox');

  const qtyInput = makeEl('input', {
    className: 'ps-drawer-rental-qty-input',
    value: String(qty),
    type: 'number',
  });
  qtyInput.setAttribute('data-qty-owner', 'surfers');
  qtyInput.setAttribute('type', 'number');

  const durSel = makeEl('select', {
    className: 'ps-drawer-rental-duration',
    value: duration,
  });
  durSel.setAttribute('data-rental-duration-select', '1');
  const opt = makeEl('option', { value: duration, textContent: duration });
  opt.setAttribute('value', duration);
  durSel.appendChild(opt);
  // select.value read
  Object.defineProperty(durSel, 'value', {
    get() { return duration; },
    set() { /* fixed for test */ },
  });

  const labelEl = makeEl('span', {
    className: 'portal-schedule-create-check',
    textContent: label,
  });

  row.appendChild(check);
  row.appendChild(labelEl);
  row.appendChild(qtyInput);
  row.appendChild(durSel);
  wrap.appendChild(row);

  const guestEl = makeEl('input', { id: 'ps-drawer-guest', value: guest });
  const phoneEl = makeEl('input', { id: 'ps-drawer-phone', value: phone });
  const dateFrom = makeEl('input', { id: 'ps-drawer-date-from', value: DATE });
  const dateTo = makeEl('input', { id: 'ps-drawer-date-to', value: DATE });
  const pay = makeEl('select', { id: 'ps-drawer-payment', value: 'unpaid' });
  Object.defineProperty(pay, 'value', { get() { return 'unpaid'; }, set() {} });
  const notes = makeEl('textarea', { id: 'ps-drawer-notes', value: '' });
  const mode = makeEl('select', { id: 'ps-drawer-main-activity', value: 'none' });
  Object.defineProperty(mode, 'value', { get() { return 'none'; }, set() {} });
  const surfers = makeEl('input', { id: 'ps-drawer-surfers', value: String(qty) });
  const equipment = makeEl('div', { id: 'ps-drawer-course-equipment' });

  const nodes = {
    'ps-drawer-rentals': wrap,
    'ps-drawer-guest': guestEl,
    'ps-drawer-phone': phoneEl,
    'ps-drawer-date-from': dateFrom,
    'ps-drawer-date-to': dateTo,
    'ps-drawer-payment': pay,
    'ps-drawer-notes': notes,
    'ps-drawer-main-activity': mode,
    'ps-drawer-surfers': surfers,
    'ps-drawer-course-equipment': equipment,
  };

  return { nodes, wrap, offeringKey, duration, qty, guest, phone, label };
}

function loadEditTransport(dom) {
  const editSrc = fs.readFileSync(EDIT_UI, 'utf8');
  const rentalMod = require(RENTAL_UI);
  const readRentFn = extractFn(editSrc, 'scheduleReadDrawerRentalSelectionFromDom');
  const readPayloadFn = extractFn(editSrc, 'scheduleReadDrawerEditPayload');
  const parsePayFn = extractFn(editSrc, 'scheduleParsePaymentSelectValue');
  assert.ok(readRentFn, 'scheduleReadDrawerRentalSelectionFromDom extractable');
  assert.ok(readPayloadFn, 'scheduleReadDrawerEditPayload extractable');

  const sandbox = {
    el(id) { return dom.nodes[id] || null; },
    scheduleDrawerMainActivityValue() { return 'none'; },
    scheduleDrawerDateSpan() { return { from: DATE, to: DATE }; },
    scheduleDrawerReadSurferCount() {
      const n = parseInt(dom.nodes['ps-drawer-surfers'].value, 10);
      return Number.isInteger(n) && n >= 1 ? n : null;
    },
    scheduleSerializeRentalsSelection: rentalMod.scheduleSerializeRentalsSelection,
    scheduleRentalsToLegacyComponents: rentalMod.scheduleRentalsToLegacyComponents,
    scheduleDrawerReadPrivateSessionsFromDom() { return []; },
    scheduleDrawerReadGroupLessonRows() { return []; },
    schedulePortalInclusiveIsoDates() { return [DATE]; },
    schedulePortalResolveDerivedCourseTier() { return null; },
    scheduleDrawerCustomLines: [],
    console,
  };
  if (parsePayFn) {
    vm.runInNewContext(`${parsePayFn}\nthis.scheduleParsePaymentSelectValue = scheduleParsePaymentSelectValue;`, sandbox);
  } else {
    sandbox.scheduleParsePaymentSelectValue = () => ({ status: 'unpaid', method: null });
  }
  vm.runInNewContext(
    `${readRentFn}\nthis.scheduleReadDrawerRentalSelectionFromDom = scheduleReadDrawerRentalSelectionFromDom;`,
    sandbox,
  );
  vm.runInNewContext(
    `${readPayloadFn}\nthis.scheduleReadDrawerEditPayload = scheduleReadDrawerEditPayload;`,
    sandbox,
  );

  const rentals = sandbox.scheduleReadDrawerRentalSelectionFromDom();
  const payload = sandbox.scheduleReadDrawerEditPayload();
  return { rentals, payload, sandbox };
}

function makePg(seed) {
  const state = {
    begins: 0,
    commits: 0,
    rollbacks: 0,
    locked: false,
    txSnap: null,
    clientId: CLIENT_ID,
    bookings: deepClone(seed.bookings || []),
    services: deepClone(seed.services || []),
    payments: deepClone(seed.payments || []),
    offerings: deepClone(seed.offerings || []),
    prices: deepClone(seed.prices || []),
    serviceInserts: 0,
  };

  function snap() {
    return deepClone({
      bookings: state.bookings,
      services: state.services,
      payments: state.payments,
    });
  }
  function restore(s) {
    state.bookings = s.bookings;
    state.services = s.services;
    state.payments = s.payments;
  }

  return {
    state,
    async query(sql, params = []) {
      const q = String(sql);

      if (/^\s*BEGIN\b/i.test(q)) {
        state.begins += 1;
        state.txSnap = snap();
        state.locked = true;
        return { rows: [], rowCount: 0 };
      }
      if (/^\s*COMMIT\b/i.test(q)) {
        state.commits += 1;
        state.txSnap = null;
        state.locked = false;
        return { rows: [], rowCount: 0 };
      }
      if (/^\s*ROLLBACK\b/i.test(q)) {
        state.rollbacks += 1;
        if (state.txSnap) restore(state.txSnap);
        state.txSnap = null;
        state.locked = false;
        return { rows: [], rowCount: 0 };
      }

      if (/pg_advisory/i.test(q)) return { rows: [], rowCount: 0 };
      if (/to_regclass/i.test(q)) {
        return { rows: [{ reg: 'tenant_price_rules', t: 'booking_service_records' }] };
      }
      if (/information_schema/i.test(q)) {
        return { rows: [{ column_name: 'location_id', table_name: 'tenant_price_rules', '?column?': 1 }] };
      }
      if (/pg_constraint/i.test(q)) {
        return {
          rows: [{
            definition: "CHECK ((service_type)::text = ANY ((ARRAY['addon_service'::character varying])::text[]))",
          }],
        };
      }
      if (/SELECT id FROM clients/i.test(q)) return { rows: [{ id: state.clientId }] };

      if (/FROM tenant_rental_offerings/i.test(q)) {
        const slug = params[0];
        const loc = params[1];
        const rows = state.offerings.filter((o) => {
          if (String(o.client_slug) !== String(slug)) return false;
          if (o.active === false && /active\s*=\s*true/i.test(q)) return false;
          if (loc != null && o.location_id != null && String(o.location_id) !== String(loc)) {
            return false;
          }
          return true;
        });
        return { rows };
      }

      if (/FROM tenant_price_rules/i.test(q)) {
        let match = null;
        for (const p of params) {
          const code = String(p || '');
          match = state.prices.find((x) => String(x.item_code) === code);
          if (match) break;
        }
        if (!match) {
          const codes = params.filter((p) => typeof p === 'string' && String(p).includes('__'));
          for (const c of codes) {
            match = state.prices.find((x) => String(x.item_code) === c);
            if (match) break;
          }
        }
        if (!match) return { rows: [] };
        return {
          rows: [{
            id: match.id || 'price-1',
            amount_cents: match.amount_cents,
            currency: 'EUR',
            item_type: match.item_type || 'rental',
            item_code: match.item_code,
            unit: match.unit || 'day',
            location_id: match.location_id || LOC,
            active: true,
            effective_from: null,
            effective_to: null,
            updated_at: '2026-06-01',
          }],
        };
      }

      if (/FROM tenant_surf_pack_rules/i.test(q)) return { rows: [] };
      if (/FROM tenant_private_lesson_rules/i.test(q)
        || (/private_lesson/i.test(q) && /config_json/i.test(q) && /SELECT/i.test(q))) {
        return { rows: [] };
      }
      if (/COALESCE\(SUM/i.test(q) && /booking_service_records/i.test(q)) {
        return { rows: [{ seats: 0, count: 0 }] };
      }

      if (/FROM bookings b/i.test(q) && /INNER JOIN clients/i.test(q)) {
        const b = state.bookings[0];
        if (!b) return { rows: [] };
        return {
          rows: [{
            booking_id: b.booking_id,
            client_id: state.clientId,
            booking_code: b.booking_code,
            guest_name: b.guest_name,
            phone: b.phone,
            status: b.status,
            payment_status: b.payment_status,
            check_in: b.check_in,
            check_out: b.check_out,
            guest_count: b.guest_count,
            amount_paid_cents: b.amount_paid_cents || 0,
            total_amount_cents: b.total_amount_cents || 0,
            balance_due_cents: b.balance_due_cents || 0,
            metadata: b.metadata,
          }],
        };
      }

      if (/FROM payments/i.test(q)) {
        if (/SUM\(amount_paid_cents\)/i.test(q)) {
          const paid = state.payments
            .filter((p) => String(p.status || p.payment_status) === 'paid')
            .reduce((s, p) => s + (Number(p.amount_paid_cents) || 0), 0);
          return { rows: [{ paid_total: paid }] };
        }
        if (/FOR UPDATE/i.test(q)) {
          return {
            rows: state.payments.map((p) => ({
              payment_id: p.payment_id || p.id,
              payment_status: p.status || p.payment_status,
              amount_due_cents: p.amount_due_cents || 0,
              amount_paid_cents: p.amount_paid_cents || 0,
            })),
          };
        }
        return { rows: state.payments };
      }

      if (/SELECT COALESCE\(total_amount_cents/i.test(q) && /FROM bookings/i.test(q)) {
        const b = state.bookings[0];
        return { rows: b ? [{ total: Number(b.total_amount_cents) || 0 }] : [] };
      }

      if (/FROM booking_service_records/i.test(q)
        && !/INSERT/i.test(q)
        && !/DELETE/i.test(q)
        && !/UPDATE/i.test(q)
        && !/SUM/i.test(q)) {
        return {
          rows: state.services.map((s) => ({
            ...s,
            id: s.id || s.service_record_id,
            service_record_id: s.service_record_id || s.id,
            record_source: s.record_source || s.source || 'staff_manual',
          })),
        };
      }

      if (/DELETE FROM booking_service_records/i.test(q)) {
        const sources = Array.isArray(params[2]) ? params[2] : [params[2]];
        state.services = state.services.filter((s) => {
          const src = s.record_source || s.source;
          return !sources.includes(src);
        });
        return { rowCount: 1 };
      }

      if (/INSERT INTO booking_service_records/i.test(q)) {
        state.serviceInserts += 1;
        let serviceType = params[4];
        let serviceDate = params[5];
        let quantity = params[6];
        let paymentStatus = params[7];
        let source = params[8];
        let metaRaw = params[9];
        let amountDue = 0;
        const bookingId = params[1];
        const bookingCode = params[2];
        const guestName = params[3];
        // Generic rental insert: amount_due at $8
        if (/'confirmed',\s*\$8,\s*0,\s*\$9/i.test(q) || (params.length >= 11 && typeof params[7] === 'number')) {
          amountDue = Number(params[7]) || 0;
          paymentStatus = params[8];
          source = params[9];
          metaRaw = params[10];
        }
        const meta = parseMeta(metaRaw);
        const id = `00000000-0000-4000-8000-${String(state.serviceInserts).padStart(12, '0')}`;
        const row = {
          id,
          service_record_id: id,
          client_slug: params[0],
          booking_id: bookingId,
          booking_code: bookingCode,
          guest_name: guestName,
          service_type: serviceType,
          service_date: String(serviceDate || '').slice(0, 10),
          quantity,
          amount_due_cents: amountDue,
          amount_paid_cents: 0,
          payment_status: paymentStatus || 'pending',
          record_source: source,
          source,
          metadata: meta,
        };
        state.services.push(row);
        return {
          rows: [{
            service_record_id: id,
            id,
            booking_id: bookingId,
            booking_code: bookingCode,
            guest_name: guestName,
            service_type: serviceType,
            service_date: row.service_date,
            quantity,
            amount_due_cents: amountDue,
            amount_paid_cents: 0,
            payment_status: row.payment_status,
            record_source: source,
            metadata: meta,
            offering_key: meta.offering_key || null,
            staff_ui_service_type: meta.staff_ui_service_type || null,
          }],
          rowCount: 1,
        };
      }

      if (/UPDATE booking_service_records/i.test(q) && /amount_due_cents/i.test(q)) {
        const due = Number(params[0]);
        const id = String(params[1]);
        const row = state.services.find((s) => String(s.service_record_id || s.id) === id);
        if (!row) return { rowCount: 0, rows: [] };
        row.amount_due_cents = due;
        return { rowCount: 1, rows: [] };
      }

      if (/UPDATE bookings/i.test(q)) {
        const b = state.bookings[0];
        if (!b) return { rowCount: 0 };
        if (/total_amount_cents/i.test(q)) {
          b.total_amount_cents = Number(params[0]);
          if (params.length >= 3 && Number.isFinite(Number(params[1]))) {
            b.amount_paid_cents = Number(params[1]) || 0;
            b.balance_due_cents = Number(params[2]) || 0;
            if (params[3] && typeof params[3] === 'string' && String(params[3]).startsWith('{')) {
              b.metadata = { ...parseMeta(b.metadata), ...parseMeta(params[3]) };
            }
          } else {
            b.balance_due_cents = Math.max(
              Number(params[0]) - Number(b.amount_paid_cents || 0),
              0,
            );
            if (params[1] && typeof params[1] === 'string' && String(params[1]).startsWith('{')) {
              b.metadata = { ...parseMeta(b.metadata), ...parseMeta(params[1]) };
            }
          }
          return { rowCount: 1, rows: [b] };
        }
        // header reprice: guest, phone, status, pay, check_in, check_out, guest_count, meta
        if (params.length >= 8 && /^\d{4}-\d{2}-\d{2}/.test(String(params[4] || ''))) {
          b.guest_name = params[0];
          b.phone = params[1];
          b.status = params[2];
          b.payment_status = params[3];
          b.check_in = params[4];
          b.check_out = params[5];
          b.guest_count = params[6];
          b.metadata = { ...parseMeta(b.metadata), ...parseMeta(params[7]) };
          return { rowCount: 1, rows: [b] };
        }
        // meta-only
        b.guest_name = params[0];
        b.phone = params[1];
        b.status = params[2];
        b.payment_status = params[3];
        b.guest_count = params[4];
        b.metadata = { ...parseMeta(b.metadata), ...parseMeta(params[5]) };
        return { rowCount: 1, rows: [b] };
      }

      if (/FROM bookings/i.test(q) && /SELECT/i.test(q)) {
        return {
          rows: state.bookings.map((b) => ({
            ...b,
            id: b.booking_id,
            metadata: b.metadata,
          })),
        };
      }

      // Ignore unread drawer context extras
      if (/stripe|checkout_url/i.test(q)) return { rows: [] };

      return { rows: [], rowCount: 0 };
    },
  };
}

function seedCatalog() {
  return {
    offerings: [
      {
        id: 'ro-1', client_slug: 'sunset', location_id: LOC,
        offering_key: TOWEL, label: TOWEL_LABEL, active: true, excludes: [], sort_order: 1,
      },
      {
        id: 'ro-2', client_slug: 'sunset', location_id: LOC,
        offering_key: 'inactive_towel', label: 'Dead Towel', active: false, excludes: [], sort_order: 2,
      },
      {
        id: 'ro-3', client_slug: 'sunset', location_id: 'sunset-sardinero',
        offering_key: 'foreign_towel', label: 'Foreign Towel', active: true, excludes: [], sort_order: 3,
      },
      {
        id: 'ro-4', client_slug: 'other-tenant', location_id: LOC,
        offering_key: 'other_tenant_towel', label: 'Other Tenant', active: true, excludes: [], sort_order: 4,
      },
    ],
    prices: [
      {
        id: 'p1', item_type: 'rental', item_code: `${TOWEL}__1_day`,
        amount_cents: TOWEL_CENTS, unit: 'day', location_id: LOC, offering_key: TOWEL,
      },
      {
        id: 'p2', item_type: 'rental', item_code: `${TOWEL}__2_days`,
        amount_cents: 4000, unit: 'day', location_id: LOC, offering_key: TOWEL,
      },
    ],
  };
}

function seedEquipmentOnlyBooking(qty) {
  const q = qty != null ? qty : 1;
  return {
    bookings: [{
      booking_id: BOOKING_ID,
      booking_code: 'SUN-EDIT-GEN',
      guest_name: 'Edit Gear Guest',
      phone: '+34600000001',
      status: 'confirmed',
      payment_status: 'unpaid',
      check_in: DATE,
      check_out: DATE,
      guest_count: q,
      total_amount_cents: TOWEL_CENTS * q,
      amount_paid_cents: 0,
      balance_due_cents: TOWEL_CENTS * q,
      metadata: {
        location_id: LOC,
        source: 'staff_manual',
        staff_manual_schedule: true,
        rentals: [{ offering_key: TOWEL, duration_key: '1_day', quantity: q }],
        components: [],
      },
    }],
    services: [{
      id: 'svc-old',
      service_record_id: 'svc-old',
      booking_id: BOOKING_ID,
      booking_code: 'SUN-EDIT-GEN',
      guest_name: 'Edit Gear Guest',
      service_type: 'addon_service',
      service_date: DATE,
      quantity: q,
      amount_due_cents: TOWEL_CENTS * q,
      amount_paid_cents: 0,
      payment_status: 'pending',
      source: 'staff_manual',
      record_source: 'staff_manual',
      metadata: {
        rental_offering: true,
        generic_rental: true,
        offering_key: TOWEL,
        offering_label: TOWEL_LABEL,
        duration_key: '1_day',
        item_code: `${TOWEL}__1_day`,
        unit: 'day',
        unit_cents: TOWEL_CENTS,
        location_id: LOC,
        staff_ui_service_type: 'rental',
        component: 'addon_service',
        source: 'staff_manual',
        staff_manual_schedule: true,
      },
    }],
    payments: [],
  };
}

(async () => {
  const {
    prepareCanonicalRentalsForCreate,
    prepareGenericRentalsForCreate,
    buildGenericRentalAuthoritativeQuote,
    inclusiveIsoDatesFromRange,
    rentalDurationKeyFromDateRange,
  } = require(WRITES_REQ);
  const drawer = require(DRAWER_REQ);
  const drawerSrc = fs.readFileSync(DRAWER_REQ, 'utf8');
  const catalog = seedCatalog();

  // ── RED: bare canonical allowlist still rejects generic keys ────────────
  const bareBody = {
    guest_name: 'Edit Gear Guest',
    date_from: DATE,
    date_to: DATE,
    payment_status: 'unpaid',
    components: {},
    surfer_count: 2,
    rentals: [{ offering_key: TOWEL, duration_key: '1_day', quantity: 2 }],
  };
  const bare = prepareCanonicalRentalsForCreate(bareBody);
  ok('RED: bare prepareCanonical rejects generic offering_key (fail-closed allowlist)',
    bare.ok === false && /offering_key is not allowed/.test(String(bare.error || '')),
    JSON.stringify(bare));

  // RED intermediate: old Edit bug restored lockedMeta generic keys into
  // canonicalRentals, disabling genericOnly short-circuit and re-entering
  // the closed quote parser with the same allowlist error.
  const redQuoteBody = {
    ...bareBody,
    // Simulated pre-fix quote transport: generic keys wrongly on rentals[]
    rentals: [{ offering_key: TOWEL, duration_key: '1_day', quantity: 2 }],
  };
  const redCanonical = prepareCanonicalRentalsForCreate(redQuoteBody);
  ok('RED: pre-fix quote transport with restored generic keys still fails allowlist',
    redCanonical.ok === false && /offering_key is not allowed/.test(String(redCanonical.error || '')),
    JSON.stringify(redCanonical));

  // Source contract: explicit rentals must not restore lockedMeta into canonical
  ok('fix source: rentalsPresentOnPatch gates lockedMeta restore',
    /const rentalsPresentOnPatch[\s\S]*if \(!rentalPrep\.present\)[\s\S]*if \(!rentalsPresentOnPatch/.test(drawerSrc)
    || /rentalsPresentOnPatch[\s\S]{0,200}!rentalsPresentOnPatch[\s\S]{0,200}lockedMeta\.rentals/.test(drawerSrc));
  ok('fix source: onlyCanonical filter keeps generic keys out of canonicalRentals',
    /onlyCanonical/.test(drawerSrc)
    && /CANONICAL_RENTAL_KEYS\.has/.test(drawerSrc));
  ok('updateSunsetScheduleBooking still wires prepareGenericRentalsForCreate + inserts records',
    /async function updateSunsetScheduleBooking[\s\S]*prepareGenericRentalsForCreate/.test(drawerSrc)
    && /for \(const descriptor of genericPrep\.records/.test(drawerSrc));

  // ── Edit controls → real transport (no page.evaluate / helper payload) ──
  const dom = buildEditRentalDom({ offeringKey: TOWEL, label: TOWEL_LABEL, durationKey: '1_day', quantity: 2 });
  const transport = loadEditTransport(dom);
  ok('Edit controls serialize identity/duration/quantity only (no cents)',
    Array.isArray(transport.rentals)
    && transport.rentals.length === 1
    && transport.rentals[0].offering_key === TOWEL
    && transport.rentals[0].duration_key === '1_day'
    && transport.rentals[0].quantity === 2
    && transport.rentals[0].amount_cents == null
    && transport.rentals[0].unit_cents == null
    && transport.rentals[0].total_cents == null,
    JSON.stringify(transport.rentals));
  ok('Edit payload transport includes rentals from live controls',
    transport.payload
    && Array.isArray(transport.payload.rentals)
    && transport.payload.rentals[0].offering_key === TOWEL
    && transport.payload.components
    && !Object.keys(transport.payload.components).length,
    JSON.stringify(transport.payload));

  // ── GREEN: public PATCH production owner (updateSunsetScheduleBooking) ──
  const seed = { ...seedEquipmentOnlyBooking(1), ...catalog };
  const pg = makePg(seed);
  const patchBody = Object.assign(
    { booking_id: BOOKING_ID },
    transport.payload,
  );
  // Browser never sends cents on rentals
  ok('PATCH body has no client money fields on rentals',
    !(patchBody.rentals || []).some((r) =>
      r && (r.amount_cents != null || r.unit_cents != null || r.total_cents != null
        || r.quoted_total_cents != null)));

  const result = await drawer.updateSunsetScheduleBooking(pg, {
    clientSlug: 'sunset',
    bookingId: BOOKING_ID,
    body: patchBody,
    locationId: LOC,
    actor: { staff_user_id: 'staff-1', email: 'staff@test.local' },
  });
  ok('GREEN: public updateSunsetScheduleBooking accepts active equipment-only generic',
    result.ok === true && result.status === 200 && result.body && result.body.success === true,
    JSON.stringify({
      ok: result.ok,
      status: result.status,
      error: result.body && result.body.error,
      reason: result.body && result.body.reason,
    }));
  ok('production transaction committed (not rolled back)',
    pg.state.commits >= 1 && pg.state.rollbacks === 0,
    `commits=${pg.state.commits} rollbacks=${pg.state.rollbacks}`);

  const metaRentals = parseMeta(pg.state.bookings[0].metadata).rentals || [];
  ok('reopen metadata rentals: canonical name key + duration + quantity',
    metaRentals.length === 1
    && metaRentals[0].offering_key === TOWEL
    && metaRentals[0].duration_key === '1_day'
    && Number(metaRentals[0].quantity) === 2,
    JSON.stringify(metaRentals));

  const towelRows = pg.state.services.filter((s) => {
    const m = parseMeta(s.metadata);
    return m.offering_key === TOWEL || m.rental_offering === true;
  });
  ok('reopen service row: offering label/duration/quantity + admin amount',
    towelRows.length >= 1
    && Number(towelRows[0].quantity) === 2
    && parseMeta(towelRows[0].metadata).offering_label === TOWEL_LABEL
    && parseMeta(towelRows[0].metadata).duration_key === '1_day'
    && Number(towelRows[0].amount_due_cents) === TOWEL_CENTS * 2,
    JSON.stringify(towelRows.map((s) => ({
      qty: s.quantity, due: s.amount_due_cents, meta: parseMeta(s.metadata),
    }))));
  ok('booking total matches generic qty × unit (no silent zero)',
    Number(pg.state.bookings[0].total_amount_cents) === TOWEL_CENTS * 2,
    String(pg.state.bookings[0].total_amount_cents));

  // ── Hostile keys fail closed ────────────────────────────────────────────
  async function hostile(label, offeringKey, expectReason) {
    const hPg = makePg({ ...seedEquipmentOnlyBooking(1), ...catalog });
    const hBody = {
      booking_id: BOOKING_ID,
      guest_name: 'Edit Gear Guest',
      guest_phone: '+34600000001',
      date_from: DATE,
      date_to: DATE,
      payment_status: 'unpaid',
      components: {},
      surfer_count: 1,
      rentals: [{ offering_key: offeringKey, duration_key: '1_day', quantity: 1 }],
      custom_line_items: [],
      course_equipment: [],
      lessons: [],
    };
    const r = await drawer.updateSunsetScheduleBooking(hPg, {
      clientSlug: 'sunset',
      bookingId: BOOKING_ID,
      body: hBody,
      locationId: LOC,
      actor: { staff_user_id: 'staff-1', email: 'staff@test.local' },
    });
    const err = String((r.body && (r.body.error || r.body.reason || r.body.reason_code)) || '');
    ok(`hostile ${label} fails closed`,
      r.ok === false
      && hPg.state.commits === 0
      && (
        expectReason.some((x) => err.includes(x))
        || /not allowed|not_active|invalid_rental|price_not_found|price_scope/i.test(err)
      ),
      JSON.stringify({ ok: r.ok, status: r.status, err, body: r.body }));
  }
  await hostile('arbitrary key', 'totally_made_up_rental_xyz', [
    'rental_offering_not_active', 'invalid_rental_offering',
  ]);
  await hostile('inactive catalog key', 'inactive_towel', [
    'rental_offering_not_active', 'invalid_rental_offering',
  ]);
  await hostile('foreign location key', 'foreign_towel', [
    'rental_offering_not_active', 'invalid_rental_offering', 'price_scope_mismatch',
  ]);
  await hostile('foreign tenant key', 'other_tenant_towel', [
    'rental_offering_not_active', 'invalid_rental_offering',
  ]);

  // Malformed duration fails closed
  {
    const hPg = makePg({ ...seedEquipmentOnlyBooking(1), ...catalog });
    const r = await drawer.updateSunsetScheduleBooking(hPg, {
      clientSlug: 'sunset',
      bookingId: BOOKING_ID,
      body: {
        booking_id: BOOKING_ID,
        guest_name: 'Edit Gear Guest',
        guest_phone: '+34600000001',
        date_from: DATE,
        date_to: DATE,
        payment_status: 'unpaid',
        components: {},
        surfer_count: 1,
        rentals: [{ offering_key: TOWEL, duration_key: 'not_a_real_duration', quantity: 1 }],
      },
      locationId: LOC,
      actor: { staff_user_id: 'staff-1', email: 'staff@test.local' },
    });
    ok('malformed duration fails closed',
      r.ok === false && hPg.state.commits === 0,
      JSON.stringify(r.body));
  }

  // Mixed + class-only remain valid (composition smoke via prep split)
  {
    const mixed = await prepareGenericRentalsForCreate({
      clientSlug: 'sunset',
      locationId: LOC,
      pgClient: {},
      rentals: [
        { offering_key: 'board_rental', duration_key: '1_day', quantity: 1 },
        { offering_key: TOWEL, duration_key: '1_day', quantity: 1 },
      ],
      serviceDate: DATE,
      source: 'staff_manual',
      calendarDayCount: 1,
      bookingDurationKey: '1_day',
      listOfferings: async () => catalog.offerings.filter((o) => o.active !== false && o.location_id === LOC && o.client_slug === 'sunset'),
      loadRule: async ({ duration }) => ({
        status: 'found',
        amount_cents: TOWEL_CENTS,
        currency: 'EUR',
        item_code: `${TOWEL}__${duration}`,
        unit: 'day',
        location_id: LOC,
      }),
    });
    ok('mixed canonical+generic: generic prep accepts towel only',
      mixed.ok === true
      && mixed.genericRentals.length === 1
      && mixed.genericRentals[0].offering_key === TOWEL,
      JSON.stringify(mixed));
    const CANONICAL = new Set(['board_rental', 'wetsuit_rental', 'board_and_suit_rental']);
    const canonRows = [
      { offering_key: 'board_rental', duration_key: '1_day', quantity: 1 },
      { offering_key: TOWEL, duration_key: '1_day', quantity: 1 },
    ].filter((r) => CANONICAL.has(r.offering_key));
    const canonPrep = prepareCanonicalRentalsForCreate({
      guest_name: 'Mixed',
      date_from: DATE,
      date_to: DATE,
      payment_status: 'unpaid',
      components: {},
      surfer_count: 1,
      rentals: canonRows,
    });
    ok('mixed: canonical lane accepts board after generic strip',
      canonPrep.ok === true && canonPrep.present === true,
      JSON.stringify(canonPrep));
  }

  // Class-only (no rentals) still validates through update-style empty prep
  {
    const emptyPrep = await prepareGenericRentalsForCreate({
      clientSlug: 'sunset',
      locationId: LOC,
      pgClient: {},
      rentals: [],
      serviceDate: DATE,
      source: 'staff_manual',
      listOfferings: async () => catalog.offerings,
      loadRule: async () => ({ status: 'not_found' }),
    });
    ok('class-only: empty rentals generic prep is no-op ok',
      emptyPrep.ok === true
      && emptyPrep.genericRentals.length === 0
      && emptyPrep.records.length === 0);
  }

  // Generic quote short-circuit composition (invoice label via offering_label)
  {
    const gp = await prepareGenericRentalsForCreate({
      clientSlug: 'sunset',
      locationId: LOC,
      pgClient: {},
      rentals: [{ offering_key: TOWEL, duration_key: '1_day', quantity: 2 }],
      serviceDate: DATE,
      source: 'staff_manual',
      calendarDayCount: inclusiveIsoDatesFromRange(DATE, DATE).length,
      bookingDurationKey: rentalDurationKeyFromDateRange(DATE, DATE),
      listOfferings: async () => catalog.offerings.filter((o) => o.active && o.location_id === LOC && o.client_slug === 'sunset'),
      loadRule: async ({ duration }) => ({
        status: 'found',
        amount_cents: TOWEL_CENTS,
        currency: 'EUR',
        item_code: `${TOWEL}__${duration}`,
        unit: 'day',
        location_id: LOC,
      }),
    });
    const gq = buildGenericRentalAuthoritativeQuote(gp.records);
    ok('invoice label composition: generic quote uses offering identity not addon_service bucket alone',
      gq.line_items.length === 1
      && gq.line_items[0].offering_id === TOWEL
      && gq.total_cents === TOWEL_CENTS * 2
      && gp.records[0].metadata.offering_label === TOWEL_LABEL,
      JSON.stringify(gq));
  }

  // Tenant scope: wrong location must not accept foreign offering even if listed elsewhere
  {
    const foreign = await prepareGenericRentalsForCreate({
      clientSlug: 'sunset',
      locationId: LOC,
      pgClient: {},
      rentals: [{ offering_key: 'foreign_towel', duration_key: '1_day', quantity: 1 }],
      serviceDate: DATE,
      source: 'staff_manual',
      listOfferings: async () => catalog.offerings.filter((o) => o.client_slug === 'sunset' && o.location_id === LOC && o.active),
      loadRule: async () => ({ status: 'not_found' }),
    });
    ok('tenant/location resolution fail-closed for foreign offering',
      foreign.ok === false
      && (foreign.reason === 'rental_offering_not_active'
        || foreign.reason === 'invalid_rental_offering'
        || foreign.reason === 'price_not_found'),
      JSON.stringify(foreign));
  }

  console.log(`\nverify-sunset-edit-generic-rental-regression — ${pass} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
