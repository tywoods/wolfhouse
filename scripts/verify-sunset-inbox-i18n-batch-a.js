'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

const expected = {
  'nav.tab.inbox': ['Inbox', 'Bandeja de entrada'],
  'inbox.search.contacts': ['Search contacts', 'Buscar contactos'],
  'inbox.loading': ['Loading conversations…', 'Cargando conversaciones…'],
  'common.loading': ['Loading…', 'Cargando…'],
  'inbox.empty.main.surf': ['No conversations yet.', 'Aún no hay conversaciones.'],
  'inbox.empty.sub.surf': ['Guest emails and WhatsApp messages will appear here when they arrive.', 'Los emails y mensajes de WhatsApp de huéspedes de Sunset aparecerán aquí cuando lleguen.'],
  'customers.detail.notes': ['Notes for next time', 'NOTAS PARA LA PRÓXIMA VEZ'],
  'inbox.layout.preset.all4': ['Full', 'Completa'],
  'admin.bookings.openInSchedule': ['Open in Schedule', 'Abrir en Agenda'],
  'inbox.detail.needsHuman.raise': ['Needs human', 'Requiere personal'],
  'inbox.channelControl.title': ['LUNA AUTONOMY', 'AUTONOMÍA LUNA'],
  'inbox.detail.lunaMode.draft': ['Draft', 'Borrador'],
  'inbox.channelControl.globalPause': ['Global Pause', 'Pausa global'],
  'customers.filter.warmLeadsTitle': ['Contacted but never booked', 'Contactado pero nunca reservó'],
  'customers.filter.hotLeadsTitle': ['Customers who have booked before', 'Clientes que ya han reservado'],
  'customers.filter.doNotContactTitle': ['Marked do not contact', 'Marcado como no contactar'],
  'customers.card.checkedIn': ['Checked in', 'CON CHECK-IN'],
  'customers.card.bookings': ['Bookings', 'RESERVAS'],
  'customers.card.classes': ['Lessons', 'CLASES'],
  'customers.card.balanceDue': ['Unpaid balance', 'SALDO PENDIENTE'],
  'customers.card.waiverStatus': ['Waiver status', 'ESTADO DEL WAIVER'],
  'customers.card.lastSetup': ['Last setup', 'ÚLTIMA CONFIGURACIÓN'],
  'customers.detail.linkedBookings': ['Linked bookings', 'Reservas vinculadas'],
};
for (const [key, pair] of Object.entries(expected)) {
  assert.strictEqual(STAFF_PORTAL_STRINGS.en[key], pair[0], `EN ${key}`);
  assert.strictEqual(STAFF_PORTAL_STRINGS.es[key], pair[1], `ES ${key}`);
}
for (const key of ['inbox.detail.lunaMode.auto', 'inbox.detail.lunaMode.off', 'inbox.channelControl.on']) {
  assert.strictEqual(STAFF_PORTAL_STRINGS.es[key], key.endsWith('.auto') ? 'Auto' : key.endsWith('.off') ? 'Off' : 'On');
}

const viewsSrc = fs.readFileSync(require.resolve('./browser/inbox-views'), 'utf8');
const viewsContext = {
  escHtml: String, portalT: (key) => STAFF_PORTAL_STRINGS.es[key] || key, console,
  loadInbox() {}, pollInboxConversationListLive() {}, el() { return null; },
};
vm.createContext(viewsContext);
vm.runInContext(viewsSrc, viewsContext);
const groups = [{ id: 'inbox', label: 'INBOX' }, { id: 'needs_you', label: 'NEEDS YOU' }, { id: 'people', label: 'PEOPLE' }];
assert.deepStrictEqual(
  Array.from(groups, (g) => viewsContext.inboxViewsGroupLabel(groups, g.id)),
  ['BANDEJA', 'TE NECESITAN', 'PERSONAS']
);
const railLabels = {
  all: 'Todas', needs_human: 'Requiere personal', all_people: 'Todas las personas', checked_in: 'Con check-in',
  hot_leads: 'Clientes potenciales calientes', warm_leads: 'Clientes potenciales templados', unpaid: 'Sin pagar',
  waiver_due: 'Waiver pendiente', lesson_today: 'Clase hoy', upcoming: 'Próximas', do_not_contact: 'No contactar',
};
for (const [id, label] of Object.entries(railLabels)) assert.strictEqual(viewsContext.inboxViewsLabel({ id, label: 'BASE' }), label, id);
assert.strictEqual(viewsContext.inboxViewsLabel({ id: 'whatsapp', label: 'WhatsApp' }), 'WhatsApp');
assert.strictEqual(viewsContext.inboxViewsLabel({ id: 'email', label: 'Email' }), 'Email');
assert.strictEqual(STAFF_PORTAL_STRINGS.es['inbox.rail.view.whatsapp'], 'WhatsApp');
assert.strictEqual(STAFF_PORTAL_STRINGS.es['inbox.rail.empty'], 'No hay vistas');

const contextPath = process.env.INBOX_CONTEXT_SOURCE
  ? require('path').resolve(process.env.INBOX_CONTEXT_SOURCE)
  : require.resolve('./browser/inbox-context');
console.log(`Inbox context source: ${contextPath}`);
const contextSrc = fs.readFileSync(contextPath, 'utf8');
function renderCustomerCards(language, omittedKeys = []) {
  const omitted = new Set(omittedKeys);
  const context = {
    window: {}, document: undefined, console,
    escHtml: String,
    portalT: (key) => omitted.has(key) ? key : (STAFF_PORTAL_STRINGS[language][key] || key),
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(contextSrc, context);
  const data = {
    phone: '+340****0000', identity: { display_name: 'Test Guest' },
    bookings: [], service_records: [], waivers: [],
  };
  return [
    ['clientInfoHtml', context.__inboxContext.clientInfoHtml(data, {})],
    ['customerCondensedHtml', context.__inboxContext.customerCondensedHtml(data, {})],
  ];
}
for (const [, html] of renderCustomerCards('en')) {
  assert(html.includes('Lessons'), 'English customer card renders Lessons');
  assert(html.includes('Unpaid balance'), 'English customer card renders Unpaid balance');
}
for (const [, html] of renderCustomerCards('es')) {
  assert(html.includes('CLASES'), 'Spanish customer card renders CLASES');
  assert(html.includes('SALDO PENDIENTE'), 'Spanish customer card renders SALDO PENDIENTE');
}
const esCards = Object.fromEntries(renderCustomerCards('es'));
assert(esCards.customerCondensedHtml.includes('NOTAS PARA LA PRÓXIMA VEZ'), 'Spanish condensed card renders notes title');
assert(!esCards.customerCondensedHtml.includes('NOTES FOR NEXT TIME'), 'Spanish condensed card does not keep EN notes title');
assert(!esCards.customerCondensedHtml.includes('Notes for<br>next time'), 'Spanish notes title is not the EN break fallback');
const customerFallbackKeys = ['customers.card.classes', 'customers.card.balanceDue'];
const expectedCallSiteFallbacks = ['Lessons', 'Unpaid balance'];
for (const [renderer, html] of renderCustomerCards('en', customerFallbackKeys)) {
  for (const fallback of expectedCallSiteFallbacks) {
    assert(html.includes(fallback), `${renderer} uses exact English call-site fallback: ${fallback}`);
  }
  for (const key of customerFallbackKeys) {
    assert(!html.includes(key), `${renderer} does not render missing translation key: ${key}`);
  }
}

const shellSrc = fs.readFileSync(require.resolve('./browser/inbox-shell'), 'utf8');
function renderChannel(t) {
  const context = {
    window: {}, document: { readyState: 'loading', getElementById() { return null; }, addEventListener() {} }, localStorage: { getItem() { return null; } },
    escHtml: String, t, console,
  };
  vm.createContext(context);
  vm.runInContext(shellSrc, context);
  return context.inboxShellChannelDefaultsHtml({ whatsapp: 'auto', email: 'draft' });
}
const channelEnHtml = renderChannel((key) => STAFF_PORTAL_STRINGS.en[key] || key);
for (const copy of ['LUNA AUTONOMY', 'Draft', 'Auto']) assert(channelEnHtml.includes(copy), `English channel render: ${copy}`);
const channelEsHtml = renderChannel((key) => STAFF_PORTAL_STRINGS.es[key] || key);
for (const copy of ['AUTONOMÍA LUNA', 'Borrador', 'Auto']) assert(channelEsHtml.includes(copy), `Spanish channel render: ${copy}`);
const channelFallbackHtml = renderChannel((key) => key);
assert(channelFallbackHtml.includes('LUNA AUTONOMY'), 'missing channel title key uses the English call-site fallback');

const apiSrc = fs.readFileSync(require.resolve('./staff-query-api'), 'utf8');
assert(apiSrc.includes('if (typeof refreshInboxViewsRail === \'function\') refreshInboxViewsRail();'),
  'locale change refreshes Inbox rail');
const contextFile = fs.readFileSync(contextPath, 'utf8');
assert(contextFile.includes('function inboxCustomerNotesLabelHtml'), 'notes title uses i18n helper');
assert(!/inboxCustomerNotesFieldHtml[\s\S]{0,80}'Notes for<br>next time'/.test(contextFile)
  || contextFile.includes('inboxCustomerNotesLabelHtml()'),
  'notes field is not a hardcoded English title');

console.log('PASS Sunset Inbox i18n Batch A translation and rendering contract');
