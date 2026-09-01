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
// Template plus injected Inbox browser modules: Inbox/Customers JS was extracted.
const src = require('./lib/staff-portal-ui-source').readStaffPortalUiSource();

// Source markers — mobile shell + feature CSS
check('M1', /@media\s*\(\s*max-width\s*:\s*768px\s*\)/.test(src), 'mobile media query @768px exists');
check('M2', src.includes('staff-portal-mobile:shell'), 'root shell mobile marker');
check('M3', /max-width:\s*100vw/.test(src) && src.includes('staff-portal-mobile:shell'), '100vw shell width override marker');
check('M4', src.includes('staff-portal-mobile:calendar-card'), 'calendar card mobile full-width marker');
check('M5', src.includes('BC_ZOOM_MOBILE_DEFAULT') && /BC_ZOOM_MOBILE_DEFAULT\s*=\s*70/.test(src), 'calendar mobile zoom default 70%');
check('M6', src.includes('BC_ZOOM_MOBILE_MIN') && /BC_ZOOM_MOBILE_MIN\s*=\s*50/.test(src), 'calendar mobile zoom min 50%');
check('M7', src.includes('staff-portal-mobile:inbox') && src.includes('inbox-mobile-back'), 'inbox mobile list/detail/back markers');
check('M7b', /@media\(max-width:1279px\) and \(min-width:901px\)/.test(src)
  && src.includes('grid-template-columns:minmax(0,var(--inbox-col1-w))'),
  'md 4-col density grid does not apply on phone');
check('M7c', /staff-portal-mobile:inbox-chrome[\s\S]{0,2800}grid-template-columns:1fr!important/.test(src)
  && src.includes('.inbox-two-col.inbox-shell-cols:not(.show-thread){grid-template-rows:auto minmax(0,1fr)}')
  && src.includes('.inbox-two-col.inbox-shell-cols:not(.show-thread) #conv-detail{display:none}'),
  'phone inbox is one column; original 768 master/detail pair intact');
check('M8', src.includes('conv-card-mobile-dense'), 'inbox compact mobile card marker');
check('M9', src.includes('staff-portal-mobile:staff-numbers') && src.includes('swn-mobile-card'), 'staff number mobile card marker');
check('M10', src.includes('viewport-fit=cover'), 'viewport-fit=cover on main portal');
check('M11', src.includes('staff-portal-mobile:main-menu') && src.includes('#banner .nav-menu-toggle') && src.includes('display:inline-flex!important'), 'mobile hamburger forced visible on banner');

// Auth POST unchanged (no accidental route edits in this slice)
check('A1', src.includes("pathname === '/staff/auth/login'") && src.includes('handleLogin'), 'staff login POST route still present');
check('A2', src.includes("pathname === '/staff/auth/logout'") && src.includes('handleLogout'), 'staff logout POST route still present');

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

// Customers outreach drawer — mobile bottom sheet shell (slice 5)
check('C1', src.includes('customers-outreach-drawer'), 'customers outreach drawer marker');
check('C2', src.includes('staff-portal-mobile:cust-outreach'), 'customers outreach mobile CSS marker');
check('C3', src.includes('cust-bulk-check'), 'customer bulk selection checkbox marker');
check('C4', src.includes('cust-outreach-send') && src.includes('sendBtn.disabled = true'), 'outreach send button disabled shell');
check('C5', src.includes('cust-outreach-template-select') && src.includes('loadCustomerMessageTemplates'), 'outreach template picker markers');
check('C6', src.includes('cust-outreach-mode-notes') && src.includes('cust-outreach-generate'), 'outreach Luna notes generate markers');
check('C7', src.includes('cust-outreach-confirm-modal') && src.includes('updateCustomersOutreachSendButton'), 'outreach send confirmation modal markers');

// Mobile punch-list (390px pass) — CSS/JS markers
check('P1', src.includes('staff-portal-mobile:punch-list'), 'punch-list mobile marker');
check('P2', src.includes('portal-admin-bookings-td-code::before') && src.includes('grid-template-areas'), 'bookings stacked card layout at 520px');
check('P3', src.includes('financeEnsureLoadedIfEmpty'), 'finance empty-body recovery hook');
check('P4', src.includes('#tab-admin .portal-admin-subtabs') && src.includes('scroll-margin-top'), 'admin subtabs clear sticky hero');
check('P5', src.includes('.portal-schedule-ops-col-hdr span:nth-child(5){grid-column:4'), 'session card GUEST/STATUS header alignment');
check('P6', src.includes('inbox-filter-scroll') || src.includes('inbox-filters::-webkit-scrollbar'), 'inbox filter chip scroll row');
check('P7', src.includes('.ck-ribbon{overflow-x:auto') || src.includes('.ck-block{min-width:76px'), 'schedule ribbon mobile chip legibility');

console.log(`\nverify-staff-portal-mobile-layout: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
