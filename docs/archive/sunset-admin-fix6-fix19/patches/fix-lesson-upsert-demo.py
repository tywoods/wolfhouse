#!/usr/bin/env python3
from pathlib import Path
p = Path('/opt/wolfhouse/WH/scripts/lib/tenant-admin-writes.js')
text = p.read_text(encoding='utf-8')
old = """  const baseline = resolveFromConfigFile(clientSlug);
  const configSlots = loadLessonTimesFromConfig(baseline.ok ? baseline : {});
  const baseSlot = configSlots.find((s) => String(s.slot_id) === String(slotId));
  if (!baseSlot) {
    return { ok: false, status: 404, body: { success: false, error: 'config_slot_not_found' } };
  }
  const parsedTimes = parseConfigSlotTimes(baseSlot.slot_time);"""
new = """  const baseline = resolveFromConfigFile(clientSlug);
  const configSlots = loadLessonTimesFromConfig(baseline.ok ? baseline : {});
  const baseSlot = configSlots.find((s) => String(s.slot_id) === String(slotId)) || null;
  const parsedTimes = parseConfigSlotTimes(baseSlot && baseSlot.slot_time);
  if (!baseSlot && !patch.time_local) {
    return { ok: false, status: 400, body: { success: false, error: 'time_local required' } };
  }"""
if old not in text:
    raise SystemExit('anchor missing for lesson upsert fix')
text = text.replace(old, new, 1)
p.write_text(text, encoding='utf-8')
print('OK lesson upsert uses patch when demo slot missing from config file')
