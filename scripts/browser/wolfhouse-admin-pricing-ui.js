'use strict';

/**
 * Wolfhouse (lodging) Admin > Pricing sub-tab.
 *
 * Owns `#wh-admin-pricing-body` and talks only to /staff/admin/wh/pricing.
 * Never reads Sunset admin state, config or endpoints: it has its own request
 * helper and its own `data-wh-price-action` delegation namespace so it cannot
 * collide with Sunset's global `data-admin-action` handler.
 *
 * Sections: Seasons, Packages, Rentals (incl. the full-day extension),
 * Services, Transfers, Extras (deposits + room supplements).
 *
 * Money is displayed in euros and sent as `amount_eur`; the server parses and
 * stores integer cents. Every price shows whether it is a staff edit or still
 * the shipped default, and prices are never invented client-side: a season with
 * no price renders as "Not set", not as zero.
 */
(function () {
  var WH_PRICING_CLIENT = 'wolfhouse-somo';
  var WH_PRICING_BASE = '/staff/admin/wh/pricing';
  var FULL_DAY_CODE = 'full_day_equipment_extension';

  var MONTHS = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];

  var state = {
    view: null,
    loading: false,
    busy: false,
    error: null,
    notice: null,
    editing: null,
    seasonDraft: null,
  };

  function node(id) { return document.getElementById(id); }

  function whEsc(s) {
    if (typeof escHtml === 'function') return escHtml(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function whT(key, fallback) {
    if (typeof t !== 'function') return fallback;
    var val = t(key);
    return (!val || val === key) ? fallback : val;
  }

  /** Own request helper — deliberately not Sunset's adminApiRequest. */
  function request(method, path, body) {
    var opts = {
      method: method,
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    };
    if (body != null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        return { status: r.status, data: data || {} };
      });
    });
  }

  function clientQuery() {
    return '?client=' + encodeURIComponent(WH_PRICING_CLIENT);
  }

  function eurosFromCents(cents) {
    var n = Number(cents);
    if (!Number.isFinite(n)) return '';
    return (n / 100).toFixed(2);
  }

  function moneyLabel(price) {
    if (!price || price.amount_cents == null) {
      return whT('admin.wh.pricing.notSet', 'Not set');
    }
    return '€' + eurosFromCents(price.amount_cents);
  }

  function unitLabel(unit) {
    var map = {
      per_person_per_week: whT('admin.wh.pricing.unit.week', 'per person / week'),
      per_person_per_night: whT('admin.wh.pricing.unit.ppn', 'per person / night'),
      per_room_per_night: whT('admin.wh.pricing.unit.rpn', 'per room / night'),
      per_person: whT('admin.wh.pricing.unit.person', 'per person'),
      per_day: whT('admin.wh.pricing.unit.day', 'per day'),
      per_night: whT('admin.wh.pricing.unit.night', 'per night'),
      per_booking: whT('admin.wh.pricing.unit.booking', 'per booking'),
      per_lesson: whT('admin.wh.pricing.unit.lesson', 'per lesson'),
      per_class: whT('admin.wh.pricing.unit.class', 'per class'),
      per_meal: whT('admin.wh.pricing.unit.meal', 'per meal'),
      per_stay: whT('admin.wh.pricing.unit.stay', 'per stay'),
      flat: whT('admin.wh.pricing.unit.flat', 'flat'),
    };
    return map[unit] || unit || '';
  }

  /** Shipped-default vs staff-edited, so staff can see what they have changed. */
  function sourceBadge(source) {
    if (source !== 'db') {
      return '<span class="portal-admin-price-meta">'
        + whEsc(whT('admin.wh.pricing.default', 'default')) + '</span>';
    }
    return '<span class="portal-admin-price-meta wh-price-edited">'
      + whEsc(whT('admin.wh.pricing.edited', 'edited')) + '</span>';
  }

  function humanize(code) {
    return String(code || '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function rangeLabel(r) {
    if (!r) return '';
    return MONTHS[Number(r.start_month) - 1] + ' ' + Number(r.start_day)
      + ' – ' + MONTHS[Number(r.end_month) - 1] + ' ' + Number(r.end_day);
  }

  function canWrite() {
    return !!(state.view && state.view.writes_enabled);
  }

  function isEditing(key) {
    return state.editing === key;
  }

  function monthOptions(selected) {
    var html = '';
    for (var i = 1; i <= 12; i++) {
      html += '<option value="' + i + '"' + (Number(selected) === i ? ' selected' : '') + '>'
        + whEsc(MONTHS[i - 1]) + '</option>';
    }
    return html;
  }

  function actionBtn(action, label, extraAttrs, variant) {
    return '<button type="button" class="btn ' + (variant || 'btn-ghost')
      + ' portal-admin-icon-btn" data-wh-price-action="' + whEsc(action) + '"'
      + (extraAttrs || '') + '>' + whEsc(label) + '</button>';
  }

  function pencilBtn(action, extraAttrs) {
    return '<button type="button" class="btn btn-ghost portal-admin-icon-btn portal-admin-row-edit"'
      + ' data-wh-price-action="' + whEsc(action) + '"'
      + (extraAttrs || '')
      + ' aria-label="' + whEsc(whT('admin.action.edit', 'Edit')) + '"'
      + ' title="' + whEsc(whT('admin.action.edit', 'Edit')) + '">✎</button>';
  }

  function amountField(id, cents, label) {
    return '<div class="portal-admin-edit-field"><label for="' + whEsc(id) + '">'
      + whEsc(label || whT('admin.wh.pricing.amountEur', 'Amount (€)')) + '</label>'
      + '<input type="text" id="' + whEsc(id) + '" inputmode="decimal" placeholder="0.00" value="'
      + whEsc(cents == null ? '' : eurosFromCents(cents)) + '"></div>';
  }

  function editActions(saveAction, extraAttrs, deleteHtml) {
    return '<div class="portal-admin-edit-actions">'
      + (deleteHtml || '')
      + '<button type="button" class="btn btn-ghost" data-wh-price-action="cancel">'
      + whEsc(whT('admin.action.cancel', 'Cancel')) + '</button>'
      + '<button type="button" class="btn btn-primary" data-wh-price-action="'
      + whEsc(saveAction) + '"' + (extraAttrs || '') + '>'
      + whEsc(whT('admin.action.save', 'Save')) + '</button>'
      + '</div>';
  }

  function deleteItemBtn(itemType, itemCode) {
    return actionBtn('delete-item', whT('admin.action.delete', 'Delete'),
      ' data-wh-item-type="' + whEsc(itemType)
      + '" data-wh-item-code="' + whEsc(itemCode) + '"',
      'btn-ghost portal-admin-danger portal-admin-soft-delete');
  }

  /**
   * Delete is offered only for catalog entries staff created. A config-seeded
   * item would come straight back from the JSON seed on the next load, so it is
   * labelled built-in rather than given a button that silently does nothing.
   */
  // ── Packages ───────────────────────────────────────────────────────────────

  var PACKAGE_PEBBLES = [
    { token: 'sand', label: 'Sand' },
    { token: 'clay', label: 'Clay' },
    { token: 'peach', label: 'Peach' },
    { token: 'rose', label: 'Rose' },
    { token: 'blush', label: 'Blush' },
    { token: 'butter', label: 'Butter' },
    { token: 'sage', label: 'Sage' },
    { token: 'mist', label: 'Mist' },
    { token: 'lilac', label: 'Lilac' },
    { token: 'stone', label: 'Stone' },
  ];

  function pebbleLabel(token) {
    for (var i = 0; i < PACKAGE_PEBBLES.length; i++) {
      if (PACKAGE_PEBBLES[i].token === token) return PACKAGE_PEBBLES[i].label;
    }
    return token;
  }

  function pebbleDropdownHtml(selected) {
    var current = selected || 'peach';
    var html = '<div class="portal-admin-edit-field"><span>'
      + whEsc(whT('admin.wh.pricing.pebbleColor', 'Pebble color')) + '</span>'
      + '<div class="wh-price-pebble-dd">'
      + '<input type="hidden" id="wh-price-item-pebble" value="' + whEsc(current) + '">'
      + '<button type="button" class="wh-price-pebble-dd-btn" data-wh-price-action="toggle-pebble-dd">'
      + '<span class="pkg-pebble pkg-pebble-' + whEsc(current) + '"></span>'
      + '<span class="wh-price-pebble-dd-label">' + whEsc(pebbleLabel(current)) + '</span>'
      + '</button>'
      + '<div class="wh-price-pebble-dd-menu" role="listbox">';
    for (var i = 0; i < PACKAGE_PEBBLES.length; i++) {
      var p = PACKAGE_PEBBLES[i];
      html += '<button type="button" class="pkg-pebble pkg-pebble-' + whEsc(p.token)
        + (p.token === current ? ' is-selected' : '')
        + '" data-wh-price-action="pick-pebble" data-wh-pebble="' + whEsc(p.token)
        + '" title="' + whEsc(p.label) + '">' + whEsc(p.label) + '</button>';
    }
    return html + '</div></div></div>';
  }

  function packageStayFieldsHtml(pkg) {
    var meta = (pkg && pkg.metadata) || {};
    var days = Number(pkg && pkg.min_days != null ? pkg.min_days : meta.min_days);
    if (!Number.isFinite(days) || days < 1) days = 7;
    var prorate = pkg && pkg.allow_daily_proration != null
      ? pkg.allow_daily_proration !== false
      : meta.allow_daily_proration !== false;
    return '<div class="portal-admin-edit-field"><label for="wh-price-item-min-days">'
      + whEsc(whT('admin.wh.pricing.minDays', 'Minimum days')) + '</label>'
      + '<input type="number" id="wh-price-item-min-days" min="1" max="365" value="'
      + whEsc(String(days)) + '"></div>'
      + '<label class="portal-admin-check">'
      + '<input type="checkbox" id="wh-price-item-prorate"' + (prorate ? ' checked' : '') + '> '
      + whEsc(whT('admin.wh.pricing.allowDailyProration',
        'Allow daily proration for more days'))
      + '</label>';
  }

  function packageMetaFromForm() {
    var days = parseInt(inputValue('wh-price-item-min-days'), 10);
    if (!Number.isFinite(days) || days < 1) days = 7;
    return {
      pebble: inputValue('wh-price-item-pebble') || 'stone',
      min_days: days,
      allow_daily_proration: checkboxValue('wh-price-item-prorate'),
    };
  }

  function catalogTitleActions(itemType, entry) {
    if (!canWrite()) return '';
    if (entry.source !== 'db') {
      return '<span class="portal-admin-price-meta">'
        + whEsc(whT('admin.wh.pricing.builtIn', 'built-in')) + '</span>';
    }
    if (itemType === 'package') {
      return '<div class="portal-admin-card-actions">'
        + pencilBtn('edit-package', ' data-wh-item-code="' + whEsc(entry.code) + '"')
        + '</div>';
    }
    return '';
  }

  function sectionShell(title, note, bodyHtml, headerExtra) {
    return '<section class="portal-admin-section">'
      + '<div class="portal-admin-section-hdr">'
      + '<div class="portal-admin-section-hdr-title">' + whEsc(title) + '</div>'
      + (headerExtra || '')
      + '</div>'
      + '<div class="portal-admin-section-body">'
      + (note ? '<p class="portal-admin-section-note">' + whEsc(note) + '</p>' : '')
      + bodyHtml
      + '</div></section>';
  }

  // ── Seasons ────────────────────────────────────────────────────────────────

  function renderSeasonEditForm(season) {
    var isNew = !season;
    // The draft wins while the operator is mid-edit, so Add/Remove range does
    // not snap the form back to what the server last returned.
    var s = state.seasonDraft
      || season
      || { code: '', label: '', priority: 0, bookable: true, ranges: [] };
    var ranges = s.ranges && s.ranges.length
      ? s.ranges
      : [{ start_month: 1, start_day: 1, end_month: 1, end_day: 31 }];

    var rangesHtml = '';
    for (var i = 0; i < ranges.length; i++) {
      var r = ranges[i];
      rangesHtml += '<div class="wh-price-range-row" data-wh-range-index="' + i + '">'
        + '<select data-wh-range-field="start_month">' + monthOptions(r.start_month) + '</select>'
        + '<input type="number" min="1" max="31" step="1" data-wh-range-field="start_day" value="'
        + whEsc(String(r.start_day)) + '" aria-label="Start day">'
        + '<span class="wh-price-range-sep">–</span>'
        + '<select data-wh-range-field="end_month">' + monthOptions(r.end_month) + '</select>'
        + '<input type="number" min="1" max="31" step="1" data-wh-range-field="end_day" value="'
        + whEsc(String(r.end_day)) + '" aria-label="End day">'
        + (ranges.length > 1
          ? actionBtn('remove-range', '×', ' data-wh-range-target="' + i + '"', 'btn-ghost portal-admin-danger')
          : '')
        + '</div>';
    }

    return '<div class="portal-admin-edit-form wh-price-season-form">'
      + '<div class="portal-admin-edit-field"><label for="wh-price-season-code">'
      + whEsc(whT('admin.wh.pricing.seasonCode', 'Code')) + '</label>'
      + '<input type="text" id="wh-price-season-code" value="' + whEsc(s.code)
      + '" maxlength="64" placeholder="high_summer"' + (isNew ? '' : ' readonly') + '></div>'
      + '<div class="portal-admin-edit-field"><label for="wh-price-season-label">'
      + whEsc(whT('admin.wh.pricing.seasonName', 'Name')) + '</label>'
      + '<input type="text" id="wh-price-season-label" value="' + whEsc(s.label)
      + '" maxlength="120" placeholder="High summer"></div>'
      + '<div class="portal-admin-edit-field"><label for="wh-price-season-priority">'
      + whEsc(whT('admin.wh.pricing.priority', 'Priority (higher wins overlaps)')) + '</label>'
      + '<input type="number" id="wh-price-season-priority" min="0" max="1000" step="1" value="'
      + whEsc(String(s.priority || 0)) + '"></div>'
      + '<div class="portal-admin-edit-field wh-price-check-field">'
      + '<label for="wh-price-season-bookable">'
      + whEsc(whT('admin.wh.pricing.bookable', 'Bookable')) + '</label>'
      + '<input type="checkbox" id="wh-price-season-bookable"'
      + (s.bookable === false ? '' : ' checked') + '></div>'
      + '<div class="portal-admin-edit-field wh-price-ranges-field">'
      + '<span class="portal-admin-field-label">'
      + whEsc(whT('admin.wh.pricing.dateRanges', 'Date ranges (repeat every year)')) + '</span>'
      + '<div id="wh-price-season-ranges">' + rangesHtml + '</div>'
      + actionBtn('add-range', '+ ' + whT('admin.wh.pricing.addRange', 'Add range'))
      + '</div>'
      + editActions('save-season', ' data-wh-season-code="' + whEsc(s.code) + '"',
        isNew ? '' : actionBtn('delete-season', whT('admin.action.delete', 'Delete'),
          ' data-wh-season-code="' + whEsc(s.code) + '"',
          'btn-ghost portal-admin-danger portal-admin-soft-delete'))
      + '</div>';
  }

  function renderSeasonsSection() {
    var view = state.view;
    var seasons = view.seasons || [];
    var html = '';

    if (isEditing('season:__new__')) html += renderSeasonEditForm(null);

    if (!seasons.length && !isEditing('season:__new__')) {
      html += '<p class="portal-admin-muted">'
        + whEsc(whT('admin.wh.pricing.noSeasons', 'No seasons yet.')) + '</p>';
    }

    for (var i = 0; i < seasons.length; i++) {
      var s = seasons[i];
      var key = 'season:' + s.code;
      if (isEditing(key)) {
        html += renderSeasonEditForm(s);
        continue;
      }
      var rangeText = (s.ranges || []).map(rangeLabel).join(', ');
      html += '<div class="portal-admin-price-card wh-price-season-card">'
        + '<div class="portal-admin-card-title-row">'
        + '<div><div class="portal-admin-price-title">' + whEsc(s.label || humanize(s.code))
        + (s.bookable === false
          ? ' <span class="wh-price-closed-pill">'
            + whEsc(whT('admin.wh.pricing.closed', 'closed')) + '</span>'
          : '')
        + '</div>'
        + '<div class="portal-admin-price-meta">' + whEsc(rangeText || '—')
        + ' · ' + whEsc(whT('admin.wh.pricing.priorityShort', 'priority'))
        + ' ' + whEsc(String(s.priority || 0))
        + ' · ' + sourceBadge(s.source) + '</div></div>'
        + (canWrite()
          ? '<div class="portal-admin-card-actions">'
            + pencilBtn('edit-season', ' data-wh-season-code="' + whEsc(s.code) + '"')
            + '</div>'
          : '')
        + '</div></div>';
    }

    var headerExtra = canWrite() && !isEditing('season:__new__')
      ? actionBtn('new-season', '+ ' + whT('admin.wh.pricing.addSeason', 'Add season'))
      : '';

    return sectionShell(
      whT('admin.wh.pricing.seasons', 'Seasons'),
      whT('admin.wh.pricing.seasonsNote',
        'Seasons repeat every year. Dates outside every season cannot be quoted and hand off to staff.'),
      html,
      headerExtra,
    );
  }

  // ── Packages ───────────────────────────────────────────────────────────────

  function renderPackagesSection() {
    var packages = state.view.packages || [];
    var html = '';
    if (isEditing('item:package:__new__')) html += renderNewItemForm('package');

    if (!packages.length && !isEditing('item:package:__new__')) {
      html += '<p class="portal-admin-muted">'
        + whEsc(whT('admin.wh.pricing.noPackages', 'No packages configured.')) + '</p>';
    }

    for (var i = 0; i < packages.length; i++) {
      var p = packages[i];
      var pkgEditKey = 'item:package:' + p.code;
      html += '<div class="portal-admin-subsection">';
      if (isEditing(pkgEditKey)) {
        html += '<div class="portal-admin-edit-form">'
          + '<div class="portal-admin-edit-field"><label for="wh-price-item-label">'
          + whEsc(whT('admin.wh.pricing.itemName', 'Name')) + '</label>'
          + '<input type="text" id="wh-price-item-label" maxlength="120" value="'
          + whEsc(p.label || humanize(p.code)) + '"></div>'
          + pebbleDropdownHtml(p.pebble)
          + packageStayFieldsHtml(p)
          + editActions('save-package-item', ' data-wh-item-code="' + whEsc(p.code) + '"',
            p.source === 'db' ? deleteItemBtn('package', p.code) : '')
          + '</div>';
      } else {
        html += '<div class="portal-admin-subsection-title-row">'
          + '<div class="portal-admin-subsection-title">'
          + '<span class="pkg-pebble pkg-pebble-' + whEsc(p.pebble || 'stone') + '"></span> '
          + whEsc(p.label || humanize(p.code))
          + '<span class="portal-admin-price-meta"> · '
          + whEsc(String(p.min_days || 7)) + ' '
          + whEsc(whT('admin.wh.pricing.days', 'days'))
          + (p.allow_daily_proration === false
            ? ''
            : ' · ' + whEsc(whT('admin.wh.pricing.prorates', 'prorates')))
          + '</span>'
          + '</div>'
          + catalogTitleActions('package', p)
          + '</div>';
      }
      html += '<div class="portal-admin-card-grid">';

      for (var j = 0; j < (p.prices || []).length; j++) {
        var slot = p.prices[j];
        var key = 'price:package:' + p.code + ':' + slot.season_code;
        if (isEditing(key)) {
          html += '<div class="portal-admin-price-card is-editing">'
            + '<div class="portal-admin-price-title">' + whEsc(slot.season_label || slot.season_code)
            + '</div>'
            + amountField('wh-price-amount', slot.price ? slot.price.amount_cents : null)
            + editActions('save-package-price',
              ' data-wh-package="' + whEsc(p.code) + '" data-wh-season="' + whEsc(slot.season_code) + '"')
            + '</div>';
          continue;
        }
        html += '<div class="portal-admin-price-card'
          + (slot.bookable === false ? ' wh-price-card-closed' : '') + '">'
          + '<div class="portal-admin-price-card-main">'
          + '<div><div class="portal-admin-price-title">'
          + whEsc(slot.season_label || slot.season_code) + '</div>'
          + '<div class="portal-admin-price-meta">'
          + (slot.price ? whEsc(unitLabel(slot.price.unit)) + ' · ' + sourceBadge(slot.price.source)
            : whEsc(whT('admin.wh.pricing.noPrice', 'no price')))
          + '</div></div>'
          + '<div class="portal-admin-price-amount">' + whEsc(moneyLabel(slot.price)) + '</div>'
          + '</div>'
          + (canWrite()
            ? '<div class="portal-admin-card-actions">'
              + pencilBtn('edit-package-price',
                ' data-wh-package="' + whEsc(p.code) + '" data-wh-season="' + whEsc(slot.season_code) + '"')
              + '</div>'
            : '')
          + '</div>';
      }
      html += '</div></div>';
    }

    var headerExtra = canWrite() && !isEditing('item:package:__new__')
      ? actionBtn('new-item', '+ ' + whT('admin.wh.pricing.addPackage', 'Add package'),
        ' data-wh-item-type="package"')
      : '';

    return sectionShell(
      whT('admin.wh.pricing.packages', 'Packages'),
      whT('admin.wh.pricing.packagesNote',
        'Weekly price per person, set per season. A season left unset cannot be quoted.'),
      html,
      headerExtra,
    );
  }

  // ── Catalog sections (rentals + services) ──────────────────────────────────

  function slugFromLabel(label, fallback) {
    var slug = String(label || '').toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64);
    return slug || fallback || 'item';
  }

  function renderNewItemForm(itemType) {
    // A package carries one price per season, so it is created empty and priced
    // from the season cards it gains — there is no single amount to ask for here.
    var isPackage = itemType === 'package';
    var namePh = itemType === 'package' ? 'Malibu' : (itemType === 'rental' ? 'Longboard' : 'Yoga class');
    var unitOptions = itemType === 'rental'
      ? ['per_day', 'per_stay', 'flat']
      : ['per_day', 'per_class', 'per_lesson', 'per_meal', 'per_person', 'per_stay'];
    var opts = '';
    for (var i = 0; i < unitOptions.length; i++) {
      opts += '<option value="' + whEsc(unitOptions[i]) + '">'
        + whEsc(unitLabel(unitOptions[i])) + '</option>';
    }
    return '<div class="portal-admin-edit-form">'
      + '<div class="portal-admin-edit-field"><label for="wh-price-item-label">'
      + whEsc(whT('admin.wh.pricing.itemName', 'Name')) + '</label>'
      + '<input type="text" id="wh-price-item-label" maxlength="120" placeholder="'
      + whEsc(namePh) + '"></div>'
      + (isPackage
        ? pebbleDropdownHtml()
          + packageStayFieldsHtml(null)
          + '<p class="portal-admin-section-note">'
          + whEsc(whT('admin.wh.pricing.newPackageNote',
            'Set a weekly price for each season once the package is created.')) + '</p>'
        : '<div class="portal-admin-edit-field"><label for="wh-price-item-unit">'
          + whEsc(whT('admin.wh.pricing.chargedPer', 'Charged per')) + '</label>'
          + '<select id="wh-price-item-unit">' + opts + '</select></div>'
          + amountField('wh-price-item-amount', null))
      + editActions('save-new-item', ' data-wh-item-type="' + whEsc(itemType) + '"')
      + '</div>';
  }

  function renderRentalsSection() {
    var rentals = state.view.rentals || [];
    var html = '';
    if (isEditing('item:rental:__new__')) html += renderNewItemForm('rental');

    if (!rentals.length && !isEditing('item:rental:__new__')) {
      html += '<p class="portal-admin-muted">'
        + whEsc(whT('admin.wh.pricing.noRentals', 'No rental items yet.')) + '</p>';
    }

    for (var i = 0; i < rentals.length; i++) {
      var r = rentals[i];
      html += '<div class="portal-admin-subsection">'
        + '<div class="portal-admin-subsection-title-row">'
        + '<div class="portal-admin-subsection-title">' + whEsc(r.label || humanize(r.code))
        + '</div>'
        + catalogTitleActions('rental', r)
        + (!(r.durations || []).length && r.source === 'db' && canWrite()
          ? '<div class="portal-admin-card-actions">' + deleteItemBtn('rental', r.code) + '</div>'
          : '')
        + '</div><div class="portal-admin-card-grid">';

      if (!(r.durations || []).length) {
        html += '<p class="portal-admin-muted">'
          + whEsc(whT('admin.wh.pricing.noPriceYet', 'No price set yet.')) + '</p>';
      }
      for (var j = 0; j < (r.durations || []).length; j++) {
        var d = r.durations[j];
        var key = 'price:rental:' + d.item_code;
        if (isEditing(key)) {
          html += '<div class="portal-admin-price-card is-editing">'
            + '<div class="portal-admin-price-title">' + whEsc(humanize(d.duration)) + '</div>'
            + amountField('wh-price-amount', d.amount_cents)
            + editActions('save-rental-price',
              ' data-wh-item-code="' + whEsc(d.item_code) + '" data-wh-unit="' + whEsc(d.unit) + '"',
              r.source === 'db' ? deleteItemBtn('rental', r.code) : '')
            + '</div>';
          continue;
        }
        html += '<div class="portal-admin-price-card">'
          + '<div class="portal-admin-price-card-main">'
          + '<div><div class="portal-admin-price-title">' + whEsc(humanize(d.duration)) + '</div>'
          + '<div class="portal-admin-price-meta">' + whEsc(unitLabel(d.unit)) + ' · '
          + sourceBadge(d.source) + '</div></div>'
          + '<div class="portal-admin-price-amount">€' + whEsc(eurosFromCents(d.amount_cents))
          + '</div></div>'
          + (canWrite()
            ? '<div class="portal-admin-card-actions">'
              + pencilBtn('edit-rental-price', ' data-wh-item-code="' + whEsc(d.item_code) + '"')
              + '</div>'
            : '')
          + '</div>';
      }
      html += '</div></div>';
    }

    html += renderFullDaySubsection();

    var headerExtra = canWrite() && !isEditing('item:rental:__new__')
      ? actionBtn('new-item', '+ ' + whT('admin.wh.pricing.addRental', 'Add rental'),
        ' data-wh-item-type="rental"')
      : '';

    return sectionShell(
      whT('admin.wh.pricing.rentals', 'Rentals'),
      whT('admin.wh.pricing.rentalsNote', 'Gear hire prices, plus the optional full-day extension.'),
      html,
      headerExtra,
    );
  }

  /**
   * Full-day extension is a standalone add-on rather than a rental duration:
   * it extends whatever gear the guest already has for the rest of the day.
   */
  function renderFullDaySubsection() {
    var addons = (state.view.extras && state.view.extras.addons) || [];
    var fullDay = null;
    for (var i = 0; i < addons.length; i++) {
      if (addons[i].code === FULL_DAY_CODE) fullDay = addons[i];
    }
    var key = 'price:addon:' + FULL_DAY_CODE;
    var body;
    if (isEditing(key)) {
      body = '<div class="portal-admin-price-card is-editing">'
        + amountField('wh-price-amount', fullDay ? fullDay.amount_cents : null)
        + editActions('save-full-day')
        + '</div>';
    } else {
      body = '<div class="portal-admin-price-card">'
        + '<div class="portal-admin-price-card-main">'
        + '<div><div class="portal-admin-price-title">'
        + whEsc(whT('admin.wh.pricing.fullDay', 'Full-day extension')) + '</div>'
        + '<div class="portal-admin-price-meta">'
        + whEsc(unitLabel('per_day'))
        + (fullDay ? ' · ' + sourceBadge(fullDay.source) : '')
        + '</div></div>'
        + '<div class="portal-admin-price-amount">' + whEsc(moneyLabel(fullDay)) + '</div>'
        + '</div>'
        + (canWrite()
          ? '<div class="portal-admin-card-actions">'
            + pencilBtn('edit-full-day')
            + '</div>'
          : '')
        + '</div>';
    }
    return '<div class="portal-admin-subsection">'
      + '<div class="portal-admin-subsection-title-row">'
      + '<div class="portal-admin-subsection-title">'
      + whEsc(whT('admin.wh.pricing.fullDaySection', 'Full day')) + '</div></div>'
      + '<div class="portal-admin-card-grid">' + body + '</div></div>';
  }

  function renderServicesSection() {
    var services = state.view.services || [];
    var html = '';
    if (isEditing('item:service:__new__')) html += renderNewItemForm('service');

    if (!services.length && !isEditing('item:service:__new__')) {
      html += '<p class="portal-admin-muted">'
        + whEsc(whT('admin.wh.pricing.noServices', 'No services yet.')) + '</p>';
    }

    html += '<div class="portal-admin-card-grid">';
    for (var i = 0; i < services.length; i++) {
      var s = services[i];
      var key = 'price:service:' + s.code;
      if (isEditing(key)) {
        html += '<div class="portal-admin-price-card is-editing">'
          + '<div class="portal-admin-price-title">' + whEsc(s.label || humanize(s.code)) + '</div>'
          + amountField('wh-price-amount', s.price ? s.price.amount_cents : null)
          + editActions('save-service-price',
            ' data-wh-item-code="' + whEsc(s.code) + '" data-wh-unit="'
            + whEsc(s.price ? s.price.unit : 'per_stay') + '"',
            s.source === 'db' ? deleteItemBtn('service', s.code) : '')
          + '</div>';
        continue;
      }
      html += '<div class="portal-admin-price-card">'
        + '<div class="portal-admin-price-card-main">'
        + '<div><div class="portal-admin-price-title">' + whEsc(s.label || humanize(s.code))
        + '</div><div class="portal-admin-price-meta">'
        + (s.price ? whEsc(unitLabel(s.price.unit)) + ' · ' + sourceBadge(s.price.source)
          : whEsc(whT('admin.wh.pricing.noPrice', 'no price')))
        + '</div></div>'
        + '<div class="portal-admin-price-amount">' + whEsc(moneyLabel(s.price)) + '</div>'
        + '</div>'
        + (canWrite()
          ? '<div class="portal-admin-card-actions">'
            + pencilBtn('edit-service-price', ' data-wh-item-code="' + whEsc(s.code) + '"')
            + '</div>'
          : '')
        + '</div>';
    }
    html += '</div>';

    var headerExtra = canWrite() && !isEditing('item:service:__new__')
      ? actionBtn('new-item', '+ ' + whT('admin.wh.pricing.addService', 'Add service'),
        ' data-wh-item-type="service"')
      : '';

    return sectionShell(
      whT('admin.wh.pricing.services', 'Services'),
      whT('admin.wh.pricing.servicesNote', 'Yoga, meals and other extras guests can add.'),
      html,
      headerExtra,
    );
  }

  // ── Transfers ──────────────────────────────────────────────────────────────

  function renderTransferEditForm(tr) {
    var isNew = !tr;
    var v = tr || {
      airport_code: '', label: '', requires_package: false, included_when_package: false,
      min_guest_count: null, unavailable_no_package_message: '',
      unavailable_below_min_group_message: '', price: null,
    };
    var unit = (v.price && v.price.unit) || 'flat';
    return '<div class="portal-admin-edit-form wh-price-transfer-form">'
      + '<div class="portal-admin-edit-field"><label for="wh-price-transfer-code">'
      + whEsc(whT('admin.wh.pricing.airportCode', 'Airport code')) + '</label>'
      + '<input type="text" id="wh-price-transfer-code" maxlength="3" placeholder="SDR" value="'
      + whEsc(v.airport_code) + '"' + (isNew ? '' : ' readonly') + '></div>'
      + '<div class="portal-admin-edit-field"><label for="wh-price-transfer-label">'
      + whEsc(whT('admin.wh.pricing.airportName', 'Airport name')) + '</label>'
      + '<input type="text" id="wh-price-transfer-label" maxlength="120" value="'
      + whEsc(v.label) + '"></div>'
      + '<div class="portal-admin-edit-field"><label for="wh-price-transfer-unit">'
      + whEsc(whT('admin.wh.pricing.chargedPer', 'Charged per')) + '</label>'
      + '<select id="wh-price-transfer-unit">'
      + '<option value="flat"' + (unit === 'flat' ? ' selected' : '') + '>'
      + whEsc(unitLabel('flat')) + '</option>'
      + '<option value="per_person"' + (unit === 'per_person' ? ' selected' : '') + '>'
      + whEsc(unitLabel('per_person')) + '</option>'
      + '</select></div>'
      + amountField('wh-price-transfer-amount', v.price ? v.price.amount_cents : null)
      + '<div class="portal-admin-edit-field wh-price-check-field">'
      + '<label for="wh-price-transfer-requires">'
      + whEsc(whT('admin.wh.pricing.requiresPackage', 'Package required')) + '</label>'
      + '<input type="checkbox" id="wh-price-transfer-requires"'
      + (v.requires_package ? ' checked' : '') + '></div>'
      + '<div class="portal-admin-edit-field wh-price-check-field">'
      + '<label for="wh-price-transfer-included">'
      + whEsc(whT('admin.wh.pricing.includedWithPackage', 'Included with a package')) + '</label>'
      + '<input type="checkbox" id="wh-price-transfer-included"'
      + (v.included_when_package ? ' checked' : '') + '></div>'
      + '<div class="portal-admin-edit-field"><label for="wh-price-transfer-min">'
      + whEsc(whT('admin.wh.pricing.minGroup', 'Minimum group size')) + '</label>'
      + '<input type="number" id="wh-price-transfer-min" min="1" max="99" step="1" value="'
      + whEsc(v.min_guest_count == null ? '' : String(v.min_guest_count)) + '"></div>'
      + '<div class="portal-admin-edit-field wh-price-wide-field">'
      + '<label for="wh-price-transfer-msg-package">'
      + whEsc(whT('admin.wh.pricing.msgNoPackage', 'Message when no package (shown to guests)'))
      + '</label>'
      + '<input type="text" id="wh-price-transfer-msg-package" maxlength="300" value="'
      + whEsc(v.unavailable_no_package_message || '') + '"></div>'
      + '<div class="portal-admin-edit-field wh-price-wide-field">'
      + '<label for="wh-price-transfer-msg-group">'
      + whEsc(whT('admin.wh.pricing.msgBelowMin', 'Message when group too small (shown to guests)'))
      + '</label>'
      + '<input type="text" id="wh-price-transfer-msg-group" maxlength="300" value="'
      + whEsc(v.unavailable_below_min_group_message || '') + '"></div>'
      + editActions('save-transfer', ' data-wh-airport="' + whEsc(v.airport_code) + '"',
        isNew ? '' : actionBtn('delete-transfer', whT('admin.action.delete', 'Delete'),
          ' data-wh-airport="' + whEsc(v.airport_code) + '"',
          'btn-ghost portal-admin-danger portal-admin-soft-delete'))
      + '</div>';
  }

  function renderTransfersSection() {
    var transfers = state.view.transfers || [];
    var html = '';
    if (isEditing('transfer:__new__')) html += renderTransferEditForm(null);

    if (!transfers.length && !isEditing('transfer:__new__')) {
      html += '<p class="portal-admin-muted">'
        + whEsc(whT('admin.wh.pricing.noTransfers', 'No airports configured.')) + '</p>';
    }

    for (var i = 0; i < transfers.length; i++) {
      var tr = transfers[i];
      var key = 'transfer:' + tr.airport_code;
      if (isEditing(key)) {
        html += renderTransferEditForm(tr);
        continue;
      }
      var facts = [];
      if (tr.requires_package) {
        facts.push(whT('admin.wh.pricing.requiresPackageShort', 'package required'));
      }
      if (tr.included_when_package) {
        facts.push(whT('admin.wh.pricing.includedShort', 'included with package'));
      }
      if (tr.min_guest_count) {
        facts.push(whT('admin.wh.pricing.minGroupShort', 'min group') + ' ' + tr.min_guest_count);
      }
      html += '<div class="portal-admin-price-card">'
        + '<div class="portal-admin-price-card-main">'
        + '<div><div class="portal-admin-price-title">'
        + whEsc(tr.label || tr.airport_code) + ' (' + whEsc(tr.airport_code) + ')</div>'
        + '<div class="portal-admin-price-meta">'
        + (tr.price ? whEsc(unitLabel(tr.price.unit)) + ' · ' + sourceBadge(tr.price.source)
          : whEsc(whT('admin.wh.pricing.noPrice', 'no price')))
        + (facts.length ? ' · ' + whEsc(facts.join(' · ')) : '')
        + '</div></div>'
        + '<div class="portal-admin-price-amount">' + whEsc(moneyLabel(tr.price)) + '</div>'
        + '</div>'
        + (canWrite()
          ? '<div class="portal-admin-card-actions">'
            + pencilBtn('edit-transfer', ' data-wh-airport="' + whEsc(tr.airport_code) + '"')
            + '</div>'
          : '')
        + '</div>';
    }

    var headerExtra = canWrite() && !isEditing('transfer:__new__')
      ? actionBtn('new-transfer', '+ ' + whT('admin.wh.pricing.addAirport', 'Add airport'))
      : '';

    return sectionShell(
      whT('admin.wh.pricing.transfers', 'Transfers'),
      whT('admin.wh.pricing.transfersNote',
        'Airport pickups. Refusal messages are shown to guests, so keep them friendly.'),
      html,
      headerExtra,
    );
  }

  // ── Extras (deposits + room supplements) ───────────────────────────────────

  function depositScopeRadiosHtml(selected) {
    var scope = selected === 'per_person' ? 'per_person' : 'per_booking';
    return '<div class="portal-admin-edit-field wh-price-scope">'
      + '<span>' + whEsc(whT('admin.wh.pricing.depositScope', 'Deposit is')) + '</span>'
      + '<div class="wh-price-scope-opts">'
      + '<label class="portal-admin-radio"><input type="radio" name="wh-deposit-scope" value="per_booking"'
      + (scope !== 'per_person' ? ' checked' : '') + '> '
      + whEsc(whT('admin.wh.pricing.perBooking', 'Per booking')) + '</label>'
      + '<label class="portal-admin-radio"><input type="radio" name="wh-deposit-scope" value="per_person"'
      + (scope === 'per_person' ? ' checked' : '') + '> '
      + whEsc(whT('admin.wh.pricing.perPerson', 'Per person')) + '</label>'
      + '</div></div>';
  }

  function renderNewExtraForm() {
    return '<div class="portal-admin-edit-form wh-price-extra-form">'
      + '<div class="portal-admin-edit-field"><label for="wh-price-extra-kind">'
      + whEsc(whT('admin.wh.pricing.extraType', 'Type')) + '</label>'
      + '<select id="wh-price-extra-kind">'
      + '<option value="deposit">' + whEsc(whT('admin.wh.pricing.deposits', 'Deposits')) + '</option>'
      + '<option value="supplement">' + whEsc(whT('admin.wh.pricing.supplements', 'Room supplements')) + '</option>'
      + '</select></div>'
      + '<div class="portal-admin-edit-field"><label for="wh-price-item-label">'
      + whEsc(whT('admin.wh.pricing.itemName', 'Name')) + '</label>'
      + '<input type="text" id="wh-price-item-label" maxlength="120" placeholder="'
      + whEsc(whT('admin.wh.pricing.extraNamePh', 'Standard deposit')) + '"></div>'
      + amountField('wh-price-item-amount', null)
      + depositScopeRadiosHtml('per_booking')
      + '<div class="portal-admin-edit-field wh-price-extra-sup"><label for="wh-price-item-unit">'
      + whEsc(whT('admin.wh.pricing.chargedPer', 'Charged per')) + '</label>'
      + '<select id="wh-price-item-unit">'
      + '<option value="per_room_per_night">' + whEsc(unitLabel('per_room_per_night')) + '</option>'
      + '<option value="per_person_per_night">' + whEsc(unitLabel('per_person_per_night')) + '</option>'
      + '</select></div>'
      + editActions('save-new-extra')
      + '</div>';
  }

  function renderExtrasRow(kind, row) {
    var key = 'price:' + kind + ':' + row.code;
    if (isEditing(key)) {
      var scopeUnit = row.unit === 'per_person' ? 'per_person' : (row.unit || 'per_booking');
      return '<div class="portal-admin-price-card is-editing">'
        + '<div class="portal-admin-price-title">' + whEsc(row.label || humanize(row.code)) + '</div>'
        + amountField('wh-price-amount', row.amount_cents)
        + (kind === 'deposit' ? depositScopeRadiosHtml(scopeUnit) : '')
        + editActions('save-extra',
          ' data-wh-extra-kind="' + whEsc(kind) + '" data-wh-item-code="' + whEsc(row.code)
          + '" data-wh-unit="' + whEsc(row.unit) + '"',
          row.source === 'db' ? deleteItemBtn(kind, row.code) : '')
        + '</div>';
    }
    return '<div class="portal-admin-price-card">'
      + '<div class="portal-admin-price-card-main">'
      + '<div><div class="portal-admin-price-title">' + whEsc(row.label || humanize(row.code)) + '</div>'
      + '<div class="portal-admin-price-meta">' + whEsc(unitLabel(row.unit)) + ' · '
      + sourceBadge(row.source) + '</div></div>'
      + '<div class="portal-admin-price-amount">€' + whEsc(eurosFromCents(row.amount_cents))
      + '</div></div>'
      + (canWrite()
        ? '<div class="portal-admin-card-actions">'
          + pencilBtn('edit-extra',
            ' data-wh-extra-kind="' + whEsc(kind) + '" data-wh-item-code="' + whEsc(row.code) + '"')
          + '</div>'
        : '')
      + '</div>';
  }

  function renderExtrasSection() {
    var extras = state.view.extras || {};
    var html = '';
    if (isEditing('item:extra:__new__')) html += renderNewExtraForm();
    var groups = [
      { kind: 'deposit', rows: extras.deposits || [], title: whT('admin.wh.pricing.deposits', 'Deposits') },
      { kind: 'supplement', rows: extras.supplements || [], title: whT('admin.wh.pricing.supplements', 'Room supplements') },
    ];
    for (var g = 0; g < groups.length; g++) {
      html += '<div class="portal-admin-subsection">'
        + '<div class="portal-admin-subsection-title-row">'
        + '<div class="portal-admin-subsection-title">' + whEsc(groups[g].title) + '</div></div>'
        + '<div class="portal-admin-card-grid">';
      if (!groups[g].rows.length) {
        html += '<p class="portal-admin-muted">'
          + whEsc(whT('admin.wh.pricing.noneSet', 'None set.')) + '</p>';
      }
      for (var i = 0; i < groups[g].rows.length; i++) {
        html += renderExtrasRow(groups[g].kind, groups[g].rows[i]);
      }
      html += '</div></div>';
    }
    var headerExtra = canWrite() && !isEditing('item:extra:__new__')
      ? actionBtn('new-extra', '+ ' + whT('admin.wh.pricing.addExtras', 'Add extras'))
      : '';
    return sectionShell(
      whT('admin.wh.pricing.extras', 'Extras'),
      whT('admin.wh.pricing.extrasNote', 'Deposits taken at booking and per-night room supplements.'),
      html,
      headerExtra,
    );
  }

  // ── Shell ──────────────────────────────────────────────────────────────────

  function render() {
    if (state.view && Array.isArray(state.view.packages)) {
      var pebbleMap = {};
      for (var pi = 0; pi < state.view.packages.length; pi++) {
        var pk = state.view.packages[pi];
        if (pk && pk.code && pk.pebble) pebbleMap[pk.code] = pk.pebble;
      }
      window.WH_PACKAGE_PEBBLE_BY_CODE = pebbleMap;
    }
    var body = node('wh-admin-pricing-body');
    if (!body) return;

    if (state.loading && !state.view) {
      body.innerHTML = '<section class="portal-admin-section"><div class="portal-admin-section-body">'
        + '<p class="portal-admin-muted">' + whEsc(whT('admin.loading', 'Loading…'))
        + '</p></div></section>';
      return;
    }
    if (!state.view) {
      body.innerHTML = '<section class="portal-admin-section"><div class="portal-admin-section-body">'
        + '<p class="portal-admin-muted">'
        + whEsc(state.error || whT('admin.wh.pricing.loadFailed', 'Could not load pricing.'))
        + '</p>' + actionBtn('reload', whT('admin.action.retry', 'Retry')) + '</div></section>';
      return;
    }

    var banner = '';
    if (!state.view.writes_enabled) {
      banner += '<div class="portal-admin-banner">'
        + whEsc(whT('admin.wh.pricing.readOnly',
          'Read-only: price editing is turned off for this environment.')) + '</div>';
    }
    if (state.view.overlay_available === false) {
      banner += '<div class="portal-admin-banner wh-price-banner-warn">'
        + whEsc(whT('admin.wh.pricing.overlayDown',
          'Showing built-in prices only — saved price changes could not be loaded.')) + '</div>';
    }
    if (state.error) {
      banner += '<div class="portal-admin-banner wh-price-banner-warn">'
        + whEsc(state.error) + '</div>';
    }
    if (state.notice) {
      banner += '<div class="portal-admin-banner wh-price-banner-ok">'
        + whEsc(state.notice) + '</div>';
    }

    body.innerHTML = banner
      + '<div class="portal-admin-sections">'
      + renderSeasonsSection()
      + renderPackagesSection()
      + renderRentalsSection()
      + renderServicesSection()
      + renderTransfersSection()
      + renderExtrasSection()
      + '</div>';
  }

  function load(opts) {
    if (state.loading) return Promise.resolve();
    state.loading = true;
    if (!(opts && opts.keepMessages)) { state.error = null; state.notice = null; }
    render();
    return request('GET', WH_PRICING_BASE + clientQuery()).then(function (r) {
      state.loading = false;
      if (r.status === 200 && r.data && r.data.success) {
        state.view = r.data;
      } else {
        state.error = (r.data && (r.data.message || r.data.error))
          || whT('admin.wh.pricing.loadFailed', 'Could not load pricing.');
      }
      render();
    }).catch(function () {
      state.loading = false;
      state.error = whT('admin.wh.pricing.loadFailed', 'Could not load pricing.');
      render();
    });
  }

  /** Apply a write, then adopt the view the server returned as the new truth. */
  function commit(method, path, body, successMsg) {
    if (state.busy) return Promise.resolve();
    state.busy = true;
    state.error = null;
    state.notice = null;
    return request(method, path, body).then(function (r) {
      state.busy = false;
      if (r.status === 200 && r.data && r.data.success) {
        state.view = r.data;
        state.editing = null;
        state.seasonDraft = null;
        state.notice = successMsg || whT('admin.wh.pricing.saved', 'Saved.');
      } else {
        state.error = (r.data && (r.data.message || r.data.error))
          || whT('admin.wh.pricing.saveFailed', 'Could not save.');
      }
      render();
    }).catch(function () {
      state.busy = false;
      state.error = whT('admin.wh.pricing.saveFailed', 'Could not save.');
      render();
    });
  }

  function inputValue(id) {
    var el = node(id);
    return el ? String(el.value == null ? '' : el.value).trim() : '';
  }

  function checkboxValue(id) {
    var el = node(id);
    return !!(el && el.checked);
  }

  function rangeFieldValue(row, name) {
    var el = row.querySelector('[data-wh-range-field="' + name + '"]');
    return el ? Number(el.value) : NaN;
  }

  function readRangeRows() {
    var wrap = node('wh-price-season-ranges');
    if (!wrap) return [];
    var rows = wrap.querySelectorAll('.wh-price-range-row');
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      out.push({
        start_month: rangeFieldValue(rows[i], 'start_month'),
        start_day: rangeFieldValue(rows[i], 'start_day'),
        end_month: rangeFieldValue(rows[i], 'end_month'),
        end_day: rangeFieldValue(rows[i], 'end_day'),
      });
    }
    return out;
  }

  function seasonByCode(code) {
    var seasons = (state.view && state.view.seasons) || [];
    for (var i = 0; i < seasons.length; i++) {
      if (seasons[i].code === code) return seasons[i];
    }
    return null;
  }

  /** Snapshot whatever is currently in the season form, including edits. */
  function readSeasonForm() {
    return {
      code: inputValue('wh-price-season-code'),
      label: inputValue('wh-price-season-label'),
      priority: Number(inputValue('wh-price-season-priority')) || 0,
      bookable: checkboxValue('wh-price-season-bookable'),
      ranges: readRangeRows(),
    };
  }

  /** Mutate the live draft (not server state) and re-render from it. */
  function mutateSeasonDraft(mutate) {
    var draft = readSeasonForm();
    mutate(draft);
    state.seasonDraft = draft;
    render();
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  var ACTIONS = {
    reload: function () { load(); },
    cancel: function () {
      state.editing = null;
      state.seasonDraft = null;
      state.error = null;
      render();
    },

    'new-season': function () {
      state.editing = 'season:__new__';
      state.seasonDraft = null;
      render();
    },
    'edit-season': function (btn) {
      var code = btn.getAttribute('data-wh-season-code');
      state.editing = 'season:' + code;
      // Seed the draft from the saved season so ranges survive Add/Remove.
      var season = seasonByCode(code);
      state.seasonDraft = season ? {
        code: season.code,
        label: season.label,
        priority: Number(season.priority) || 0,
        bookable: season.bookable !== false,
        ranges: (season.ranges || []).slice(),
      } : null;
      render();
    },
    'add-range': function () {
      mutateSeasonDraft(function (draft) {
        // Start the new row after the previous one. A second row copied from the
        // first would be an exact duplicate, which the server rejects, so the
        // operator would have to fix it before it could ever save.
        var last = draft.ranges[draft.ranges.length - 1];
        var month = last ? (Number(last.end_month) % 12) + 1 : 1;
        draft.ranges.push({
          start_month: month, start_day: 1, end_month: month, end_day: 28,
        });
      });
    },
    'remove-range': function (btn) {
      var idx = Number(btn.getAttribute('data-wh-range-target'));
      mutateSeasonDraft(function (draft) {
        if (draft.ranges.length > 1) draft.ranges.splice(idx, 1);
      });
    },
    'save-season': function () {
      var body = readSeasonForm();
      state.seasonDraft = null;
      commit('PUT', WH_PRICING_BASE + '/seasons' + clientQuery(), body);
    },
    'delete-season': function (btn) {
      var code = btn.getAttribute('data-wh-season-code');
      if (!window.confirm(whT('admin.wh.pricing.confirmDeleteSeason',
        'Remove this season? Prices set for it stay saved but stop applying.'))) return;
      commit('DELETE',
        WH_PRICING_BASE + '/seasons/' + encodeURIComponent(code) + clientQuery(), null);
    },

    'edit-package-price': function (btn) {
      state.editing = 'price:package:' + btn.getAttribute('data-wh-package')
        + ':' + btn.getAttribute('data-wh-season');
      render();
    },
    'edit-package': function (btn) {
      state.editing = 'item:package:' + btn.getAttribute('data-wh-item-code');
      render();
    },
    'toggle-pebble-dd': function (btn) {
      var wrap = btn.closest ? btn.closest('.wh-price-pebble-dd') : null;
      if (!wrap) return;
      wrap.classList.toggle('is-open');
    },
    'pick-pebble': function (btn) {
      var token = btn.getAttribute('data-wh-pebble') || 'stone';
      var wrap = btn.closest ? btn.closest('.wh-price-pebble-dd') : null;
      if (!wrap) return;
      var hidden = wrap.querySelector('#wh-price-item-pebble');
      if (hidden) hidden.value = token;
      var chip = wrap.querySelector('.wh-price-pebble-dd-btn .pkg-pebble');
      if (chip) chip.className = 'pkg-pebble pkg-pebble-' + token;
      var lab = wrap.querySelector('.wh-price-pebble-dd-label');
      if (lab) lab.textContent = pebbleLabel(token);
      var chips = wrap.querySelectorAll('.wh-price-pebble-dd-menu .pkg-pebble');
      for (var i = 0; i < chips.length; i++) {
        if (chips[i].getAttribute('data-wh-pebble') === token) chips[i].classList.add('is-selected');
        else chips[i].classList.remove('is-selected');
      }
      wrap.classList.remove('is-open');
    },
    'save-package-item': function (btn) {
      commit('PUT', WH_PRICING_BASE + '/items' + clientQuery(), {
        item_type: 'package',
        item_code: btn.getAttribute('data-wh-item-code'),
        label: inputValue('wh-price-item-label'),
        metadata: packageMetaFromForm(),
      });
    },
    'save-package-price': function (btn) {
      commit('PUT', WH_PRICING_BASE + '/prices' + clientQuery(), {
        item_type: 'package',
        item_code: btn.getAttribute('data-wh-package'),
        season_code: btn.getAttribute('data-wh-season'),
        unit: 'per_person_per_week',
        amount_eur: inputValue('wh-price-amount'),
      });
    },

    'edit-rental-price': function (btn) {
      state.editing = 'price:rental:' + btn.getAttribute('data-wh-item-code');
      render();
    },
    'save-rental-price': function (btn) {
      commit('PUT', WH_PRICING_BASE + '/prices' + clientQuery(), {
        item_type: 'rental',
        item_code: btn.getAttribute('data-wh-item-code'),
        unit: btn.getAttribute('data-wh-unit') || 'per_day',
        amount_eur: inputValue('wh-price-amount'),
      });
    },

    'edit-service-price': function (btn) {
      state.editing = 'price:service:' + btn.getAttribute('data-wh-item-code');
      render();
    },
    'save-service-price': function (btn) {
      commit('PUT', WH_PRICING_BASE + '/prices' + clientQuery(), {
        item_type: 'service',
        item_code: btn.getAttribute('data-wh-item-code'),
        unit: btn.getAttribute('data-wh-unit') || 'per_stay',
        amount_eur: inputValue('wh-price-amount'),
      });
    },

    'edit-full-day': function () { state.editing = 'price:addon:' + FULL_DAY_CODE; render(); },
    'save-full-day': function () {
      commit('PUT', WH_PRICING_BASE + '/prices' + clientQuery(), {
        item_type: 'addon',
        item_code: FULL_DAY_CODE,
        unit: 'per_day',
        amount_eur: inputValue('wh-price-amount'),
      });
    },

    'edit-extra': function (btn) {
      state.editing = 'price:' + btn.getAttribute('data-wh-extra-kind')
        + ':' + btn.getAttribute('data-wh-item-code');
      render();
    },
    'save-extra': function (btn) {
      var extraKind = btn.getAttribute('data-wh-extra-kind');
      var unit = btn.getAttribute('data-wh-unit');
      if (extraKind === 'deposit') {
        var scoped = document.querySelector('input[name="wh-deposit-scope"]:checked');
        if (scoped && scoped.value) unit = scoped.value;
      }
      commit('PUT', WH_PRICING_BASE + '/prices' + clientQuery(), {
        item_type: extraKind,
        item_code: btn.getAttribute('data-wh-item-code'),
        unit: unit,
        amount_eur: inputValue('wh-price-amount'),
      });
    },

    'new-item': function (btn) {
      state.editing = 'item:' + btn.getAttribute('data-wh-item-type') + ':__new__';
      render();
    },
    'new-extra': function () {
      state.editing = 'item:extra:__new__';
      render();
    },
    'save-new-extra': function () {
      var kind = inputValue('wh-price-extra-kind') || 'deposit';
      var label = inputValue('wh-price-item-label');
      var code = slugFromLabel(label, kind);
      var unit = kind === 'deposit'
        ? ((document.querySelector('input[name="wh-deposit-scope"]:checked') || {}).value || 'per_booking')
        : (inputValue('wh-price-item-unit') || 'per_room_per_night');
      var amount = inputValue('wh-price-item-amount');
      if (state.busy) return;
      state.busy = true;
      state.error = null;
      state.notice = null;
      request('PUT', WH_PRICING_BASE + '/items' + clientQuery(), {
        item_type: kind, item_code: code, label: label,
      }).then(function (r) {
        if (!(r.status === 200 && r.data && r.data.success)) {
          state.busy = false;
          state.error = (r.data && (r.data.message || r.data.error))
            || whT('admin.wh.pricing.saveFailed', 'Could not save.');
          render();
          return null;
        }
        return request('PUT', WH_PRICING_BASE + '/prices' + clientQuery(), {
          item_type: kind, item_code: code, unit: unit, amount_eur: amount,
        }).then(function (pr) {
          state.busy = false;
          if (pr.status === 200 && pr.data && pr.data.success) {
            state.view = pr.data;
            state.editing = null;
            state.notice = whT('admin.wh.pricing.saved', 'Saved.');
          } else {
            if (r.data && r.data.success) state.view = r.data;
            state.editing = null;
            state.error = whT('admin.wh.pricing.itemSavedNoPrice',
              'Item created, but the price was rejected. Set it with Edit.');
          }
          render();
        });
      }).catch(function () {
        state.busy = false;
        state.error = whT('admin.wh.pricing.saveFailed', 'Could not save.');
        render();
      });
    },
    /**
     * Two writes: the catalog identity, then its opening price. The item is
     * saved first so a rejected price still leaves a usable, priceable item
     * rather than dropping what the operator typed.
     */
    'save-new-item': function (btn) {
      var itemType = btn.getAttribute('data-wh-item-type');
      var label = inputValue('wh-price-item-label');
      var code = slugFromLabel(label, itemType);
      if (itemType === 'package') {
        // Priced per season, so creating the package is a single write and the
        // season cards it gains are where the amounts get set.
        commit('PUT', WH_PRICING_BASE + '/items' + clientQuery(),
          {
            item_type: 'package',
            item_code: code,
            label: label,
            metadata: packageMetaFromForm(),
          },
          whT('admin.wh.pricing.packageCreated',
            'Package created. Set a price for each season.'));
        return;
      }
      var unit = inputValue('wh-price-item-unit');
      var amount = inputValue('wh-price-item-amount');
      if (state.busy) return;
      state.busy = true;
      state.error = null;
      state.notice = null;
      request('PUT', WH_PRICING_BASE + '/items' + clientQuery(), {
        item_type: itemType, item_code: code, label: label,
      }).then(function (r) {
        if (!(r.status === 200 && r.data && r.data.success)) {
          state.busy = false;
          state.error = (r.data && (r.data.message || r.data.error))
            || whT('admin.wh.pricing.saveFailed', 'Could not save.');
          render();
          return null;
        }
        var priceCode = itemType === 'rental' ? code + '__1_day' : code;
        return request('PUT', WH_PRICING_BASE + '/prices' + clientQuery(), {
          item_type: itemType, item_code: priceCode, unit: unit, amount_eur: amount,
        }).then(function (pr) {
          state.busy = false;
          if (pr.status === 200 && pr.data && pr.data.success) {
            state.view = pr.data;
            state.editing = null;
            state.notice = whT('admin.wh.pricing.saved', 'Saved.');
          } else {
            // Item exists, price did not stick — say so precisely.
            if (r.data && r.data.success) state.view = r.data;
            state.editing = null;
            state.error = whT('admin.wh.pricing.itemSavedNoPrice',
              'Item created, but the price was rejected. Set it with Edit.');
          }
          render();
        });
      }).catch(function () {
        state.busy = false;
        state.error = whT('admin.wh.pricing.saveFailed', 'Could not save.');
        render();
      });
    },
    'delete-item': function (btn) {
      var itemType = btn.getAttribute('data-wh-item-type');
      var code = btn.getAttribute('data-wh-item-code');
      if (!window.confirm(whT('admin.wh.pricing.confirmDeleteItem',
        'Remove this item and its prices?'))) return;
      commit('DELETE', WH_PRICING_BASE + '/items/' + encodeURIComponent(itemType)
        + '/' + encodeURIComponent(code) + clientQuery(), null);
    },

    'new-transfer': function () { state.editing = 'transfer:__new__'; render(); },
    'edit-transfer': function (btn) {
      state.editing = 'transfer:' + btn.getAttribute('data-wh-airport');
      render();
    },
    /**
     * Two writes as well: the eligibility rule, then the fare. Rule first so a
     * rejected amount still leaves the airport configured.
     */
    'save-transfer': function () {
      var code = inputValue('wh-price-transfer-code').toUpperCase();
      var amount = inputValue('wh-price-transfer-amount');
      var unit = inputValue('wh-price-transfer-unit') || 'flat';
      var rule = {
        airport_code: code,
        label: inputValue('wh-price-transfer-label'),
        requires_package: checkboxValue('wh-price-transfer-requires'),
        included_when_package: checkboxValue('wh-price-transfer-included'),
        min_guest_count: inputValue('wh-price-transfer-min') || null,
        unavailable_no_package_message: inputValue('wh-price-transfer-msg-package'),
        unavailable_below_min_group_message: inputValue('wh-price-transfer-msg-group'),
      };
      if (state.busy) return;
      state.busy = true;
      state.error = null;
      state.notice = null;
      request('PUT', WH_PRICING_BASE + '/transfers' + clientQuery(), rule).then(function (r) {
        if (!(r.status === 200 && r.data && r.data.success)) {
          state.busy = false;
          state.error = (r.data && (r.data.message || r.data.error))
            || whT('admin.wh.pricing.saveFailed', 'Could not save.');
          render();
          return null;
        }
        if (!amount) {
          state.busy = false;
          state.view = r.data;
          state.editing = null;
          state.notice = whT('admin.wh.pricing.saved', 'Saved.');
          render();
          return null;
        }
        return request('PUT', WH_PRICING_BASE + '/prices' + clientQuery(), {
          item_type: 'transfer', item_code: code, unit: unit, amount_eur: amount,
        }).then(function (pr) {
          state.busy = false;
          if (pr.status === 200 && pr.data && pr.data.success) {
            state.view = pr.data;
            state.editing = null;
            state.notice = whT('admin.wh.pricing.saved', 'Saved.');
          } else {
            state.view = r.data;
            state.editing = null;
            state.error = whT('admin.wh.pricing.transferSavedNoPrice',
              'Airport saved, but the fare was rejected. Set it with Edit.');
          }
          render();
        });
      }).catch(function () {
        state.busy = false;
        state.error = whT('admin.wh.pricing.saveFailed', 'Could not save.');
        render();
      });
    },
    'delete-transfer': function (btn) {
      var code = btn.getAttribute('data-wh-airport');
      if (!window.confirm(whT('admin.wh.pricing.confirmDeleteAirport',
        'Remove this airport and its fare?'))) return;
      commit('DELETE', WH_PRICING_BASE + '/transfers/' + encodeURIComponent(code) + clientQuery(),
        null);
    },
  };

  function wire() {
    var body = node('wh-admin-pricing-body');
    if (!body || body.dataset.whPricingWired === '1') return;
    body.dataset.whPricingWired = '1';
    body.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest
        ? ev.target.closest('[data-wh-price-action]')
        : null;
      if (!btn || !body.contains(btn)) return;
      ev.preventDefault();
      var action = ACTIONS[btn.getAttribute('data-wh-price-action')];
      if (typeof action === 'function') action(btn);
    });
  }

  /** Entry point called by the Pricing sub-tab. */
  function loadWolfhouseAdminPricing(opts) {
    wire();
    if (!state.view || (opts && opts.force)) return load(opts);
    render();
    return Promise.resolve();
  }

  window.loadWolfhouseAdminPricing = loadWolfhouseAdminPricing;
  window.__whPricingRenderForTest = render;
  window.__whPricingStateForTest = state;
})();
