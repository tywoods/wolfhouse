#!/usr/bin/env python3
"""Lesson groups card, ES-first i18n, full Spanish, softer light theme."""
from pathlib import Path
import json

ROOT = Path("/opt/wolfhouse/WH")
API = ROOT / "scripts/staff-query-api.js"
I18N = ROOT / "scripts/lib/staff-portal-i18n.js"
ES_SUNSET = ROOT / "scripts/lib/staff-portal-i18n-es-sunset.js"

ES_EXTRA = {
    "nav.tab.daySchedule": "Horario del día",
    "nav.tab.inbox": "Bandeja de entrada",
    "nav.tab.portalHome": "Horario",
    "nav.tab.customers": "Clientes",
    "customers.title": "Clientes",
    "customers.subtitle": "Historial de huéspedes, preferencias y clases o alquileres anteriores.",
    "customers.promo": "Recuerda a los huéspedes que vuelven: consulta clases, alquileres, preferencias y notas anteriores para reservar más rápido.",
    "customers.searchPlaceholder": "Buscar por nombre, email o teléfono",
    "customers.filter.all": "Todos",
    "customers.filter.booked": "Reservados",
    "customers.filter.needsAttention": "Requieren atención",
    "customers.empty.main": "Aún no hay clientes.",
    "customers.empty.sub": "Los perfiles aparecerán aquí cuando Luna reciba emails, WhatsApp, clases o alquileres.",
    "customers.loading": "Cargando clientes…",
    "customers.error": "No se pudieron cargar los clientes:",
    "customers.lastContact": "Último contacto",
    "customers.contact.unknown": "Teléfono/email desconocido",
    "customers.detail.select": "Selecciona un cliente para ver su historial.",
    "customers.detail.error": "No se pudieron cargar los detalles del cliente.",
    "customers.detail.phone": "Teléfono",
    "customers.detail.email": "Email",
    "customers.detail.language": "Idioma",
    "customers.detail.lastSetup": "Última configuración",
    "customers.detail.services": "Clases y alquileres anteriores",
    "customers.detail.notes": "Notas para la próxima vez",
    "customers.detail.messages": "Mensajes recientes",
    "customers.detail.handoffs": "Derivaciones abiertas",
    "customers.detail.noServices": "Sin servicios anteriores",
    "customers.detail.noNotes": "Sin notas aún",
    "customers.detail.noMessages": "Sin mensajes aún",
    "customers.detail.noHandoffs": "Sin derivaciones abiertas",
    "demoHome.schoolName": "Sunset Surf School",
    "demoHome.brand": "Luna Front Desk",
    "demoHome.subtitle": "Emails y WhatsApp de huéspedes, clases y alquileres en un solo lugar.",
    "demoHome.card.inbox.title": "Bandeja de entrada",
    "demoHome.card.inbox.zero": "0 conversaciones abiertas",
    "demoHome.card.inbox.count": "{count} conversaciones abiertas",
    "demoHome.card.inbox.helper": "Los emails y WhatsApp de huéspedes aparecerán aquí.",
    "demoHome.card.lessons.title": "Clases hoy",
    "demoHome.card.lessons.empty": "Aún no hay horarios de clases configurados.",
    "demoHome.card.rentals.title": "Alquileres hoy",
    "demoHome.card.rentals.zero": "Sin alquileres programados",
    "demoHome.card.rentals.count": "{count} alquiler(es) hoy",
    "demoHome.card.rentals.helper": "Los alquileres de tabla y neopreno aparecerán aquí.",
    "demoHome.card.attention.title": "Requiere atención",
    "demoHome.card.attention.zero": "Sin derivaciones ahora",
    "demoHome.card.attention.count": "{count} requieren atención del staff",
    "demoHome.card.attention.helper": "Luna marcará reservas poco claras, pagos y derivaciones.",
    "demoHome.schedule.title": "Horario de hoy",
    "demoHome.schedule.capacityNote": "La capacidad programada se muestra según tu configuración de Sunset.",
    "demoHome.luna.title": "En qué ayudará Luna",
    "demoHome.luna.item1": "Un solo lugar para conversaciones con huéspedes",
    "demoHome.luna.item2": "Redactar respuestas por email",
    "demoHome.luna.item3": "Organizar hilos de WhatsApp",
    "demoHome.luna.item4": "Marcar solicitudes poco claras para el staff",
    "demoHome.luna.item5": "Emails y chats — diseñado para bandeja compartida",
    "demoHome.openInbox": "Abrir bandeja",
    "demoHome.openSchedule": "Abrir horario",
    "daySchedule.title": "Horario del día",
    "daySchedule.sub": "Alquileres y clases de solo lectura para la fecha seleccionada.",
    "daySchedule.sub.surf": "Alquileres, clases y capacidad programada para la fecha seleccionada.",
    "daySchedule.date": "Fecha",
    "daySchedule.load": "Cargar",
    "daySchedule.demoSlots": "Horarios de clases (demo)",
    "daySchedule.demoSlots.surf": "Capacidad programada (vista previa)",
    "daySchedule.lessons": "Clases",
    "daySchedule.rentals": "Alquileres / material",
    "daySchedule.empty": "Sin registros de servicio para esta fecha.",
    "daySchedule.empty.surf": "Sin clases ni alquileres programados para esta fecha.",
    "daySchedule.loading": "Cargando horario…",
    "daySchedule.error": "No se pudo cargar el horario.",
    "daySchedule.readOnly": "Solo lectura — demo",
    "inbox.filter.allShared": "Todos",
    "inbox.filter.email": "Email",
    "inbox.filter.whatsapp": "WhatsApp",
    "inbox.filter.needsAttention": "Requiere atención",
    "inbox.badge.email": "Email",
    "inbox.badge.whatsapp": "WhatsApp",
    "inbox.preview.bannerTitle": "Ejemplos de vista previa",
    "inbox.preview.bannerSub": "Aún no hay mensajes en vivo — así organizará Luna.",
    "inbox.preview.exampleLabel": "Ejemplo de hilo con huésped",
    "inbox.preview.detailNote": "Este es un ejemplo de vista previa, no un mensaje real.",
    "inbox.empty.listEmail": "Ninguna conversación de email coincide con este filtro.",
    "inbox.empty.listWhatsapp": "Ninguna conversación de WhatsApp coincide con este filtro.",
    "inbox.empty.main.surf": "Aún no hay conversaciones.",
    "inbox.empty.sub.surf": "Los emails y WhatsApp de huéspedes aparecerán aquí cuando lleguen.",
    "inbox.empty.list": "Ninguna conversación requiere revisión ahora.",
    "inbox.empty.list.surf": "Aún no hay emails ni chats de huéspedes.",
    "inbox.empty.listNeedsHuman": "Ninguna conversación requiere revisión del staff.",
    "inbox.empty.listNeedsHuman.surf": "Ninguna conversación requiere atención del staff.",
    "calendar.legend.blocked": "Bloqueado",
    "calendar.block.button": "Bloquear fechas",
    "calendar.block.title": "Bloquear fechas",
    "calendar.block.disabled": "Bloqueo de fechas no disponible",
    "calendar.block.confirm": "¿Bloquear estas fechas?",
    "calendar.block.creating": "Creando bloqueo…",
    "calendar.block.success": "Fechas bloqueadas.",
    "calendar.block.failed": "No se pudo bloquear:",
    "calendar.block.actionsDisabled": "Acciones deshabilitadas durante el bloqueo",
    "schedule.card.rentalsToday": "Alquileres hoy",
    "schedule.card.wetsuitsToday": "Neoprenos",
    "schedule.card.surfboardsToday": "Tablas",
    "schedule.card.needReplyEmail": "Email sin responder",
    "schedule.card.needReplyWhatsapp": "WhatsApp sin responder",
    "schedule.view.next30": "Próximos 30 días",
    "schedule.source.luna": "Luna",
    "schedule.summary.boardShort": "tabla",
    "schedule.summary.wetsuitShort": "neopreno",
    "schedule.summary.boards": "tablas",
    "schedule.summary.wetsuits": "neoprenos",
    "schedule.status.paid": "Pagado",
    "schedule.status.pending": "Pendiente",
    "schedule.status.pendingDetail": "Pago pendiente",
    "schedule.status.unpaid": "Sin pagar",
    "schedule.source.staff": "Staff",
    "schedule.source.demo": "Demo",
    "schedule.source.ariaStaff": "Reserva del staff",
    "schedule.source.ariaLuna": "Reserva de Luna",
    "schedule.source.ariaDemo": "Reserva demo",
    "schedule.create.components": "Componentes",
    "schedule.create.componentsRequired": "Selecciona al menos un componente.",
    "schedule.create.surferCount": "Número de surfistas",
    "schedule.create.boardQty": "Cantidad de tablas",
    "schedule.create.wetsuitQty": "Cantidad de neoprenos",
    "schedule.create.dateFrom": "Desde",
    "schedule.create.dateTo": "Hasta",
    "schedule.create.lessonCategory": "Adultos (mayores de 12)",
    "schedule.drawer.source": "Origen",
    "schedule.drawer.components": "Componentes",
    "schedule.drawer.bookingCode": "Código de reserva",
    "schedule.drawer.stripeLink": "Enlace de pago",
    "schedule.drawer.stripeSoon": "Pagos en línea próximamente",
    "schedule.drawer.goConversation": "Ir a conversación",
    "schedule.drawer.conversationSoon": "Conversaciones próximamente",
    "schedule.lessons.noSlotsToday": "Sin clases programadas hoy",
    "schedule.card.lessonsToday": "Clases hoy",
    "schedule.card.seatsLeft": "Plazas libres",
    "schedule.card.lessonsWeek": "Clases esta semana",
    "schedule.card.needReply": "Sin responder",
    "schedule.card.unpaid": "Sin pagar",
    "schedule.nav.prev": "Anterior",
    "schedule.nav.today": "Hoy",
    "schedule.nav.next": "Siguiente",
    "schedule.view.day": "Día",
    "schedule.view.today": "Hoy",
    "schedule.card.unpaidPending": "Sin pagar / Pendiente",
    "schedule.card.unpaidPendingSub": "Reservas pendientes de pago",
    "schedule.type.rental": "Alquiler",
    "schedule.ops.boardTitle": "Tablero operativo de hoy",
    "schedule.ops.lessonGroup": "grupo de clases",
    "schedule.metric.lesson": "clase",
    "schedule.metric.rental": "alquiler",
    "schedule.card.lessonGroups": "Grupos de clases",
    "schedule.slot.booked": "reservados",
    "schedule.ops.lessonGroupTitle": "GRUPO DE CLASES",
    "schedule.ops.prepare": "Preparar",
    "schedule.ops.rentalPickupsToday": "Recogidas de alquiler hoy",
    "schedule.ops.rentalBoth": "Tabla + neopreno",
    "schedule.ops.rentalBoardsOnly": "Solo tablas",
    "schedule.ops.rentalWetsuitsOnly": "Solo neoprenos",
    "schedule.ops.rentalNothingScheduled": "Nada programado",
    "schedule.ops.surfboardsNeeded": "Tablas necesarias",
    "schedule.ops.wetsuitsNeeded": "Neoprenos necesarios",
    "schedule.col.qty": "Cant.",
    "schedule.col.guest": "Huésped",
    "schedule.col.equipment": "Material",
    "schedule.col.status": "Estado",
    "schedule.equipment.boardAndWetsuit": "tabla + neopreno",
    "schedule.equipment.board": "tabla",
    "schedule.equipment.wetsuit": "neopreno",
    "schedule.equipment.none": "sin material",
    "schedule.view.week": "Semana",
    "schedule.view.month": "Próximos 30 días",
    "schedule.emptyDay": "Nada programado para este día",
    "schedule.list.title": "Reservas",
    "schedule.list.empty": "Sin reservas para este rango",
    "schedule.filter.all": "Todas",
    "schedule.filter.lessons": "Clases",
    "schedule.filter.rentals": "Alquileres",
    "schedule.filter.needsReply": "Sin responder",
    "schedule.filter.unpaid": "Sin pagar",
    "schedule.col.date": "Fecha",
    "schedule.col.time": "Hora",
    "schedule.col.type": "Tipo",
    "schedule.col.details": "Detalles",
    "schedule.col.payment": "Pago",
    "schedule.col.action": "Acción",
    "schedule.type.lesson": "Clase de surf",
    "schedule.action.unpaid": "Sin pagar",
    "schedule.drawer.close": "Cerrar",
    "schedule.createBooking": "Crear reserva",
    "schedule.create.title": "Nueva reserva manual",
    "schedule.create.sub": "Crea una reserva de staff para clases o alquileres.",
    "schedule.create.guestName": "Nombre del huésped",
    "schedule.create.bookingType": "Tipo de reserva",
    "schedule.create.date": "Fecha",
    "schedule.create.time": "Hora",
    "schedule.create.lessonSlot": "Horario de clase",
    "schedule.slot.bookings": "reservas",
    "schedule.slot.surfers": "surfistas",
    "schedule.slot.fallbackNotice": "Usando horarios de clase predeterminados",
    "schedule.slot.noConfiguredTimes": "Sin horarios de clase configurados",
    "schedule.emptySlot": "Sin reservas en este horario",
    "schedule.rentals.section": "Alquileres",
    "schedule.slot.otherLessons": "Otras clases",
    "schedule.drawer.lessonSlot": "Horario de clase",
    "schedule.create.count": "Cantidad",
    "schedule.create.paymentStatus": "Estado de pago",
    "schedule.create.notes": "Notas",
    "schedule.create.needsReply": "Requiere respuesta",
    "schedule.create.submit": "Crear reserva",
    "schedule.create.cancel": "Cancelar",
    "schedule.type.boardRental": "Alquiler de tabla",
    "schedule.type.wetsuitRental": "Alquiler de neopreno",
    "schedule.badge.demo": "Reserva demo",
    "schedule.badge.manualDraft": "Borrador manual",
    "schedule.badge.dbManual": "Reserva guardada",
    "schedule.create.guestRequired": "El nombre del huésped es obligatorio.",
    "schedule.create.failed": "No se pudo crear la reserva:",
    "schedule.drawer.recordId": "ID de registro",
    "schedule.drawer.time": "Hora",
    "schedule.drawer.details": "Detalles",
    "schedule.drawer.notes": "Notas",
    "schedule.drawer.needsReply": "Requiere respuesta",
    "schedule.drawer.needsAction": "Requiere acción",
    "schedule.payment.paid": "Pagado",
    "schedule.payment.unpaid": "Sin pagar",
    "schedule.payment.pending": "Pendiente",
    "schedule.drawer.readOnly": "Solo lectura — los cambios se gestionan en la conversación o el calendario.",
    "nav.tab.admin": "Admin",
    "admin.title": "Configuración de Sunset",
    "admin.banner.readOnly": "Solo lectura — la edición se habilitará cuando los cambios de escritura estén activos.",
    "admin.banner.writesApiOnly": "Escrituras de API habilitadas",
    "admin.banner.writesApiOnlySub": "La UI de edición permanece oculta; usa la API para cambios.",
    "admin.action.apiOnlyTitle": "Edición solo por API",
    "admin.banner.writesDisabled": "Escrituras deshabilitadas en staging",
    "admin.banner.lunaNote": "Luna usa esta configuración para precios, capacidad y horarios.",
    "admin.section.prices": "Precios",
    "admin.section.capacity": "Capacidad de clases",
    "admin.section.lessonTimes": "Horarios de clases",
    "admin.section.businessInfo": "Información del negocio",
    "admin.section.changeHistory": "Historial de cambios",
    "admin.prices.notConfigured": "Sin precios configurados",
    "admin.prices.futureNote": "Los precios se gestionan en la configuración del tenant.",
    "admin.capacity.dailyDefault": "Capacidad diaria predeterminada",
    "admin.capacity.seatsPerDay": "Plazas por día",
    "admin.capacity.futureNote": "La capacidad limita cuántos surfistas pueden reservar por día.",
    "admin.lessonTimes.placeholder": "Sin horarios de clases configurados",
    "admin.lessonTimes.col.date": "Fecha",
    "admin.lessonTimes.col.time": "Hora",
    "admin.lessonTimes.col.label": "Etiqueta",
    "admin.lessonTimes.col.capacity": "Capacidad",
    "admin.business.schoolName": "Nombre de la escuela",
    "admin.business.brand": "Marca",
    "admin.business.futureNote": "Información de contacto y marca para huéspedes.",
    "admin.history.empty": "Sin cambios registrados aún",
    "admin.action.saveComingSoon": "Guardar (próximamente)",
    "admin.action.editComingSoon": "Editar (próximamente)",
    "admin.loading": "Cargando configuración…",
    "admin.error": "No se pudo cargar la configuración:",
    "admin.prices.col.category": "Categoría",
    "admin.prices.col.offering": "Servicio",
    "admin.prices.col.unit": "Unidad",
    "admin.prices.col.amount": "Importe",
    "admin.prices.col.status": "Estado",
    "admin.prices.configNote": "Precios de referencia para Luna y el portal.",
    "admin.business.timezone": "Zona horaria",
    "admin.business.source": "Fuente",
    "admin.business.staging": "Staging",
    "admin.business.stagingYes": "Sí",
    "admin.business.stagingNo": "No",
    "admin.banner.writesUiEnabled": "Edición habilitada",
    "admin.banner.writesUiEnabledSub": "Puedes editar precios, capacidad y horarios.",
    "admin.action.edit": "Editar",
    "admin.action.save": "Guardar",
    "admin.action.cancel": "Cancelar",
    "admin.edit.col.actions": "Acciones",
    "admin.edit.editing": "Editando",
    "admin.edit.displayName": "Nombre visible",
    "admin.edit.amountEur": "Importe (€)",
    "admin.edit.startTime": "Hora de inicio",
    "admin.edit.capacityInvalid": "Capacidad no válida",
    "admin.edit.amountRequired": "El importe es obligatorio",
    "admin.edit.amountInvalid": "Importe no válido",
    "admin.edit.timeInvalid": "Hora no válida",
    "admin.edit.nameRequired": "El nombre es obligatorio",
    "admin.edit.savedCapacity": "Capacidad guardada.",
    "admin.edit.savedPrice": "Precio guardado.",
    "admin.edit.savedTime": "Horario guardado.",
    "admin.edit.saveFailed": "Error al guardar:",
    "admin.history.col.when": "Cuándo",
    "admin.history.col.actor": "Actor",
    "admin.history.col.action": "Acción",
    "admin.history.col.entity": "Entidad",
}


def require(text, needle, label):
    if needle not in text:
        raise SystemExit(f"MISSING {label}")


def write_es_sunset():
    lines = [
        "'use strict';",
        "",
        "/** Sunset + portal Spanish strings — supplements staff-portal-i18n-es.js */",
        "module.exports = {",
    ]
    for k in sorted(ES_EXTRA.keys()):
        v = ES_EXTRA[k].replace("\\", "\\\\").replace("'", "\\'")
        lines.append(f"  '{k}': '{v}',")
    lines.append("};")
    ES_SUNSET.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {ES_SUNSET} ({len(ES_EXTRA)} keys)")


def patch_i18n():
    i18n = I18N.read_text(encoding="utf-8")
    if "staff-portal-i18n-es-sunset" not in i18n:
        i18n = i18n.replace(
            "const STAFF_PORTAL_ES = require('./staff-portal-i18n-es');",
            "const STAFF_PORTAL_ES_BASE = require('./staff-portal-i18n-es');\n"
            "const STAFF_PORTAL_ES_SUNSET = require('./staff-portal-i18n-es-sunset');\n"
            "const STAFF_PORTAL_ES = Object.assign({}, STAFF_PORTAL_ES_BASE, STAFF_PORTAL_ES_SUNSET);",
        )
    i18n = i18n.replace(
        " * Staff Portal UI — English / Spanish / Italian strings.",
        " * Staff Portal UI — English / Spanish strings.",
    )
    i18n = i18n.replace(
        "      if (s === 'it' || s === 'en' || s === 'es') return s;",
        "      if (s === 'en' || s === 'es') return s;",
    )
    i18n = i18n.replace("    return 'en';", "    return 'es';")
    i18n = i18n.replace(
        "    if (loc !== 'en' && loc !== 'it' && loc !== 'es') return;",
        "    if (loc !== 'en' && loc !== 'es') return;",
    )
    I18N.write_text(i18n, encoding="utf-8")
    print("patched i18n.js")


def patch_api():
    api = API.read_text(encoding="utf-8")

    OLD_ROOT = """:root{
  --cream:#F7F3EC;        /* page background */
  --surface:#FFFDFA;      /* card surface */
  --surface-soft:#FBF7F0; /* inset / muted surface */
  --sand:#E9DDCF;         /* light sand */
  --tan:#DCC8B7;          /* soft tan */
  --sage:#AFC3A3;         /* sage green */
  --olive:#8FA58E;        /* muted olive/sage */
  --dusty-blue:#B7CAD6;   /* dusty blue */
  --ocean:#95B4C7;        /* soft ocean blue */
  --teal:#C7DDD7;         /* pale teal */
  --text:#44504A;         /* main text */
  --text-2:#6B756F;       /* secondary text */
  --text-3:#97A09A;       /* muted/tertiary text */
  --border:#E6DCCD;       /* soft warm border */
  --border-soft:#EFE8DC;  /* subtle divider */
  --radius:14px;
  --radius-sm:10px;
  --radius-pill:999px;
  --shadow:0 1px 2px rgba(68,80,74,.05),0 6px 18px rgba(68,80,74,.06);
  --shadow-soft:0 1px 2px rgba(68,80,74,.04),0 3px 10px rgba(68,80,74,.04);
  --primary:#7E947D;      /* primary action (deep sage) */
  --primary-hover:#6C8268;
  --focus:#95B4C7;        /* focus ring (ocean) */
}"""

    NEW_ROOT = """:root{
  --cream:#EDE8E0;        /* warm oatmeal page — reduced glare */
  --surface:#F5F1EA;      /* soft card surface */
  --surface-soft:#EDE8E0; /* inset / muted surface */
  --sand:#E0D8CC;         /* light sand */
  --tan:#D4C9BA;          /* soft tan */
  --sage:#B8CBB0;         /* muted sage green */
  --olive:#8FA58E;        /* muted olive/sage */
  --dusty-blue:#B5C4CE;   /* dusty blue */
  --ocean:#9DB4C4;        /* soft ocean blue */
  --teal:#D0E0DA;         /* pale teal */
  --text:#4E5853;         /* main text — softer contrast */
  --text-2:#727C76;       /* secondary text */
  --text-3:#959F99;       /* muted/tertiary text */
  --border:#DDD5C9;       /* soft warm border */
  --border-soft:#E8E2D8;  /* subtle divider */
  --radius:14px;
  --radius-sm:10px;
  --radius-pill:999px;
  --shadow:0 1px 2px rgba(78,88,83,.04),0 4px 14px rgba(78,88,83,.05);
  --shadow-soft:0 1px 2px rgba(78,88,83,.03),0 2px 8px rgba(78,88,83,.04);
  --primary:#7A9279;      /* primary action (deep sage) */
  --primary-hover:#6A8268;
  --focus:#9DB4C4;        /* focus ring (ocean) */
}"""

    require(api, OLD_ROOT, "light theme")
    api = api.replace(OLD_ROOT, NEW_ROOT)

    api = api.replace(
        ".portal-schedule-ops-lesson-group{background:var(--surface);border:1px solid rgba(255,255,255,.06);",
        ".portal-schedule-ops-lesson-group{background:var(--surface);border:1px solid var(--border-soft);",
    )
    api = api.replace(
        ".portal-schedule-ops-rental-pickups{margin-top:20px;border:1px solid rgba(255,255,255,.08);",
        ".portal-schedule-ops-rental-pickups{margin-top:20px;border:1px solid var(--border-soft);",
    )
    api = api.replace(
        ".portal-schedule-card{background:var(--surface);border:1px solid rgba(255,255,255,.06);",
        ".portal-schedule-card{background:var(--surface);border:1px solid var(--border-soft);",
    )

    OLD_CARD = (
        '<div class="portal-schedule-card portal-schedule-metric-card">'
        '<div class="portal-schedule-card-label" data-i18n="schedule.card.lessonGroups">Lesson groups</div>'
        '<div class="portal-schedule-card-stat-lg" id="ps-lessons-surfers-today">…</div>'
        '<div class="portal-schedule-card-sub" id="ps-lessons-slot-sub">…</div></div>'
    )
    NEW_CARD = (
        '<div class="portal-schedule-card portal-schedule-metric-card portal-schedule-metric-card-lessons">'
        '<div class="portal-schedule-card-label" data-i18n="schedule.card.lessonGroups">Lesson groups</div>'
        '<div class="portal-schedule-lesson-times" id="ps-lessons-slot-sub">…</div></div>'
    )
    require(api, OLD_CARD, "lesson groups card")
    api = api.replace(OLD_CARD, NEW_CARD)

    INSERT_AFTER = ".portal-schedule-metric-slots .portal-schedule-metric-slot{display:block;font-weight:600}"
    NEW_CSS = """
.portal-schedule-metric-card-lessons .portal-schedule-card-label{margin-bottom:4px}
.portal-schedule-lesson-times{display:flex;flex-direction:column;gap:10px;margin-top:6px;min-height:48px}
.portal-schedule-lesson-time-row{display:flex;align-items:baseline;justify-content:space-between;gap:16px}
.portal-schedule-lesson-time{font-size:20px;font-weight:700;color:var(--text);letter-spacing:.01em;line-height:1.15}
.portal-schedule-lesson-time-count{font-size:26px;font-weight:800;color:var(--text);line-height:1;min-width:28px;text-align:right}
.portal-schedule-lesson-times-empty{font-size:13px;color:var(--text-3);line-height:1.4;padding-top:4px}"""
    if ".portal-schedule-lesson-time-row" not in api:
        require(api, INSERT_AFTER, "metric slot css anchor")
        api = api.replace(INSERT_AFTER, INSERT_AFTER + NEW_CSS)

    OLD_LANG = """  <div class="staff-lang-switch" id="staff-lang-switch" aria-label="Language">
    <button type="button" class="staff-lang-btn is-active" data-lang="en">EN</button>
    <span class="staff-lang-sep">|</span>
    <button type="button" class="staff-lang-btn" data-lang="es">ES</button>
    <span class="staff-lang-sep">|</span>
    <button type="button" class="staff-lang-btn" data-lang="it">IT</button>
  </div>"""
    NEW_LANG = """  <div class="staff-lang-switch" id="staff-lang-switch" aria-label="Language">
    <button type="button" class="staff-lang-btn is-active" data-lang="es">ES</button>
    <span class="staff-lang-sep">|</span>
    <button type="button" class="staff-lang-btn" data-lang="en">EN</button>
  </div>"""
    require(api, OLD_LANG, "lang switch")
    api = api.replace(OLD_LANG, NEW_LANG)

    OLD_LANG_LOGIN = """    <div class="staff-lang-switch-login" id="staff-lang-switch" aria-label="Language">
      <button type="button" class="staff-lang-btn-login staff-lang-btn is-active" data-lang="en">EN</button>
      <span class="staff-lang-sep-login staff-lang-sep">|</span>
      <button type="button" class="staff-lang-btn-login staff-lang-btn" data-lang="es">ES</button>
      <span class="staff-lang-sep-login staff-lang-sep">|</span>
      <button type="button" class="staff-lang-btn-login staff-lang-btn" data-lang="it">IT</button>
    </div>"""
    NEW_LANG_LOGIN = """    <div class="staff-lang-switch-login" id="staff-lang-switch" aria-label="Language">
      <button type="button" class="staff-lang-btn-login staff-lang-btn is-active" data-lang="es">ES</button>
      <span class="staff-lang-sep-login staff-lang-sep">|</span>
      <button type="button" class="staff-lang-btn-login staff-lang-btn" data-lang="en">EN</button>
    </div>"""
    require(api, OLD_LANG_LOGIN, "login lang switch")
    api = api.replace(OLD_LANG_LOGIN, NEW_LANG_LOGIN)

    OLD_BREAKDOWN = """function scheduleRenderLessonsTodayBreakdown(rows, todayIso, lessonTimes){
  var stat = el('ps-lessons-surfers-today');
  var sub = el('ps-lessons-slot-sub');
  if (!stat) return;
  var totalSurfers = scheduleLessonsSurfersToday(rows, todayIso);
  stat.textContent = String(totalSurfers);
  var slots = scheduleSlotsForDate(lessonTimes, todayIso);
  if (!slots.length) slots = scheduleUniqueConfiguredSlots(lessonTimes);
  var todayLessons = (rows || []).filter(function(r){
    return String(r.service_date || '').slice(0, 10) === todayIso && scheduleRowType(r) === 'lesson';
  });
  var subHtml = '';
  slots.forEach(function(slot){
    var stats = scheduleSlotAggregates(todayLessons, slot);
    subHtml += '<span class="portal-schedule-metric-slot">' + escHtml(scheduleNormalizeSlotTime(slot.slot_time) + ' — ' + String(stats.surfers)) + '</span>';
  });
  if (scheduleLessonTimesFallback) subHtml += '<span class="portal-schedule-metric-slot">' + escHtml(portalT('schedule.slot.fallbackNotice')) + '</span>';
  if (sub){
    sub.className = 'portal-schedule-card-sub portal-schedule-metric-slots';
    sub.innerHTML = subHtml || escHtml(portalT('schedule.lessons.noSlotsToday'));
  }
}"""

    NEW_BREAKDOWN = """function scheduleRenderLessonsTodayBreakdown(rows, todayIso, lessonTimes){
  var sub = el('ps-lessons-slot-sub');
  if (!sub) return;
  var slots = scheduleSlotsForDate(lessonTimes, todayIso);
  if (!slots.length) slots = scheduleUniqueConfiguredSlots(lessonTimes);
  var todayLessons = (rows || []).filter(function(r){
    return String(r.service_date || '').slice(0, 10) === todayIso && scheduleRowType(r) === 'lesson';
  });
  var subHtml = '';
  slots.forEach(function(slot){
    var stats = scheduleSlotAggregates(todayLessons, slot);
    subHtml += '<div class="portal-schedule-lesson-time-row">' +
      '<span class="portal-schedule-lesson-time">' + escHtml(scheduleNormalizeSlotTime(slot.slot_time)) + '</span>' +
      '<span class="portal-schedule-lesson-time-count">' + escHtml(String(stats.surfers || 0)) + '</span>' +
      '</div>';
  });
  if (scheduleLessonTimesFallback) subHtml += '<div class="portal-schedule-lesson-times-empty">' + escHtml(portalT('schedule.slot.fallbackNotice')) + '</div>';
  sub.className = 'portal-schedule-lesson-times';
  sub.innerHTML = subHtml || ('<div class="portal-schedule-lesson-times-empty">' + escHtml(portalT('schedule.lessons.noSlotsToday')) + '</div>');
}"""

    require(api, OLD_BREAKDOWN, "lesson breakdown")
    api = api.replace(OLD_BREAKDOWN, NEW_BREAKDOWN)

    API.write_text(api, encoding="utf-8")
    print("patched staff-query-api.js")


if __name__ == "__main__":
    write_es_sunset()
    patch_i18n()
    patch_api()
    print("done")
