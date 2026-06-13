'use strict';
const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const TOKEN = execSync('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv', { encoding: 'utf8' }).trim();

const guestContext = {
  message_lane: 'new_booking_inquiry',
  intake_state: 'ready_for_availability_check',
  readiness_state: 'ready_for_availability_check',
  booking_intake_ready: true,
  extracted_fields: {
    check_in: '2026-07-10',
    check_out: '2026-07-17',
    guest_count: 2,
    package_interest: 'malibu',
    transfer_interest: null,
    service_interest: [],
    payment_preference: null,
  },
  availability: {
    availability_check_attempted: true,
    availability_status: 'available',
    selected_bed_codes: ['DEMO-R1-B1', 'DEMO-R2-B1'],
  },
  quote: {
    quote_status: 'ready',
    payment_choice_needed: true,
    quote_total_cents: 59800,
    deposit_options: { deposit_required_cents: 20000 },
  },
  payment_choice_needed: true,
};

function post(wamid) {
  const payload = {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    phone_number_id: '1152900101233109',
    guest_phone: '+34600995555',
    guest_email: 'open-demo+34600995555@example.test',
    message_text: 'Deposit is fine',
    wamid,
    inbound_message_id: wamid,
    reference_date: '2026-06-08',
    guest_context: guestContext,
    create_demo_hold_draft_confirmed: true,
    assign_demo_bed_confirmed: true,
  };
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const r = https.request({
      hostname: HOST,
      path: '/staff/bot/open-demo-whatsapp-inbound-dry-run',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Luna-Bot-Token': TOKEN,
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

function pick(b) {
  return {
    http: b.status,
    success: b.body.success,
    write_status: b.body.write_status,
    assignment_write_status: b.body.assignment_write_status,
    booking_code: b.body.booking_code,
    booking_id: b.body.booking_id,
    assigned_bed_label: b.body.assigned_bed_label,
    assigned_room_label: b.body.assigned_room_label,
    calendar_visible_expected: b.body.calendar_visible_expected,
    stripe_link_created: b.body.stripe_link_created,
    payment_link_sent: b.body.payment_link_sent,
    whatsapp_sent: b.body.whatsapp_sent,
    confirmation_sent: b.body.confirmation_sent,
    pc_ready: b.body.review && b.body.review.payment_choice && b.body.review.payment_choice.payment_choice_ready,
    plan_status: b.body.review && b.body.review.hold_payment_draft_plan && b.body.review.hold_payment_draft_plan.plan_status,
  };
}

(async () => {
  const r1 = await post(`wamid.demo-seed-${Date.now()}-a`);
  await new Promise((r) => setTimeout(r, 2000));
  const r2 = await post(`wamid.demo-seed-${Date.now()}-b`);
  console.log(JSON.stringify({ run1: pick(r1), run2: pick(r2) }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
