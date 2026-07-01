/* Wolfhouse Camps and Services admin — CRUD tab.
   Injected into buildUiHtml() AFTER sunset-admin-ui.js, so globals like
   adminApiRequest, adminClientQuery, escHtml, el are available. Self-guarded anyway. */
(function () {
  function svcEl(id) { return document.getElementById(id); }
  function esc(s) { return (typeof escHtml === 'function') ? escHtml(s == null ? '' : String(s)) : String(s == null ? '' : s); }
  function eur(cents) { return (Number(cents || 0) / 100).toFixed(2); }
  function svcDateOnly(v) { return v ? String(v).slice(0, 10) : ''; }
  function svcQuery() { return (typeof adminClientQuery === 'function') ? adminClientQuery() : '?client=wolfhouse-somo'; }
  var svcRoomsCache = null;
  var svcRoomsLoading = false;

  function servicesApi(method, path, body) {
    if (typeof adminApiRequest === 'function') return adminApiRequest(method, path, body);
    var opts = { method: method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
    if (body != null) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, data: d }; });
    });
  }

  function svcMsg(kind, text) {
    var box = svcEl('svc-save-msg'); if (!box) return;
    if (!text) { box.style.display = 'none'; return; }
    box.textContent = text; box.style.display = 'block';
    box.style.color = kind === 'error' ? '#b00020' : '#0a7d33';
  }

  function svcClientSlug() {
    if (typeof getClient === 'function') return getClient();
    var m = svcQuery().match(/client=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : 'wolfhouse-somo';
  }

  function svcLoadRooms(cb) {
    if (svcRoomsCache) { if (cb) cb(svcRoomsCache); return; }
    if (svcRoomsLoading) {
      setTimeout(function () { svcLoadRooms(cb); }, 120);
      return;
    }
    svcRoomsLoading = true;
    fetch('/staff/tour-operator/rooms?client=' + encodeURIComponent(svcClientSlug()), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        svcRoomsCache = (data && data.success && data.rooms) ? data.rooms : [];
        svcRoomsLoading = false;
        if (cb) cb(svcRoomsCache);
      })
      .catch(function () {
        svcRoomsCache = [];
        svcRoomsLoading = false;
        if (cb) cb([]);
      });
  }

  function svcRenderRoomChecklist(selectedCodes) {
    var list = svcEl('svc-f-rooms-list');
    if (!list) return;
    var selected = {};
    (selectedCodes || []).forEach(function (code) { selected[String(code || '').toUpperCase()] = true; });
    if (!svcRoomsCache || !svcRoomsCache.length) {
      list.innerHTML = '<p class="portal-admin-muted">No rooms found.</p>';
      return;
    }
    var html = '';
    svcRoomsCache.forEach(function (room) {
      var code = String(room.room_code || room.code || '').trim();
      if (!code) return;
      var id = 'svc-room-' + code.replace(/[^a-zA-Z0-9_-]/g, '_');
      html += '<label for="' + esc(id) + '"><input type="checkbox" class="svc-room-checkbox" id="' + esc(id) + '" value="' + esc(code) + '"' +
        (selected[code.toUpperCase()] ? ' checked' : '') + '> ' + esc(code) + '</label>';
    });
    list.innerHTML = html || '<p class="portal-admin-muted">No rooms found.</p>';
  }

  function svcReadSelectedRooms() {
    var out = [];
    document.querySelectorAll('.svc-room-checkbox:checked').forEach(function (node) {
      if (node.value) out.push(String(node.value).trim());
    });
    return out;
  }

  function svcUpdateBlockRoomsUi() {
    var enabled = !!(svcEl('svc-f-block-rooms') && svcEl('svc-f-block-rooms').checked);
    var wrap = svcEl('svc-f-rooms-wrap');
    if (wrap) wrap.style.display = enabled ? '' : 'none';
    if (enabled) {
      svcLoadRooms(function () {
        svcRenderRoomChecklist(svcReadSelectedRooms());
      });
    }
  }


  function svcSlotRowHtml(slot, idx, removable) {
    slot = slot || {};
    return '<div class="svc-slot-row" data-slot-idx="' + idx + '" style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:6px;align-items:end;margin-top:6px">'
      + '<input type="hidden" class="svc-slot-id" value="' + esc(slot.slot_id || '') + '">'
      + '<label style="font-size:12px">Start<input type="time" class="svc-slot-start" value="' + esc(slot.time_local || '09:00') + '"></label>'
      + '<label style="font-size:12px">End<input type="time" class="svc-slot-end" value="' + esc(slot.time_local_end || '') + '"></label>'
      + '<label style="font-size:12px">Capacity<input type="number" min="1" max="20" class="svc-slot-cap" value="' + esc(slot.capacity || 1) + '"></label>'
      + '<button type="button" class="btn btn-ghost portal-admin-icon-btn svc-slot-remove" ' + (removable ? '' : 'disabled') + '>×</button>'
      + '<label style="font-size:12px;grid-column:1 / -1">Label<input type="text" class="svc-slot-label" value="' + esc(slot.label || '') + '" placeholder="Morning private lesson"></label>'
      + '</div>';
  }

  function svcRenderSlots(slots) {
    var list = svcEl('svc-f-slots-list');
    if (!list) return;
    slots = (slots && slots.length) ? slots : [{ time_local: '09:00', capacity: 1, active: true }];
    list.innerHTML = slots.map(function (slot, idx) { return svcSlotRowHtml(slot, idx, slots.length > 1); }).join('');
    list.querySelectorAll('.svc-slot-remove').forEach(function (btn) {
      btn.addEventListener('click', function () { btn.closest('.svc-slot-row').remove(); svcUpdateSlotRemoveState(); });
    });
  }

  function svcUpdateSlotRemoveState() {
    var rows = document.querySelectorAll('.svc-slot-row');
    rows.forEach(function (row) { var b = row.querySelector('.svc-slot-remove'); if (b) b.disabled = rows.length <= 1; });
  }

  function svcUpdateCategoryUi() {
    var isLesson = svcEl('svc-f-category') && svcEl('svc-f-category').value === 'lesson';
    var wrap = svcEl('svc-f-slots-wrap');
    if (wrap) wrap.style.display = isLesson ? '' : 'none';
    if (isLesson && svcEl('svc-f-slots-list') && !svcEl('svc-f-slots-list').children.length) svcRenderSlots([]);
  }

  function svcReadSlots() {
    var rows = [];
    document.querySelectorAll('.svc-slot-row').forEach(function (row) {
      var start = row.querySelector('.svc-slot-start');
      var end = row.querySelector('.svc-slot-end');
      var cap = row.querySelector('.svc-slot-cap');
      var id = row.querySelector('.svc-slot-id');
      var label = row.querySelector('.svc-slot-label');
      if (!start || !start.value) return;
      rows.push({ slot_id: id && id.value || undefined, label: label && label.value || '', time_local: start.value, time_local_end: end && end.value || '', capacity: parseInt(cap && cap.value || '1', 10), active: true });
    });
    return rows;
  }

  window.loadServicesTab = function loadServicesTab() {
    wireServicesTab();
    var body = svcEl('svc-list-body'); if (body) body.innerHTML = '<p class="portal-admin-muted">Loading…</p>';
    servicesApi('GET', '/staff/admin/services' + svcQuery(), null).then(function (res) {
      if (res.status !== 200 || !res.data || res.data.success !== true) {
        if (body) body.innerHTML = '<p class="portal-admin-muted">Could not load camps and services.</p>';
        return;
      }
      renderServices(res.data.services || []);
    });
  };

  function renderServices(list) {
    var body = svcEl('svc-list-body'); if (!body) return;
    window.__svcCache = list;
    if (!list.length) { body.innerHTML = '<p class="portal-admin-muted">Nothing yet. Click “+ Create camp / lesson / service”.</p>'; return; }
    var html = '<div class="portal-admin-pack-grid" id="svc-grid">';
    list.forEach(function (s) {
      var dates = (s.start_date || s.end_date) ? (esc(svcDateOnly(s.start_date) || '…') + ' → ' + esc(svcDateOnly(s.end_date) || '…')) : 'Always';
      var tags = [];
      if (s.price_unit === 'per_day') tags.push('spans stay');
      if (!s.active) tags.push('inactive');
      if (s.luna_visible === false) tags.push('hidden from Luna');
      if (s.block_rooms_enabled && (s.blocked_room_codes || []).length) {
        tags.push('rooms blocked: ' + (s.blocked_room_codes || []).join(', '));
      }
      html += '<article class="portal-admin-pack-card" data-svc-id="' + esc(s.id) + '" style="opacity:' + (s.active ? '1' : '0.55') + '">'
        + '<div class="portal-admin-card-title-row"><div><div class="portal-admin-pack-title">' + esc(s.name) + '</div>'
        + '<div class="portal-admin-pack-sub">€' + eur(s.price_cents) + ' / guest · ' + esc(s.price_unit || '') + ' · ' + dates
        + (tags.length ? (' · ' + esc(tags.join(', '))) : '') + '</div></div>'
        + '<div class="portal-admin-card-actions">'
        + '<button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-svc-edit="' + esc(s.id) + '">✎</button>'
        + '<button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn portal-admin-danger" data-svc-del="' + esc(s.id) + '">×</button>'
        + '</div></div>'
        + (s.notes_for_luna ? '<p class="portal-admin-muted">' + esc(s.notes_for_luna) + '</p>' : '')
        + '</article>';
    });
    html += '</div>';
    body.innerHTML = html;
    body.querySelectorAll('[data-svc-edit]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-svc-edit');
        openSvcModal((window.__svcCache || []).find(function (x) { return String(x.id) === id; }));
      });
    });
    body.querySelectorAll('[data-svc-del]').forEach(function (b) {
      b.addEventListener('click', function () { deleteSvc(b.getAttribute('data-svc-del')); });
    });
  }

  function fillForm(s) {
    s = s || {};
    svcEl('svc-modal-title').textContent = s.id ? 'Edit camp / lesson / service' : 'Create camp / lesson / service';
    svcEl('svc-f-id').value = s.id || '';
    svcEl('svc-f-name').value = s.name || '';
    svcEl('svc-f-category').value = s.category || '';
    svcEl('svc-f-start').value = svcDateOnly(s.start_date);
    svcEl('svc-f-end').value = svcDateOnly(s.end_date);
    svcEl('svc-f-price').value = s.price_cents != null ? (Number(s.price_cents) / 100) : '';
    svcEl('svc-f-unit').value = s.price_unit || 'per_day';
    svcEl('svc-f-luna').checked = s.luna_visible !== false;
    svcEl('svc-f-keywords').value = (s.keywords || []).join(', ');
    svcEl('svc-f-notes').value = s.notes_for_luna || '';
    if (svcEl('svc-f-block-rooms')) svcEl('svc-f-block-rooms').checked = s.block_rooms_enabled === true;
    svcRenderSlots(s.schedule_slots || []);
    svcUpdateCategoryUi();
    svcLoadRooms(function () {
      svcRenderRoomChecklist(s.blocked_room_codes || []);
      svcUpdateBlockRoomsUi();
    });
  }

  function openSvcModal(s) {
    fillForm(s);
    var m = svcEl('svc-modal');
    if (m) { m.style.display = 'flex'; m.setAttribute('aria-hidden', 'false'); }
  }

  function closeSvcModal() {
    var m = svcEl('svc-modal');
    if (m) { m.style.display = 'none'; m.setAttribute('aria-hidden', 'true'); }
  }

  function readForm() {
    var priceRaw = (svcEl('svc-f-price').value || '').trim();
    var kws = (svcEl('svc-f-keywords').value || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    var blockEnabled = !!(svcEl('svc-f-block-rooms') && svcEl('svc-f-block-rooms').checked);
    var body = {
      name: (svcEl('svc-f-name').value || '').trim(),
      category: svcEl('svc-f-category').value || null,
      notes_for_luna: (svcEl('svc-f-notes').value || ''),
      keywords: kws,
      start_date: svcEl('svc-f-start').value || '',
      end_date: svcEl('svc-f-end').value || '',
      price_cents: priceRaw === '' ? 0 : Math.round(parseFloat(priceRaw) * 100),
      price_unit: svcEl('svc-f-unit').value || 'per_day',
      luna_visible: !!svcEl('svc-f-luna').checked,
      block_rooms_enabled: blockEnabled,
      blocked_room_codes: blockEnabled ? svcReadSelectedRooms() : [],
    };
    if (body.category === 'lesson') body.schedule_slots = svcReadSlots();
    if (!body.category) delete body.category;
    if (Number.isNaN(body.price_cents)) body.price_cents = 0;
    return body;
  }

  function svcFormatError(res) {
    var data = res && res.data;
    if (!data) return 'error ' + (res && res.status);
    if (data.error === 'bed_conflicts') {
      var room = data.room_code ? (' (' + data.room_code + ')') : '';
      return 'Room block conflict' + room + '. Another booking overlaps these dates.';
    }
    if (data.error === 'block_rooms_requires_start_and_end_date') {
      return 'Start and end dates are required when blocking rooms.';
    }
    if (data.error === 'blocked_room_codes required when block_rooms_enabled') {
      return 'Select at least one room to block.';
    }
    return data.error || data.message || ('error ' + res.status);
  }

  function submitSvc() {
    var id = (svcEl('svc-f-id').value || '').trim();
    var body = readForm();
    if (!body.name) { svcMsg('error', 'Name is required.'); return; }
    if (body.block_rooms_enabled) {
      if (!body.start_date || !body.end_date) { svcMsg('error', 'Start and end dates are required when blocking rooms.'); return; }
      if (!body.blocked_room_codes.length) { svcMsg('error', 'Select at least one room to block.'); return; }
    }
    var method = id ? 'PATCH' : 'POST';
    var path = '/staff/admin/services' + (id ? ('/' + encodeURIComponent(id)) : '') + svcQuery();
    servicesApi(method, path, body).then(function (res) {
      if ((res.status === 200 || res.status === 201) && res.data && res.data.success) {
        closeSvcModal(); svcMsg('ok', id ? 'Camp / lesson / service updated.' : 'Camp / lesson / service created.'); loadServicesTab();
      } else {
        svcMsg('error', svcFormatError(res));
      }
    });
  }

  function deleteSvc(id) {
    if (!id) return;
    servicesApi('DELETE', '/staff/admin/services/' + encodeURIComponent(id) + svcQuery(), null).then(function (res) {
      if (res.status === 200 && res.data && res.data.success) { svcMsg('ok', 'Removed.'); loadServicesTab(); }
      else svcMsg('error', svcFormatError(res));
    });
  }

  window.wireServicesTab = function wireServicesTab() {
    var pairs = [['svc-create-open', function () { openSvcModal(null); }], ['svc-modal-cancel', closeSvcModal], ['svc-modal-submit', submitSvc]];
    pairs.forEach(function (p) { var n = svcEl(p[0]); if (n && !n.dataset.wired) { n.dataset.wired = '1'; n.addEventListener('click', p[1]); } });
    var bd = svcEl('svc-modal-backdrop'); if (bd && !bd.dataset.wired) { bd.dataset.wired = '1'; bd.addEventListener('click', closeSvcModal); }
    var cat = svcEl('svc-f-category');
    if (cat && !cat.dataset.svcWired) { cat.dataset.svcWired = '1'; cat.addEventListener('change', svcUpdateCategoryUi); }
    var addSlot = svcEl('svc-slot-add');
    if (addSlot && !addSlot.dataset.svcWired) {
      addSlot.dataset.svcWired = '1';
      addSlot.addEventListener('click', function () { var current = svcReadSlots(); current.push({ time_local: '09:00', capacity: 1, active: true }); svcRenderSlots(current); });
    }
    var blockCb = svcEl('svc-f-block-rooms');
    if (blockCb && !blockCb.dataset.wired) {
      blockCb.dataset.wired = '1';
      blockCb.addEventListener('change', svcUpdateBlockRoomsUi);
    }
  };
})();
