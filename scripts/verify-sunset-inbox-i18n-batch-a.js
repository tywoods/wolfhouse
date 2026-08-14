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
  'inbox.channelControl.title': ['CHANNEL CONTROL', 'CONTROL DE CANALES'],
  'inbox.detail.lunaMode.draft': ['Draft', 'Borrador'],
  'inbox.channelControl.globalPause': ['Global Pause', 'Pausa global'],
  'customers.filter.warmLeadsTitle': ['Contacted but never booked', 'Contactado pero nunca reservó'],
  'customers.filter.hotLeadsTitle': ['Customers who have booked before', 'Clientes que ya han reservado'],
  'customers.filter.doNotContactTitle': ['Marked do not contact', 'Marcado como no contactar'],
  'customers.card.checkedIn': ['Checked in', 'CON CHECK-IN'],
  'customers.card.bookings': ['Bookings', 'RESERVAS'],
  'customers.card.classes': ['Classes', 'CLASES'],
  'customers.card.balanceDue': ['Balance due', 'SALDO PENDIENTE'],
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

const shellSrc = fs.readFileSync(require.resolve('./browser/inbox-shell'), 'utf8');
const shellContext = {
  window: {}, document: { readyState: 'loading', getElementById() { return null; }, addEventListener() {} }, localStorage: { getItem() { return null; } },
  escHtml: String, t: (key) => STAFF_PORTAL_STRINGS.es[key] || key, console,
};
vm.createContext(shellContext);
vm.runInContext(shellSrc, shellContext);
const channelHtml = shellContext.inboxShellChannelDefaultsHtml({ whatsapp: 'auto', email: 'draft' });
for (const copy of ['CONTROL DE CANALES', 'Borrador', 'Auto']) assert(channelHtml.includes(copy), `channel render: ${copy}`);
assert(!channelHtml.includes('CHANNEL AUTONOMY'));

console.log('PASS Sunset Inbox i18n Batch A translation and rendering contract');
