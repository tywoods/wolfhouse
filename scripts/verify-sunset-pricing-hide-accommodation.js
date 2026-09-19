'use strict';

/**
 * Admin → Pricing: Accommodation section is hidden for staff.
 *
 * Ty: Pricing will not use Accommodation. Hide chrome only — keep shell ids,
 * APIs, and booking-side accommodation flows intact.
 *
 * Run: node scripts/verify-sunset-pricing-hide-accommodation.js
 *      npm run verify:sunset-pricing-hide-accommodation
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const adminUi = read('scripts/browser/sunset-admin-ui.js');
const apiSrc = read('scripts/staff-query-api.js');

const hideFn = (adminUi.match(/function adminHidePricingAccommodationSection\([\s\S]*?\nfunction /) || [])[0] || '';
const renderFn = (adminUi.match(/function renderAdminSectionAccommodationFromConfig\([\s\S]*?\nfunction /) || [])[0] || '';

assert.ok(hideFn, 'adminHidePricingAccommodationSection present');
assert.ok(renderFn, 'renderAdminSectionAccommodationFromConfig present');

assert.ok(
  /sec\.style\.display = 'none'/.test(hideFn) && /sec\.hidden = true/.test(hideFn),
  'hide helper sets display:none and hidden',
);
assert.ok(/box\.innerHTML = ''/.test(hideFn), 'hide helper clears accommodation body');

assert.ok(
  /adminHidePricingAccommodationSection\(\)/.test(renderFn)
    && !/data-testid="admin-accommodation-card"/.test(renderFn),
  'Pricing render path only hides — does not paint Accommodation card',
);

assert.ok(
  /adminHidePricingAccommodationSection\(\)/.test(adminUi)
    && /wireAdminTab[\s\S]{0,500}adminHidePricingAccommodationSection\(\)/.test(adminUi),
  'wireAdminTab hides Accommodation before config fetch',
);

assert.ok(
  /id="admin-sec-accommodation"[^>]*\bhidden\b/.test(apiSrc)
    && /id="admin-accommodation-body"/.test(apiSrc),
  'Admin HTML shell kept but marked hidden (no empty Pricing chrome)',
);

assert.ok(
  /id="admin-sec-prices"/.test(apiSrc)
    && apiSrc.indexOf('admin-sec-prices') < apiSrc.indexOf('admin-sec-accommodation'),
  'other Pricing sections (Equipment) remain ahead of hidden Accommodation shell',
);

assert.ok(
  /pathname === '\/staff\/admin\/config\/accommodation'/.test(apiSrc)
    && /handleAdminConfigAccommodationPut/.test(apiSrc),
  'accommodation config API still present for booking flows',
);

assert.ok(
  /action === 'save-accommodation'/.test(adminUi)
    && /\/staff\/admin\/config\/accommodation/.test(adminUi),
  'save-accommodation handler retained (UI not painted)',
);

console.log('verify:sunset-pricing-hide-accommodation — PASS');
