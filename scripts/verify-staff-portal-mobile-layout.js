'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function check(id, ok, msg) {
  if (ok) { passed += 1; return; }
  failed += 1;
  console.error(`FAIL ${id}: ${msg}`);
}

const apiPath = path.join(__dirname, 'staff-query-api.js');
const src = fs.readFileSync(apiPath, 'utf8');

// Source markers — mobile shell + feature CSS
check('M1', /@media\s*\(\s*max-width\s*:\s*768px\s*\)/.test(src), 'mobile media query @768px exists');
check('M2', src.includes('staff-portal-mobile:shell'), 'root shell mobile marker');
check('M3', /max-width:\s*100vw/.test(src) && src.includes('staff-portal-mobile:shell'), '100vw shell width override marker');
check('M4', src.includes('staff-portal-mobile:calendar-card'), 'calendar card mobile full-width marker');
check('M5', src.includes('BC_ZOOM_MOBILE_DEFAULT') && /BC_ZOOM_MOBILE_DEFAULT\s*=\s*70/.test(src), 'calendar mobile zoom default 70%');
check('M6', src.includes('BC_ZOOM_MOBILE_MIN') && /BC_ZOOM_MOBILE_MIN\s*=\s*50/.test(src), 'calendar mobile zoom min 50%');
check('M7', src.includes('staff-portal-mobile:inbox') && src.includes('inbox-mobile-back'), 'inbox mobile list/detail/back markers');
check('M8', src.includes('conv-card-mobile-dense'), 'inbox compact mobile card marker');
check('M9', src.includes('staff-portal-mobile:staff-numbers') && src.includes('swn-mobile-card'), 'staff number mobile card marker');
check('M10', src.includes('viewport-fit=cover'), 'viewport-fit=cover on main portal');

// Auth POST unchanged (no accidental route edits in this slice)
check('A1', !/app\.post\s*\(\s*['"]\/staff\/login['"]/.test(src) || src.includes("app.post('/staff/login'"), 'staff login POST route still present');
check('A2', !src.includes("app.post('/staff/logout'") || src.includes("app.post('/staff/logout'"), 'staff logout POST route still present');

// Tab / section markers still present
check('T1', src.includes('data-tab="services"') || src.includes("data-tab='services'"), 'Services tab marker');
check('T2', src.includes('cc-staff-whatsapp-numbers'), 'Staff/Owner WhatsApp numbers section marker');
check('T3', src.includes('id="tab-bed-calendar"'), 'Booking calendar tab marker');
check('T4', src.includes('id="tab-conversations"'), 'WhatsApp/inbox tab marker');

// Portal script syntax (static extract — no full HTML build)
{
  check('UI1', src.includes('bcOnBedCalendarTabOpen') && src.includes("'use strict';"), 'main portal script present in source');
  check('UI2', src.includes('function bcInitCalendarZoom') && src.includes('BC_ZOOM_MOBILE_DEFAULT'), 'portal calendar zoom wired in source');
  check('UI3', src.includes('staff-portal-mobile:shell'), 'mobile shell CSS in source');
  check('UI4', src.includes('BC_ZOOM_MOBILE_DEFAULT'), 'mobile zoom constants in source');
}

console.log(`\nverify-staff-portal-mobile-layout: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
