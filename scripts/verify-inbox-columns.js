'use strict';

/**
 * verify:inbox-columns
 *
 * Contract gate for the Inbox column layout model (Inbox Phase 1).
 * Canonical rules: docs/INBOX-PORTAL-REDESIGN.md, "Column layout model".
 *
 * Everything is asserted against the *rendered* /staff/ui, through the same offline seam
 * the parity harness uses (buildUiHtmlForOfflineTest, one child process per tenant because
 * staff-query-api.js reads its config at require time). Asserting on the rendered document
 * rather than the source file means a later extraction — moving CSS or moving the module —
 * cannot quietly disarm this gate.
 *
 * What it proves:
 *   - every column state emits the documented custom property value, in CSS and in the model
 *   - grid-template-columns is composed from those properties only, with no pixel literal
 *   - the three presets set the documented combinations
 *   - the viewport buckets map to the documented states, and a manual override survives
 *     until the viewport crosses a bucket boundary
 *   - persistence is keyed by viewport bucket
 *   - the module's DOM writes are the data-col* attributes (plus data-peek) and nothing else:
 *     no element measured, no computed style read, no width assigned
 *
 * The model is executed, not grepped: the emitted module fragment is pulled out of the
 * rendered document and run in a vm against a recording fake DOM.
 *
 * Run:
 *   node scripts/verify-inbox-columns.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmp', 'inbox-columns');
const SPEC = path.join(ROOT, 'docs', 'INBOX-PORTAL-REDESIGN.md');

/** sunset exercises the surf-vertical branch; wolfhouse-somo the lodging default. */
const TENANTS = ['sunset', 'wolfhouse-somo'];

const MODULE_BEGIN = '/* ── inbox-columns model: begin';
const MODULE_END = '/* ── inbox-columns model: end';

const SHELL_RULE = '.inbox-two-col.inbox-shell-cols{';
const DESKTOP_MEDIA = '@media(min-width:901px){';
const STACK_MEDIA = '@media(max-width:900px){';
const PHONE_MEDIA = '@media(max-width:768px){';

/** The spec's own numbers. Changing one here is changing the design. */
const SPEC_WIDTHS = {
  col1: { full: '240px', icons: '56px' },
  col2: { comfortable: '360px', compact: '280px', hidden: '0px' },
  col4: { wide: '460px', peek: '300px', hidden: '0px' },
};
const SPEC_COL3_MIN = '480px';
const SPEC_PRESETS = {
  all4: { col1: 'full', col2: 'comfortable', col4: 'peek' },
  chat: { col1: 'icons', col2: 'hidden', col4: 'peek' },
  guest: { col1: 'icons', col2: 'hidden', col4: 'wide' },
};
/** Under roughly 1280px column 4 auto-collapses; under roughly 900px column 2 auto-hides. */
const SPEC_BUCKETS = [
  { width: 1920, bucket: 'lg', state: { col1: 'full', col2: 'comfortable', col4: 'peek' } },
  { width: 1280, bucket: 'lg', state: { col1: 'full', col2: 'comfortable', col4: 'peek' } },
  { width: 1279, bucket: 'md', state: { col1: 'full', col2: 'comfortable', col4: 'hidden' } },
  { width: 1024, bucket: 'md', state: { col1: 'full', col2: 'comfortable', col4: 'hidden' } },
  { width: 900, bucket: 'md', state: { col1: 'full', col2: 'comfortable', col4: 'hidden' } },
  { width: 899, bucket: 'sm', state: { col1: 'full', col2: 'hidden', col4: 'hidden' } },
  { width: 420, bucket: 'sm', state: { col1: 'full', col2: 'hidden', col4: 'hidden' } },
];

/** Reading any of these would mean the layout had moved into JavaScript. */
const FORBIDDEN_GEOMETRY = [
  'getBoundingClientRect',
  'offsetWidth',
  'offsetHeight',
  'clientWidth',
  'clientHeight',
  'scrollWidth',
  'getComputedStyle',
  'style.width',
  'style.gridTemplateColumns',
  'setProperty',
  'gridTemplateColumns',
];

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${label}${detail === undefined ? '' : `  (${detail})`}`);
  return false;
}

function section(title) {
  console.log(`\n${title}`);
}

/* ── rendering ───────────────────────────────────────────────────────────── */

function runEmit(client, dest) {
  process.env.NODE_ENV = 'test';
  process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';
  process.env.STAFF_AUTH_REQUIRED = 'false';
  process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
  process.env.DEFAULT_CLIENT_SLUG = client;
  const api = require(path.join(ROOT, 'scripts', 'staff-query-api.js'));
  if (typeof api.buildUiHtmlForOfflineTest !== 'function') {
    console.error('Production staff UI builder seam is unavailable');
    process.exit(2);
  }
  fs.writeFileSync(dest, api.buildUiHtmlForOfflineTest(0, client), 'utf8');
}

function renderTenant(client) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dest = path.join(OUT_DIR, `rendered-${client}.html`);
  const r = spawnSync(process.execPath, [__filename, '--emit', client, dest], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`render failed for ${client}: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return fs.readFileSync(dest, 'utf8');
}

/** Body of a `selector{...}` rule from the rendered stylesheet. */
function ruleBody(css, selectorWithBrace) {
  const start = css.indexOf(selectorWithBrace);
  if (start < 0) return null;
  const open = start + selectorWithBrace.length;
  const close = css.indexOf('}', open);
  if (close < 0) return null;
  return css.slice(open, close);
}

/** Body of a brace-balanced at-rule, so "is this inside the desktop media query" is checkable. */
function blockBody(css, header) {
  const start = css.indexOf(header);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start + header.length - 1; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start + header.length, i);
    }
  }
  return null;
}

/** Every block for an at-rule header, since one breakpoint can be opened more than once. */
function blockBodies(css, header) {
  const out = [];
  let from = 0;
  for (;;) {
    const start = css.indexOf(header, from);
    if (start < 0) return out;
    let depth = 0;
    let advanced = false;
    for (let i = start + header.length - 1; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push(css.slice(start + header.length, i));
          from = i + 1;
          advanced = true;
          break;
        }
      }
    }
    if (!advanced) return out;
  }
}

function declaration(body, prop) {
  const m = new RegExp(`(?:^|;)\\s*${prop.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+)`).exec(body || '');
  return m ? m[1].trim() : null;
}

/* ── recording fake DOM ──────────────────────────────────────────────────── */

function makeElement(spec) {
  const el = {
    id: spec.id || '',
    tagName: spec.tagName || 'DIV',
    selectors: spec.selectors || [],
    parent: null,
    attributes: Object.assign({}, spec.attrs),
    attributeWrites: [],
    classes: new Set(spec.classes || []),
    classWrites: [],
    listeners: {},
    styleWrites: [],
    isContentEditable: !!spec.isContentEditable,
  };
  el.style = new Proxy({}, {
    set(_t, prop, value) { el.styleWrites.push([String(prop), value]); return true; },
    get(_t, prop) { return prop === 'setProperty' ? function () { el.styleWrites.push(['setProperty']); } : ''; },
  });
  el.setAttribute = function (name, value) {
    el.attributes[name] = String(value);
    el.attributeWrites.push([name, String(value)]);
  };
  el.getAttribute = function (name) {
    return Object.prototype.hasOwnProperty.call(el.attributes, name) ? el.attributes[name] : null;
  };
  el.removeAttribute = function (name) {
    delete el.attributes[name];
    el.attributeWrites.push([name, null]);
  };
  el.classList = {
    add(name) { el.classes.add(name); el.classWrites.push(['add', name]); },
    remove(name) { el.classes.delete(name); el.classWrites.push(['remove', name]); },
    contains(name) { return el.classes.has(name); },
    toggle(name, on) {
      const next = on === undefined ? !el.classes.has(name) : !!on;
      if (next) el.classes.add(name); else el.classes.delete(name);
      el.classWrites.push(['toggle', name, next]);
      return next;
    },
  };
  el.addEventListener = function (type, fn) {
    (el.listeners[type] = el.listeners[type] || []).push(fn);
  };
  el.closest = function (selector) {
    const wanted = String(selector).split(',').map((s) => s.trim());
    let node = el;
    while (node) {
      if (node.selectors.some((s) => wanted.indexOf(s) >= 0)) return node;
      node = node.parent;
    }
    return null;
  };
  el.dispatch = function (type, event) {
    (el.listeners[type] || []).forEach((fn) => fn(event));
  };
  return el;
}

function makeHarness() {
  const store = new Map();
  const harness = { width: 1920, elements: {}, documentListeners: {}, mediaListeners: [] };

  const shell = makeElement({ id: 'inbox-shell', selectors: ['#inbox-shell'] });
  const rail = makeElement({ id: 'inbox-col1', selectors: ['#inbox-col1'] });
  const list = makeElement({ id: 'inbox-card', selectors: ['#inbox-card'] });
  const sidebar = makeElement({ id: 'inbox-detail-sidebar', selectors: ['#inbox-detail-sidebar'] });
  const panel = makeElement({ id: 'tab-conversations', classes: ['tab-panel', 'active'] });
  const composer = makeElement({ id: 'draft-textarea', tagName: 'TEXTAREA' });

  const presetBtns = Object.keys(SPEC_PRESETS).map((preset) => makeElement({
    selectors: ['[data-inbox-preset]'],
    attrs: { 'data-inbox-preset': preset },
  }));
  const toggles = ['col1', 'col2', 'col4'].map((col) => makeElement({
    selectors: ['[data-inbox-col-toggle]'],
    attrs: { 'data-inbox-col-toggle': col },
  }));
  const edges = ['col2', 'col4'].map((col) => makeElement({
    selectors: ['[data-inbox-peek-edge]'],
    attrs: { 'data-inbox-peek-edge': col },
  }));

  [rail, list, sidebar].forEach((child) => { child.parent = shell; });
  const listRow = makeElement({ selectors: ['.conv-card'] });
  listRow.parent = list;

  const byId = { 'inbox-shell': shell, 'inbox-col1': rail, 'inbox-card': list, 'tab-conversations': panel };
  const bySelectorAll = {
    '[data-inbox-preset]': presetBtns,
    '[data-inbox-col-toggle]': toggles,
    '[data-inbox-peek-edge]': edges,
  };

  const document = {
    getElementById(id) { return byId[id] || null; },
    querySelector() { return null; },
    querySelectorAll(selector) { return bySelectorAll[selector] || []; },
    addEventListener(type, fn) { (harness.documentListeners[type] = harness.documentListeners[type] || []).push(fn); },
  };

  const localStorage = {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); },
  };

  const window = {
    innerWidth: harness.width,
    addEventListener() {},
    matchMedia(query) {
      const m = /min-width:\s*(\d+)px/.exec(query);
      const min = m ? Number(m[1]) : 0;
      return {
        matches: harness.width >= min,
        addEventListener(_type, fn) { harness.mediaListeners.push(fn); },
      };
    },
  };

  Object.assign(harness, {
    shell, rail, list, sidebar, panel, composer, presetBtns, toggles, edges, listRow,
    store, document, window, localStorage,
  });
  harness.setWidth = function (width) {
    harness.width = width;
    window.innerWidth = width;
  };
  harness.dispatchDocument = function (type, event) {
    (harness.documentListeners[type] || []).forEach((fn) => fn(event));
  };
  return harness;
}

function loadModule(fragment, harness) {
  const context = {
    window: harness.window,
    document: harness.document,
    localStorage: harness.localStorage,
    console,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fragment, context, { filename: 'inbox-columns.js' });
  return harness.window.__inboxColumns;
}

function stateOf(harness) {
  return {
    col1: harness.shell.getAttribute('data-col1'),
    col2: harness.shell.getAttribute('data-col2'),
    col4: harness.shell.getAttribute('data-col4'),
  };
}

function sameState(a, b) {
  return a && b && a.col1 === b.col1 && a.col2 === b.col2 && a.col4 === b.col4;
}

/* ── the gate ────────────────────────────────────────────────────────────── */

function checkRenderedCss(client, html) {
  section(`2. Rendered CSS contract — ${client}`);

  const shellBody = ruleBody(html, SHELL_RULE);
  if (!ok('shell grid rule present in rendered CSS', !!shellBody)) return;

  const template = declaration(shellBody, 'grid-template-columns');
  ok('grid-template-columns is composed from the column custom properties',
    !!template
    && template.indexOf('var(--inbox-col1-w)') >= 0
    && template.indexOf('var(--inbox-col2-w)') >= 0
    && template.indexOf('var(--inbox-col3-min)') >= 0
    && template.indexOf('var(--inbox-col4-w)') >= 0,
    template || 'missing');
  ok('grid-template-columns carries no pixel literal (only column 3 is elastic, in CSS)',
    !!template && !/\d+px/.test(template), template || 'missing');
  ok('column 3 is the only flexible track (1fr) and keeps a floor',
    !!template && /minmax\(var\(--inbox-col3-min\),\s*1fr\)/.test(template), template || 'missing');
  ok(`column 3 floor is ${SPEC_COL3_MIN}`, declaration(shellBody, '--inbox-col3-min') === SPEC_COL3_MIN,
    declaration(shellBody, '--inbox-col3-min'));
  ok('shell declares a default for every column width property',
    ['--inbox-col1-w', '--inbox-col2-w', '--inbox-col4-w', '--inbox-col-gap']
      .every((prop) => !!declaration(shellBody, prop)));

  Object.keys(SPEC_WIDTHS).forEach((col) => {
    Object.keys(SPEC_WIDTHS[col]).forEach((state) => {
      const selector = `.inbox-two-col.inbox-shell-cols[data-${col}="${state}"]{`;
      const body = ruleBody(html, selector);
      const value = body ? declaration(body, `--inbox-${col}-w`) : null;
      ok(`${col}="${state}" emits ${SPEC_WIDTHS[col][state]}`, value === SPEC_WIDTHS[col][state], value);
    });
  });

  const desktop = blockBody(html, DESKTOP_MEDIA);
  if (!ok('desktop-only block present (mobile keeps its master/detail stack)', !!desktop)) return;
  ok('columns 3 and 4 are promoted into the shell grid with display:contents',
    /#conv-detail,[\s\S]{0,200}\.detail-layout\{display:contents\}/.test(desktop));
  ok('each column is pinned to its track by number',
    /\.inbox-col1\{grid-column:1/.test(desktop)
    && /\.inbox-left\{grid-column:2/.test(desktop)
    && /\.detail-main\{grid-column:3/.test(desktop)
    && /\.detail-sidebar\{grid-column:4/.test(desktop));
  /* .detail-sidebar carries width:280px from the pre-grid layout; the track must win. */
  ok('column 4 takes its width from the track, not from the guest card default',
    /\.detail-sidebar\{grid-column:4;grid-row:1;width:auto\}/.test(desktop));
  ok('a hidden column is taken out of view inside the desktop block only',
    /\[data-col2="hidden"\] > \.inbox-left\{display:none\}/.test(desktop)
    && /\[data-col4="hidden"\] \.detail-sidebar\{display:none\}/.test(desktop));
  ok('the gap a collapsed track would keep is compensated in CSS',
    /\[data-col2="hidden"\][\s\S]{0,220}margin-left:calc\(-1 \* var\(--inbox-col-gap\)\)/.test(desktop)
    && /\[data-col4="hidden"\][\s\S]{0,220}margin-right:calc\(-1 \* var\(--inbox-col-gap\)\)/.test(desktop));
  ok('peek-on-demand is an overlay driven by data-peek, and does not resize a track',
    /\[data-peek="col2"\] > \.inbox-left,[\s\S]{0,160}\[data-peek="col4"\] \.detail-sidebar\{opacity:1/.test(desktop)
    && /position:absolute/.test(desktop)
    && /var\(--inbox-col2-peek-w\)/.test(desktop)
    && /var\(--inbox-col4-peek-w\)/.test(desktop));
  ok('an edge strip exposes the peek for each collapsible column',
    /\[data-col2="hidden"\] > \.inbox-peek-edge-col2\{\s*display:block/.test(desktop)
    && /\[data-col4="hidden"\] > \.inbox-peek-edge-col4\{\s*display:block/.test(desktop));

  const stacked = blockBodies(html, STACK_MEDIA).join('\n');
  ok('below 901px the tracks become rows the rail cannot squeeze',
    /\.inbox-two-col\.inbox-shell-cols\{[^}]*grid-template-rows:auto minmax\(0,1fr\) minmax\(0,1fr\)/.test(stacked)
    && /\.inbox-two-col\.inbox-shell-cols\.show-thread\{grid-template-rows:minmax\(0,1fr\)\}/.test(stacked));
  const phone = blockBodies(html, PHONE_MEDIA).join('\n');
  ok('on a phone the closed thread leaves the flow, so the list keeps the shell',
    /\.inbox-shell-cols:not\(\.show-thread\)\{grid-template-rows:auto minmax\(0,1fr\)\}/.test(phone)
    && /\.inbox-shell-cols:not\(\.show-thread\) #conv-detail\{display:none\}/.test(phone));

  section(`3. Rendered markup — ${client}`);
  ok('shell carries the container id and an initial state for every column',
    /class="inbox-two-col inbox-shell-cols" id="inbox-shell" data-col1="full" data-col2="comfortable" data-col4="peek"/.test(html));
  const railStart = html.indexOf('<nav class="inbox-col1"');
  const railBody = railStart < 0 ? '' : html.slice(railStart, html.indexOf('</nav>', railStart));
  ok('column 1 is a labelled nav landmark holding the view + filter navigation',
    /<nav class="inbox-col1" id="inbox-col1"[^>]*aria-label="Inbox views"/.test(html)
    && /data-view="conversations"/.test(railBody)
    && /data-view="customers"/.test(railBody)
    && /data-inbox-filter="all"/.test(railBody)
    && /data-inbox-filter="needs-human"/.test(railBody));
  ok('preset control is a labelled group of three buttons with aria state and Alt hints',
    /class="inbox-layout-presets"[^>]*role="group"/.test(html)
    && /data-inbox-preset="all4"[^>]*aria-pressed="true"[^>]*aria-keyshortcuts="Alt\+0"/.test(html)
    && /data-inbox-preset="chat"[^>]*aria-keyshortcuts="Alt\+3"/.test(html)
    && /data-inbox-preset="guest"[^>]*aria-keyshortcuts="Alt\+4"/.test(html));
  ok('per-column toggles are labelled buttons with aria state',
    ['col1', 'col2', 'col4'].every((col) => new RegExp(`data-inbox-col-toggle="${col}"[^>]*aria-pressed="`).test(html))
    && /data-inbox-col-toggle="col1"[^>]*aria-label="/.test(html));
  ok('peek edge strips are present and hidden from assistive tech',
    /data-inbox-peek-edge="col2" aria-hidden="true"/.test(html)
    && /data-inbox-peek-edge="col4" aria-hidden="true"/.test(html));
}

function checkModel(client, html) {
  section(`4. Model executed from the rendered document — ${client}`);

  const begin = html.indexOf(MODULE_BEGIN);
  const end = html.indexOf(MODULE_END);
  if (!ok('column model fragment is present in the rendered document', begin >= 0 && end > begin)) return;
  const fragment = html.slice(begin, end);

  ok('model measures nothing: no element geometry, no computed style, no width written',
    FORBIDDEN_GEOMETRY.every((needle) => fragment.indexOf(needle) < 0),
    FORBIDDEN_GEOMETRY.filter((needle) => fragment.indexOf(needle) >= 0).join(', '));

  const harness = makeHarness();
  const api = loadModule(fragment, harness);
  if (!ok('model exposes its table and controls on window.__inboxColumns', !!api)) return;

  ok('model widths match the spec, state for state',
    JSON.stringify(api.WIDTHS) === JSON.stringify(SPEC_WIDTHS),
    JSON.stringify(api.WIDTHS));
  ok(`model column 3 floor is ${SPEC_COL3_MIN}`, api.COL3_MIN === SPEC_COL3_MIN, api.COL3_MIN);
  ok('the three presets set the documented combinations',
    JSON.stringify(api.PRESETS) === JSON.stringify(SPEC_PRESETS),
    JSON.stringify(api.PRESETS));
  ok('all four is the default preset', api.DEFAULT_PRESET === 'all4', api.DEFAULT_PRESET);
  ok('column 1 is never hidden — its collapsed state is icons',
    api.COLLAPSED.col1 === 'icons' && !api.WIDTHS.col1.hidden, JSON.stringify(api.COLLAPSED));

  SPEC_BUCKETS.forEach((row) => {
    ok(`${row.width}px is bucket ${row.bucket}`, api.bucketForWidth(row.width) === row.bucket,
      api.bucketForWidth(row.width));
  });

  harness.setWidth(1920);
  api.init();
  ok('init wires once and applies a state to the container', api.init() === true && !!stateOf(harness).col1);
  ok('default state at 1920px is 1 full, 2 comfortable, 4 peek',
    sameState(stateOf(harness), SPEC_PRESETS.all4), JSON.stringify(stateOf(harness)));

  SPEC_BUCKETS.forEach((row) => {
    ok(`${row.width}px derives ${row.state.col1}/${row.state.col2}/${row.state.col4}`,
      sameState(api.resolve(row.bucket, { preset: 'all4', overrides: {} }), row.state),
      JSON.stringify(api.resolve(row.bucket, { preset: 'all4', overrides: {} })));
  });

  section(`5. Presets, toggles, peek and persistence — ${client}`);

  harness.shell.attributeWrites.length = 0;
  api.setPreset('chat');
  ok('Chat preset: 1 icons, 2 hidden, 4 peek', sameState(stateOf(harness), SPEC_PRESETS.chat),
    JSON.stringify(stateOf(harness)));
  api.setPreset('guest');
  ok('Guest preset: 1 icons, 2 hidden, 4 wide', sameState(stateOf(harness), SPEC_PRESETS.guest),
    JSON.stringify(stateOf(harness)));
  api.setPreset('all4');
  ok('back to all four', sameState(stateOf(harness), SPEC_PRESETS.all4), JSON.stringify(stateOf(harness)));

  const written = harness.shell.attributeWrites.map((w) => w[0]);
  ok('the container only ever receives data-col1 / data-col2 / data-col4 / data-peek',
    written.every((name) => ['data-col1', 'data-col2', 'data-col4', 'data-peek'].indexOf(name) >= 0),
    written.filter((name) => ['data-col1', 'data-col2', 'data-col4', 'data-peek'].indexOf(name) < 0).join(', '));
  ok('no inline style is written anywhere in the layout path',
    [harness.shell, harness.rail, harness.list, harness.sidebar]
      .every((el) => el.styleWrites.length === 0));

  api.toggle('col2');
  ok('Alt+2 collapses column 2 from comfortable to hidden', stateOf(harness).col2 === 'hidden');
  api.toggle('col2');
  ok('toggling again restores the width it had', stateOf(harness).col2 === 'comfortable');
  api.toggle('col1');
  ok('column 1 collapses to icons, never to hidden', stateOf(harness).col1 === 'icons');
  api.toggle('col1');
  ok('column 1 restores to full', stateOf(harness).col1 === 'full');

  api.setPreset('all4');
  api.toggle('col4');
  ok('peek is refused for a column that is on screen', api.peek('col2') && !harness.shell.getAttribute('data-peek'));
  api.peek('col4');
  ok('peeking a collapsed column sets data-peek', harness.shell.getAttribute('data-peek') === 'col4');
  ok('peeking does not change any column state', stateOf(harness).col4 === 'hidden');
  api.clearPeek();
  ok('clearing the peek removes the attribute', harness.shell.getAttribute('data-peek') === null);

  api.setPreset('chat');
  api.peek('col2');
  harness.dispatchDocument('click', { target: harness.listRow });
  ok('a peeked column slides away on selection', harness.shell.getAttribute('data-peek') === null);

  section(`6. Buckets, overrides and re-derivation — ${client}`);

  harness.setWidth(1920);
  api.setPreset('all4');
  api.syncViewport();
  ok('lg keeps column 4 visible', stateOf(harness).col4 === 'peek');

  harness.setWidth(1100);
  api.syncViewport();
  ok('crossing under 1280px auto-collapses column 4', stateOf(harness).col4 === 'hidden');
  api.toggle('col4');
  ok('a manual override wins over the bucket clamp', stateOf(harness).col4 === 'peek');

  harness.setWidth(1000);
  api.syncViewport();
  ok('staying inside the bucket keeps the override', stateOf(harness).col4 === 'peek');

  harness.setWidth(1500);
  api.syncViewport();
  harness.setWidth(1000);
  api.syncViewport();
  ok('crossing a bucket boundary re-derives and drops the override', stateOf(harness).col4 === 'hidden');

  harness.setWidth(800);
  api.syncViewport();
  ok('under 900px column 2 auto-hides as well', stateOf(harness).col2 === 'hidden');

  harness.setWidth(1920);
  api.syncViewport();
  api.setPreset('guest');
  const keys = Array.from(harness.store.keys());
  ok('state persists under a key carrying the viewport bucket',
    keys.some((key) => key.indexOf(api.STORAGE_PREFIX) === 0 && /:lg$/.test(key)), keys.join(', '));
  ok('the persisted record holds the preset',
    JSON.parse(harness.store.get(api.storageKey('lg'))).preset === 'guest',
    harness.store.get(api.storageKey('lg')));

  harness.setWidth(1000);
  api.syncViewport();
  api.setPreset('chat');
  ok('each bucket keeps its own preset',
    JSON.parse(harness.store.get(api.storageKey('md'))).preset === 'chat'
    && JSON.parse(harness.store.get(api.storageKey('lg'))).preset === 'guest');
  harness.setWidth(1920);
  api.syncViewport();
  ok('returning to a bucket restores that bucket\'s preset',
    sameState(stateOf(harness), SPEC_PRESETS.guest), JSON.stringify(stateOf(harness)));

  section(`7. Keyboard — ${client}`);

  function keydown(overrides) {
    harness.dispatchDocument('keydown', Object.assign({
      altKey: false, shiftKey: false, ctrlKey: false, metaKey: false,
      key: '', code: '', target: harness.shell, preventDefault() {},
    }, overrides));
  }

  api.setPreset('all4');
  keydown({ altKey: true, code: 'Digit3', key: '3' });
  ok('Alt+3 selects the Chat preset', sameState(stateOf(harness), SPEC_PRESETS.chat), JSON.stringify(stateOf(harness)));
  keydown({ altKey: true, code: 'Digit4', key: '4' });
  ok('Alt+4 selects the Guest preset', sameState(stateOf(harness), SPEC_PRESETS.guest));
  keydown({ altKey: true, code: 'Digit0', key: '0' });
  ok('Alt+0 returns to all four', sameState(stateOf(harness), SPEC_PRESETS.all4));
  keydown({ altKey: true, code: 'Digit2', key: '2' });
  ok('Alt+2 toggles column 2 alone', stateOf(harness).col2 === 'hidden' && stateOf(harness).col1 === 'full');
  keydown({ altKey: true, code: 'Digit1', key: '1' });
  ok('Alt+1 toggles column 1 alone', stateOf(harness).col1 === 'icons');
  keydown({ altKey: true, shiftKey: true, code: 'Digit4', key: '4' });
  ok('Alt+Shift+4 toggles column 4 alone', stateOf(harness).col4 === 'hidden');

  keydown({ key: 'Escape', code: 'Escape' });
  ok('Escape exits any zoom back to all four', sameState(stateOf(harness), SPEC_PRESETS.all4));

  api.setPreset('chat');
  keydown({ altKey: true, code: 'Digit0', key: '0', target: harness.composer });
  ok('shortcuts never hijack typing in the composer', sameState(stateOf(harness), SPEC_PRESETS.chat));
  keydown({ ctrlKey: true, code: 'Digit3', key: '3' });
  ok('Ctrl is left to the browser (Chrome owns Ctrl+1..4)', sameState(stateOf(harness), SPEC_PRESETS.chat));

  harness.panel.classList.remove('active');
  keydown({ altKey: true, code: 'Digit0', key: '0' });
  ok('shortcuts are inert while another tab is open', sameState(stateOf(harness), SPEC_PRESETS.chat));
  harness.panel.classList.add('active');
}

function checkSpec() {
  section('1. Spec anchors');
  const spec = fs.readFileSync(SPEC, 'utf8');
  const start = spec.indexOf('## Column layout model');
  const end = spec.indexOf('\n## ', start + 1);
  const body = start >= 0 ? spec.slice(start, end < 0 ? spec.length : end) : '';
  ok('spec section "Column layout model" is present', !!body);
  const numbers = ['240px', '56px', '360px', '280px', '480px', '460px', '300px'];
  ok('spec still documents every width this gate enforces',
    numbers.every((n) => body.indexOf(n) >= 0),
    numbers.filter((n) => body.indexOf(n) < 0).join(', '));
  ok('spec still documents the Alt bindings and the no-drag decision',
    /Alt\+0/.test(body) && /Alt\+3/.test(body) && /Alt\+4/.test(body) && /No drag-to-resize/.test(body));
  ok('spec still documents the bucket boundaries',
    /1280px/.test(body) && /900px/.test(body));
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--emit') {
    runEmit(args[1], args[2]);
    return 0;
  }

  console.log('verify-inbox-columns  (Inbox column layout model)');
  checkSpec();
  for (const client of TENANTS) {
    const html = renderTenant(client);
    checkRenderedCss(client, html);
    checkModel(client, html);
  }

  console.log(`\n── verify:inbox-columns: ${pass} passed, ${fail} failed ──`);
  return fail ? 1 : 0;
}

process.exit(main());
