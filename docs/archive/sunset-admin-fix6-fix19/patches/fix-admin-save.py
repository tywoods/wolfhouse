#!/usr/bin/env python3
"""Fix admin save: patchLessonTimeRule DB leak, lesson end time, pack handlers/routes."""
from pathlib import Path

ROOT = Path('/opt/wolfhouse/WH')
writes_path = ROOT / 'scripts/lib/tenant-admin-writes.js'
api_path = ROOT / 'scripts/staff-query-api.js'

writes = writes_path.read_text(encoding='utf-8')

# Fix patchLessonTimeRule using patch instead of dbPatchLesson in UPDATE loop
old_loop = """    for (const [key, value] of Object.entries(patch)) {
      if (key === 'capacity' && !hasCapacity) continue;
      if (key === 'weekdays_active') {
        sets.push(`${key} = $${idx}::smallint[]`);
        params.push(value);
      } else if (key === 'capacity') {
        sets.push(`${key} = $${idx}::integer`);
        params.push(value);
      } else {
        sets.push(`${key} = $${idx}`);
        params.push(value);
      }
      idx += 1;
    }"""

new_loop = """    delete dbPatchLesson.kind;
    delete dbPatchLesson.age_band;
    delete dbPatchLesson.frequency;
    for (const [key, value] of Object.entries(dbPatchLesson)) {
      if (key === 'capacity' && !hasCapacity) continue;
      if (key === 'weekdays_active') {
        sets.push(`${key} = $${idx}::smallint[]`);
        params.push(value);
      } else if (key === 'capacity') {
        sets.push(`${key} = $${idx}::integer`);
        params.push(value);
      } else {
        sets.push(`${key} = $${idx}`);
        params.push(value);
      }
      idx += 1;
    }"""

if old_loop in writes:
    writes = writes.replace(old_loop, new_loop, 1)
    print('OK patchLessonTimeRule loop')
else:
    print('SKIP patchLessonTimeRule loop')

old_validate = """  if (body.active != null) {
    if (typeof body.active !== 'boolean') return { ok: false, error: 'active must be boolean' };
    out.active = body.active;
  }
  if (!Object.keys(out).length) return { ok: false, error: 'empty body' };

  const kindAge = validateLessonKindAgeFrequency(body, out);
  if (!kindAge.ok) return kindAge;
  if (out.kind != null || out.age_band != null) {
    const kind = out.kind || 'lesson';
    const age = out.age_band || 'all_ages';
    out.lesson_type = buildLessonType(kind, age);
    delete out.kind;
    delete out.age_band;
  }
  delete out.frequency;"""

new_validate = """  if (body.active != null) {
    if (typeof body.active !== 'boolean') return { ok: false, error: 'active must be boolean' };
    out.active = body.active;
  }

  const kindAge = validateLessonKindAgeFrequency(body, out);
  if (!kindAge.ok) return kindAge;
  if (out.kind != null || out.age_band != null) {
    const kind = out.kind || 'lesson';
    const age = out.age_band || 'all_ages';
    out.lesson_type = buildLessonType(kind, age);
    delete out.kind;
    delete out.age_band;
  }
  delete out.frequency;

  if (!Object.keys(out).length) return { ok: false, error: 'empty body' };"""

if old_validate in writes:
    writes = writes.replace(old_validate, new_validate, 1)
    print('OK validateLessonTimePatchBody')
else:
    print('SKIP validateLessonTimePatchBody')

writes_path.write_text(writes, encoding='utf-8')

api = api_path.read_text(encoding='utf-8')

old_save_time = """    if (action === 'save-time'){
      var timeId = String(btn.getAttribute('data-time-id') || '');
      var labelInput = el('admin-time-label');
      var startInput = el('admin-time-start');
      var endInput = el('admin-time-end');
      var capInput = el('admin-time-capacity');
      var label = labelInput ? String(labelInput.value || '').trim() : '';
      if (!label){ adminShowMessage('error', portalT('admin.edit.nameRequired')); return; }
      var timeParsed = adminParseTimeHm(startInput && startInput.value);
      if (!timeParsed.ok){ adminShowMessage('error', timeParsed.error); return; }
      var endParsed = adminParseTimeHm(endInput && endInput.value);
      if (!endParsed.ok){ adminShowMessage('error', endParsed.error); return; }
      if (endParsed.value <= timeParsed.value){ adminShowMessage('error', portalT('admin.edit.endAfterStart')); return; }
      var capacityParsed = adminParseCapacity(capInput && capInput.value);
      if (!capacityParsed.ok){ adminShowMessage('error', capacityParsed.error); return; }
      adminSaveBusy = true;
      adminShowMessage('', '');
      var kindInput = el('admin-time-kind');
      var ageInput = el('admin-time-age');
      var freqInput = el('admin-time-frequency');
      var costInput = el('admin-time-cost');
      var costParsed = adminParseEurosToCents(costInput && costInput.value);
      if (!costParsed.ok){ adminShowMessage('error', costParsed.error); return; }
      adminApiRequest('PATCH', '/staff/admin/config/lesson-times/' + encodeURIComponent(timeId) + adminClientQuery(), {
        label: label,
        kind: 'lesson',
        age_band: ageInput ? String(ageInput.value || 'all_ages') : 'all_ages',
        frequency: freqInput ? String(freqInput.value || 'daily') : 'daily',
        time_local: timeParsed.value,
        time_local_end: endParsed.value,
        capacity: capacityParsed.value,
        amount_cents: costParsed.value,
      }).then(function(res){"""

new_save_time = """    if (action === 'save-time'){
      var timeId = String(btn.getAttribute('data-time-id') || '');
      var labelInput = el('admin-time-label');
      var startInput = el('admin-time-start');
      var endInput = el('admin-time-end');
      var capInput = el('admin-time-capacity');
      var label = labelInput ? String(labelInput.value || '').trim() : '';
      if (!label){ adminShowMessage('error', portalT('admin.edit.nameRequired')); return; }
      var timeParsed = adminParseTimeHm(startInput && startInput.value);
      if (!timeParsed.ok){ adminShowMessage('error', timeParsed.error); return; }
      var endRaw = endInput ? String(endInput.value || '').trim() : '';
      var endParsed = { ok: true, value: null };
      if (endRaw){
        endParsed = adminParseTimeHm(endRaw);
        if (!endParsed.ok){ adminShowMessage('error', endParsed.error); return; }
        if (endParsed.value <= timeParsed.value){ adminShowMessage('error', portalT('admin.edit.endAfterStart')); return; }
      }
      var capacityParsed = adminParseCapacity(capInput && capInput.value);
      if (!capacityParsed.ok){ adminShowMessage('error', capacityParsed.error); return; }
      var ageInput = el('admin-time-age');
      var freqInput = el('admin-time-frequency');
      var costInput = el('admin-time-cost');
      var costParsed = adminParseEurosToCents(costInput && costInput.value);
      if (!costParsed.ok){ adminShowMessage('error', costParsed.error); return; }
      var timePayload = {
        label: label,
        kind: 'lesson',
        age_band: ageInput ? String(ageInput.value || 'all_ages') : 'all_ages',
        frequency: freqInput ? String(freqInput.value || 'daily') : 'daily',
        time_local: timeParsed.value,
        capacity: capacityParsed.value,
        amount_cents: costParsed.value,
      };
      if (endParsed.value) timePayload.time_local_end = endParsed.value;
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('PATCH', '/staff/admin/config/lesson-times/' + encodeURIComponent(timeId) + adminClientQuery(), timePayload).then(function(res){"""

if old_save_time in api:
    api = api.replace(old_save_time, new_save_time, 1)
    print('OK save-time optional end')
else:
    print('SKIP save-time')

old_gate = """      if (!adminCfgWritesEnabled(cfg)) return;
    }
    if (action === 'toggle-pill'){"""

new_gate = """      if (!adminCfgWritesEnabled(cfg)){ adminShowMessage('error', portalT('admin.banner.writesDisabled')); return; }
    }
    if (action === 'toggle-pill'){"""

if old_gate in api:
    api = api.replace(old_gate, new_gate, 1)
    print('OK writes gate message')
else:
    print('SKIP writes gate message')

PACK_HANDLERS = '''
    if (action === 'add-pack'){
      adminEditTarget = 'pack:new';
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'edit-pack'){
      adminEditTarget = 'pack:' + String(btn.getAttribute('data-pack-id') || '');
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'delete-pack'){
      var deletePackId = String(btn.getAttribute('data-pack-id') || '');
      if (!deletePackId || !window.confirm(portalT('admin.edit.confirmRemovePack'))) return;
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('DELETE', '/staff/admin/config/surf-packs/' + encodeURIComponent(deletePackId) + adminClientQuery(), {})
        .then(function(res){
          adminSaveBusy = false;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.removedPack'));
          adminReloadConfig();
        }).catch(function(err){
          adminSaveBusy = false;
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      return;
    }
    if (action === 'save-pack' || action === 'save-new-pack'){
      var packId = action === 'save-pack' ? String(btn.getAttribute('data-pack-id') || '') : '';
      var payload = adminReadPackFormPayload(packId || null);
      if (!payload.label){ adminShowMessage('error', portalT('admin.edit.nameRequired')); return; }
      adminSaveBusy = true;
      adminShowMessage('', '');
      var packReq = packId
        ? adminApiRequest('PATCH', '/staff/admin/config/surf-packs/' + encodeURIComponent(packId) + adminClientQuery(), payload)
        : adminApiRequest('POST', '/staff/admin/config/surf-packs' + adminClientQuery(), payload);
      packReq.then(function(res){
        adminSaveBusy = false;
        if ((res.status !== 200 && res.status !== 201) || !res.data || res.data.success !== true){
          adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
          return;
        }
        adminShowMessage('success', packId ? portalT('admin.edit.savedPack') : portalT('admin.edit.addedPack'));
        adminReloadConfig();
      }).catch(function(err){
        adminSaveBusy = false;
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
      });
      return;
    }
'''

wire_body = api.split('function wireAdminTab')[1].split('var customersCache')[0]
if "action === 'save-new-pack'" not in wire_body:
    api = api.replace('    if (action === \'save-new-time\'){', PACK_HANDLERS + "\n    if (action === 'save-new-time'){", 1)
    print('OK pack handlers')
else:
    print('SKIP pack handlers')

ROUTE_BLOCK = """
  if (pathname === '/staff/admin/config/surf-packs' && method === 'POST') {
    const auth = await requireAuth(req, res, 'admin');
    if (!auth.ok) return;
    return handleAdminConfigSurfPackPost(parsed.query, req, res, auth.user);
  }

  const adminSurfPackPatchMatch = /^\\/staff\\/admin\\/config\\/surf-packs\\/([0-9a-f-]{36})$/i.exec(pathname);
  if (adminSurfPackPatchMatch && method === 'PATCH') {
    const auth = await requireAuth(req, res, 'admin');
    if (!auth.ok) return;
    return handleAdminConfigSurfPackPatch(adminSurfPackPatchMatch[1], parsed.query, req, res, auth.user);
  }
  if (adminSurfPackPatchMatch && method === 'DELETE') {
    const auth = await requireAuth(req, res, 'admin');
    if (!auth.ok) return;
    return handleAdminConfigSurfPackDelete(adminSurfPackPatchMatch[1], parsed.query, req, res, auth.user);
  }

"""

if '/staff/admin/config/surf-packs' not in api:
    api = api.replace(
        "  if (pathname === '/staff/admin/config/lesson-times' && method === 'POST') {",
        ROUTE_BLOCK + "  if (pathname === '/staff/admin/config/lesson-times' && method === 'POST') {",
        1,
    )
    print('OK surf-packs routes')
else:
    print('SKIP surf-packs routes')

api_path.write_text(api, encoding='utf-8')
print('DONE')
