'use strict';

/**
 * Offline RED→GREEN + mutation proof for private multi-session quote claim.
 *
 * Base defect: private INSERT uses service_type surf_lesson + nested
 * metadata.component=private_lesson, but INSERT RETURNING rows pushed into
 * createdRows omit nested metadata → applyAuthoritativeQuoteAmounts fails
 * with unclaimed_service_row_surf_lesson.
 *
 * Safe fix (private insert owner only): createdRows.push({ ...row, metadata })
 * Do NOT widen rowMatchesQuoteLine with flattened aliases.
 *
 * Run: node scripts/verify-sunset-private-quote-claim.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WRITES_PATH = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-booking-writes.js');
const WRITES_REQ = path.join(__dirname, 'lib', 'sunset-schedule-booking-writes.js');
const I18N_REQ = path.join(__dirname, 'lib', 'staff-portal-i18n.js');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); pass += 1; }
  else { console.error('  FAIL  ' + label + (detail ? ' — ' + detail : '')); fail += 1; }
}
function loadWrites() {
  delete require.cache[require.resolve(WRITES_REQ)];
  return require(WRITES_REQ);
}

/** INSERT RETURNING shape — flattened fields only, no nested metadata. */
function barePrivateReturning(id, opts) {
  opts = opts || {};
  return {
    service_record_id: id,
    booking_id: 'bk-1',
    booking_code: 'SUNSET-PL',
    guest_name: 'Private Guest',
    service_type: 'surf_lesson',
    service_date: opts.service_date || '2026-08-21',
    quantity: opts.quantity != null ? opts.quantity : 1,
    payment_status: 'pending',
    record_source: 'staff_manual',
    service_time_local: opts.start || '10:00',
    service_time_local_end: opts.end || '12:00',
    slot_time: opts.start || '10:00',
    staff_ui_service_type: 'private_lesson',
    metadata_source: 'staff_manual_schedule',
    metadata_component: 'private_lesson',
    bundle_id: 'bundle-1',
    metadata_components: 'private_lesson',
  };
}

/** Production private-insert owner reattachment (matches writes.js). */
function reattachPrivate(row, metadata) { return { ...row, metadata }; }

function privateMetadata(extra) {
  return Object.assign({
    source: 'staff_manual_schedule',
    staff_manual_schedule: true,
    staff_ui_service_type: 'private_lesson',
    component: 'private_lesson',
    components: ['private_lesson'],
    bundle_id: 'bundle-1',
    slot_time: '10:00',
    private_lesson_label: 'Private lesson',
    private_lesson_session_index: 1,
    private_lesson_session_count: 1,
    unit_amount_cents: 8000,
  }, extra || {});
}

function makePg(knownIds) {
  const amounts = Object.create(null);
  const known = new Set(knownIds || []);
  return {
    amounts,
    query: async (sql, params) => {
      if (/UPDATE booking_service_records SET amount_due_cents/i.test(String(sql))) {
        const id = String(params[1]);
        if (String(params[2] || '') !== 'sunset') return { rowCount: 0, rows: [] };
        if (known.size && !known.has(id)) return { rowCount: 0, rows: [] };
        amounts[id] = params[0];
        return { rowCount: 1, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function privateQuote(total, sessions) {
  const n = sessions != null ? sessions : 1;
  return {
    total_cents: total,
    line_items: [{
      component: 'private_lesson',
      offering_id: 'private_lesson__session',
      total_cents: total,
      unit_amount_cents: Math.round(total / n),
      quantity: n,
    }],
  };
}

function extractPrivatePushBlock(src) {
  const start = src.indexOf('if (input.components.private_lesson)');
  if (start < 0) return null;
  const nextFor = src.indexOf('for (const serviceDate of input.service_dates)', start);
  if (nextFor < 0) return null;
  return src.slice(start, nextFor);
}

async function apply(writes, rows, quote, ids) {
  return writes.applyAuthoritativeQuoteAmounts(makePg(ids), rows, quote, { clientSlug: 'sunset' });
}

async function main() {
  console.log('\nverify:sunset-private-quote-claim — private multi-session quote claim\n');

  let src = fs.readFileSync(WRITES_PATH, 'utf8');
  const privateBlock = extractPrivatePushBlock(src);
  assert('private insert owner block present', !!privateBlock);
  assert('private owner reattaches nested metadata',
    !!(privateBlock && /createdRows\.push\(\{\s*\.\.\.row,\s*metadata\s*\}\)/.test(privateBlock)));
  assert('private owner does not bare-push RETURNING row',
    !!(privateBlock && !/createdRows\.push\(row\)\s*;/.test(privateBlock)));
  const matcherSlice = src.slice(src.indexOf('function rowMatchesQuoteLine'), src.indexOf('function rowMatchesQuoteLine') + 900);
  assert('matcher does not OR flattened metadata aliases',
    !/row\.metadata_component === 'private_lesson'/.test(src)
    && !/meta\.component === 'private_lesson' \|\|[\s\S]{0,80}metadata_component/.test(src)
    && !/staff_ui_service_type === 'private_lesson'[\s\S]{0,60}return/.test(matcherSlice));

  let writes = loadWrites();
  assert('uses real production applyAuthoritativeQuoteAmounts', typeof writes.applyAuthoritativeQuoteAmounts === 'function');
  assert('private DB type is surf_lesson', writes.UI_TO_DB_SERVICE_TYPE.private_lesson === 'surf_lesson');

  console.log('[1] Base RED — bare RETURNING private multi-session');
  {
    const bare1 = barePrivateReturning('sr-pl-1', { service_date: '2026-08-21' });
    const bare2 = barePrivateReturning('sr-pl-2', { service_date: '2026-08-23' });
    assert('bare rows omit nested metadata', bare1.metadata == null && bare2.metadata == null);
    assert('bare rows expose flattened private identity',
      bare1.metadata_component === 'private_lesson'
      && bare1.staff_ui_service_type === 'private_lesson'
      && bare1.service_type === 'surf_lesson');
    const pg = makePg(['sr-pl-1', 'sr-pl-2']);
    const red = await writes.applyAuthoritativeQuoteAmounts(pg, [bare1, bare2], privateQuote(16000, 2), { clientSlug: 'sunset' });
    assert('exact base RED unclaimed_service_row_surf_lesson',
      red.ok === false && red.error === 'unclaimed_service_row_surf_lesson', JSON.stringify(red));
    assert('RED zero amounts persisted', Object.keys(pg.amounts).length === 0);
  }

  console.log('[2] GREEN — reattach-only + amounts');
  {
    const row1 = reattachPrivate(barePrivateReturning('sr-pl-1', { service_date: '2026-08-21' }),
      privateMetadata({ private_lesson_session_index: 1, private_lesson_session_count: 2 }));
    const row2 = reattachPrivate(barePrivateReturning('sr-pl-2', { service_date: '2026-08-23' }),
      privateMetadata({ private_lesson_session_index: 2, private_lesson_session_count: 2 }));
    const pg = makePg(['sr-pl-1', 'sr-pl-2']);
    const green = await writes.applyAuthoritativeQuoteAmounts(pg, [row1, row2], privateQuote(16000, 2), { clientSlug: 'sunset' });
    assert('reattach GREEN ok', green.ok === true && green.total_cents === 16000, JSON.stringify(green));
    assert('exact authoritative amount assignment (primary + zero peer)',
      pg.amounts['sr-pl-1'] === 16000 && pg.amounts['sr-pl-2'] === 0, JSON.stringify(pg.amounts));
  }

  {
    const row = reattachPrivate(barePrivateReturning('sr-one'), privateMetadata());
    const pg = makePg(['sr-one']);
    const g = await writes.applyAuthoritativeQuoteAmounts(pg, [row], privateQuote(8000, 1), { clientSlug: 'sunset' });
    assert('single private session GREEN', g.ok && g.total_cents === 8000 && pg.amounts['sr-one'] === 8000, JSON.stringify(g));
  }

  {
    const m = privateMetadata({ private_lesson_session_count: 2 });
    const a = reattachPrivate(barePrivateReturning('sr-a', { service_date: '2026-08-21', start: '10:00', end: '12:00' }),
      { ...m, private_lesson_session_index: 1 });
    const b = reattachPrivate(barePrivateReturning('sr-b', { service_date: '2026-08-21', start: '10:00', end: '12:00' }),
      { ...m, private_lesson_session_index: 2 });
    const pg = makePg(['sr-a', 'sr-b']);
    const g = await writes.applyAuthoritativeQuoteAmounts(pg, [a, b], privateQuote(16000, 2), { clientSlug: 'sunset' });
    assert('identical sessions claim same line without double-claim',
      g.ok && g.total_cents === 16000 && g.error !== 'duplicate_row_claim', JSON.stringify(g));
    assert('identical sessions accounting primary+zero',
      (pg.amounts['sr-a'] === 16000 && pg.amounts['sr-b'] === 0)
      || (pg.amounts['sr-b'] === 16000 && pg.amounts['sr-a'] === 0), JSON.stringify(pg.amounts));
  }

  {
    const late = reattachPrivate(barePrivateReturning('sr-z', { service_date: '2026-08-25' }),
      privateMetadata({ private_lesson_session_index: 2, private_lesson_session_count: 2 }));
    const early = reattachPrivate(barePrivateReturning('sr-y', { service_date: '2026-08-20' }),
      privateMetadata({ private_lesson_session_index: 1, private_lesson_session_count: 2 }));
    const pg = makePg(['sr-y', 'sr-z']);
    const g = await writes.applyAuthoritativeQuoteAmounts(pg, [late, early], privateQuote(12000, 2), { clientSlug: 'sunset' });
    assert('reordered rows GREEN', g.ok && g.total_cents === 12000, JSON.stringify(g));
    assert('reordered primary is earliest date', pg.amounts['sr-y'] === 12000 && pg.amounts['sr-z'] === 0, JSON.stringify(pg.amounts));
  }

  console.log('[3] Private + gear multi-line accounting');
  {
    const pl = reattachPrivate(barePrivateReturning('sr-pl'), privateMetadata());
    const gear = {
      service_record_id: 'sr-board',
      service_type: 'surfboard',
      service_date: '2026-08-21',
      quantity: 1,
      staff_ui_service_type: 'surfboard',
      metadata_component: 'surfboard',
      metadata: { component: 'surfboard', offering_key: 'board_rental', staff_ui_service_type: 'surfboard' },
    };
    const quote = {
      total_cents: 10000,
      line_items: [
        { component: 'private_lesson', total_cents: 8000 },
        { component: 'board_rental', total_cents: 2000 },
      ],
    };
    const pg = makePg(['sr-pl', 'sr-board']);
    const g = await writes.applyAuthoritativeQuoteAmounts(pg, [gear, pl], quote, { clientSlug: 'sunset' });
    assert('private+gear GREEN', g.ok && g.total_cents === 10000, JSON.stringify(g));
    assert('private+gear exact line amounts',
      pg.amounts['sr-pl'] === 8000 && pg.amounts['sr-board'] === 2000, JSON.stringify(pg.amounts));

    const pg2 = makePg(['sr-pl-bare', 'sr-board']);
    const red = await writes.applyAuthoritativeQuoteAmounts(
      pg2, [barePrivateReturning('sr-pl-bare'), gear], quote, { clientSlug: 'sunset' },
    );
    assert('private+gear bare private RED unclaimed_service_row_surf_lesson',
      red.ok === false && red.error === 'unclaimed_service_row_surf_lesson', JSON.stringify(red));
  }

  console.log('[4] Conflict fail-closed (nested vs flattened)');
  {
    const nestedLesson = {
      ...barePrivateReturning('sr-c1'),
      metadata: { component: 'lesson', staff_ui_service_type: 'lesson' },
      metadata_component: 'private_lesson',
      staff_ui_service_type: 'private_lesson',
    };
    const r1 = await apply(writes, [nestedLesson], privateQuote(8000, 1), ['sr-c1']);
    assert('nested lesson vs flattened private fails closed on private line',
      r1.ok === false && /unclaimed_service_row_/.test(String(r1.error)), JSON.stringify(r1));

    const nestedPrivate = {
      service_record_id: 'sr-c2',
      service_type: 'surf_lesson',
      service_date: '2026-08-21',
      metadata: { component: 'private_lesson', staff_ui_service_type: 'private_lesson' },
      metadata_component: 'lesson',
      staff_ui_service_type: 'lesson',
    };
    const r2 = await apply(writes, [nestedPrivate], {
      total_cents: 5000,
      line_items: [{ component: 'lesson', total_cents: 5000 }],
    }, ['sr-c2']);
    assert('nested private vs flattened lesson fails closed on lesson line',
      r2.ok === false && /unclaimed_service_row_/.test(String(r2.error)), JSON.stringify(r2));

    const r3 = await apply(writes, [nestedLesson], {
      total_cents: 13000,
      line_items: [
        { component: 'lesson', total_cents: 5000 },
        { component: 'private_lesson', total_cents: 8000 },
      ],
    }, ['sr-c1']);
    assert('conflicting flattened does not cause duplicate_row_claim',
      r3.ok === false && r3.error !== 'duplicate_row_claim'
      && /no_operational_rows_for_private_lesson|unclaimed/.test(String(r3.error)), JSON.stringify(r3));
  }

  console.log('[5] Missing/extra/duplicate lines, bare non-private, malformed');
  {
    const row = reattachPrivate(barePrivateReturning('sr-m1'), privateMetadata());
    const missing = await apply(writes, [row], {
      total_cents: 2000,
      line_items: [{ component: 'board_rental', total_cents: 2000 }],
    }, ['sr-m1']);
    assert('missing private quote line → unclaimed',
      missing.ok === false && /unclaimed_service_row_/.test(String(missing.error)), JSON.stringify(missing));

    const extra = await apply(writes, [row], {
      total_cents: 10000,
      line_items: [
        { component: 'private_lesson', total_cents: 8000 },
        { component: 'board_rental', total_cents: 2000 },
      ],
    }, ['sr-m1']);
    assert('extra quote line without rows → no_operational_rows',
      extra.ok === false && /no_operational_rows_for_board_rental/.test(String(extra.error)), JSON.stringify(extra));

    const dup = await apply(writes, [row], {
      total_cents: 16000,
      line_items: [
        { component: 'private_lesson', total_cents: 8000 },
        { component: 'private_lesson', total_cents: 8000 },
      ],
    }, ['sr-m1']);
    assert('duplicate private quote lines → duplicate_row_claim',
      dup.ok === false && dup.error === 'duplicate_row_claim', JSON.stringify(dup));

    const bareLesson = {
      service_record_id: 'sr-gl',
      service_type: 'surf_lesson',
      service_date: '2026-08-21',
      staff_ui_service_type: 'lesson',
      metadata_component: 'lesson',
    };
    const bareNonPrivate = await apply(writes, [bareLesson], privateQuote(8000, 1), ['sr-gl']);
    assert('bare non-private surf_lesson unclaimed against private line',
      bareNonPrivate.ok === false && bareNonPrivate.error === 'unclaimed_service_row_surf_lesson',
      JSON.stringify(bareNonPrivate));

    for (const [label, meta] of [
      ['string garbage', '{not-json'],
      ['array metadata', [{ component: 'private_lesson' }]],
      ['null metadata', null],
      ['number metadata', 42],
    ]) {
      const bad = { ...barePrivateReturning('sr-bad'), metadata: meta };
      const r = await apply(writes, [bad], privateQuote(8000, 1), ['sr-bad']);
      assert('malformed metadata fails closed: ' + label,
        r.ok === false && /unclaimed_service_row_/.test(String(r.error)), JSON.stringify(r));
    }
  }

  console.log('[6] Create-status i18n keys EN/ES/IT');
  {
    delete require.cache[require.resolve(I18N_REQ)];
    const { STAFF_PORTAL_STRINGS } = require(I18N_REQ);
    for (const k of [
      'schedule.create.creating',
      'schedule.create.createBusy',
      'schedule.create.idempotencyConflict',
    ]) {
      const en = STAFF_PORTAL_STRINGS.en[k];
      const es = STAFF_PORTAL_STRINGS.es[k];
      const it = STAFF_PORTAL_STRINGS.it[k];
      assert('i18n ' + k,
        !!(en && es && it) && en !== k && es !== en && it !== en && !/^schedule\.create\./.test(en),
        JSON.stringify({ en, es, it }));
    }
  }

  console.log('[7] Mutation RED — strip private metadata reattachment');
  const originalBytes = fs.readFileSync(WRITES_PATH);
  try {
    const block = extractPrivatePushBlock(originalBytes.toString('utf8'));
    assert('mutation target private block', !!block);
    const mutatedBlock = block.replace(
      /createdRows\.push\(\{\s*\.\.\.row,\s*metadata\s*\}\)\s*;/,
      'createdRows.push(row);',
    );
    assert('mutation changed private push only',
      mutatedBlock !== block && /createdRows\.push\(row\)\s*;/.test(mutatedBlock));
    const originalText = originalBytes.toString('utf8');
    const mutatedSrc = originalText.slice(0, originalText.indexOf(block))
      + mutatedBlock
      + originalText.slice(originalText.indexOf(block) + block.length);
    assert('rental reattach preserved under private mutation',
      (mutatedSrc.match(/createdRows\.push\(\{\s*\.\.\.row,\s*metadata\s*\}\)/g) || []).length >= 1);
    fs.writeFileSync(WRITES_PATH, mutatedSrc);
    const mutBlock = extractPrivatePushBlock(fs.readFileSync(WRITES_PATH, 'utf8'));
    assert('mutated private owner bare-pushes',
      !!(mutBlock && /createdRows\.push\(row\)\s*;/.test(mutBlock)));

    writes = loadWrites();
    const bare1 = barePrivateReturning('sr-mut-1', { service_date: '2026-08-21' });
    const bare2 = barePrivateReturning('sr-mut-2', { service_date: '2026-08-23' });
    const mutRed = await apply(writes, [bare1, bare2], privateQuote(16000, 2), ['sr-mut-1', 'sr-mut-2']);
    assert('mutation RED exact unclaimed_service_row_surf_lesson',
      mutRed.ok === false && mutRed.error === 'unclaimed_service_row_surf_lesson', JSON.stringify(mutRed));

    const fixed = [
      reattachPrivate(bare1, privateMetadata({ private_lesson_session_index: 1, private_lesson_session_count: 2 })),
      reattachPrivate(bare2, privateMetadata({ private_lesson_session_index: 2, private_lesson_session_count: 2 })),
    ];
    const stillGreen = await apply(writes, fixed, privateQuote(16000, 2), ['sr-mut-1', 'sr-mut-2']);
    assert('matcher unchanged: reattached rows still GREEN under mutated source',
      stillGreen.ok && stillGreen.total_cents === 16000, JSON.stringify(stillGreen));
  } finally {
    fs.writeFileSync(WRITES_PATH, originalBytes);
    loadWrites();
  }

  const restored = fs.readFileSync(WRITES_PATH);
  assert('mutation restored exact bytes', Buffer.compare(restored, originalBytes) === 0);
  const restoredBlock = extractPrivatePushBlock(restored.toString('utf8'));
  assert('restored private owner still reattaches',
    !!(restoredBlock && /createdRows\.push\(\{\s*\.\.\.row,\s*metadata\s*\}\)/.test(restoredBlock)
      && !/createdRows\.push\(row\)\s*;/.test(restoredBlock)));

  console.log('\n' + '─'.repeat(48));
  console.log(`Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error('verify:sunset-private-quote-claim — FAILED');
    process.exit(1);
  }
  console.log('verify:sunset-private-quote-claim — ALL CHECKS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
