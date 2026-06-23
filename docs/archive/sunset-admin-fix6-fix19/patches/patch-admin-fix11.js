'use strict';
const fs = require('fs');

const apiPath = 'G:/Luna/Sunset/scripts/staff-query-api.js';
let api = fs.readFileSync(apiPath, 'utf8');
const oldCatch = `  } catch (err) {
    return sendJSON(res, 500, { success: false, error: 'write failed' });
  }
}

async function handleAdminConfigSurfPackPost`;
const newCatch = `  } catch (err) {
    console.error('lesson time patch failed', err);
    return sendJSON(res, 500, { success: false, error: 'write failed', message: err && err.message ? String(err.message) : undefined });
  }
}

async function handleAdminConfigSurfPackPost`;
if (!api.includes(oldCatch)) throw new Error('lesson patch catch not found');
api = api.replace(oldCatch, newCatch);
fs.writeFileSync(apiPath, api, 'utf8');

const writesPath = 'G:/Luna/Sunset/scripts/lib/tenant-admin-writes.js';
let writes = fs.readFileSync(writesPath, 'utf8');
const oldPost = `    await client.query('COMMIT');
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
    return { ok: true, status: 200, body: { success: true, lesson_time_rule: after, storage: 'db' } };`;
const newPost = `    await client.query('COMMIT');
    if (amountCentsPatch != null || priceLabelPatch != null) {
      try {
        await upsertLessonSlotPriceRule(client, {
          clientSlug,
          locationId: loc,
          slotId: after.id,
          label: priceLabelPatch || after.label,
          amountCents: amountCentsPatch != null ? amountCentsPatch : undefined,
          actor,
        });
      } catch (priceErr) {
        console.error('lesson slot price upsert failed', priceErr);
      }
    }
    if (patch.capacity != null) {
      try {
        locationStore.patchLocationLessonTime(loc, after.id, {
          label: after.label,
          time_local: String(after.time_local || '').slice(0, 5),
          time_local_end: after.time_local_end == null ? null : String(after.time_local_end).slice(0, 5),
          capacity: patch.capacity,
        });
      } catch (capErr) {
        console.error('lesson capacity overlay failed', capErr);
      }
    }
    return { ok: true, status: 200, body: { success: true, lesson_time_rule: after, storage: 'db' } };`;
if (!writes.includes(oldPost)) throw new Error('post commit block not found');
writes = writes.replace(oldPost, newPost);
fs.writeFileSync(writesPath, writes, 'utf8');
console.log('fix11 ok');
