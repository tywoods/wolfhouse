'use strict';
// Offline contract test: actual Staff handlers/coordinator and disposable SQL.
// Only Stripe and the upstream booking-create result are fixtures. No live I/O.
const assert = require('assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const routes = require('./lib/staff-bot-v2-routes');
const clientId = '10000000-0000-0000-0000-000000000001';
const bookingId = '20000000-0000-0000-0000-000000000001';
const guests = [3, 1, 2].map(n => ({ booking_guest_id: `30000000-0000-0000-0000-00000000000${n}`,
  guest_number: n, guest_name: `Synthetic Guest ${n}`, deposit: 1017 * n }));
function capture() {
  return { status: null, body: null, setHeader() {}, writeHead(s) { this.status = s; }, end(raw) { this.body = JSON.parse(raw); } };
}
(async () => {
  const db = new PGlite();
  const sessions = new Map(); let creates = 0;
  const stripe = { checkout: { sessions: {
    async create(params, options) {
      creates++;
      assert.equal(params.currency, 'eur');
      const id = `cs_synthetic_${params.metadata.booking_guest_id}`;
      const session = { id, url: `https://checkout.stripe.com/test/${id}`, status: 'open', payment_status: 'unpaid', expires_at: 4102444800 };
      sessions.set(id, { ...session, params, key: options.idempotencyKey }); return session;
    },
    async retrieve(id) { assert(sessions.has(id)); return sessions.get(id); },
    async expire() { assert.fail('unchanged intent must not expire'); },
  } } };
  const pg = { async query(sql, params) { const r = await db.query(sql, params); return { ...r, rowCount: r.affectedRows ?? r.rows.length }; } };
  const ctx = { DEFAULT_CLIENT: 'wolfhouse-somo', BOT_BOOKING_ENABLED: true, STAFF_AUTH_REQUIRED: true,
    STRIPE_LINKS_ENABLED: true, STRIPE_SECRET_KEY: 'synthetic-not-a-key', stripe,
    withPgClient: fn => fn(pg), readBody: async req => req.body || '{}',
    sendJSON(res, status, body) { res.writeHead(status); res.end(JSON.stringify(body)); },
    send400(res, error) { res.writeHead(400); res.end(JSON.stringify({success:false,error})); },
    stripeCheckoutRedirectUrlsConfigured: () => true,
    stripeCheckoutSessionSuccessUrl: () => 'https://synthetic.invalid/success',
    stripeCheckoutSessionCancelUrl: () => 'https://synthetic.invalid/cancel',
  };
  try {
    await db.exec(`CREATE TYPE payment_record_status AS ENUM ('draft','checkout_created','paid','expired');
      CREATE TYPE payment_kind AS ENUM ('deposit_only','full_amount');
      CREATE TABLE clients(id uuid PRIMARY KEY, slug text);
      CREATE TABLE bookings(id uuid PRIMARY KEY, booking_code text, status text);
      CREATE TABLE booking_guests(id uuid PRIMARY KEY, client_id uuid, booking_id uuid, guest_number int,
        guest_name text, deposit_amount_cents bigint, metadata jsonb, payment_id uuid, payment_status text, updated_at timestamptz);
      CREATE TABLE payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid, booking_id uuid, booking_guest_id uuid,
        status payment_record_status, payment_kind payment_kind, currency text, amount_due_cents bigint, amount_paid_cents bigint DEFAULT 0,
        metadata jsonb, stripe_checkout_session_id text, checkout_url text, expires_at timestamptz, created_at timestamptz DEFAULT now());
      CREATE UNIQUE INDEX active_guest_payment ON payments(client_id,booking_id,booking_guest_id)
        WHERE metadata->>'source'='bot_guest_payment_link_slice_a' AND booking_guest_id IS NOT NULL AND status IN ('draft','checkout_created');`);
    await pg.query('INSERT INTO clients VALUES ($1,$2)', [clientId, 'wolfhouse-somo']);
    await pg.query('INSERT INTO bookings VALUES ($1,$2,$3)', [bookingId, 'WH-SYNTHETIC', 'confirmed']);
    for (const g of guests) await pg.query('INSERT INTO booking_guests(id,client_id,booking_id,guest_number,guest_name,deposit_amount_cents,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [g.booking_guest_id, clientId, bookingId, g.guest_number, g.guest_name, g.deposit, JSON.stringify({subtotal_cents:50000})]);
    const personal = [];
    for (const g of guests) {
      const res = capture();
      await routes.handleBotGuestPaymentCreateLink(g.booking_guest_id, {}, res, null, 'offline', ctx);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const row = (await pg.query('SELECT * FROM payments WHERE id=$1', [res.body.payment_id])).rows[0];
      assert.equal(res.body.currency, row.currency, 'personal response currency must match stored payment');
      assert.equal(res.body.booking_id, row.booking_id);
      assert.equal(res.body.booking_guest_id, row.booking_guest_id);
      assert.equal(res.body.guest_number, g.guest_number);
      assert.equal(res.body.guest_name, g.guest_name);
      assert.equal(res.body.amount_due_cents, Number(row.amount_due_cents));
      assert.equal(res.body.stripe_checkout_session_id, row.stripe_checkout_session_id);
      personal.push(res.body);
      const retry = capture();
      await routes.handleBotGuestPaymentCreateLink(g.booking_guest_id, {}, retry, null, 'offline', ctx);
      for (const key of ['currency','payment_id','booking_id','booking_guest_id','guest_number','amount_due_cents','stripe_checkout_session_id'])
        assert.equal(retry.body[key], res.body[key], `retry ${key}`);
      assert.equal(retry.body.idempotent, true);
    }
    assert.equal(creates, guests.length, 'retry must reuse provider identity');
    // Real automatic projection, deliberately permuted/stale roster labels.
    ctx.handleBotBookingCreate = async (_req, res) => res.end(JSON.stringify({ success:true, created:true,
      booking_id:bookingId, booking_code:'WH-SYNTHETIC', uses_per_guest_model:true,
      booking_guests: [...guests].reverse().map(g => ({...g,guest_name:'STALE ROSTER LABEL'})) }));
    ctx.handleBotGuestPaymentCreateLink = (id, req, res, user, auth) => routes.handleBotGuestPaymentCreateLink(id, req, res, user, auth,
      { ...ctx, readBody: async request => { let raw=''; for await (const chunk of request) raw += chunk; return raw; } });
    const batch = capture();
    await routes.handleBotBookingCreateFromPlan({body:JSON.stringify({client_slug:'wolfhouse-somo',payment_choice:'split'})},batch,null,'offline',ctx);
    assert.equal(batch.status,200); assert.equal(batch.body.guest_payment_links.length,3);
    for (const link of batch.body.guest_payment_links) {
      const owner = personal.find(p => p.booking_guest_id === link.booking_guest_id); assert(owner);
      for (const key of ['currency','booking_id','booking_code','booking_guest_id','guest_number','guest_name','payment_id','amount_due_cents','payment_target','stripe_checkout_session_id'])
        assert.equal(link[key], owner[key], `automatic projection must preserve ${key}`);
      assert.equal(link.secure_payment_url, owner.guest_payment_url);
    }
    assert.equal(creates,3);
    assert.equal(Number((await pg.query('SELECT count(*) AS count FROM payments')).rows[0].count),3);
    // Projection boundary probes: supplied currency/zero survive, missing truth
    // stays null instead of being filled from tenant defaults or roster guesses.
    for (const currency of ['GBP', null, undefined]) {
      ctx.handleBotGuestPaymentCreateLink = async (_id, _req, res) => res.end(JSON.stringify({
        success:true, currency, amount_due_cents:0, checkout_url:'https://checkout.stripe.com/test/boundary' }));
      const out = capture();
      await routes.handleBotBookingCreateFromPlan({body:JSON.stringify({client_slug:'wolfhouse-somo',payment_choice:'split'})},out,null,'offline',ctx);
      for (const link of out.body.guest_payment_links) {
        assert.equal(link.currency,currency ?? null);
        assert.equal(link.amount_due_cents,0);
        for (const key of ['booking_id','booking_code','booking_guest_id','guest_number','guest_name','payment_id','payment_target','stripe_checkout_session_id'])
          assert.equal(link[key],null,`absent ${key} must not be inferred`);
      }
    }
    // Non-Wolfhouse projection remains byte-for-byte the original shape.
    const other = capture();
    await routes.handleBotBookingCreateFromPlan({body:JSON.stringify({client_slug:'sunset',payment_choice:'split'})},other,null,'offline',ctx);
    assert.deepEqual(other.body.guest_payment_links,[...guests].reverse().map(g=>({
      guest_number:g.guest_number,guest_name:'STALE ROSTER LABEL',booking_guest_id:g.booking_guest_id,payment_id:null,
      secure_payment_url:'https://checkout.stripe.com/test/boundary' })));
    // Actual response function, coordinator result stubbed at its boundary only:
    // proves propagation, not support for collecting a new currency.
    const fs = require('fs'), vm = require('vm');
    const src = fs.readFileSync(require.resolve('./lib/staff-bot-v2-routes'),'utf8');
    const fn = src.slice(src.indexOf('async function handleBotGuestPaymentCreateLink('),src.indexOf('// POST /staff/bot/booking-guests/payment-status'));
    for (const currency of ['GBP', null, undefined]) {
      const sandbox = {process:{env:{}},buildPaymentShortLink:()=>null,require:()=>({run:async()=>({
        guest:{...guests[0],booking_id:bookingId,booking_code:'WH-SYNTHETIC'},paymentId:personal[0].payment_id,
        amount:1017,currency,session:{id:'cs_boundary',url:'https://checkout.stripe.com/test/boundary'} })})};
      vm.createContext(sandbox);vm.runInContext(fn,sandbox);
      const out = capture();
      await sandbox.handleBotGuestPaymentCreateLink(guests[0].booking_guest_id,{},out,null,'offline',ctx);
      assert.equal(out.status,200); assert.equal(out.body.currency,currency ?? null);
      const sunset = capture();
      await sandbox.handleBotGuestPaymentCreateLink(guests[0].booking_guest_id,{body:JSON.stringify({client_slug:'sunset'})},sunset,null,'offline',ctx);
      assert.equal(Object.hasOwn(sunset.body,'currency'),false,'non-Wolfhouse response shape unchanged');
    }
    console.log('PASS: disposable SQL + real personal/create-from-plan handlers; currency, exact identity, unequal cents, permuted roster, retries and provider reuse; boundary no-default/no-inference and non-Wolfhouse shape guards');
  } finally { await db.close(); }
})().catch(err => { console.error(err); process.exitCode=1; });
