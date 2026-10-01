'use strict';

/**
 * Luna Staff → Room placement. Settings and preview only.
 * Not connected to booking placement. Research On/Off is a different control.
 */
(function () {
  var NOTICE = 'Settings and preview only — not connected to booking placement.';
  var HOUSE_HELP = 'Balance placements across eligible rooms, taking room capacity into account.';
  var ROOM_HELP = 'Fill eligible rooms in this order before moving to the next. Safety and keeping a party together come first.';
  var TIE_HELP = 'In Fill House this order is only the tie-break.';
  var dragging = null;

  function el(id) { return document.getElementById(id); }

  function css() {
    if (el('staff-room-fill-style')) return;
    var style = document.createElement('style');
    style.id = 'staff-room-fill-style';
    style.textContent = [
      '#staff-room-fill{margin-top:14px;padding-top:12px;border-top:1px solid var(--border,rgba(78,88,83,.22));max-width:100%;font-family:var(--font-sans,inherit);color:inherit}',
      '#staff-room-fill *{box-sizing:border-box}',
      '.rf-notice{margin:0 0 10px;padding:8px 10px;border:1px solid var(--border,rgba(78,88,83,.28));border-radius:8px;font-size:13px;line-height:1.4}',
      '.rf-title{font-size:15px;font-weight:650;margin:0 0 8px}',
      '.rf-modes{display:flex;gap:8px;flex-wrap:wrap}',
      '.rf-modes label{min-height:44px;display:inline-flex;align-items:center;gap:6px;padding:0 12px;border:1px solid var(--border,rgba(78,88,83,.35));border-radius:8px}',
      '.rf-help,.rf-legacy{margin:8px 0;font-size:13px;line-height:1.4}',
      '.rf-row{display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border,rgba(78,88,83,.12));max-width:100%}',
      '.rf-rank{min-width:28px;font-weight:650}',
      '.rf-code{font-weight:650;font-size:16px}',
      '.rf-meta{font-size:13px;line-height:1.35;min-width:0}',
      '.rf-moves{display:flex;gap:4px;margin-left:auto}',
      '.rf-moves button,.rf-handle,.rf-actions button,.rf-preview button{min-width:44px;min-height:44px}',
      '.rf-actions,.rf-preview{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}',
      '.rf-preview label{display:flex;flex-direction:column;font-size:12px;gap:4px;min-width:120px}',
      '.rf-preview input,.rf-preview select{min-height:44px;max-width:100%}',
      '.rf-live{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}',
      '.rf-error{color:#9C3D3D}',
      '@media (max-width:420px){.rf-row{flex-wrap:wrap}.rf-moves{margin-left:0}.rf-meta{flex:1 1 100%}}'
    ].join('');
    document.head.appendChild(style);
  }

  function state() {
    if (!window.__roomFillState) {
      window.__roomFillState = { server: null, draftMode: 'house', draftOrder: [], source: 'default_numeric', touched: false, dirty: false, pending: false };
    }
    return window.__roomFillState;
  }

  function labelFor(room) {
    if (!room) return 'Room';
    if (room.roomNumber != null) return 'Room ' + room.roomNumber;
    return room.label || room.roomCode || 'Room';
  }

  function roomById(id) {
    var cat = (state().server && state().server.catalogue) || [];
    for (var i = 0; i < cat.length; i++) if (cat[i].roomId === id) return cat[i];
    return null;
  }

  function say(text) {
    var live = el('staff-room-fill-live');
    if (live) live.textContent = text;
  }

  function paint() {
    var root = el('staff-room-fill');
    if (!root) return;
    css();
    var s = state();
    var server = s.server;
    root.hidden = false;
    root.innerHTML = '';
    var notice = document.createElement('p');
    notice.className = 'rf-notice';
    notice.id = 'staff-room-fill-notice';
    notice.textContent = NOTICE;
    root.appendChild(notice);
    var title = document.createElement('h3');
    title.className = 'rf-title';
    title.textContent = 'Room placement';
    root.appendChild(title);
    var modes = document.createElement('div');
    modes.className = 'rf-modes';
    modes.setAttribute('role', 'radiogroup');
    modes.setAttribute('aria-label', 'Room placement');
    ['house', 'room'].forEach(function (mode) {
      var label = document.createElement('label');
      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'staff-room-fill-mode';
      input.value = mode;
      input.checked = s.draftMode === mode;
      input.addEventListener('change', function () {
        if (!input.checked) return;
        s.draftMode = mode;
        s.dirty = true;
        paint();
      });
      label.appendChild(input);
      label.appendChild(document.createTextNode(mode === 'house' ? ' Fill House' : ' Fill Room'));
      modes.appendChild(label);
    });
    root.appendChild(modes);
    var help = document.createElement('p');
    help.className = 'rf-help';
    help.textContent = s.draftMode === 'house' ? HOUSE_HELP + ' ' + TIE_HELP : ROOM_HELP;
    root.appendChild(help);
    var legacy = document.createElement('p');
    legacy.className = 'rf-legacy';
    legacy.textContent = (server && server.legacyNote) || 'Not configured. Saving does not change booking placement.';
    if (server && server.policyStatus === 'not_configured') {
      legacy.textContent = 'Not configured. ' + legacy.textContent;
    }
    if (server && server.policyStatus === 'invalid') {
      legacy.textContent = 'Saved setting could not be read. It was not replaced with a default.';
      legacy.className = 'rf-legacy rf-error';
    }
    root.appendChild(legacy);
    var status = document.createElement('div');
    status.id = 'staff-room-fill-status';
    status.setAttribute('role', 'status');
    status.className = 'rf-help';
    root.appendChild(status);
    var live = document.createElement('div');
    live.id = 'staff-room-fill-live';
    live.className = 'rf-live';
    live.setAttribute('aria-live', 'polite');
    root.appendChild(live);
    var list = document.createElement('div');
    list.id = 'staff-room-fill-list';
    list.setAttribute('role', 'list');
    s.draftOrder.forEach(function (id, index) {
      list.appendChild(rowFor(id, index));
    });
    (server && server.unrankedRoomIds || []).forEach(function (id) {
      if (s.draftOrder.indexOf(id) === -1) list.appendChild(rowFor(id, null));
    });
    root.appendChild(list);
    if (server && server.removedRoomIds && server.removedRoomIds.length) {
      var tomb = document.createElement('p');
      tomb.className = 'rf-help';
      tomb.textContent = 'Removed from inventory: ' + server.removedRoomIds.length + ' room(s). Reset or review before saving.';
      root.appendChild(tomb);
    }
    var actions = document.createElement('div');
    actions.className = 'rf-actions';
    actions.appendChild(button('Reset order', 'staff-room-fill-reset', function () {
      var suggested = server && server.suggestedPolicy;
      if (!suggested) return;
      s.draftOrder = suggested.roomPriority.slice();
      s.source = 'default_numeric';
      s.touched = false;
      s.dirty = true;
      paint();
      say('Order reset to room numbers. Not saved.');
    }));
    actions.appendChild(button('Cancel', 'staff-room-fill-cancel', function () {
      applyServer(server);
      paint();
      say('Restored the saved room placement.');
    }));
    var save = button('Save settings', 'staff-room-fill-save', saveDraft);
    save.disabled = s.pending || !server || server.requiresReview && orderIncomplete();
    actions.appendChild(save);
    root.appendChild(actions);
    root.appendChild(previewForm());
    var out = document.createElement('div');
    out.id = 'staff-room-fill-preview-out';
    out.className = 'rf-help';
    root.appendChild(out);
  }

  function orderIncomplete() {
    var server = state().server;
    if (!server) return true;
    var ids = (server.catalogue || []).map(function (room) { return room.roomId; });
    if (ids.length !== state().draftOrder.length) return true;
    return ids.some(function (id) { return state().draftOrder.indexOf(id) < 0; });
  }

  function button(text, id, onClick) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = id;
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function rowFor(id, index) {
    var room = roomById(id) || { roomId: id, roomCode: id, roomNumber: null, capacity: null, active: false };
    var row = document.createElement('div');
    row.className = 'rf-row';
    row.setAttribute('role', 'listitem');
    row.setAttribute('data-room-id', id);
    row.addEventListener('dragover', function (event) {
      if (!dragging) return;
      event.preventDefault();
    });
    row.addEventListener('drop', function (event) {
      event.preventDefault();
      if (!dragging || dragging === id) return;
      moveId(dragging, state().draftOrder.indexOf(id));
      dragging = null;
    });
    var handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'rf-handle';
    handle.draggable = true;
    handle.setAttribute('aria-label', 'Drag ' + labelFor(room));
    handle.textContent = '⋮⋮';
    handle.addEventListener('dragstart', function () { dragging = id; });
    handle.addEventListener('dragend', function () { dragging = null; });
    var rank = document.createElement('span');
    rank.className = 'rf-rank';
    rank.textContent = index == null ? '—' : String(index + 1);
    var code = document.createElement('span');
    code.className = 'rf-code';
    code.textContent = labelFor(room);
    var meta = document.createElement('span');
    meta.className = 'rf-meta';
    var bits = [room.roomCode || ''];
    if (room.roomNumber == null) bits.push('No numeric room number');
    if (room.capacity != null) bits.push(room.capacity + ' beds');
    if (room.active === false) bits.push('Inactive');
    meta.textContent = bits.filter(Boolean).join(' · ');
    var moves = document.createElement('span');
    moves.className = 'rf-moves';
    var up = document.createElement('button');
    up.type = 'button';
    up.textContent = 'Move up';
    up.setAttribute('aria-label', 'Move ' + labelFor(room) + ' up');
    up.disabled = index == null || index === 0;
    up.addEventListener('click', function () { moveId(id, index - 1, up.getAttribute('aria-label')); });
    var down = document.createElement('button');
    down.type = 'button';
    down.textContent = 'Move down';
    down.setAttribute('aria-label', 'Move ' + labelFor(room) + ' down');
    down.disabled = index == null || index === state().draftOrder.length - 1;
    down.addEventListener('click', function () { moveId(id, index + 1, down.getAttribute('aria-label')); });
    if (index == null) {
      var add = document.createElement('button');
      add.type = 'button';
      add.textContent = 'Add';
      add.setAttribute('aria-label', 'Add ' + labelFor(room) + ' to priority');
      add.addEventListener('click', function () {
        state().draftOrder.push(id);
        state().source = 'custom';
        state().touched = true;
        state().dirty = true;
        paint();
      });
      moves.appendChild(add);
    }
    moves.appendChild(up);
    moves.appendChild(down);
    row.appendChild(handle);
    row.appendChild(rank);
    row.appendChild(code);
    row.appendChild(meta);
    row.appendChild(moves);
    return row;
  }

  function moveId(id, toIndex, focusLabel) {
    var s = state();
    var from = s.draftOrder.indexOf(id);
    if (from < 0 || toIndex < 0 || toIndex >= s.draftOrder.length || from === toIndex) return;
    s.draftOrder.splice(from, 1);
    s.draftOrder.splice(toIndex, 0, id);
    s.source = 'custom';
    s.touched = true;
    s.dirty = true;
    var room = roomById(id);
    paint();
    say(labelFor(room) + ' moved to priority ' + (toIndex + 1));
    var buttons = document.querySelectorAll('#staff-room-fill-list [data-room-id="' + id + '"] button');
    for (var i = 0; i < buttons.length; i++) {
      if (focusLabel && buttons[i].getAttribute('aria-label') === focusLabel.replace(' up', ' up').replace(' down', ' down') && buttons[i].textContent.indexOf(toIndex < from ? 'up' : 'down') >= 0) {
        buttons[i].focus();
        return;
      }
    }
    if (buttons[1]) buttons[1].focus();
  }

  function previewForm() {
    var form = document.createElement('form');
    form.className = 'rf-preview';
    form.id = 'staff-room-fill-preview-form';
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      runPreview(form);
    });
    function field(name, label, node) {
      var wrap = document.createElement('label');
      wrap.textContent = label;
      node.name = name;
      wrap.appendChild(node);
      form.appendChild(wrap);
    }
    var inn = document.createElement('input'); inn.type = 'date'; inn.required = true;
    var out = document.createElement('input'); out.type = 'date'; out.required = true;
    var party = document.createElement('input'); party.type = 'number'; party.min = '1'; party.value = '1'; party.required = true;
    field('checkIn', 'Check in', inn);
    field('checkOut', 'Check out', out);
    field('partySize', 'Party size', party);
    var gender = document.createElement('select');
    [['', 'Not specified'], ['female', 'Female'], ['male', 'Male'], ['mixed', 'Mixed']].forEach(function (pair) {
      var opt = document.createElement('option'); opt.value = pair[0]; opt.textContent = pair[1]; gender.appendChild(opt);
    });
    field('groupGender', 'Group', gender);
    var pref = document.createElement('select');
    [['', 'None'], ['female_only', 'Female only'], ['male_only', 'Male only'], ['private', 'Private'], ['mixed', 'Mixed']].forEach(function (pair) {
      var opt = document.createElement('option'); opt.value = pair[0]; opt.textContent = pair[1]; pref.appendChild(opt);
    });
    field('roomPreference', 'Room preference', pref);
    var go = document.createElement('button');
    go.type = 'submit';
    go.textContent = 'Preview placement';
    form.appendChild(go);
    return form;
  }

  function applyServer(server) {
    var s = state();
    s.server = server;
    var policy = server && server.policyStatus === 'saved' ? server.policy : server && server.suggestedPolicy;
    s.draftMode = policy && policy.fillMode === 'room' ? 'room' : 'house';
    s.draftOrder = policy && policy.roomPriority ? policy.roomPriority.slice() : [];
    s.source = policy && policy.roomPrioritySource ? policy.roomPrioritySource : 'default_numeric';
    s.dirty = false;
    s.touched = false;
  }

  function roomFillLoad() {
    var root = el('staff-room-fill');
    if (!root) return;
    var s = state();
    if (s.dirty || s.pending) return;
    fetch('/staff/luna-intelligence/room-fill', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (res) { return res.json().then(function (body) { return { status: res.status, body: body }; }); })
      .then(function (res) {
        if (res.status === 403) { root.hidden = true; return; }
        if (!res.body || res.body.success !== true) {
          root.hidden = false;
          css();
          root.textContent = (res.body && res.body.error) || 'Could not load room placement.';
          return;
        }
        applyServer(res.body);
        paint();
      })
      .catch(function () {
        root.hidden = false;
        root.textContent = 'Could not load room placement.';
      });
  }

  function saveDraft() {
    var s = state();
    var server = s.server;
    if (!server || s.pending || orderIncomplete()) return;
    s.pending = true;
    paint();
    var body = {
      contractVersion: 1,
      fillMode: s.draftMode,
      roomPriority: s.draftOrder.slice(),
      roomPrioritySource: s.touched ? 'custom' : s.source,
      expectedSettingsRevision: server.settingsRevision,
      expectedCatalogRevision: server.catalogRevision
    };
    fetch('/staff/luna-intelligence/room-fill', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) { return res.json().then(function (payload) { return { status: res.status, body: payload }; }); })
      .then(function (res) {
        s.pending = false;
        if (!res.body || res.body.success !== true) {
          paint();
          var status = el('staff-room-fill-status');
          if (status) status.textContent = 'Could not save room placement. The saved setting was not changed.';
          return;
        }
        applyServer(res.body);
        paint();
        var status = el('staff-room-fill-status');
        if (status) status.textContent = NOTICE;
      })
      .catch(function () {
        s.pending = false;
        paint();
        var status = el('staff-room-fill-status');
        if (status) status.textContent = 'Could not save room placement. The saved setting was not changed.';
      });
  }

  function runPreview(form) {
    var s = state();
    var server = s.server;
    var out = el('staff-room-fill-preview-out');
    if (!server || !out) return;
    var data = new FormData(form);
    var body = {
      policySource: 'draft',
      expectedCatalogRevision: server.catalogRevision,
      draftPolicy: {
        contractVersion: 1,
        fillMode: s.draftMode,
        roomPriority: s.draftOrder.slice(),
        roomPrioritySource: s.touched ? 'custom' : (s.source || 'default_numeric')
      },
      checkIn: String(data.get('checkIn') || ''),
      checkOut: String(data.get('checkOut') || ''),
      partySize: Number(data.get('partySize')),
      groupGender: String(data.get('groupGender') || '') || undefined,
      roomPreference: String(data.get('roomPreference') || '') || undefined
    };
    fetch('/staff/luna-intelligence/room-fill/preview', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) { return res.json().then(function (payload) { return { status: res.status, body: payload }; }); })
      .then(function (res) {
        out.textContent = '';
        if (!res.body || res.body.success !== true) {
          out.textContent = (res.body && res.body.error) || 'Preview failed.';
          return;
        }
        var decision = res.body.decision || {};
        var lines = ['Mode: ' + res.body.mode, 'Source: ' + res.body.source, 'Status: ' + decision.status];
        (decision.selected || []).forEach(function (row) {
          lines.push('Selected ' + (row.roomCode || row.roomId) + ' beds ' + (row.beds || []).map(function (bed) { return bed.bedCode || bed.bedId; }).join(', '));
        });
        (decision.rationale || []).forEach(function (item) { lines.push(item.text || item.code); });
        (decision.rooms || []).forEach(function (room) {
          if (!room.reasons || !room.reasons.length) return;
          if (room.status === 'selected') return;
          lines.push((room.roomCode || room.roomId) + ': ' + room.reasons.map(function (item) { return item.text || item.code; }).join(' '));
        });
        lines.push(NOTICE);
        out.textContent = lines.join('\n');
      })
      .catch(function () { out.textContent = 'Preview failed.'; });
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') dragging = null;
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    var active = document.activeElement && document.activeElement.closest ? document.activeElement.closest('[data-room-id]') : null;
    if (!active) return;
    var id = active.getAttribute('data-room-id');
    var index = state().draftOrder.indexOf(id);
    if (index < 0) return;
    event.preventDefault();
    moveId(id, event.key === 'ArrowUp' ? index - 1 : index + 1);
  });
  window.addEventListener('beforeunload', function (event) {
    if (!state().dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  window.roomFillLoad = roomFillLoad;
  if (typeof wireLunaStaffTabCards === 'function' && !wireLunaStaffTabCards._roomFillWrapped) {
    var previous = wireLunaStaffTabCards;
    var wrapped = function () {
      previous.apply(this, arguments);
      roomFillLoad();
    };
    wrapped._roomFillWrapped = true;
    window.wireLunaStaffTabCards = wrapped;
  }
  if (el('staff-room-fill')) roomFillLoad();
})();
