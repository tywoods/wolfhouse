#!/usr/bin/env python3
"""Fix pack/lesson write failures: circular dep, transactions, lesson upsert."""
from pathlib import Path

ROOT = Path('/opt/wolfhouse/WH')
TBC = ROOT / 'scripts/lib/tenant-business-config.js'
PACK = ROOT / 'scripts/lib/sunset-admin-pack-rules.js'
WRITES = ROOT / 'scripts/lib/tenant-admin-writes.js'

# 1) Break circular dependency: lazy-load pack rules from tenant-business-config
tbc = TBC.read_text(encoding='utf-8')
if "require('./sunset-admin-pack-rules')" in tbc.split('function isSunsetAdminDbReadEnabled')[0]:
    tbc = tbc.replace(
        "const { loadSurfPacksFromDb, defaultPackConfig } = require('./sunset-admin-pack-rules');\n",
        "",
        1,
    )
    tbc = tbc.replace(
        "  const surf_packs = await loadSurfPacksFromDb(client, slug, loc);",
        "  const { loadSurfPacksFromDb } = require('./sunset-admin-pack-rules');\n  const surf_packs = await loadSurfPacksFromDb(client, slug, loc);",
        1,
    )
    if 'function defaultSurfPacksFromConfig()' not in tbc:
        tbc = tbc.replace(
            "function loadLessonTimesFromConfig(cfg) {",
            "function defaultSurfPacksFromConfig() {\n  return [];\n}\n\nfunction loadLessonTimesFromConfig(cfg) {",
            1,
        )
    tbc = tbc.replace(
        "    surf_packs: [],",
        "    surf_packs: defaultSurfPacksFromConfig(),",
        1,
    )
    TBC.write_text(tbc, encoding='utf-8')
    print('OK lazy pack rules import in tenant-business-config')

# 2) Fix createSurfPackRule post-commit tier upsert + rollback guard
pack = PACK.read_text(encoding='utf-8')
old_pack = """    const row = inserted.rows[0];
    await client.query('COMMIT');
    await upsertPackPriceTiers(client, {
      clientSlug,
      locationId: loc,
      packId: row.id,
      packLabel: label,
      tiers: cfg.price_tiers,
      actor,
    });
    return { ok: true, status: 201, body: { success: true, surf_pack: mapPackRow(row) } };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}"""
new_pack = """    const row = inserted.rows[0];
    await client.query('COMMIT');
    try {
      await upsertPackPriceTiers(client, {
        clientSlug,
        locationId: loc,
        packId: row.id,
        packLabel: label,
        tiers: cfg.price_tiers,
        actor,
      });
    } catch (tierErr) {
      return {
        ok: false,
        status: 500,
        body: { success: false, error: 'pack_price_tiers_failed', message: tierErr.message },
      };
    }
    return { ok: true, status: 201, body: { success: true, surf_pack: mapPackRow(row) } };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already committed or idle */ }
    throw err;
  }
}"""
if old_pack in pack:
    pack = pack.replace(old_pack, new_pack, 1)
    PACK.write_text(pack, encoding='utf-8')
    print('OK createSurfPackRule transaction fix')

# 3) Fix upsertPackPriceTiers to require tenant-admin-writes at module load after cycle broken
# (lazy require inside function remains)

# 4) Fix lesson upsert: no FOR UPDATE outside transaction; inline patch for existing rows
writes = WRITES.read_text(encoding='utf-8')
writes = writes.replace(
    "      ? `SELECT * FROM tenant_lesson_time_rules WHERE client_slug = $1 AND location_id = $2 AND lesson_type = $3 AND active = true FOR UPDATE`",
    "      ? `SELECT * FROM tenant_lesson_time_rules WHERE client_slug = $1 AND location_id = $2 AND lesson_type = $3 AND active = true`",
    1,
)
writes = writes.replace(
    "      : `SELECT * FROM tenant_lesson_time_rules WHERE client_slug = $1 AND lesson_type = $2 AND active = true FOR UPDATE`,",
    "      : `SELECT * FROM tenant_lesson_time_rules WHERE client_slug = $1 AND lesson_type = $2 AND active = true`,",
    1,
)

# Fix baseSlot null reference when building dbPatch label
writes = writes.replace(
    "    label: patch.label != null ? patch.label : (baseSlot.offering_label || 'Surf lesson'),",
    "    label: patch.label != null ? patch.label : ((baseSlot && baseSlot.offering_label) || 'Surf lesson'),",
    1,
)

WRITES.write_text(writes, encoding='utf-8')
print('OK lesson upsert query fix')
print('DONE')
