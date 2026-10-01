'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'staff-query-api.js'),'utf8');
function fn(name){const m=new RegExp('(?:async )?function '+name+'\\(').exec(source);assert(m,'Missing '+name);return source.slice(m.index,source.indexOf('\n}',m.index)+2);}
const guest={booking_guest_id:'guest-2',guest_name:'Second',check_in:'2026-10-05',check_out:'2026-10-11'};
const inputs={'bc-field-dates-check-in':{value:'2026-10-06'},'bc-field-dates-check-out':{value:'2026-10-10'},'bc-field-dates-guest':{value:'guest-2'}};
const sandbox={bcFieldEditState:{clientSlug:'wolfhouse-somo',bookingId:'booking',bookingCode:'WH-DATES',snapshot:{guest_names:[guest]}},
  el:id=>inputs[id],bcNewDatesEditIdempotencyKey:()=> 'offline-key',getBcClient:()=> 'wolfhouse-somo'};
vm.createContext(sandbox);
const helper=/function bcFieldEditSelectedDateGuest\(/.test(source)?fn('bcFieldEditSelectedDateGuest'):'';
vm.runInContext(helper+'\n'+fn('bcFieldEditBuildDatesWritePayload'),sandbox);
const payload=sandbox.bcFieldEditBuildDatesWritePayload();
assert.equal(payload.edit_type,'guest_dates','drawer dates are guest-scoped, never group dates');
assert.equal(payload.booking_guest_id,'guest-2');assert.equal(payload.expected_check_in,guest.check_in);assert.equal(payload.expected_check_out,guest.check_out);
inputs['bc-field-dates-guest'].value='';assert(sandbox.bcFieldEditBuildDatesWritePayload().error,'no selected identity fails closed');
console.log('PASS native date payload captures guest identity and expected stay; no group fallback');
const projection={movePreviewNights:(a,b)=>(Date.parse(b)-Date.parse(a))/86400000,
  normalizeGuestPackagesFromBooking:()=>[{guest_number:1,package_code:'malibu'},{guest_number:2,package_code:'waimea'}],
  editPreviewQuotePackageCode:x=>x,editPreviewTryQuote:()=>{throw Error('Persisted guest stays must not reprice on GET');},
  guestQuoteAccommodationCents:()=>0,staffPackageDisplayLabel:x=>x};
vm.createContext(projection);
vm.runInContext(fn('buildGuestAccommodationLines'),projection);
const booking={check_in:'2026-10-01',check_out:'2026-10-12'};
const guests=[{booking_guest_id:'one',guest_number:1,check_in:'2026-10-01',check_out:'2026-10-07'},
 {booking_guest_id:'two',guest_number:2,check_in:'2026-10-04',check_out:'2026-10-12'}];
const md={quote_snapshot:{per_guest_dates:true,per_person:[{guest_number:1,package_code:'malibu',accommodation_cents:45678},
 {guest_number:2,package_code:'waimea',accommodation_cents:87654}]}};
const lines=projection.buildGuestAccommodationLines('wolfhouse-somo',booking,md,guests);
assert.deepEqual(JSON.parse(JSON.stringify(lines.map(g=>[g.guest_number,g.nights,g.accommodation_cents]))),[[1,6,45678],[2,8,87654]]);
vm.runInContext(fn('projectBookingGuestStays'),projection);
const derived=projection.projectBookingGuestStays(booking,[{booking_guest_id:'one',assigned_bed_code:'B1',metadata:{}},
 {booking_guest_id:'two',assigned_bed_code:'B2',metadata:{check_in:'2026-10-04',check_out:'2026-10-12'}}],
 [{bed_code:'B1',assignment_type:'guest',check_in:'2026-10-01',check_out:'2026-10-07'},
 {bed_code:'B2',assignment_type:'guest',check_in:'2026-10-04',check_out:'2026-10-12'}]);
assert.equal(derived[0].check_out,'2026-10-07');assert.equal(derived[0].nights,6);assert.equal(derived[1].nights,8);
console.log('PASS persisted context amounts and assignment stays; legacy sibling never inherits expanded envelope');
const unassigned=projection.projectBookingGuestStays({...booking,metadata:{guest_stay_windows:{one:{check_in:'2026-10-01',check_out:'2026-10-07'}}}},
 [{booking_guest_id:'one',metadata:{}}],[]);
assert.equal(unassigned[0].check_out,'2026-10-07','unassigned sibling uses frozen legacy window rather than new envelope');
