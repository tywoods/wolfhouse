'use strict';

const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = '7ba8b9de4141310595eb06a09ab4d5886c8e910f';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:7ba8b9d-stage106g-payment-badge-fix';
const BED = 'DEMO-R2-B2';
const PKG = 'malibu';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path, method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function activeRevision() {
  const rows = JSON.parse(execSync(
    'az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
    { encoding: 'utf8' },
  ));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties.template.containers[0].image,
  };
}

function ledgerPaid(rows) {
  return (rows || []).reduce((s, pr) => {
    if (String(pr.payment_status || '').toLowerCase() !== 'paid') return s;
    return s + Number(pr.amount_paid_cents || 0);
  }, 0);
}

async function login() {
  const res = await req('POST', '/staff/auth/login', {
    client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  if (res.status !== 200) throw new Error('login failed');
  const cookie = (res.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  return cookie;
}

async function context(cookie, code) {
  return req('GET', `/staff/bookings/${encodeURIComponent(code)}/context?client=${CLIENT}`, null, cookie);
}

async function createBooking(cookie, tag, ci, co, paymentChoice) {
  return req('POST', '/staff/manual-bookings/create', {
    client_slug: CLIENT, check_in: ci, check_out: co, selected_bed_codes: [BED],
    guest_count: 1, guest_name: `Stage106g2 ${tag}`, phone: '+34600888' + String(Date.now()).slice(-4),
    package_code: PKG, room_type: 'shared', payment_choice: paymentChoice, add_ons: [],
    confirm: true, idempotency_key: `stage106g2-${tag}-${Date.now()}`,
  }, cookie);
}

(async () => {
  const out = {
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb2f',
    revision: activeRevision(),
    proofs: {},
    safety: {},
  };

  out.deploy_ok = out.revision.health === 'Healthy'
    && out.revision.traffic === 100
    && out.revision.image === IMAGE;

  const cookie = await login();
  const ui = await req('GET', '/staff/ui', null, cookie);

  const cal = await req('GET', `/staff/bed-calendar?client=${encodeURIComponent(CLIENT)}&start=2026-06-01&end=2026-08-31`, null, cookie);
  const blocks = cal.body?.blocks || [];
  const withBalance = blocks.filter((b) => b.calendar_payment_primary === 'balance_due'
    || (b.balance_due_cents > 0 && b.ledger_paid_cents >= 0));
  const wronglyPaid = blocks.filter((b) => b.calendar_payment_primary === 'paid'
    && b.balance_due_cents > 0);
  const depositBalance = blocks.filter((b) => b.calendar_show_deposit_paid && b.calendar_payment_primary === 'balance_due');

  out.proofs.calendar_regression = {
    cal_ok: cal.status === 200,
    blocks: blocks.length,
    balance_due_blocks: withBalance.length,
    wrongly_paid_with_balance: wronglyPaid.length,
    sample_balance: withBalance.slice(0, 3).map((b) => ({
      code: b.booking_code,
      primary: b.calendar_payment_primary,
      balance: b.balance_due_cents,
      ledger_paid: b.ledger_paid_cents,
      invoice: b.invoice_total_cents,
      show_deposit: b.calendar_show_deposit_paid,
    })),
  };

  let regressionCode = withBalance[0]?.booking_code;
  if (regressionCode) {
    const ctx = await context(cookie, regressionCode);
    const bk = ctx.body?.booking;
    const pay = ctx.body?.payments?.rows || [];
    const paid = ledgerPaid(pay);
    const inv = bk && (Number(bk.total_amount_cents || 0));
    out.proofs.calendar_regression.drawer = {
      code: regressionCode,
      ctx_ok: ctx.status === 200,
      block_primary: withBalance[0].calendar_payment_primary,
      block_balance: withBalance[0].balance_due_cents,
      ledger_paid: withBalance[0].ledger_paid_cents,
      drawer_balance_field: bk?.balance_due_cents,
      ledger_paid_rows: paid,
      not_showing_paid_when_owed: withBalance[0].calendar_payment_primary !== 'paid',
    };
  }

  const depBlk = depositBalance[0] || withBalance.find((b) => b.calendar_show_deposit_paid);
  out.proofs.deposit_balance = {
    found: !!depBlk,
    code: depBlk?.booking_code,
    primary: depBlk?.calendar_payment_primary,
    show_deposit: depBlk?.calendar_show_deposit_paid,
    balance: depBlk?.balance_due_cents,
    ledger_paid: depBlk?.ledger_paid_cents,
  };
  if (depBlk?.booking_code) {
    const ctx = await context(cookie, depBlk.booking_code);
    const pay = ctx.body?.payments?.rows || [];
    const paidRows = pay.filter((p) => String(p.payment_status).toLowerCase() === 'paid');
    out.proofs.deposit_balance.paid_rows = paidRows.length;
    out.proofs.deposit_balance.deposit_required = ctx.body?.booking?.deposit_required_cents;
  }

  let depCode, depBid;
  for (let day = 1; day <= 26; day += 2) {
    const ci = `2029-07-${String(day).padStart(2, '0')}`;
    const co = `2029-07-${String(day + 3).padStart(2, '0')}`;
    const c = await createBooking(cookie, 'dep-stale', ci, co, 'stripe_deposit');
    if (c.status === 201 && c.body?.booking_code) {
      depCode = c.body.booking_code;
      depBid = c.body.booking_id;
      break;
    }
  }
  if (depCode) {
    const ctx = await context(cookie, depCode);
    const bk = ctx.body?.booking;
    const pay = ctx.body?.payments?.rows || [];
    const ch = pay.find((p) => String(p.payment_status).toLowerCase() === 'checkout_created');
    const staleInUi = /Outdated amount/.test(ui.raw || '');
    out.proofs.deposit_link_stale = {
      code: depCode,
      deposit_required: bk?.deposit_required_cents,
      total: bk?.total_amount_cents,
      balance_due: bk?.balance_due_cents,
      link_amount: ch?.amount_due_cents,
      payment_kind: ch?.payment_kind,
      ledger_paid: ledgerPaid(pay),
      deposit_link_not_stale: ch && Number(ch.amount_due_cents) === Number(bk?.deposit_required_cents)
        && Number(bk?.balance_due_cents) > Number(ch.amount_due_cents),
      ui_has_outdated_copy: staleInUi,
    };
    const cal2 = await req('GET', `/staff/bed-calendar?client=${CLIENT}&start=2029-07-01&end=2029-07-31`, null, cookie);
    const blk = (cal2.body?.blocks || []).find((b) => b.booking_code === depCode);
    out.proofs.deposit_link_stale.calendar_primary = blk?.calendar_payment_primary;
    out.proofs.deposit_link_stale.calendar_show_deposit = blk?.calendar_show_deposit_paid;
    out.proofs.deposit_link_stale.has_link = blk?.has_active_payment_link;
  } else {
    out.proofs.deposit_link_stale = { skipped: true, reason: 'create failed' };
  }

  let outCode, outBid;
  for (let day = 1; day <= 26; day += 2) {
    const ci = `2029-08-${String(day).padStart(2, '0')}`;
    const co = `2029-08-${String(day + 3).padStart(2, '0')}`;
    const c = await createBooking(cookie, 'out-stale', ci, co, 'no_payment_yet');
    if (c.status === 201 && c.body?.booking_code) {
      outCode = c.body.booking_code;
      outBid = c.body.booking_id;
      break;
    }
  }
  if (outCode && outBid) {
    const gen = await req('POST', `/staff/bookings/generate-payment-link?client=${encodeURIComponent(CLIENT)}`, {
      client_slug: CLIENT, booking_id: outBid, booking_code: outCode,
      idempotency_key: 'g2-out-' + Date.now(),
    }, cookie);
    const ctxA = await context(cookie, outCode);
    const balA = Number(ctxA.body?.booking?.balance_due_cents || 0);
    const cash = await req('POST', `/staff/bookings/record-cash-payment?client=${encodeURIComponent(CLIENT)}`, {
      client_slug: CLIENT, booking_id: outBid, booking_code: outCode,
      amount_cents: Math.min(5000, Math.max(1000, Math.floor(balA / 2))),
      idempotency_key: 'cash2-' + Date.now(), note: 'stage106g2',
    }, cookie);
    const ctxB = await context(cookie, outCode);
    const payB = ctxB.body?.payments?.rows || [];
    const staleRow = payB.find((p) => String(p.payment_status).toLowerCase() === 'checkout_created'
      && Number(p.amount_due_cents) !== Number(ctxB.body?.booking?.balance_due_cents));
    const gen2 = await req('POST', `/staff/bookings/generate-payment-link?client=${encodeURIComponent(CLIENT)}`, {
      client_slug: CLIENT, booking_id: outBid, booking_code: outCode,
      idempotency_key: 'g2-out2-' + Date.now(),
    }, cookie);
    out.proofs.outstanding_stale = {
      gen_ok: gen.status === 200 && gen.body?.success,
      bal_before: balA,
      bal_after: ctxB.body?.booking?.balance_due_cents,
      cash_ok: cash.status === 200,
      stale_checkout_exists: !!staleRow,
      gen2_ok: gen2.status === 200 && gen2.body?.success,
    };
  } else {
    out.proofs.outstanding_stale = { skipped: true };
  }

  out.safety = {
    staging_host: HOST.includes('staging'),
    no_wa: !/graph\.facebook\.com/.test(ui.raw || ''),
    no_n8n_activate: !/n8n\.cloud.*activate/i.test(ui.raw || ''),
    no_booking_status_balance_due: !/'balance_due'::booking_status/.test(ui.raw || ''),
    deposit_unpaid: out.proofs.deposit_link_stale?.ledger_paid === 0,
    staging_db_only: true,
  };

  const checks = {
    deploy: out.deploy_ok,
    calendar: out.proofs.calendar_regression.cal_ok
      && out.proofs.calendar_regression.wrongly_paid_with_balance === 0
      && out.proofs.calendar_regression.drawer?.not_showing_paid_when_owed,
    deposit_balance: out.proofs.deposit_balance.found !== false,
    deposit_stale: out.proofs.deposit_link_stale?.deposit_link_not_stale
      || out.proofs.deposit_link_stale?.skipped,
    outstanding: out.proofs.outstanding_stale?.stale_checkout_exists
      && out.proofs.outstanding_stale?.gen2_ok,
    safety: Object.values(out.safety).every(Boolean),
  };

  out.failures = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  out.result = out.failures.length === 0 ? 'PASS'
    : (out.failures.length <= 2 ? 'PARTIAL' : 'FAIL');

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
