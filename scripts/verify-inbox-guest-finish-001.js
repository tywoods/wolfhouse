#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const views = read('scripts/browser/inbox-views.js');
const thread = read('scripts/browser/inbox-thread.js');
const bookings = read('scripts/browser/sunset-admin-bookings-ui.js');

function ok(name, cond) {
  assert.ok(cond, name);
  console.log('ok - ' + name);
}

ok('Guest cold-load syncs preset surface before saved-view list fetch',
  /function loadInboxFromSavedView\([\s\S]*?var presetSurface = inboxViewsSyncSurfaceFromPreset\(\);[\s\S]*?inboxCurrentSurface = presetSurface;[\s\S]*?inboxSavedViewId = presetSurface === INBOX_VIEW_SURFACE_GUEST[\s\S]*?'all_people'[\s\S]*?var viewId = inboxSavedViewId/.test(views));

ok('Guest card create/open conversation switches to Full before loading thread',
  /function openInboxToConversation\(convId\)[\s\S]*?switchToTab\('conversations', 'inbox'\)[\s\S]*?inboxColumnsSetPreset\('all4', \{ immediate: true \}\)[\s\S]*?loadInbox\(convId\)/.test(thread));

ok('Bookings toolbar exposes Clear control',
  /id="admin-bookings-clear"/.test(bookings));

ok('Bookings Clear resets search, dates, dropdowns, pagination, and sorting',
  /function adminBookingsClearFilters\(\)[\s\S]*?f\.q = ''[\s\S]*?f\.date_from = ''[\s\S]*?f\.date_to = ''[\s\S]*?f\.status = ''[\s\S]*?f\.type = ''[\s\S]*?f\.offset = 0[\s\S]*?f\.sort = ''[\s\S]*?f\.dir = ''/.test(bookings));

ok('Bookings Clear reloads list from page 1',
  /var clearAllBtn = el\('admin-bookings-clear'\);[\s\S]*?adminBookingsClearFilters\(\);[\s\S]*?loadAdminBookings\(\);/.test(bookings));

console.log('verify-inbox-guest-finish-001 PASS');
