'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const extCalRoutes = require('./lib/external-calendar-inventory-routes');
const { dtoHasAuthority } = require('./lib/external-calendar-inventory-sync');

function ok(label, cond, detail) {
  if (!cond) {
    console.error('FAIL', label, detail || '');
    throw new Error(label);
  }
  console.log('  PASS ', label);
}

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

function main() {
  console.log('verify-external-calendar-inventory-ui');
  const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  const cardStart = api.indexOf('id="cc-owner-schedule-bridge"');
  const card = api.slice(cardStart, api.indexOf('id="cc-staff-whatsapp-numbers"'));

  ok('empty rest state is visible HTML', /id="osb-empty"/.test(card) && /Connect Google Sheet/.test(card));
  ok('editor and detail start hidden', /id="osb-editor" hidden/.test(card) && /id="osb-detail" hidden/.test(card));
  ok('no SECRET_REF or Bed maps JSON', !/SECRET_REF/.test(api) && !/Bed maps JSON/.test(card));
  ok('no invented browser secret name', !/EXTERNAL_CALENDAR_SHEETS_SA/.test(api));
  ok('save payload has no secret_ref', !/secret_ref:/.test(extractFn(api, 'ownerScheduleBridgeSave')));
  ok('beds load from tour-operator rooms', /\/staff\/tour-operator\/rooms\?client=/.test(api));
  ok('bed control is a select', /<select data-osb-bed/.test(api));
  ok('save maps submit bed_id from select', /bed_id: bed/.test(extractFn(api, 'ownerScheduleReadMaps')));

  ok('caller secret_ref is rejected', dtoHasAuthority({ secret_ref: 'ANY_NAME' }) === true);
  ok('empty save DTO is not authority', dtoHasAuthority({ name: 'x', spreadsheet_id: '12345678' }) === false);
  ok('route rejects secret_ref', extCalRoutes.rejectCallerAuthority({ secret_ref: 'KV_X' }).error === 'caller_authority_rejected');

  const els = {};
  function makeEl(id, tag, extras) {
    const node = {
      id,
      tagName: (tag || 'div').toUpperCase(),
      value: '',
      textContent: '',
      className: '',
      hidden: false,
      disabled: false,
      innerHTML: '',
      children: [],
      options: [],
      getAttribute(n) { return n === 'hidden' && this.hidden ? '' : null; },
      setAttribute(n, v) { if (n === 'hidden') this.hidden = true; },
      removeAttribute(n) { if (n === 'hidden') this.hidden = false; },
      appendChild(c) { this.children.push(c); if (c.tagName === 'OPTION') this.options.push(c); },
      querySelector() { return this.children[0] || null; },
      addEventListener() {},
    };
    Object.assign(node, extras || {});
    els[id] = node;
    return node;
  }
  ['osb-empty', 'osb-editor', 'osb-detail', 'osb-status', 'osb-detail-name', 'osb-detail-status',
    'osb-detail-meta', 'osb-access-hint', 'osb-enable', 'osb-probe', 'osb-sync', 'osb-connections',
    'osb-name', 'osb-sheet', 'osb-tab', 'osb-map-rows', 'osb-map-json', 'osb-out'].forEach((id) => {
    makeEl(id, id.includes('connections') ? 'select' : 'div');
  });
  els['osb-connections'].options = [{ value: '', textContent: 'Select a connection' }];

  const ctx = {
    osbSelectedId: '',
    osbView: 'rest',
    osbConnections: [],
    osbBeds: [],
    OSB_SAFE: { calendar_bridge_failed: 'fail' },
    el: (id) => els[id] || null,
    escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    document: {
      createElement(tag) {
        return { tagName: tag.toUpperCase(), value: '', textContent: '', className: '', children: [], appendChild() {}, querySelector() { return { value: '' }; } };
      },
      querySelectorAll() { return []; },
    },
    Array,
    String,
    ownerScheduleSafeCopy(code) { return code || 'fail'; },
  };
  vm.createContext(ctx);
  vm.runInContext(extractFn(api, 'ownerScheduleSetHidden'), ctx);
  vm.runInContext(extractFn(api, 'ownerSchedulePaint'), ctx);
  vm.runInContext(extractFn(api, 'ownerScheduleBedSelectHtml'), ctx);
  vm.runInContext(extractFn(api, 'ownerScheduleParseSheetId'), ctx);
  vm.runInContext(extractFn(api, 'ownerScheduleDeriveName'), ctx);

  ctx.ownerSchedulePaint();
  ok('rest hides editor and detail', els['osb-editor'].hidden === true && els['osb-detail'].hidden === true && els['osb-empty'].hidden === false);

  ctx.osbView = 'editor';
  ctx.ownerSchedulePaint();
  ok('editor shows only the connect form', els['osb-editor'].hidden === false && els['osb-empty'].hidden === true && els['osb-detail'].hidden === true);

  ctx.osbView = 'detail';
  ctx.osbSelectedId = '11111111-1111-1111-1111-111111111111';
  ctx.osbConnections = [{ id: ctx.osbSelectedId, name: 'Owner schedule · ABCDEF', status: 'disabled', has_secret: false }];
  ctx.ownerSchedulePaint();
  ok('unconfigured detail disables Check/Update', els['osb-probe'].disabled === true && els['osb-sync'].disabled === true);
  ok('unconfigured detail shows access hint', els['osb-access-hint'].hidden === false);

  ctx.osbConnections[0].has_secret = true;
  ctx.ownerSchedulePaint();
  ok('configured detail enables Check/Update', els['osb-probe'].disabled === false && els['osb-sync'].disabled === false);

  ctx.osbBeds = [
    { id: 'bed-1', label: 'R1 / A' },
    { id: 'bed-2', label: 'R2 / B' },
  ];
  const selectHtml = ctx.ownerScheduleBedSelectHtml('bed-2');
  ok('bed picker uses readable labels', /R1 \/ A/.test(selectHtml) && /R2 \/ B/.test(selectHtml));
  ok('bed picker values are canonical ids', /value="bed-1"/.test(selectHtml) && /value="bed-2" selected/.test(selectHtml));
  ok('sheet URL parser extracts id', ctx.ownerScheduleParseSheetId('https://docs.google.com/spreadsheets/d/AbC_123-xyz/edit') === 'AbC_123-xyz');

  console.log('\nverify-external-calendar-inventory-ui: ALL CHECKS PASSED');
}

main();
