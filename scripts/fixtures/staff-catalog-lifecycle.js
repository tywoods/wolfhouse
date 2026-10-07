'use strict';
// Disposable SQL adapter shared by focused handler and ordinary emitted-page proof.
// No server, inherited DB connection, provider or guest transport is started.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const catalog = require('../lib/tenant-services-writes');
const invoice = require('../lib/booking-invoice-totals');
const ROOT = path.join(__dirname, '../..');
const CLIENT = '10000000-0000-4000-8000-000000000001';
const BOOKING = '20000000-0000-4000-8000-000000000001';
const OTHER = '20000000-0000-4000-8000-000000000002';
const CODE = 'WH-CATALOG-OFFLINE';
function extract(source, name) {
  const m = new RegExp('^(?:async )?function ' + name + '\\(', 'm').exec(source);
  assert(m, 'production function missing: ' + name);
  const end = source.indexOf('\n}', m.index);
  assert(end > m.index);
  return source.slice(m.index, end + 2);
}
async function createFixture() {
  const db = new PGlite();
  const queries = [];
  const pg = { async query(sql, args) {
    queries.push({ sql, args });
    const r = await db.query(sql, args);
    return { ...r, rowCount: r.affectedRows ?? r.rows.length };
  } };
  await db.exec(`CREATE TABLE clients(id uuid PRIMARY KEY, slug text UNIQUE);
    CREATE TABLE bookings(id uuid PRIMARY KEY, client_id uuid REFERENCES clients(id), booking_code text,
      status text DEFAULT 'confirmed', guest_name text DEFAULT 'Offline catalog party', guest_count integer DEFAULT 2,
      check_in date DEFAULT '2026-10-10', check_out date DEFAULT '2026-10-17',
      total_amount_cents integer DEFAULT 10000, deposit_required_cents integer DEFAULT 0,
      metadata jsonb DEFAULT '{"quote_snapshot":{"line_items":[{"code":"package","total_cents":10000}]}}');
    CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at=NOW(); RETURN NEW; END $$;`);
  for (const migration of ['010_booking_service_records.sql','018_booking_service_records_nullable_service_date.sql','030_booking_service_records_slot_reservations.sql']) {
    await db.exec(fs.readFileSync(path.join(ROOT, 'database/migrations', migration), 'utf8'));
  }
  await db.query('INSERT INTO clients VALUES($1,$2)', [CLIENT, 'wolfhouse-somo']);
  await db.query('INSERT INTO clients VALUES($1,$2)', ['10000000-0000-4000-8000-000000000002', 'sunset']);
  await db.query('INSERT INTO bookings(id,client_id,booking_code) VALUES($1,$2,$3),($4,$2,$5)', [BOOKING,CLIENT,CODE,OTHER,'WH-OTHER-OFFLINE']);
  const services = {};
  for (const [key, body] of Object.entries({
    camp: {name:'Offline dated camp',category:'experience',price_cents:35000,price_unit:'per_stay',per_guest:true,start_date:'2026-10-10',end_date:'2026-10-17'},
    bike: {name:'Offline daily bike',category:'rental',price_cents:1500,price_unit:'per_day',per_guest:true},
    transfer: {name:'Offline flat transfer',category:'transfer',price_cents:4000,price_unit:'per_stay',per_guest:false},
    lesson: {name:'Offline lesson',category:'lesson',price_cents:6000,price_unit:'per_lesson',per_guest:true},
  })) {
    const r = await catalog.createService(pg, {clientSlug:'wolfhouse-somo',body,actor:{}});
    assert.equal(r.status, 201, JSON.stringify(r));
    services[key] = r.body.service;
  }
  // Production handler SQL and context service read execute against actual SQL.
  // Booking detail SELECT alone is adapted to this deliberately minimal base schema.
  const lookup = `SELECT b.*,b.id::text AS booking_id,b.check_in::text AS check_in,b.check_out::text AS check_out
    FROM bookings b JOIN clients c ON c.id=b.client_id WHERE c.slug=$1 AND `;
  const api = {
    fs, Date, ...require('../lib/staff-booking-services-schedule'), ...invoice,
    ...require('../lib/staff-booking-detail-queries'),
    computeTenantServiceChargeCents:catalog.computeServiceChargeCents,
    ensureBookingServiceGenericType:catalog.ensureBookingServiceGenericType,
    GENERIC_BOOKING_SERVICE_TYPE:catalog.GENERIC_BOOKING_SERVICE_TYPE,
    DEFAULT_CLIENT:'wolfhouse-somo', SQL_INJECT_RE:/[;'"\\]/, UUID_VALIDATE_RE:/^[a-f0-9-]{36}$/i, DATE_RE:/^\d{4}-\d{2}-\d{2}$/,
    readBody:async req=>JSON.stringify(req.body), withPgClient:fn=>fn(pg), appendAuditLog:()=>{},
    sendJSON:(res,status,body)=>Object.assign(res,{status,body}),
    send400:(res,error)=>Object.assign(res,{status:400,body:{success:false,error}}),
    bookingStatusIsCancelled:s=>['cancelled','expired'].includes(s), isMissingBookingServiceRecordsTable:()=>false,
    EDIT_PREVIEW_BOOKING_BY_ID_SQL:lookup+'b.id=$2::uuid', EDIT_PREVIEW_BOOKING_BY_CODE_SQL:lookup+'b.booking_code=$2',
    // Unrelated equipment combo side-effect not part of catalog billing.
    rebalanceBookingWetsuitBoardCombo:async()=>({rebalanced:false}),
  };
  const source = fs.readFileSync(path.join(ROOT,'scripts/staff-query-api.js'),'utf8');
  vm.createContext(api);
  for (const name of ['parseCalendarDate','movePreviewNights','resolveCatalogLessonSlot','lockAndAssertLessonSlotCapacity',
    'ensureBookingServiceSlotColumns','handleBookingAddService','handleBookingRemoveService','bookingContextServiceRecordsSql','loadBookingServiceRecords']) {
    vm.runInContext(extract(source,name),api,{filename:'staff-query-api.js#'+name});
  }
  const user = {staff_user_id:'offline-staff',role:'operator'};
  async function invoke(name,body) {const res={};await api[name]({body},res,user);return res;}
  async function records(client='wolfhouse-somo',code=CODE) {return (await api.loadBookingServiceRecords(pg,client,code)).rows;}
  async function booking() {return (await pg.query(api.EDIT_PREVIEW_BOOKING_BY_ID_SQL,['wolfhouse-somo',BOOKING])).rows[0];}
  async function totals() {
    const rows=await records();
    const due=rows.reduce((n,r)=>n+r.amount_due_cents,0);
    const additional=rows.filter(r=>r.metadata.invoice_total_inclusion==='additional').reduce((n,r)=>n+r.amount_due_cents,0);
    return invoice.bookingLedgerInvoicePaidBalance(await booking(),due,0,0,additional);
  }
  return {db,pg,queries,services,api,records,booking,totals,
    add:(service,extra={})=>invoke('handleBookingAddService',{client_slug:'wolfhouse-somo',booking_id:BOOKING,
      service_type:'service:'+service.id,quantity:2,service_date:'2026-10-10',idempotency_key:'offline-'+service.id,...extra}),
    remove:(ids,extra={})=>invoke('handleBookingRemoveService',{client_slug:'wolfhouse-somo',booking_id:BOOKING,
      booking_service_record_ids:ids,idempotency_key:'offline-remove',...extra}),
    close:()=>db.close()};
}
module.exports={createFixture,BOOKING,OTHER,CODE,CLIENT,extract};
