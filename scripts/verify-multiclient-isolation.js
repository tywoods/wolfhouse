'use strict';

/**
 * Multi-client isolation gate.
 *
 * Static, read-only verifier for config/clients/clients.json — the canonical
 * registry of clients (tenants) and their locations. Asserts the registry is
 * well-formed and isolated: unique slugs, globally-unique location ids, every
 * location owned by exactly one client, required clients/locations present,
 * clean display names, and that nothing is flipped live by accident.
 *
 * No DB, no network, no runtime imports. Exit 0 on pass, nonzero on failure.
 */

const fs = require('fs');
const path = require('path');

const CLIENTS_FILE = path.join(__dirname, '..', 'config', 'clients', 'clients.json');

const REQUIRED_CLIENTS = ['wolfhouse', 'sunset', 'mirleft'];
const REQUIRED_LOCATIONS = ['wolfhouse-somo', 'sunset-somo', 'sunset-sardinero', 'mirleft-main'];

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name); }
}

console.log('verify:multiclient-isolation — config/clients/clients.json\n');

let raw = null;
let parsed = null;
let parseError = null;
try {
  raw = fs.readFileSync(CLIENTS_FILE, 'utf8');
} catch (err) {
  parseError = `cannot read: ${err.message}`;
}
if (raw != null) {
  try { parsed = JSON.parse(raw); } catch (err) { parseError = `invalid JSON: ${err.message}`; }
}

ok('clients.json exists and parses', parsed != null && parseError == null);

const clients = parsed && Array.isArray(parsed.clients) ? parsed.clients : null;
ok('top-level clients array exists', Array.isArray(clients));

if (!Array.isArray(clients)) {
  console.log(`\n── multiclient-isolation: ${pass} passed, ${fail || 1} failed ──`);
  if (parseError) console.log(`  ${parseError}`);
  process.exit(1);
}

// Collect slugs + locations.
const slugs = [];
const locationIds = [];
const locationOwners = {}; // location_id -> [client_slug, ...]
const displayNames = [];

for (const c of clients) {
  const slug = c && typeof c.client_slug === 'string' ? c.client_slug : null;
  if (slug) slugs.push(slug);
  if (c && typeof c.display_name === 'string') displayNames.push(c.display_name);
  const locs = c && Array.isArray(c.locations) ? c.locations : [];
  for (const l of locs) {
    const lid = l && typeof l.location_id === 'string' ? l.location_id : null;
    if (lid) {
      locationIds.push(lid);
      (locationOwners[lid] = locationOwners[lid] || []).push(slug || '(no-slug)');
    }
    if (l && typeof l.display_name === 'string') displayNames.push(l.display_name);
  }
}

// client_slug unique
const dupSlugs = slugs.filter((s, i) => slugs.indexOf(s) !== i);
ok('client_slug values are unique', dupSlugs.length === 0);

// location_id unique globally
const dupLocs = locationIds.filter((s, i) => locationIds.indexOf(s) !== i);
ok('location_id values are unique globally', dupLocs.length === 0);

// every location belongs to exactly one client
const multiOwned = Object.keys(locationOwners).filter((lid) => locationOwners[lid].length !== 1);
ok('every location belongs to exactly one client', multiOwned.length === 0);

// required clients exist
const missingClients = REQUIRED_CLIENTS.filter((s) => !slugs.includes(s));
ok(`required clients exist (${REQUIRED_CLIENTS.join(', ')})`, missingClients.length === 0);

// required locations exist
const missingLocs = REQUIRED_LOCATIONS.filter((l) => !locationIds.includes(l));
ok(`required locations exist (${REQUIRED_LOCATIONS.join(', ')})`, missingLocs.length === 0);

// sunset-sardinero display_name is exactly "elSardi"
let sardiDisplay = null;
for (const c of clients) {
  for (const l of (c.locations || [])) {
    if (l && l.location_id === 'sunset-sardinero') sardiDisplay = l.display_name;
  }
}
ok('sunset-sardinero display_name is exactly "elSardi"', sardiDisplay === 'elSardi');

// no display_name contains underscores
const underscored = displayNames.filter((n) => String(n).includes('_'));
ok('no display_name contains underscores', underscored.length === 0);

// no client live_enabled=true
const liveClients = clients.filter((c) => c && c.live_enabled === true).map((c) => c.client_slug);
ok('no client has live_enabled=true', liveClients.length === 0);

// Diagnostics for any failures.
if (dupSlugs.length) console.log(`    duplicate client_slug: ${[...new Set(dupSlugs)].join(', ')}`);
if (dupLocs.length) console.log(`    duplicate location_id: ${[...new Set(dupLocs)].join(', ')}`);
if (multiOwned.length) console.log(`    location owned by >1 client: ${multiOwned.join(', ')}`);
if (missingClients.length) console.log(`    missing clients: ${missingClients.join(', ')}`);
if (missingLocs.length) console.log(`    missing locations: ${missingLocs.join(', ')}`);
if (underscored.length) console.log(`    display_name with underscore: ${underscored.join(', ')}`);
if (liveClients.length) console.log(`    live_enabled=true: ${liveClients.join(', ')}`);

console.log(`\n── multiclient-isolation: ${pass} passed, ${fail} failed ──`);
if (fail === 0) {
  console.log(`verify:multiclient-isolation — ALL CHECKS PASSED (${clients.length} clients, ${locationIds.length} locations, all live_enabled=false)`);
}
process.exit(fail ? 1 : 0);
