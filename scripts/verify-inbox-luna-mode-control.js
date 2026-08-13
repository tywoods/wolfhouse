#!/usr/bin/env node
'use strict';

/**
 * verify-inbox-luna-mode-control
 *
 * Offline gate for the Inbox thread-header Luna mode control. Proves the UI
 * maps onto existing pause / needs_human endpoints and does not fake modes
 * the send path cannot honour (no WhatsApp Draft, no Email Auto).
 *
 * Run: node scripts/verify-inbox-luna-mode-control.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');
const { lunaModeControlOptions } = require('./lib/luna-effective-mode');
const { LUNA_MODE_MODULE } = require('./lib/inbox-browser-source');

const ROOT = path.join(__dirname, '..');
const THREAD = path.join(ROOT, 'scripts/browser/inbox-thread.js');
const MODE_JS = LUNA_MODE_MODULE;
const STAFF_API = path.join(ROOT, 'scripts/staff-query-api.js');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function loadModeFns() {
  const sandbox = {
    t: (key) => key,
    escHtml: (s) => String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${read(MODE_JS)}\nthis.inboxLunaModeOptions = inboxLunaModeOptions;\nthis.inboxLunaModeFromPaused = inboxLunaModeFromPaused;\nthis.inboxLunaModeControlHtml = inboxLunaModeControlHtml;`, sandbox);
  return sandbox;
}

function sliceFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

function main() {
  console.log('\nverify-inbox-luna-mode-control — thread header Auto|Draft|Off wiring\n');

  const modeSrc = read(MODE_JS);
  const threadSrc = read(THREAD);
  const portalSrc = readStaffPortalUiSource();
  const staffSrc = read(STAFF_API);
  const fns = loadModeFns();

  console.log('[1] Channel options match the shipped send path (no faked modes)');
  assert('whatsapp options are Auto|Off',
    JSON.stringify(fns.inboxLunaModeOptions('whatsapp')) === JSON.stringify(['auto', 'off']));
  assert('email options are Draft|Off',
    JSON.stringify(fns.inboxLunaModeOptions('email')) === JSON.stringify(['draft', 'off']));
  assert('browser options match lunaModeControlOptions(whatsapp)',
    JSON.stringify([...lunaModeControlOptions('whatsapp')]) === JSON.stringify(fns.inboxLunaModeOptions('whatsapp')));
  assert('browser options match lunaModeControlOptions(email)',
    JSON.stringify([...lunaModeControlOptions('email')]) === JSON.stringify(fns.inboxLunaModeOptions('email')));
  assert('unpaused whatsapp is auto', fns.inboxLunaModeFromPaused('whatsapp', false) === 'auto');
  assert('unpaused email is draft', fns.inboxLunaModeFromPaused('email', false) === 'draft');
  assert('paused whatsapp is off', fns.inboxLunaModeFromPaused('whatsapp', true) === 'off');
  assert('paused email is off', fns.inboxLunaModeFromPaused('email', true) === 'off');

  console.log('\n[2] Rendered control HTML');
  const waOn = fns.inboxLunaModeControlHtml({ channel: 'whatsapp', paused: false, needs_human: false });
  const waOff = fns.inboxLunaModeControlHtml({ channel: 'whatsapp', paused: true, needs_human: false });
  const emDraft = fns.inboxLunaModeControlHtml({ channel: 'email', paused: false, needs_human: true });
  const emOff = fns.inboxLunaModeControlHtml({ channel: 'email', paused: true, needs_human: false });

  assert('whatsapp Auto present', /data-luna-mode="auto"/.test(waOn) && /data-luna-mode="auto"/.test(waOff));
  assert('whatsapp Off present', /data-luna-mode="off"/.test(waOn));
  assert('whatsapp has no Draft option', !/data-luna-mode="draft"/.test(waOn) && !/data-luna-mode="draft"/.test(waOff));
  assert('email Draft present', /data-luna-mode="draft"/.test(emDraft));
  assert('email Off present', /data-luna-mode="off"/.test(emDraft));
  assert('email has no Auto option', !/data-luna-mode="auto"/.test(emDraft) && !/data-luna-mode="auto"/.test(emOff));
  assert('keeps #luna-pause-switch for existing pause wiring', /id="luna-pause-switch"/.test(waOn));
  assert('keeps #conv-needs-human-toggle for existing handoff wiring', /id="conv-needs-human-toggle"/.test(waOn));
  assert('pause switch is checked when Off', /id="luna-pause-switch"[^>]*checked/.test(waOff));
  assert('pause switch is unchecked when Auto', /id="luna-pause-switch"/.test(waOn) && !/id="luna-pause-switch"[^>]*checked/.test(waOn));
  assert('Auto is selected when unpaused whatsapp', /data-luna-mode="auto"[^>]*aria-checked="true"/.test(waOn));
  assert('Off is selected when paused', /data-luna-mode="off"[^>]*aria-checked="true"/.test(waOff));
  assert('Draft is selected when unpaused email', /data-luna-mode="draft"[^>]*aria-checked="true"/.test(emDraft));
  assert('needs-human raise exists', /id="inbox-needs-human-raise"/.test(waOn));
  assert('needs-human raise is on when flagged', /id="inbox-needs-human-raise"[^>]*aria-pressed="true"/.test(emDraft));

  console.log('\n[3] Header uses the control; overlapping Pause Luna / Needs human switches gone');
  const switchesFn = sliceFn(threadSrc, 'detailHeaderSwitchesHtml');
  const headerPillsFn = sliceFn(threadSrc, 'convHeaderStatusPillsHtml');
  assert('detailHeaderSwitchesHtml calls inboxLunaModeControlHtml', /inboxLunaModeControlHtml\s*\(/.test(switchesFn));
  assert('header no longer renders Pause Luna switch label', !/inbox\.detail\.switch\.pauseLuna/.test(switchesFn));
  assert('header no longer renders Needs human switch label', !/inbox\.detail\.switch\.needsHuman/.test(switchesFn));
  assert('header pills no longer include Luna/Staff badge', !/inboxLunaStaffPill/.test(headerPillsFn));
  assert('loadConvDetail still wires pause + needs-human endpoints',
    /wireLunaPauseSwitch\s*\(/.test(threadSrc) && /wireNeedsHumanToggle\s*\(/.test(threadSrc));
  assert('loadConvDetail wires the visible mode control', /wireInboxLunaModeControl\s*\(/.test(threadSrc));
  assert('loadConvDetail wires the needs-human raise', /wireInboxNeedsHumanRaise\s*\(/.test(threadSrc));
  const demoDetail = sliceFn(threadSrc, 'loadSurfInboxDemoDetail');
  assert('demo-preview threads do not render inert Luna controls', !/detailHeaderSwitchesHtml\s*\(/.test(demoDetail));

  console.log('\n[4] Visible clicks drive existing pause / needs_human semantics');
  const modeWire = sliceFn(modeSrc, 'wireInboxLunaModeControl');
  const pauseWire = sliceFn(portalSrc, 'wireLunaPauseSwitch');
  const raiseWire = sliceFn(modeSrc, 'wireInboxNeedsHumanRaise');
  const needsWire = sliceFn(portalSrc, 'wireNeedsHumanToggle');
  assert('mode click sets #luna-pause-switch and dispatches change',
    /getAttribute\('data-luna-mode'\) === 'off'/.test(modeWire)
    && /sw\.checked = wantPaused/.test(modeWire)
    && /dispatchEvent\(new Event\('change'/.test(modeWire));
  assert('pause switch still POSTs /staff/bot/pause and /staff/bot/resume',
    /\/staff\/bot\/pause/.test(pauseWire) && /\/staff\/bot\/resume/.test(pauseWire));
  assert('pause switch still sends conversation_id', /conversation_id:\s*convId/.test(pauseWire));
  assert('pause switch still rolls back on failure', /sw\.checked = !wantPaused/.test(pauseWire));
  assert('raise click toggles #conv-needs-human-toggle and dispatches change',
    /toggle\.checked = !toggle\.checked/.test(raiseWire)
    && /dispatchEvent\(new Event\('change'/.test(raiseWire));
  assert('needs-human toggle still POSTs /needs-human',
    /\/staff\/conversations\/' \+ encodeURIComponent\(convId\) \+ '\/needs-human'/.test(needsWire)
    || /\/needs-human/.test(needsWire));

  console.log('\n[5] No new send path, migration, or luna-mode API in this slice');
  assert('control module does not fetch a new luna-mode route', !/\/staff\/inbox\/luna-mode/.test(modeSrc));
  assert('thread module does not fetch a new luna-mode route', !/\/staff\/inbox\/luna-mode/.test(threadSrc));
  assert('staff API not given a luna-mode route in this slice', !/\/staff\/inbox\/luna-mode/.test(staffSrc));
  assert('no WhatsApp draft approval write in the control', !/luna_outbound_approvals|078_luna_outbound/.test(modeSrc));
  const injector = read(path.join(ROOT, 'scripts/lib/inbox-browser-source.js'));
  assert('thread inject prepends luna-mode module',
    /getInboxLunaModeBrowserSource\(\)\s*\+\s*['"]\\n['"]\s*\+\s*readBrowserModule\(THREAD_MODULE\)/.test(injector));

  console.log(`\nverify-inbox-luna-mode-control: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main();
