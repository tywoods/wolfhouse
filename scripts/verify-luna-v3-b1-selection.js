'use strict';

const assert = require('node:assert/strict');
const { Client } = require('pg');
const api = require('./lib/model-led-luna');
const { assertSafeToolRequest } = require('./lib/model-led-luna/contracts');
const { formatServiceRecordForSchedule } = require('./lib/staff-booking-services-schedule');

const beds = [
  { room_id:'r3',room_code:'R3',room_name:'Room 3',room_type:'shared',selling_mode:'shared',capacity:4,fill_priority:1,room_sort_order:1,gender_strategy:'mixed',bed_id:'r3b1',bed_code:'R3-B1',bed_label:'1',bed_number:1,bed_active:true,bed_sellable:true },
  { room_id:'r3',room_code:'R3',room_name:'Room 3',room_type:'shared',selling_mode:'shared',capacity:4,fill_priority:1,room_sort_order:1,gender_strategy:'mixed',bed_id:'r3b2',bed_code:'R3-B2',bed_label:'2',bed_number:2,bed_active:true,bed_sellable:true },
  { room_id:'r3',room_code:'R3',room_name:'Room 3',room_type:'shared',selling_mode:'shared',capacity:4,fill_priority:1,room_sort_order:1,gender_strategy:'mixed',bed_id:'r3b3',bed_code:'R3-B3',bed_label:'3',bed_number:3,bed_active:true,bed_sellable:true },
  { room_id:'r3',room_code:'R3',room_name:'Room 3',room_type:'shared',selling_mode:'shared',capacity:4,fill_priority:1,room_sort_order:1,gender_strategy:'mixed',bed_id:'r3b4',bed_code:'R3-B4',bed_label:'4',bed_number:4,bed_active:true,bed_sellable:true },
  { room_id:'r10',room_code:'R10',room_name:'Room 10',room_type:'shared',selling_mode:'shared',capacity:1,fill_priority:2,room_sort_order:2,gender_strategy:'mixed',bed_id:'r10b1',bed_code:'R10-B1',bed_label:'1',bed_number:1,bed_active:true,bed_sellable:true },
];
const seasons=[{id:'s',code:'all',label:'All',priority:1,bookable:true,active:true,sort_order:1,ranges:[{start_month:1,start_day:1,end_month:12,end_day:31}],source:'db'}];
const items=[
 {id:'policy',item_type:'policy',item_code:'package_min_nights',label:'Minimum',metadata:{minimum_nights:7},active:true,sort_order:1,source:'db'},
 {id:'rental',item_type:'rental',item_code:'wetsuit_soft_top_combo',label:'Rental',metadata:{},active:true,sort_order:2,source:'db'},
 {id:'pkg',item_type:'package',item_code:'malibu',label:'Malibu',metadata:{min_days:7},active:true,sort_order:3,source:'db'},
];
const rules=[
 {id:'d1',item_type:'deposit',item_code:'standard_package',season_code:null,unit:'per_person',amount_cents:10000,currency:'EUR',active:true,source:'db'},
 {id:'d2',item_type:'deposit',item_code:'custom_or_short_stay',season_code:null,unit:'per_person',amount_cents:5000,currency:'EUR',active:true,source:'db'},
 {id:'r1',item_type:'rental',item_code:'wetsuit_soft_top_combo',season_code:null,unit:'per_day',amount_cents:1500,currency:'EUR',active:true,source:'db'},
 {id:'p1',item_type:'package',item_code:'malibu',season_code:'all',unit:'per_person_per_week',amount_cents:50000,currency:'EUR',active:true,source:'db'},
];
function pg(){ return { queries:[], async query(sql,params){ this.queries.push({sql,params});
  if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)/.test(sql)) return {rows:[]};
  if (/FROM rooms r/.test(sql)) return {rows:beds};
  if (/FROM booking_beds bb/.test(sql)||/FROM luna_v3_hold_beds hb/.test(sql)) return {rows:[]};
  if (/FROM wh_pricing_seasons s/.test(sql)) return {rows:seasons};
  if (/FROM wh_pricing_rules/.test(sql)) return {rows:rules};
  if (/FROM wh_pricing_items/.test(sql)) return {rows:items};
  if (/FROM wh_pricing_transfer_rules/.test(sql)) return {rows:[]};
  if (/FROM luna_v3_sessions/.test(sql)) return {rows:[{id:'sid',client_id:'cid',write_admitted:true}]};
  if (/INSERT INTO luna_v3_operations/.test(sql)) return {rows:[{id:'oid',request_fingerprint:params[3],receipt:null}]};
  if (/INSERT INTO luna_v3_selections/.test(sql)||/UPDATE luna_v3_operations/.test(sql)) return {rows:[]};
  throw new Error(`unexpected query: ${sql.slice(0,100)}`);
} }; }
const context={tenantId:'wolfhouse-somo',authenticated:true,sessionId:'b1',principalId:'p',writeAllowed:true};
const guests=['Camille','Ari','Bo','Cy','Dee'].map(name=>({name}));

async function verifyDatedRentalsInPostgres() {
  const client = new Client({ connectionString: process.env.V3_TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query(`
      INSERT INTO wh_pricing_items(client_slug,item_type,item_code,label,metadata,active,sort_order)
      VALUES('wolfhouse-somo','rental','wetsuit_soft_top_combo','Wetsuit + soft top','{}',true,90);
      INSERT INTO wh_pricing_rules(client_slug,item_type,item_code,season_code,unit,amount_cents,currency,active)
      VALUES('wolfhouse-somo','rental','wetsuit_soft_top_combo',NULL,'per_day',1500,'EUR',true);
      ALTER TABLE booking_service_records
        ADD COLUMN booking_code text,
        ADD COLUMN guest_name text,
        ADD COLUMN service_type text,
        ADD COLUMN service_date date,
        ADD COLUMN quantity int,
        ADD COLUMN amount_paid_cents int DEFAULT 0,
        ADD COLUMN payment_status text,
        ADD COLUMN source text,
        ADD COLUMN notes text;
    `);
    const tenant = (await client.query(`SELECT id FROM clients WHERE slug='wolfhouse-somo'`)).rows[0];
    assert.ok(tenant, 'disposable suite did not leave the wolfhouse-somo schema fixture available');

    const withPgClient = async (fn) => {
      const operationClient = new Client({ connectionString: process.env.V3_TEST_DATABASE_URL });
      await operationClient.connect();
      try { return await fn(operationClient); } finally { await operationClient.end(); }
    };
    const operations = api.createOperations(withPgClient, {
      resolveBookingAdmission: async () => ({ allowed: true, source: 'b1_disposable_postgres_verifier' }),
    });
    const cases = [
      { suffix: 'three-days-q1', checkIn: '2031-06-01', checkOut: '2031-06-08', dates: ['2031-06-02','2031-06-04','2031-06-06'], days: 3, quantity: 1, bed: 'R10-B1' },
      { suffix: 'two-days-q4', checkIn: '2031-07-01', checkOut: '2031-07-08', dates: ['2031-07-03','2031-07-05'], days: 2, quantity: 4, bed: 'R10-B2' },
    ];
    for (const rentalCase of cases) {
      const sessionId = `luna-v3:b1-rental-${rentalCase.suffix}`;
      const operationContext = {
        tenantId: 'wolfhouse-somo', authenticated: true, sessionId,
        principalId: 'staff-api-authenticated', writeAllowed: true, guestPhone: '+34600000000',
      };
      await client.query(
        `INSERT INTO luna_v3_sessions(client_id,session_key,principal_id,write_admitted,guest_phone) VALUES($1,$2,$3,true,$4)`,
        [tenant.id, sessionId, operationContext.principalId, operationContext.guestPhone],
      );
      const expectedRental = { code: 'wetsuit_soft_top_combo', days: rentalCase.days, quantity: rentalCase.quantity, dates: rentalCase.dates };
      const quote = await operations.quote({
        operation_key: `b1-quote-${rentalCase.suffix}`, check_in: rentalCase.checkIn, check_out: rentalCase.checkOut,
        guests: [{ name: `Rental ${rentalCase.suffix}` }],
        selection: { selected_bed_codes: [rentalCase.bed], room_type: 'shared' },
        add_ons: [expectedRental],
      }, operationContext);
      assert.equal(quote.ok, true, JSON.stringify(quote));
      assert.deepEqual(
        quote.lineItems.find((line) => line.code === expectedRental.code),
        { code: expectedRental.code, label: `Wetsuit + soft top (${rentalCase.days} days × ${rentalCase.quantity} ${rentalCase.quantity === 1 ? 'person' : 'people'} × 15€)`, days: rentalCase.days, quantity: rentalCase.quantity, people_count: rentalCase.quantity, unit_cents: 1500, total_cents: 1500 * rentalCase.days * rentalCase.quantity },
      );
      const quotedSql = (await client.query(
        `SELECT quote->'addOns' add_ons FROM luna_v3_selections WHERE client_id=$1 AND session_id=(SELECT id FROM luna_v3_sessions WHERE client_id=$1 AND session_key=$2) AND quote_revision=$3`,
        [tenant.id, sessionId, quote.quoteRevision],
      )).rows[0];
      assert.deepEqual(quotedSql.add_ons, [expectedRental], 'independent SQL quote readback lost dated rental fields');

      const hold = await operations.hold_beds({ operation_key: `b1-hold-${rentalCase.suffix}`, ...quote.holdInput }, operationContext);
      assert.equal(hold.ok, true, JSON.stringify(hold));
      const booked = await operations.book({ operation_key: `b1-book-${rentalCase.suffix}`, hold_id: hold.holdId }, operationContext);
      assert.equal(booked.ok, true, JSON.stringify(booked));
      assert.deepEqual(booked.addOns, [expectedRental], 'book service receipt lost dated rental fields');

      const serviceReadback = await operations.get_booking({ booking_id: booked.bookingId }, operationContext);
      assert.equal(serviceReadback.ok, true, JSON.stringify(serviceReadback));
      assert.deepEqual(serviceReadback.addOns, [expectedRental], 'getBooking service readback lost dated rental fields');
      const isoDate = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
      assert.equal(isoDate(serviceReadback.check_in), rentalCase.checkIn);
      assert.equal(isoDate(serviceReadback.check_out), rentalCase.checkOut);

      const sqlReadback = (await client.query(
        `SELECT check_in::text,check_out::text,metadata->'add_ons_at_create' add_ons FROM bookings WHERE id=$1 AND client_id=$2`,
        [booked.bookingId, tenant.id],
      )).rows[0];
      assert.deepEqual(sqlReadback, { check_in: rentalCase.checkIn, check_out: rentalCase.checkOut, add_ons: [expectedRental] },
        'independent SQL booking readback lost dated rental fields');
      const serviceRows = (await client.query(
        `SELECT service_type,service_date::text,quantity,metadata->'requested_dates' requested_dates,
                (metadata->>'rental_days')::int rental_days,(metadata->>'rental_people')::int rental_people
           FROM booking_service_records WHERE booking_id=$1 ORDER BY service_type`,
        [booked.bookingId],
      )).rows;
      assert.deepEqual(serviceRows, ['surfboard', 'wetsuit'].map((serviceType) => ({
        service_type: serviceType, service_date: rentalCase.dates[0], quantity: rentalCase.days,
        requested_dates: rentalCase.dates, rental_days: rentalCase.days, rental_people: rentalCase.quantity,
      })), 'independent SQL service-record readback lost dated rental days or quantity');
      if (rentalCase.quantity === 4) {
        const staffRows = (await client.query(
          `SELECT id,service_type,service_date,quantity,amount_due_cents,amount_paid_cents,status,payment_status,metadata
             FROM booking_service_records WHERE booking_id=$1 ORDER BY service_type`,
          [booked.bookingId],
        )).rows;
        for (const row of staffRows) {
          const publicService = formatServiceRecordForSchedule(row);
          assert.equal(publicService.quantity * publicService.people_count, 8,
            `Staff services read must expose 8 participant-days for ${row.service_type}`);
        }
      }
    }
  } finally {
    await client.end();
  }
}

async function main(){
  const together=await api.findRooms(pg(),{check_in:'2027-07-01',check_out:'2027-07-08',party_size:5,preferences:{keep_together:true,guests}},context);
  assert.deepEqual(together.rooms,[],'together-required discovery must not split');
  assert.equal(together.splitSelection,null);

  const split=await api.findRooms(pg(),{check_in:'2027-07-01',check_out:'2027-07-08',party_size:5,preferences:{keep_together:false,guests}},context);
  assert.deepEqual(split.roomIds,['R3','R10'],'explicit split consent keeps useful partial rooms');
  const expectedBeds=['R10-B1','R3-B1','R3-B2','R3-B3','R3-B4'];
  assert.deepEqual(split.splitSelection,{selectedBedCodes:expectedBeds,guestBedAssignments:guests.map((guest,index)=>({guestIndex:index,guestName:guest.name,bedCode:expectedBeds[index]}))});

  const q=await api.quote(pg(),{operation_key:'quote-none',check_in:'2027-07-01',check_out:'2027-07-06',guests:[{name:'Lucia'}],selection:{selected_bed_codes:['R3-B1'],room_type:'shared'},add_ons:[{code:'wetsuit_soft_top_combo',days:1,quantity:1,dates:['2027-07-02']}]},context);
  assert.equal(q.ok,true,JSON.stringify(q));
  assert.deepEqual(q.holdInput,{check_in:'2027-07-01',check_out:'2027-07-06',guests:[{name:'Lucia'}],assignments:[{bed_code:'R3-B1',guest_name:'Lucia',package_code:'package_none'}],quoted_selection:q.quoteRevision});
  assert.doesNotThrow(()=>assertSafeToolRequest('hold_beds',{operation_key:'hold-none',...q.holdInput}));

  assert.doesNotThrow(()=>assertSafeToolRequest('quote',{operation_key:'lesson-request',add_ons:[{code:'surf_lesson',quantity:1,dates:['2027-03-13']}]}),
    'lesson date requests must not be coerced into rental days');
  const badRental=await api.quote(pg(),{operation_key:'rental-bad',check_in:'2027-11-10',check_out:'2027-11-17',guests:[{name:'Tom'}],selection:{selected_bed_codes:['R3-B1'],room_type:'shared'},add_ons:[{code:'wetsuit_soft_top_combo',days:2,quantity:1,dates:['2027-11-13']}]},context);
  assert.equal(badRental.ok,false);
  assert.equal(badRental.code,'rental_dates_duration_mismatch');
  console.log('B1 offline production-path checks passed: split consent, canonical hold input, rental units, lesson date discrimination');
  if (!process.env.V3_TEST_DATABASE_URL) throw new Error('V3_TEST_DATABASE_URL is required; disposable-DB B1 verification was not run');
  const dbResult=await require('./lib/model-led-luna/test-v3-postgres').main(api);
  assert(dbResult && dbResult.observations && dbResult.observations.stalePricingRefusal,
    'disposable-DB suite did not prove durable rejected hold recovery');
  await verifyDatedRentalsInPostgres();
  console.log('B1 disposable-DB checks passed: hold/book/readback, durable rejection, races, restart recovery');
}

if(require.main===module) main().catch(error=>{console.error(error.stack||error);process.exit(1)});
module.exports={main};
