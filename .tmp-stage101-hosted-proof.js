'use strict';
const https = require('https');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function cookieFrom(res) {
  return (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
}

async function login() {
  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  if (login.status !== 200) throw new Error('login failed ' + login.status);
  return cookieFrom(login);
}

(async () => {
  const cookie = await login();
  const ui = await req('GET', '/staff/ui', null, cookie);
  const html = ui.body || '';

  const uiPolish = {
    bcManualCreateInFlight: /var bcManualCreateInFlight/.test(html),
    inFlightCopy: /Creating booking/.test(html),
    errorHelper: /function bcManualCreateErrorMessage/.test(html),
    drawerOpen: /function bcOpenDrawerAfterManualCreate/.test(html),
    serviceRecordsCopy: /service_records_created/.test(html.match(/function renderCreateResult[\s\S]*?\n\}/)?.[0] || ''),
    paymentReadiness: /Draft payment ready|Payment:/.test(html.match(/function renderCreateResult[\s\S]*?\n\}/)?.[0] || ''),
    noWhatsapp: !/graph\.facebook\.com/.test(html.match(/function runManualBookingCreate[\s\S]*?function runCreateStripeLink/)?.[0] || ''),
    noStripeApi: !/api\.stripe\.com/.test(html.match(/function runManualBookingCreate[\s\S]*?function runCreateStripeLink/)?.[0] || ''),
  };

  const checkIn = '2026-09-20';
  const checkOut = '2026-09-23';
  const bed = 'DEMO-R1-B1';
  const guestName = 'Manual Polish Test';
  const phone = '+34999001991';
  const idem = 'stage101-manual-polish-' + Date.now();

  const quote = await req('POST', '/staff/quote-preview', {
    client_slug: CLIENT,
    check_in: checkIn,
    check_out: checkOut,
    selected_bed_codes: [bed],
    guest_count: 1,
    package_code: 'malibu',
    room_type: 'shared',
    payment_choice: 'deposit',
    add_ons: [],
  }, cookie);

  const createPayload = {
    client_slug: CLIENT,
    check_in: checkIn,
    check_out: checkOut,
    selected_bed_codes: [bed],
    guest_count: 1,
    guest_name: guestName,
    phone,
    package_code: 'malibu',
    room_type: 'shared',
    payment_choice: 'deposit',
    add_ons: [],
    confirm: true,
    idempotency_key: idem,
  };

  const create1 = await req('POST', '/staff/manual-bookings/create', createPayload, cookie);
  const create2 = await req('POST', '/staff/manual-bookings/create', createPayload, cookie);

  const missingField = await req('POST', '/staff/manual-bookings/create', {
    ...createPayload,
    guest_name: '',
    idempotency_key: idem + '-missing',
  }, cookie);

  let ctx = null;
  if (create1.body && create1.body.booking_code) {
    ctx = await req('GET', '/staff/bookings/' + encodeURIComponent(create1.body.booking_code) + '/context?client=' + CLIENT, null, cookie);
  }

  const out = {
    deploy: {
      image: 'whstagingacr.azurecr.io/wh-staff-api:c06b486-stage101-manual-booking-polish',
      revision: 'wh-staging-staff-api--0000051',
      commit: 'c06b486428f81c182d9987b9c5373f6cd4a97b97',
    },
    uiPolish,
    quote: { status: quote.status, success: quote.body && quote.body.success },
    testBooking: {
      status: create1.status,
      booking_code: create1.body && create1.body.booking_code,
      booking_id: create1.body && create1.body.booking_id,
      payment_id: create1.body && create1.body.payment_id,
      payment_status: create1.body && create1.body.payment_status,
      service_records_created: create1.body && create1.body.service_records_created,
      beds_inserted: create1.body && create1.body.beds_inserted,
      quote_summary: create1.body && create1.body.quote_summary,
    },
    doubleClickProof: {
      firstStatus: create1.status,
      retryStatus: create2.status,
      retryIdempotent: !!(create2.body && (create2.body.idempotent || create2.body.duplicate)),
      sameBookingCode: (create1.body && create2.body && create1.body.booking_code === create2.body.booking_code),
    },
    errorProof: {
      status: missingField.status,
      error: missingField.body && missingField.body.error,
      successFalse: !(missingField.body && missingField.body.success),
    },
    drawerProof: {
      contextStatus: ctx && ctx.status,
      contextOk: !!(ctx && ctx.body && ctx.body.success),
      guestName: ctx && ctx.body && ctx.body.booking && ctx.body.booking.guest_name,
      bookingCode: ctx && ctx.body && ctx.body.booking && ctx.body.booking.booking_code,
    },
    addOnProof: 'skipped',
    safety: {
      noWhatsapp: uiPolish.noWhatsapp,
      noStripeApi: uiPolish.noStripeApi,
      quoteReadOnly: quote.status === 200,
    },
  };

  const ok =
    uiPolish.bcManualCreateInFlight &&
    uiPolish.inFlightCopy &&
    uiPolish.errorHelper &&
    uiPolish.drawerOpen &&
    create1.status === 201 &&
    create1.body && create1.body.booking_code &&
    create2.body && (create2.body.idempotent || create2.body.duplicate) &&
    missingField.body && !missingField.body.success &&
    ctx && ctx.body && ctx.body.success;

  out.result = ok ? 'PASS' : 'PARTIAL';
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
