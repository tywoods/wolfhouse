'use strict';
const fs = require('fs');

function patchFile(path, edits) {
  let s = fs.readFileSync(path, 'utf8');
  for (const [oldStr, newStr, label] of edits) {
    if (!s.includes(oldStr)) throw new Error(`${path}: missing block for ${label}`);
    s = s.replace(oldStr, newStr);
  }
  fs.writeFileSync(path, s, 'utf8');
  console.log('patched', path);
}

patchFile('G:/Luna/Sunset/scripts/lib/tenant-admin-writes.js', [
  [
    `async function upsertLessonSlotPriceRule(client, {
  clientSlug, locationId, slotId, label, amountCents, currency, actor,
}) {
  const itemCode = lessonSlotPriceItemCode(slotId);
  const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_price_rules');
  const loc = normalizeSunsetLocationId(locationId);
  const existing = await findPriceRuleRow(client, {
    clientSlug, locationId: loc, itemType: 'lesson', itemCode, hasLoc,
  });
  let cents = amountCents;
  if (cents == null && existing.rows[0]) cents = existing.rows[0].amount_cents;
  if (cents == null) return { ok: true };
  return upsertConfigPriceRule(client, {
    clientSlug,
    locationId,
    category: 'lesson',
    offeringKey: itemCode,
    unit: 'session',`,
    `async function upsertLessonSlotPriceRule(client, {
  clientSlug, locationId, slotId, label, amountCents, currency, actor,
}) {
  const slotKey = String(slotId || '').trim();
  const offeringKey = \`lesson_slot_\${slotKey}\`;
  const itemCode = lessonSlotPriceItemCode(slotKey);
  const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_price_rules');
  const loc = normalizeSunsetLocationId(locationId);
  const existing = await findPriceRuleRow(client, {
    clientSlug, locationId: loc, itemType: 'lesson', itemCode, hasLoc,
  });
  let cents = amountCents;
  if (cents == null && existing.rows[0]) cents = existing.rows[0].amount_cents;
  if (cents == null) return { ok: true };
  return upsertConfigPriceRule(client, {
    clientSlug,
    locationId,
    category: 'lesson',
    offeringKey,
    unit: 'session',`,
    'upsertLessonSlotPriceRule offeringKey',
  ],
  [
    `      for (const [key, value] of Object.entries(dbPatch)) {
        sets.push(\`\${key} = $\${idx}\`);
        params.push(value);
        idx += 1;
      }
      sets.push('updated_at = NOW()');
      sets.push(\`updated_by = $\${idx}::uuid\`);
      params.push(actor.staff_user_id || null);
      const updated = await client.query(
        \`UPDATE tenant_price_rules SET \${sets.join(', ')}
          WHERE id = $1::uuid AND client_slug = $2
          RETURNING *\`,`,
    `      for (const [key, value] of Object.entries(dbPatch)) {
        if (forceItemCode && (key === 'item_code' || key === 'unit')) continue;
        sets.push(\`\${key} = $\${idx}\`);
        params.push(value);
        idx += 1;
      }
      sets.push('updated_at = NOW()');
      sets.push(\`updated_by = $\${idx}::uuid\`);
      params.push(actor.staff_user_id || null);
      const updated = await client.query(
        \`UPDATE tenant_price_rules SET \${sets.join(', ')}
          WHERE id = $1::uuid AND client_slug = $2
          RETURNING *\`,`,
    'upsertConfigPriceRule skip item_code on forceItemCode',
  ],
  [
    `    await client.query('COMMIT');
    if (amountCentsPatch != null || priceLabelPatch != null) {
      await upsertLessonSlotPriceRule(client, {
        clientSlug,
        locationId: loc,
        slotId: after.id,
        label: priceLabelPatch || after.label,
        amountCents: amountCentsPatch != null ? amountCentsPatch : undefined,
        actor,
      });
    }
    return { ok: true, status: 200, body: { success: true, lesson_time_rule: after, storage: 'db' } };`,
    `    await client.query('COMMIT');
    if (amountCentsPatch != null || priceLabelPatch != null) {
      await upsertLessonSlotPriceRule(client, {
        clientSlug,
        locationId: loc,
        slotId: after.id,
        label: priceLabelPatch || after.label,
        amountCents: amountCentsPatch != null ? amountCentsPatch : undefined,
        actor,
      });
    }
    if (patch.capacity != null || patch.time_local_end != null) {
      locationStore.patchLocationLessonTime(loc, after.id, {
        label: after.label,
        time_local: String(after.time_local || '').slice(0, 5),
        time_local_end: after.time_local_end == null ? null : String(after.time_local_end).slice(0, 5),
        capacity: patch.capacity != null ? patch.capacity : undefined,
      });
    }
    return { ok: true, status: 200, body: { success: true, lesson_time_rule: after, storage: 'db' } };`,
    'patchLessonTimeRule capacity overlay',
  ],
]);

patchFile('G:/Luna/Sunset/scripts/lib/sunset-admin-location-store.js', [
  [
    `function patchLocationLessonTime(locationId, slotId, patch) {
  const store = readStoreSync();
  const bucket = ensureLocationBucket(store, locationId);
  const sid = configTimeStoreKey(slotId);
  const prev = bucket.lesson_times[sid] || {};
  const start = patch.time_local || prev.time_local || (prev.slot_time ? String(prev.slot_time).split('-')[0] : null);
  bucket.lesson_times[sid] = {
    ...prev,
    label: patch.label != null ? patch.label : (prev.label || prev.offering_label),
    slot_time: start,
    time_local: start,
    updated_at: new Date().toISOString(),
  };`,
    `function patchLocationLessonTime(locationId, slotId, patch) {
  const store = readStoreSync();
  const bucket = ensureLocationBucket(store, locationId);
  const sid = configTimeStoreKey(slotId);
  const prev = bucket.lesson_times[sid] || {};
  const start = patch.time_local || prev.time_local || (prev.slot_time ? String(prev.slot_time).split('-')[0].trim() : null);
  const endRaw = patch.time_local_end !== undefined
    ? patch.time_local_end
    : (prev.time_local_end != null ? prev.time_local_end : (prev.slot_time && String(prev.slot_time).includes('-') ? String(prev.slot_time).split('-').pop().trim() : null));
  const slotTime = start && endRaw ? (start + '-' + endRaw) : start;
  bucket.lesson_times[sid] = {
    ...prev,
    label: patch.label != null ? patch.label : (prev.label || prev.offering_label),
    slot_time: slotTime,
    time_local: start,
    time_local_end: endRaw || null,
    capacity: patch.capacity != null ? Number(patch.capacity) : prev.capacity,
    updated_at: new Date().toISOString(),
  };`,
    'patchLocationLessonTime capacity',
  ],
]);

console.log('fix10 ok');
