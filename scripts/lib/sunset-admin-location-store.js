'use strict';

/**
 * School-scoped Sunset Admin config persistence (JSON file).
 * Dev/local fallback and pre-023 school-delta bridge. Production staging uses Postgres
 * tenant_* tables (021 + 023) as authoritative store when present.
 *
 * @see database/migrations/023_sunset_admin_location_id_PROPOSED.sql
 */

const fs = require('fs');
const path = require('path');
const {
  normalizeSunsetLocationId,
  DEFAULT_SUNSET_LOCATION_ID,
  SUNSET_LOCATIONS,
} = require('./sunset-school-locations');
const { validateConfig } = require('./sunset-course-equipment-pricing');

const STORE_PATH = path.join(__dirname, '../../config/clients/sunset.location-admin.json');
const CFG_PREFIX = 'cfg:';

// Narrow read compatibility for an obsolete Admin route. Invalid legacy JSON
// fails closed and is never promoted to authoritative course configuration.
function normalizeLegacyCourseEquipmentPricing(value) {
  const row = value && value.all_day;
  if (value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).every((key) => key === 'all_day')
      && row && typeof row.enabled === 'boolean'
      && Number.isSafeInteger(row.surfboard_cents) && row.surfboard_cents >= 0
      && Number.isSafeInteger(row.wetsuit_cents) && row.wetsuit_cents >= 0) {
    return validateConfig(value);
  }
  return { all_day: { enabled: false, surfboard_cents: 0, wetsuit_cents: 0 } };
}

function stablePriceKey(category, offeringKey, unit) {
  return `${category}|${offeringKey}|${unit}`;
}

function priceIdFromParts(locationId, category, offeringKey, unit) {
  return `${CFG_PREFIX}${normalizeSunsetLocationId(locationId)}:${stablePriceKey(category, offeringKey, unit)}`;
}

function parseConfigPriceId(id) {
  const text = String(id || '');
  if (!text.startsWith(CFG_PREFIX)) return null;
  const rest = text.slice(CFG_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon < 0) return null;
  const locationId = normalizeSunsetLocationId(rest.slice(0, colon));
  const key = rest.slice(colon + 1);
  const parts = key.split('|');
  if (parts.length !== 3) return null;
  return {
    locationId,
    category: parts[0],
    offering_key: parts[1],
    unit: parts[2],
  };
}

function isConfigPriceId(id) {
  return String(id || '').startsWith(CFG_PREFIX);
}

function isConfigTimeId(id) {
  const text = String(id || '');
  return text.startsWith('cfg-time:') || (!/^[0-9a-f-]{36}$/i.test(text) && !!text && !text.startsWith(CFG_PREFIX));
}

function configTimeStoreKey(slotId) {
  return String(slotId || '').trim();
}

function readStoreSync() {
  try {
    if (!fs.existsSync(STORE_PATH)) return { version: 1, locations: {} };
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (!raw || typeof raw !== 'object') return { version: 1, locations: {} };
    if (!raw.locations || typeof raw.locations !== 'object') raw.locations = {};
    return raw;
  } catch (_) {
    return { version: 1, locations: {} };
  }
}

function writeStoreSync(store) {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${STORE_PATH}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, STORE_PATH);
    const dirFd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

const LOCK_PATH = `${STORE_PATH}.lock`;
function mutateStoreSync(mutator) {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let lockFd;
  const deadline = Date.now() + 5000;
  while (lockFd == null) {
    try {
      lockFd = fs.openSync(LOCK_PATH, 'wx', 0o600);
      fs.writeFileSync(lockFd, `${process.pid}\n`, 'utf8');
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      // Recover only demonstrably stale locks; otherwise bounded synchronous wait.
      try {
        const age = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
        if (age > 30000) { fs.unlinkSync(LOCK_PATH); continue; }
      } catch (_) { continue; }
      if (Date.now() >= deadline) throw new Error('location store lock timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    const store = readStoreSync();
    const result = mutator(store); // exceptions are rollback: no replace occurs
    store.revision = Number.isSafeInteger(store.revision) ? store.revision + 1 : 1;
    writeStoreSync(store);
    return result;
  } finally {
    try { fs.closeSync(lockFd); } catch (_) {}
    try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
  }
}

function ensureLocationBucket(store, locationId) {
  const loc = normalizeSunsetLocationId(locationId);
  if (!store.locations[loc]) {
    store.locations[loc] = {
      prices: {},
      lesson_capacity: null,
      lesson_times: {},
      services: null,
    };
  }
  const bucket = store.locations[loc];
  if (!bucket.prices || typeof bucket.prices !== 'object') bucket.prices = {};
  if (!bucket.lesson_times || typeof bucket.lesson_times !== 'object') bucket.lesson_times = {};
  return bucket;
}

function getCourseEquipmentPricing(locationId) {
  const loc = normalizeSunsetLocationId(locationId);
  const bucket = readStoreSync().locations[loc];
  return normalizeLegacyCourseEquipmentPricing(bucket && bucket.course_equipment_pricing);
}

function putCourseEquipmentPricing(locationId, value) {
  const canonical = validateConfig(value);
  return mutateStoreSync((store) => {
    const bucket = ensureLocationBucket(store, locationId);
    bucket.course_equipment_pricing = canonical;
    return canonical;
  });
}

function resolveLocationLabel(locationId) {
  const loc = SUNSET_LOCATIONS.find((l) => l.id === normalizeSunsetLocationId(locationId));
  return loc ? loc.displayName : normalizeSunsetLocationId(locationId);
}

function hasLocationOverrides(locationId) {
  const loc = normalizeSunsetLocationId(locationId);
  const bucket = readStoreSync().locations[loc];
  if (!bucket) return false;
  if (bucket.lesson_capacity && bucket.lesson_capacity.default_daily_cap != null) return true;
  if (bucket.prices && Object.keys(bucket.prices).length) return true;
  if (bucket.lesson_times && Object.keys(bucket.lesson_times).length) return true;
  return false;
}

function assignConfigPriceId(price, locationId) {
  if (!price || price.id) return price;
  return {
    ...price,
    id: priceIdFromParts(locationId, price.category, price.offering_key, price.unit),
  };
}

function applyStoreToResolvedConfig(config, locationId) {
  if (!config || !config.ok) return config;
  const loc = normalizeSunsetLocationId(locationId);
  const store = readStoreSync();
  const bucket = store.locations[loc];
  // course_equipment_pricing is obsolete as an Admin/quote authority. Historical
  // JSON may still exist in the location store file; use getCourseEquipmentPricing
  // only for bounded legacy read/test compatibility — do not project it here.
  const next = {
    ...config,
    location_id: loc,
    location_label: resolveLocationLabel(loc),
  };

  if (next.prices && Array.isArray(next.prices)) {
    next.prices = next.prices.map((p) => {
      const withId = assignConfigPriceId(p, loc);
      const key = stablePriceKey(withId.category, withId.offering_key, withId.unit);
      const ov = bucket && bucket.prices ? bucket.prices[key] : null;
      const projected = withId.unit === '1_day'
        ? { ...withId, unit: 'full_day', legacy_unit: undefined }
        : withId;
      if (!ov) return projected;
      return {
        ...projected,
        label: ov.label || ov.display_name || projected.label,
        amount: ov.amount != null ? Number(ov.amount) : projected.amount,
        currency: ov.currency || projected.currency,
        active: ov.active != null ? ov.active !== false : projected.active,
        effective_state: 'location_override',
        source: 'location_store',
      };
    });
  }

  if (bucket && bucket.lesson_capacity && bucket.lesson_capacity.default_daily_cap != null) {
    next.lesson_capacity = {
      ...(next.lesson_capacity || {}),
      default_daily_cap: Number(bucket.lesson_capacity.default_daily_cap),
      source: 'location_store',
    };
  }

  if (next.lesson_times && Array.isArray(next.lesson_times)) {
    next.lesson_times = next.lesson_times.map((slot) => {
      const sid = configTimeStoreKey(slot.slot_id);
      const ov = bucket && bucket.lesson_times ? bucket.lesson_times[sid] : null;
      if (!ov) return slot;
      return {
        ...slot,
        slot_time: ov.slot_time != null ? ov.slot_time : slot.slot_time,
        offering_label: ov.label || ov.offering_label || slot.offering_label,
        capacity: ov.capacity != null ? ov.capacity : slot.capacity,
        source: 'location_store',
      };
    });
    if (bucket && bucket.lesson_times) {
      for (const [sid, ov] of Object.entries(bucket.lesson_times)) {
        if (ov && ov._added) {
          next.lesson_times.push({
            slot_id: sid,
            date: ov.date || null,
            slot_time: ov.slot_time || null,
            offering_label: ov.label || ov.offering_label || 'Lesson',
            session_type: ov.session_type || null,
            capacity: ov.capacity != null ? ov.capacity : null,
            source: 'location_store',
          });
        }
      }
    }
  }

  if (bucket && bucket.services && typeof bucket.services === 'object') {
    next.available_services = { ...(next.available_services || {}), ...bucket.services };
  }

  if (bucket && Object.keys(bucket.prices || {}).length) {
    next.source = next.source === 'db' ? 'db+location_store' : 'location_store';
  }

  return next;
}

function patchConfigPrice(locationId, category, offeringKey, unit, patch) {
  return mutateStoreSync((store) => {
  const bucket = ensureLocationBucket(store, locationId);
  const key = stablePriceKey(category, offeringKey, unit);
  const prev = bucket.prices[key] || {};
  const nextAmount = patch.amount_cents != null
    ? Number(patch.amount_cents) / 100
    : (prev.amount != null ? Number(prev.amount) : null);
  const nextActive = patch.active != null
    ? patch.active === true
    : (prev.active !== false);
  if (nextActive === true) {
    const cents = nextAmount == null ? NaN : Math.round(Number(nextAmount) * 100);
    if (!Number.isInteger(cents) || cents <= 0) {
      return {
        ok: false,
        status: 400,
        body: { success: false, error: 'amount_cents must be > 0 to enable' },
      };
    }
  }
  bucket.prices[key] = {
    ...prev,
    category,
    offering_key: offeringKey,
    unit,
    label: patch.display_name != null ? patch.display_name : (prev.label || prev.display_name),
    amount: nextAmount,
    currency: patch.currency || prev.currency || 'EUR',
    active: nextActive,
    updated_at: new Date().toISOString(),
  };
  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      price_rule: {
        id: priceIdFromParts(locationId, category, offeringKey, unit),
        ...bucket.prices[key],
        active: nextActive,
      },
      storage: 'location_store',
    },
  };
  });
}

function putLocationCapacity(locationId, capacity) {
  return mutateStoreSync((store) => {
    const bucket = ensureLocationBucket(store, locationId);
    bucket.lesson_capacity = {
      default_daily_cap: Number(capacity),
      updated_at: new Date().toISOString(),
    };
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        lesson_capacity: bucket.lesson_capacity,
        storage: 'location_store',
      },
    };
  });
}

function patchLocationLessonTime(locationId, slotId, patch) {
  return mutateStoreSync((store) => {
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
  };
  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      lesson_time_rule: { slot_id: sid, ...bucket.lesson_times[sid] },
      storage: 'location_store',
    },
  };
  });
}

function appendLocationAudit(locationId, entry) {
  return mutateStoreSync((store) => {
  const bucket = ensureLocationBucket(store, locationId);
  if (!Array.isArray(bucket.change_history)) bucket.change_history = [];
  bucket.change_history.unshift({
    ...entry,
    location_id: normalizeSunsetLocationId(locationId),
    changed_at: new Date().toISOString(),
    source: 'location_store',
  });
  bucket.change_history = bucket.change_history.slice(0, 50);
  return bucket.change_history[0];
  });
}


function deactivateConfigPrice(locationId, category, offeringKey, unit) {
  const loc = normalizeSunsetLocationId(locationId);
  return mutateStoreSync((store) => {
  const bucket = ensureLocationBucket(store, loc);
  const key = stablePriceKey(category, offeringKey, unit);
  if (bucket.prices && bucket.prices[key]) {
    bucket.prices[key].active = false;
  }
  return { ok: true, body: { price_rule: { id: priceIdFromParts(loc, category, offeringKey, unit), active: false } } };
  });
}
module.exports = {
  STORE_PATH,
  CFG_PREFIX,
  DEFAULT_SUNSET_LOCATION_ID,
  stablePriceKey,
  priceIdFromParts,
  parseConfigPriceId,
  deactivateConfigPrice,
  isConfigPriceId,
  isConfigTimeId,
  readStoreSync,
  applyStoreToResolvedConfig,
  patchConfigPrice,
  putLocationCapacity,
  patchLocationLessonTime,
  appendLocationAudit,
  resolveLocationLabel,
  hasLocationOverrides,
  getCourseEquipmentPricing,
  putCourseEquipmentPricing,
  mutateStoreSync,
};
