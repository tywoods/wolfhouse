'use strict';

const crypto = require('node:crypto');
const CHECK_QUOTE_BOOK_FIELDS = Object.freeze(['action','purpose','check_in','check_out','guests','room','package','add_ons','payment','offer_reference']);
const date = { type: 'string', format: 'date' };
const nonempty = { type: 'string', minLength: 1 };
const checkQuoteBookSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://lunafrontdesk.com/contracts/luna-v3/check-quote-book.json',
  title: 'Luna v3 public one-try booking transaction', type: 'object', additionalProperties: false, required: ['action'],
  properties: {
    action: { type: 'string', enum: ['prepare','confirm','decline'] }, purpose: { type: 'string', enum: ['catalog','quote','offer'] },
    check_in: date, check_out: date,
    guests: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, properties: { name: nonempty, explicit_gender: nonempty, gender: nonempty } } },
    room: { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { type: 'string', enum: ['exact','private','shared','women_only','auto'] }, name: nonempty, beds: { type:'array', items:nonempty, uniqueItems:true }, together: { type:'string', enum:['required','preferred','not_required'] } } },
    package: { type:'object', additionalProperties:false, properties:{ name:nonempty, per_guest:{ type:'array', minItems:1, items:{ type:'object', additionalProperties:false, required:['guest','name'], properties:{ guest:{type:'integer',minimum:1}, name:nonempty } } } }, anyOf:[{required:['name']},{required:['per_guest']}] },
    add_ons: { type:'array', items:{ type:'object', additionalProperties:false, properties:{ name:nonempty, code:nonempty, quantity:{type:'integer',minimum:1}, days:{type:'integer',minimum:1}, people:{type:'array',items:nonempty,uniqueItems:true}, dates:{type:'array',items:date,minItems:1,uniqueItems:true}, requested_dates:{type:'array',items:date,minItems:1,uniqueItems:true} }, anyOf:[{required:['code']},{required:['name']}] } },
    payment:{type:'object',additionalProperties:false,required:['arrangement'],properties:{arrangement:{type:'string',enum:['together','separately']},choice:{type:'string',enum:['deposit','balance']}}},
    offer_reference:{type:'string',pattern:'^offer_[A-Za-z0-9_-]{24,80}$'},
  },
  allOf:[
    {if:{properties:{action:{const:'prepare'},purpose:{const:'quote'}},required:['action','purpose']},then:{required:['check_in','check_out','guests','room','package','add_ons'],not:{required:['payment']}}},
    {if:{properties:{action:{const:'prepare'},purpose:{const:'offer'}},required:['action','purpose']},then:{required:['check_in','check_out','guests','room','package','add_ons','payment'],properties:{guests:{items:{required:['name']}}}}},
    {if:{properties:{action:{const:'prepare'},purpose:{const:'catalog'}},required:['action','purpose']},then:{required:['check_in','check_out']}},
    {if:{properties:{action:{enum:['confirm','decline']}},required:['action']},then:{required:['offer_reference'],not:{anyOf:['purpose','check_in','check_out','guests','room','package','add_ons','payment'].map((field)=>({required:[field]}))}}},
  ],
};
function refusalEnvelope(failure={}, context={}) {
  const code=String(failure.code||'internal_failure'); const classification=failure.classification||'validation';
  return {ok:false,code,classification,message:'I could not safely complete that booking action.',field_errors:Array.isArray(failure.field_errors)?failure.field_errors:[{path:failure.path||'$',code,message:failure.fieldMessage||(classification==='validation'?'The request was not accepted.':'Staff could not return a usable result.')}],next_step:failure.next_step||(classification==='validation'?'correct_request':'wait_for_verified_result'),retry_allowed:false,correlation_id:context.correlationId||context.turnId||null};
}
const choice=(items,kind,wanted)=>items.find((x)=>x.item_type===kind&&[x.item_code,x.label].some((v)=>String(v||'').trim().toLowerCase()===String(wanted||'').trim().toLowerCase()));
function normalizeQuoteRequest(input,catalog,beds,context={}) {
  const items=Array.isArray(catalog&&catalog.items)?catalog.items:[]; const fail=(code,path)=>refusalEnvelope({code,path,next_step:'ask_guest'},context);
  const resolvePackage=(name)=>{const p=choice(items,'package',name); if(p)return p.item_code; const s=choice(items,'deposit',name); return s&&s.item_code==='custom_or_short_stay'?'package_none':null;};
  let packages={};
  if(input.package&&Array.isArray(input.package.per_guest)) {
    const seen=new Set(); const rows=[];
    for(const row of input.package.per_guest){if(row.guest<1||row.guest>input.guests.length||seen.has(row.guest))return fail('guest_package_invalid','package.per_guest'); seen.add(row.guest); const code=resolvePackage(row.name); if(!code)return fail('package_choice_required',`package.per_guest[${rows.length}].name`); rows.push({guest_number:row.guest,package_code:code});}
    if(rows.length!==input.guests.length)return fail('guest_package_incomplete','package.per_guest'); packages.guest_packages=rows.sort((a,b)=>a.guest_number-b.guest_number);
  } else { const code=resolvePackage(input.package&&input.package.name); if(!code)return fail('package_choice_required','package.name'); packages.package_id=code; }
  const extras=[];
  for(const [i,a] of (input.add_ons||[]).entries()){const item=choice(items,'service',a.code||a.name)||choice(items,'rental',a.code||a.name); if(!item)return fail('staff_service_unavailable',`add_ons[${i}]`); const dates=a.dates||a.requested_dates; const quantity=Number.isSafeInteger(a.quantity)?a.quantity:Array.isArray(a.people)?a.people.length:1; if(item.item_type==='rental'&&(!dates||!dates.length))return fail('rental_dates_required',`add_ons[${i}].dates`); if(dates&&(new Set(dates).size!==dates.length||dates.some((d)=>!/^\d{4}-\d{2}-\d{2}$/.test(d)||d<input.check_in||d>=input.check_out)))return fail(`${item.item_type}_dates_invalid`,`add_ons[${i}].dates`); if(a.days!==undefined&&(!dates||a.days!==dates.length))return fail(`${item.item_type}_dates_duration_mismatch`,`add_ons[${i}].days`); extras.push({code:item.item_code,quantity,...(dates?{dates:[...dates],days:dates.length}:{}),...(a.people?{people:[...a.people]}:{})});}
  const hash=crypto.createHash('sha256').update(JSON.stringify({session:context.sessionId,turn:context.turnId,input})).digest('base64url').slice(0,40);
  return {ok:true,value:{operation_key:`one-try:prepare-quote:${hash}`,check_in:input.check_in,check_out:input.check_out,guests:input.guests.map((g,i)=>({name:g.name||`Quote guest ${i+1}`,explicit_gender:g.explicit_gender||g.gender||null})),selection:{selected_bed_codes:[...beds],bed_ids:[...beds],room_type:input.room.kind==='private'?'double':input.room.kind==='women_only'?'female':input.room.kind==='shared'?'dorm':undefined,room_preference:input.room.name,keep_together:input.room.together==='required'?true:input.room.together==='not_required'?false:undefined},...packages,add_ons:extras}};
}
module.exports={CHECK_QUOTE_BOOK_FIELDS,checkQuoteBookSchema,normalizeQuoteRequest,refusalEnvelope};
