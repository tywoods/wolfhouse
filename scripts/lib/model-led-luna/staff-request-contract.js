'use strict';

const crypto = require('node:crypto');
const SHARED_CHECK_QUOTE_BOOK_SCHEMA = require('../../../docker/hermes-luna-v3/contracts/check_quote_book.schema.json');
const CHECK_QUOTE_BOOK_FIELDS = Object.freeze(['action','purpose','check_in','check_out','guests','room','package','add_ons','payment','offer_reference']);
const ACCOMMODATION_ONLY = Object.freeze({
  item_type: 'package', item_code: 'package_none', label: 'Accommodation only',
  description: 'Accommodation without a surf package.',
  requirements: Object.freeze({ package_minimum_nights: false, exact_bed_required: true, guest_count_required: true }),
  metadata: Object.freeze({ includes: [] }),
});
function normalizeCapabilityChoice(item, rules = []) {
  const pricing = rules.filter((rule) => rule.item_type === item.item_type
    && String(rule.item_code || '').split('__')[0] === item.item_code);
  const units = [...new Set(pricing.map((rule) => rule.unit).filter(Boolean))].sort();
  return {
    kind: item.item_type === 'package' ? (item.item_code === 'package_none' ? 'accommodation' : 'package') : item.item_type,
    item_type: item.item_type, code: item.item_code, label: item.label, description: item.description || null,
    applicability: item.item_type === 'package' ? 'per_guest' : 'party_or_participants',
    requirements: { dates: item.item_type === 'rental', quantity: item.item_type !== 'package',
      participants: item.item_type !== 'package', units,
      exact_bed_required: item.item_type === 'package', guest_count_required: item.item_type === 'package',
      package_minimum_nights: item.item_type === 'package' && item.item_code !== 'package_none',
      date_dependent_eligibility: 'unknown_until_prepare' },
    configuration: { active: item.active !== false,
      pricing_ready: item.item_code === 'package_none' || pricing.length > 0 },
    includes: Array.isArray(item.metadata && item.metadata.includes) ? item.metadata.includes : [],
  };
}
const date = { type: 'string', format: 'date' };
const nonempty = { type: 'string', minLength: 1 };
const checkQuoteBookSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://lunafrontdesk.com/contracts/luna-v3/check-quote-book.json',
  title: 'Luna v3 public one-try booking transaction', type: 'object', additionalProperties: false, required: ['action'],
  'x-staff-public-catalog': { accommodation_only: ACCOMMODATION_ONLY },
  properties: {
    action: { type: 'string', enum: ['prepare','confirm','decline'] }, purpose: { type: 'string', enum: ['quote','offer'] },
    check_in: date, check_out: date,
    guests: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, properties: { name: nonempty, explicit_gender: nonempty, gender: nonempty } } },
    room: { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { type: 'string', enum: ['exact','private','shared','women_only','auto'] }, name: nonempty, beds: { type:'array', items:nonempty, uniqueItems:true }, together: { type:'string', enum:['required','preferred','not_required'] } } },
    package: { type:'object', additionalProperties:false, properties:{ code:nonempty, name:nonempty, per_guest:{ type:'array', minItems:1, items:{ type:'object', additionalProperties:false, required:['guest'], properties:{ guest:{type:'integer',minimum:1}, code:nonempty, name:nonempty }, anyOf:[{required:['code']},{required:['name']}] } } }, anyOf:[{required:['code']},{required:['name']},{required:['per_guest']}] },
    add_ons: { type:'array', items:{ type:'object', additionalProperties:false, properties:{ name:nonempty, code:nonempty, quantity:{type:'integer',minimum:1,description:'Number of people or equipment units; never participant-days.'}, days:{type:'integer',minimum:1,description:'Number of distinct requested dates.'}, people:{type:'array',items:nonempty,minItems:1,uniqueItems:true}, dates:{type:'array',items:date,minItems:1,uniqueItems:true,description:'Exact selected dates. A service with multiple dates is refused until Staff has an explicit count interpretation.'}, requested_dates:{type:'array',items:date,minItems:1,uniqueItems:true} }, anyOf:[{required:['code']},{required:['name']}] } },
    payment:{type:'object',additionalProperties:false,required:['arrangement'],properties:{arrangement:{type:'string',enum:['together','separately']},choice:{type:'string',enum:['deposit','balance']}}},
    offer_reference:{type:'string',pattern:'^offer_[A-Za-z0-9_-]{24,80}$'},
  },
  allOf:[
    {if:{properties:{action:{const:'prepare'},purpose:{const:'quote'}},required:['action','purpose']},then:{required:['check_in','check_out','guests','room','package','add_ons'],not:{required:['payment']}}},
    {if:{properties:{action:{const:'prepare'},purpose:{const:'offer'}},required:['action','purpose']},then:{required:['check_in','check_out','guests','room','package','add_ons','payment'],properties:{guests:{items:{required:['name']}}}}},

    {if:{properties:{action:{enum:['confirm','decline']}},required:['action']},then:{required:['offer_reference'],not:{anyOf:['purpose','check_in','check_out','guests','room','package','add_ons','payment'].map((field)=>({required:[field]}))}}},
  ],
};
function refusalEnvelope(failure={}, context={}) {
  const code=String(failure.code||'internal_failure'); const classification=failure.classification||'validation';
  const details={guests_required:['Guest details are required before Staff can prepare this quote.','ask_guest'],room_required:['The guest must choose a room requirement before Staff can prepare this quote.','ask_guest'],package_choice_required:['Staff did not recognize that accommodation or package selection.','choose_catalog_option'],unknown_catalog_choice:['Staff did not recognize the selected option.','choose_catalog_option'],catalog_choice_conflict:['The supplied code and name identify different Staff catalog choices.','use_current_staff_catalog'],stale_capability_choice:['The selected Staff catalog choice changed after it was shown.','wait_for_new_guest_message'],exact_bed_selection_required:['No eligible beds are available for the requested stay.','choose_available_beds'],requested_room_unavailable:['No eligible beds are available for the requested room choice.','choose_available_beds'],selected_beds_unavailable:['The requested beds are no longer available.','choose_available_beds'],staff_service_unavailable:['Staff does not currently offer the selected service or rental.','choose_catalog_option'],staff_package_ineligible:['That package is not eligible for the requested stay.','choose_eligible_catalog_option'],package_min_nights_violation:['The selected package does not meet Staff’s minimum-stay requirement.','change_dates_or_package'],staff_pricing_unavailable:['Staff has no verified price for the requested choice.','wait_for_staff_price_configuration'],STAFF_PRICING_UNAVAILABLE:['Staff has no verified price for the requested choice.','wait_for_staff_price_configuration'],staff_stay_price_missing:['Staff has no verified accommodation price for the requested stay.','ask_staff_to_configure_stay_price'],staff_package_price_missing:['Staff has no verified price for the selected package.','ask_staff_to_configure_package_price'],staff_add_on_price_missing:['Staff has no verified price for the selected rental or add-on.','ask_staff_to_configure_add_on_price'],staff_lesson_price_missing:['Staff has no verified price for the selected lesson.','ask_staff_to_configure_lesson_price'],staff_deposit_price_missing:['Staff has no verified deposit configuration for this stay.','ask_staff_to_configure_deposit'],staff_pricing_season_missing:["Staff has no verified accommodation price for one or more requested nights.",'wait_for_staff_price_configuration'],staff_pricing_season_closed:['Accommodation is unavailable for one or more requested nights.','change_dates'],transport_unavailable:['Staff has no verified transport option for this request.','ask_staff_about_transport'],prepare_outcome_unknown:['Staff could not verify the outcome of this prepare attempt.','wait_for_verified_result']};
  const detail=details[code];
  return {ok:false,code,classification,message:failure.message||(detail&&detail[0])||'I could not safely complete that booking action.',field_errors:Array.isArray(failure.field_errors)?failure.field_errors:[{path:failure.path||'$',code,message:failure.fieldMessage||(detail&&detail[0])||(classification==='validation'?'The request was not accepted.':'Staff could not return a usable result.')}],next_step:failure.next_step||(detail&&detail[1])||(classification==='validation'?'correct_request':'wait_for_verified_result'),retry_allowed:false,correlation_id:failure.correlation_id||context.correlationId||context.turnId||null};
}
const choice = (items, kind, wanted) => items.find((item) => item.item_type === kind
  && [item.item_code, item.label].some((value) => String(value || '').trim().toLowerCase() === String(wanted || '').trim().toLowerCase()));
function semanticError(code, path, message) {
  const error = new Error(message || code);
  error.code = code;
  error.path = path;
  return error;
}
function schemaError(schema, value, path = '$') {
  const fail = (message) => ({ path, message });
  if (!schema || typeof schema !== 'object') return null;
  if (schema.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) return fail('must be an object');
  if (schema.type === 'array' && !Array.isArray(value)) return fail('must be an array');
  if (schema.type === 'string' && typeof value !== 'string') return fail('must be a string');
  if (schema.type === 'integer' && !Number.isSafeInteger(value)) return fail('must be an integer');
  if (schema.enum && !schema.enum.includes(value)) return fail('has a value outside the allowed enum');
  if (schema.const !== undefined && value !== schema.const) return fail('does not equal the required value');
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return fail('is too short');
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) return fail('does not match the required pattern');
    if (schema.format === 'date' && !validDate(value)) return fail('must be a real date');
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) return fail('is below the minimum');
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return fail('has too few items');
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return fail('must have unique items');
    for (let index = 0; index < value.length; index += 1) {
      const error = schemaError(schema.items, value[index], `${path}[${index}]`);
      if (error) return error;
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!(key in value)) return { path: `${path}.${key}`, message: 'is required' };
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) {
      if (!schema.properties || !(key in schema.properties)) return { path: `${path}.${key}`, message: 'is not allowed' };
    }
    for (const [key, child] of Object.entries(schema.properties || {})) if (key in value) {
      const error = schemaError(child, value[key], `${path}.${key}`);
      if (error) return error;
    }
  }
  if (schema.anyOf && !schema.anyOf.some((candidate) => !schemaError(candidate, value, path))) return fail('does not match an allowed shape');
  if (schema.not && !schemaError(schema.not, value, path)) return fail('matches a forbidden shape');
  for (const clause of schema.allOf || []) {
    if ((!clause.if || !schemaError(clause.if, value, path)) && clause.then) {
      const error = schemaError(clause.then, value, path);
      if (error) return error;
    }
  }
  return null;
}
function validateSharedRequest(input) {
  if (input && typeof input === 'object' && !Array.isArray(input) && input.action === 'prepare'
      && (!validDate(input.check_in) || !validDate(input.check_out) || input.check_out <= input.check_in)) {
    throw semanticError('stay_dates_invalid', !validDate(input.check_in) ? 'check_in' : 'check_out', 'check_in and check_out must be real ascending dates');
  }
  const invalid = schemaError(SHARED_CHECK_QUOTE_BOOK_SCHEMA, input);
  const throwSchemaError = () => {
    if (!invalid) return;
    const detail = invalid.path === '$.payment' ? 'payment arrangement is required by the check_quote_book schema'
      : invalid.path === '$.offer_reference' ? 'valid public offer_reference is required by the check_quote_book schema'
        : `check_quote_book schema ${invalid.message}`;
    throw semanticError('invalid_tool_request', invalid.path.replace(/^\$\.?/, ''), detail);
  };
  // Preserve the more actionable existing semantic diagnostics, while still
  // executing and enforcing the complete shared schema for every request.
  if (!input || typeof input !== 'object' || Array.isArray(input)) throwSchemaError();
  if (input.action !== 'prepare') { throwSchemaError(); return; }
  if (!validDate(input.check_in) || !validDate(input.check_out) || input.check_out <= input.check_in) {
    throw semanticError('stay_dates_invalid', !validDate(input.check_in) ? 'check_in' : 'check_out', 'check_in and check_out must be real ascending dates');
  }
  if (!['quote', 'offer'].includes(input.purpose)) { throwSchemaError(); return; }
  if (!Array.isArray(input.guests) || input.guests.length === 0) throw semanticError('guests_required', 'guests');
  if (!input.room || typeof input.room !== 'object' || Array.isArray(input.room)) throw semanticError('room_required', 'room');
  if (!input.package || typeof input.package !== 'object' || Array.isArray(input.package)) throw semanticError('package_choice_required', 'package');
  if (!Array.isArray(input.add_ons)) throw semanticError('add_ons_required', 'add_ons');
  for (const [index, addOn] of input.add_ons.entries()) {
    const path = `add_ons[${index}]`;
    if (!addOn || typeof addOn !== 'object' || Array.isArray(addOn)) throw semanticError('invalid_tool_request', path);
    if (addOn.people !== undefined) {
      if (!Array.isArray(addOn.people) || addOn.people.length === 0) throw semanticError('add_on_people_required', `${path}.people`);
      if (new Set(addOn.people).size !== addOn.people.length) throw semanticError('invalid_tool_request', `${path}.people`, `${path}.people must contain unique people`);
    }
    if (addOn.quantity !== undefined && (!Number.isSafeInteger(addOn.quantity) || addOn.quantity < 1)) throw semanticError('invalid_quantity', `${path}.quantity`);
    if (Array.isArray(addOn.people) && addOn.quantity !== undefined && addOn.quantity !== addOn.people.length) throw semanticError('conflicting_quantity_people', `${path}.quantity`);
    if (addOn.dates !== undefined && addOn.requested_dates !== undefined
        && JSON.stringify(addOn.dates) !== JSON.stringify(addOn.requested_dates)) throw semanticError('conflicting_date_aliases', `${path}.dates`);
  }
  throwSchemaError();
}
function resolveCatalogChoice(items, kinds, reference) {
  const candidates = items.filter((item) => kinds.includes(item.item_type));
  const find = (wanted) => candidates.find((item) => [item.item_code, item.label]
    .some((value) => String(value || '').trim().toLowerCase() === String(wanted || '').trim().toLowerCase()));
  const byCode = reference && reference.code !== undefined ? find(reference.code) : null;
  const byName = reference && reference.name !== undefined ? find(reference.name) : null;
  if (reference && reference.code !== undefined && reference.name !== undefined && (byCode || byName)
      && (!byCode || !byName || byCode.item_type !== byName.item_type || byCode.item_code !== byName.item_code)) return { conflict: true };
  return { item: byCode || byName };
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizeQuoteRequest(input, catalog, beds, context = {}) {
  const fail = (code, path) => {
    const classification = ['catalog_choice_conflict','package_choice_required','staff_service_unavailable'].includes(code)
      ? 'configuration' : ['exact_bed_selection_required','requested_room_unavailable','selected_beds_unavailable'].includes(code)
        ? 'availability' : 'validation';
    return refusalEnvelope({ code, path, classification }, context);
  };
  if (!input || typeof input !== 'object') return fail('invalid_quote_request', '$');
  try { validateSharedRequest(input); }
  catch (error) { return fail(error.code || 'invalid_tool_request', error.path || '$'); }
  if (!validDate(input.check_in) || !validDate(input.check_out) || input.check_out <= input.check_in) {
    return fail('stay_dates_invalid', !validDate(input.check_in) ? 'check_in' : 'check_out');
  }
  if (!Array.isArray(input.guests) || input.guests.length === 0) return fail('guests_required', 'guests');
  if (!input.room || typeof input.room !== 'object') return fail('room_required', 'room');
  if (!Array.isArray(beds) || beds.length !== input.guests.length || beds.some((bed) => !String(bed || '').trim())) {
    return fail('exact_bed_selection_required', 'room.beds');
  }
  // Accommodation-only is a protocol choice owned by this contract, not a
  // tenant pricing-catalog row. Inject it at the normalization boundary so
  // every caller (including the live booking flow) resolves package_none the
  // same way even when its date-scoped catalog only contains priced items.
  const catalogItems = Array.isArray(catalog && catalog.items) ? catalog.items : [];
  const items = [ACCOMMODATION_ONLY,
    ...catalogItems.filter((item) => !(item.item_type === 'package' && item.item_code === ACCOMMODATION_ONLY.item_code))];
  const resolvePackage = (reference) => {
    const resolved = resolveCatalogChoice(items, ['package'], reference);
    if (resolved.conflict) return { conflict: true };
    const selected = resolved.item;
    if (!selected) return { code: null };
    return { code: selected.item_type === 'package' ? selected.item_code : null };
  };
  const packages = {};
  if (input.package && Array.isArray(input.package.per_guest)) {
    if (input.package.per_guest.length === 0) return fail('guest_package_incomplete', 'package.per_guest');
    const seen = new Set(); const rows = [];
    for (const row of input.package.per_guest) {
      if (!row || row.guest < 1 || row.guest > input.guests.length || seen.has(row.guest)) return fail('guest_package_invalid', 'package.per_guest');
      seen.add(row.guest); const resolved = resolvePackage(row);
      if (resolved.conflict) return fail('catalog_choice_conflict', `package.per_guest[${rows.length}]`);
      if (!resolved.code) return fail('package_choice_required', `package.per_guest[${rows.length}]`);
      rows.push({ guest_number: row.guest, package_code: resolved.code });
    }
    if (rows.length !== input.guests.length) return fail('guest_package_incomplete', 'package.per_guest');
    packages.guest_packages = rows.sort((a, b) => a.guest_number - b.guest_number);
  } else {
    const resolved = resolvePackage(input.package);
    if (resolved.conflict) return fail('catalog_choice_conflict', 'package');
    if (!resolved.code) return fail('package_choice_required', 'package');
    packages.package_id = resolved.code;
  }
  if (!Array.isArray(input.add_ons)) return fail('add_ons_required', 'add_ons');
  const extras = [];
  for (const [index, addOn] of input.add_ons.entries()) {
    const path = `add_ons[${index}]`;
    const resolved = resolveCatalogChoice(items, ['service', 'rental'], addOn);
    if (resolved.conflict) return fail('catalog_choice_conflict', path);
    const item = resolved.item;
    if (!item) return fail('staff_service_unavailable', path);
    if (addOn.dates !== undefined && addOn.requested_dates !== undefined
        && JSON.stringify(addOn.dates) !== JSON.stringify(addOn.requested_dates)) return fail('conflicting_date_aliases', `${path}.dates`);
    const dates = addOn.dates !== undefined ? addOn.dates : addOn.requested_dates;
    if (addOn.people !== undefined && (!Array.isArray(addOn.people) || addOn.people.length === 0)) return fail('add_on_people_required', `${path}.people`);
    const quantity = addOn.quantity !== undefined ? addOn.quantity : Array.isArray(addOn.people) ? addOn.people.length : 1;
    if (!Number.isSafeInteger(quantity) || quantity < 1) return fail('invalid_quantity', `${path}.quantity`);
    if (Array.isArray(addOn.people) && addOn.quantity !== undefined && addOn.quantity !== addOn.people.length) return fail('conflicting_quantity_people', `${path}.quantity`);
    if (item.item_type === 'rental' && (!Array.isArray(dates) || dates.length === 0)) return fail('rental_dates_required', `${path}.dates`);
    if (dates !== undefined && (!Array.isArray(dates) || dates.length === 0 || new Set(dates).size !== dates.length
        || dates.some((date) => !validDate(date) || date < input.check_in || date >= input.check_out))) return fail(`${item.item_type}_dates_invalid`, `${path}.dates`);
    if (item.item_type === 'service' && Array.isArray(dates) && dates.length > 1) return fail('lesson_multi_date_count_required', `${path}.dates`);
    if (addOn.days !== undefined && (!Array.isArray(dates) || addOn.days !== dates.length)) return fail(`${item.item_type}_dates_duration_mismatch`, `${path}.days`);
    extras.push({ code: item.item_code, quantity, ...(dates ? { dates: [...dates], days: dates.length } : {}),
      ...(addOn.people ? { people: [...addOn.people] } : {}) });
  }
  const hash = crypto.createHash('sha256').update(JSON.stringify({ session: context.sessionId, turn: context.turnId, input })).digest('base64url').slice(0, 40);
  return { ok: true, value: { operation_key: `one-try:prepare-quote:${hash}`, check_in: input.check_in, check_out: input.check_out,
    guests: input.guests.map((guest, index) => ({ name: guest.name || `Quote guest ${index + 1}`, explicit_gender: guest.explicit_gender || guest.gender || null })),
    selection: { selected_bed_codes: [...beds], bed_ids: [...beds], room_type: input.room.kind === 'private' ? 'double' : input.room.kind === 'women_only' ? 'female' : input.room.kind === 'shared' ? 'dorm' : undefined,
      room_preference: input.room.name, keep_together: input.room.together === 'required' ? true : input.room.together === 'not_required' ? false : undefined },
    ...packages, add_ons: extras } };
}
module.exports={CHECK_QUOTE_BOOK_FIELDS,ACCOMMODATION_ONLY,normalizeCapabilityChoice,checkQuoteBookSchema,normalizeQuoteRequest,refusalEnvelope,validateSharedRequest,resolveCatalogChoice};
