'use strict';

/**
 * Luna Staff → Room placement. Settings and preview only.
 * Not connected to booking placement. Research On/Off is a different control.
 */
(function () {
  var PREVIEW_NOTE = 'Preview only · no beds reserved.';
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
      '#staff-room-fill{margin-top:20px;max-width:100%;font-family:var(--font-sans,inherit);color:var(--text,inherit)}',
      '#staff-room-fill .rf-card{background:var(--surface,#fff);border:1px solid var(--border-soft,#ddd);border-radius:var(--radius-sm,12px);box-shadow:var(--shadow-soft,0 2px 8px rgba(0,0,0,.04));padding:20px;margin:16px 0}',
      '[data-theme="dark"] #staff-room-fill .rf-card{background:#2d2d2d;border-color:#3c3c3c;box-shadow:none}',
      '#staff-room-fill .rf-card-title{font-size:15px;font-weight:650;margin:0 0 6px}',
      '#staff-room-fill .rf-title{font-size:22px;letter-spacing:-.4px;margin:0 0 4px}',
      '#staff-room-fill .rf-subtitle{color:var(--muted,#737b77);font-size:13px;margin:0 0 16px}',
      '#staff-room-fill button{font:inherit;font-size:12px;border:1px solid var(--border-soft,#d5d9d6);border-radius:var(--radius-sm,8px);background:transparent;color:inherit;padding:8px 12px;cursor:pointer}',
      '#staff-room-fill button:disabled{opacity:.45;cursor:default}',
      '#staff-room-fill button:focus-visible,#staff-room-fill input:focus-visible,#staff-room-fill select:focus-visible{outline:2px solid var(--accent,#56866b);outline-offset:3px}',
      '#staff-room-fill button.rf-primary{background:var(--staff-green-bg,#e4eee6);color:var(--staff-green-text,#315b42);border-color:transparent}',
      '#staff-room-fill input:not([type=radio]),#staff-room-fill select{background:var(--surface,#fff);color:var(--text,#272d29);border:1px solid var(--border-soft,#ddd);border-radius:8px;padding:10px;font:inherit;width:100%;min-width:0}',
      '[data-theme="dark"] #staff-room-fill input:not([type=radio]),[data-theme="dark"] #staff-room-fill select{background:#262626;border-color:#484848}',
      '#staff-room-fill .rf-modes label{flex:1;min-width:140px;padding:14px;border-color:var(--border-soft,#ddd);cursor:pointer}',
      '#staff-room-fill .rf-modes label:has(input:checked){background:var(--staff-green-bg,#e4eee6);color:var(--staff-green-text,#315b42);border-color:var(--staff-green-border,#98b09d)}',
      '#staff-room-fill .rf-row{padding:12px 0;flex-wrap:wrap;gap:10px}',
      '#staff-room-fill .rf-rank{border-radius:50%;background:var(--surface-soft,#f3f4f2);width:28px;height:28px;display:grid;place-items:center;font-size:12px}',
      '#staff-room-fill .rf-code{font-size:14px}',
      '#staff-room-fill .rf-meta{color:var(--muted,#737b77)}',
      '#staff-room-fill .rf-pebble{display:inline-flex;border-radius:999px;font-size:12px;padding:5px 10px;background:var(--staff-green-bg,#e4eee6);color:var(--staff-green-text,#315b42)}',
      '#staff-room-fill .rf-pebble[data-gender=female]{background:var(--staff-purple-bg,#eee8f3);color:var(--staff-purple-text,#70517d)}',
      '#staff-room-fill .rf-pebble[data-gender=male]{background:var(--staff-blue-bg,#e6edf5);color:var(--staff-blue-text,#395e81)}',
      '[data-theme="dark"] #staff-room-fill .rf-pebble[data-gender=female]{background:#443648;color:#dbc6e4}',
      '[data-theme="dark"] #staff-room-fill .rf-pebble[data-gender=male]{background:#304355;color:#c0d8ed}',
      '#staff-room-fill .rf-workspace{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:16px}',
      '#staff-room-fill .rf-workspace>.rf-card{margin:0;min-width:0}',
      '#staff-room-fill .rf-builder-form{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0}',
      '#staff-room-fill .rf-genders{grid-column:1/-1;border:0;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:8px}',
      '#staff-room-fill .rf-genders legend{font-size:12px;margin-bottom:8px}',
      '#staff-room-fill .rf-genders label{flex-direction:row;align-items:center;min-height:44px;cursor:pointer}',
      '#staff-room-fill .rf-room-summary{grid-column:1/-1;font-size:14px;border:1px dashed var(--border-soft,#ddd);border-radius:8px;padding:14px;overflow-wrap:anywhere}',
      '#staff-room-fill .rf-draft{display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding:14px 0;border-top:1px solid var(--border-soft,#ddd)}',
      '@media(max-width:850px){#staff-room-fill .rf-workspace{grid-template-columns:1fr}}',
      '#staff-room-fill .rf-builder-form label{display:flex;flex-direction:column;gap:6px;font-size:12px;min-width:0}',
      '#staff-room-fill .rf-builder-actions{grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap}',
      '#staff-room-fill .rf-help{color:var(--muted,#737b77)}',
      '#staff-room-fill .rf-preview{align-items:end;display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr))}',
      '#staff-room-fill .rf-preview label{min-width:0}',
      '#staff-room-fill .rf-preview-out{white-space:pre-wrap;line-height:1.6;font-size:13px;margin-top:16px}',
      '#staff-room-fill .rf-preview-room{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-weight:600}',
      '#staff-room-fill .rf-error{color:var(--staff-red-text,#ad4747)}',
      '@media(max-width:540px){#staff-room-fill .rf-card{padding:14px}#staff-room-fill .rf-builder-form{grid-template-columns:1fr}#staff-room-fill .rf-builder-actions{grid-column:1}#staff-room-fill .rf-moves{margin-left:0;flex-wrap:wrap}}',
      '#staff-room-fill *{box-sizing:border-box}',
      '#staff-room-fill .rf-modes{display:flex;gap:12px;flex-wrap:wrap}',
      '#staff-room-fill .rf-modes label{min-height:64px;display:inline-flex;align-items:center;gap:10px;border:1px solid var(--border-soft,#ddd);border-radius:var(--radius-sm,8px)}',
      '#staff-room-fill .rf-help,#staff-room-fill .rf-legacy{margin:8px 0;font-size:13px;line-height:1.5;white-space:pre-wrap}',
      '#staff-room-fill .rf-row{display:flex;align-items:center;border-bottom:1px solid var(--border-soft,#ddd);max-width:100%}',
      '#staff-room-fill .rf-rank{min-width:28px;font-weight:650}',
      '#staff-room-fill .rf-code{font-weight:650}',
      '#staff-room-fill .rf-meta{font-size:13px;line-height:1.35;min-width:0;overflow-wrap:anywhere}',
      '#staff-room-fill .rf-moves{display:flex;gap:4px;margin-left:auto}',
      '#staff-room-fill button{min-width:44px;min-height:44px}',
      '#staff-room-fill .rf-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}',
      '#staff-room-fill .rf-preview{gap:12px;margin-top:16px}',
      '#staff-room-fill .rf-preview label{display:flex;flex-direction:column;font-size:12px;gap:6px}',
      '#staff-room-fill .rf-preview input,#staff-room-fill .rf-preview select{min-height:44px;max-width:100%}',
      '#staff-room-fill .rf-live{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}',
      '[data-theme="dark"] #staff-room-fill .rf-rank{background:#383e39;color:#d5dfd8}',
      '[data-theme="dark"] #staff-room-fill .rf-help,[data-theme="dark"] #staff-room-fill .rf-meta,[data-theme="dark"] #staff-room-fill .rf-subtitle{color:#b2b8b3}',
      '[data-theme="dark"] #staff-room-fill .rf-error{color:#f4aaaa}',
      '#staff-room-fill .rf-builder-form .rf-genders label{flex-direction:row}',
      '#staff-room-fill .rf-genders label:has(input:checked){outline:2px solid currentColor;outline-offset:2px}',
      '#staff-room-fill input[type=radio]{accent-color:var(--staff-green-text,#315b42);width:16px;min-width:16px;max-width:16px;height:16px;flex:0 0 16px}',
      '@media(max-width:420px){#staff-room-fill .rf-meta{flex:1 1 100%}}'
    ].join('');
    document.head.appendChild(style);
  }

  function state() {
    if (!window.__roomFillState) {
      window.__roomFillState = { server: null, draftMode: 'house', draftOrder: [], source: 'default_numeric', touched: false, dirty: false, pending: false };
    }
    var s = window.__roomFillState;
    if (!s.builder) s.builder = { number: '', beds: '', gender: '', drafts: [] };
    if (!s.previewFields) s.previewFields = {};
    return s;
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
    s.previewSequence = (s.previewSequence || 0) + 1;
    var server = s.server;
    root.hidden = false;
    root.innerHTML = '';
    var title = document.createElement('h3');
    title.className = 'rf-title';
    title.textContent = 'Room placement';
    root.appendChild(title);
    var subtitle = document.createElement('p');
    subtitle.className = 'rf-subtitle';
    subtitle.textContent = 'Shape your rooms, choose a fill style and review the room order.';
    root.appendChild(subtitle);
    var strategy = card('Placement style');
    root.appendChild(strategy);
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
        root.querySelector('input[name="staff-room-fill-mode"]:checked').focus();
      });
      label.appendChild(input);
      label.appendChild(document.createTextNode(mode === 'house' ? ' Fill House' : ' Fill Room'));
      modes.appendChild(label);
    });
    strategy.appendChild(modes);
    var help = document.createElement('p');
    help.className = 'rf-help';
    help.textContent = s.draftMode === 'house' ? HOUSE_HELP + ' ' + TIE_HELP : ROOM_HELP;
    strategy.appendChild(help);
    var legacy = document.createElement('p');
    legacy.className = 'rf-legacy';
    legacy.textContent = 'Choose a placement style and save your settings.';
    if (server && server.policyStatus === 'not_configured') {
      legacy.textContent = 'Not configured. ' + legacy.textContent;
    }
    if (server && server.policyStatus === 'invalid') {
      legacy.textContent = 'Saved setting could not be read. It was not replaced with a default.';
      legacy.className = 'rf-legacy rf-error';
    }
    strategy.appendChild(legacy);
    var status = document.createElement('div');
    status.id = 'staff-room-fill-status';
    status.setAttribute('role', 'status');
    status.className = 'rf-help';
    status.textContent = s.pending ? 'Saving…' : s.dirty ? 'Unsaved settings' : '';
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
    var priority = card('Room priority');
    var priorityHelp = document.createElement('p');
    priorityHelp.className = 'rf-help';
    priorityHelp.textContent = 'Drag to reorder, use the arrow buttons, or press Alt + ↑ / ↓ on a room.';
    priority.appendChild(priorityHelp);
    priority.appendChild(list);
    var workspace = document.createElement('div');
    workspace.className = 'rf-workspace';
    workspace.appendChild(priority);
    workspace.appendChild(builderCard());
    root.appendChild(workspace);
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
    save.className = 'rf-primary';
    priority.appendChild(actions);
    priority.appendChild(status);
    if (s.pending) {
      strategy.querySelectorAll('input').forEach(function (node) { node.disabled = true; });
      priority.querySelectorAll('button').forEach(function (node) { node.disabled = true; });
    }
    var preview = card('Try a placement');
    var previewHelp = document.createElement('p');
    previewHelp.className = 'rf-help';
    previewHelp.textContent = PREVIEW_NOTE + (s.builder.drafts.length ? ' Uses existing inventory, not room drafts.' : '');
    preview.appendChild(previewHelp);
    preview.appendChild(previewForm());
    root.appendChild(preview);
    var out = document.createElement('div');
    out.id = 'staff-room-fill-preview-out';
    out.className = 'rf-preview-out';
    out.setAttribute('role', 'status');
    preview.appendChild(out);
  }

  function card(title) {
    var section = document.createElement('section');
    section.className = 'rf-card';
    var heading = document.createElement('h4');
    heading.className = 'rf-card-title';
    heading.textContent = title;
    section.appendChild(heading);
    return section;
  }

  function builderCard() {
    var b = state().builder;
    var section = card('Room builder');
    section.id = 'staff-room-builder';
    var help = document.createElement('p');
    help.className = 'rf-help';
    help.textContent = 'Drafts stay in this tab; they do not change room inventory.';
    section.appendChild(help);
    var form = document.createElement('form');
    form.className = 'rf-builder-form';
    ['number', 'beds'].forEach(function (key) {
      var label = document.createElement('label');
      label.textContent = key === 'number' ? 'Room number' : 'Bed count';
      var input = document.createElement('input');
      input.id = 'rf-builder-' + key;
      input.type = 'number';
      input.min = '1';
      input.step = '1';
      input.required = true;
      input.value = b[key];
      input.addEventListener('input', function () { b[key] = input.value; updateSummary(); });
      label.appendChild(input);
      form.appendChild(label);
    });
    var genders = document.createElement('fieldset');
    genders.className = 'rf-genders';
    var legend = document.createElement('legend');
    legend.textContent = 'Room type';
    genders.appendChild(legend);
    ['female', 'male', 'mixed'].forEach(function (gender) {
      var label = document.createElement('label');
      label.className = 'rf-pebble';
      label.dataset.gender = gender;
      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'rf-builder-gender';
      radio.value = gender;
      radio.required = true;
      radio.checked = b.gender === gender;
      radio.addEventListener('change', function () { b.gender = gender; updateSummary(); });
      label.appendChild(radio);
      label.appendChild(document.createTextNode(gender.charAt(0).toUpperCase() + gender.slice(1)));
      genders.appendChild(label);
    });
    form.appendChild(genders);
    var summary = document.createElement('div');
    summary.id = 'rf-builder-summary';
    summary.className = 'rf-room-summary';
    summary.setAttribute('aria-live', 'polite');
    function updateSummary() {
      summary.textContent = 'Room ' + (b.number || '—') + ' · ' + (b.beds || '—') + ' beds · ' +
        (b.gender ? b.gender.charAt(0).toUpperCase() + b.gender.slice(1) : 'Choose room type');
    }
    updateSummary();
    form.appendChild(summary);
    var add = document.createElement('button');
    add.type = 'submit';
    add.id = 'rf-builder-add';
    add.className = 'rf-primary';
    form.noValidate = true;
    add.textContent = b.editing != null ? 'Update draft' : 'Add room draft';
    form.appendChild(add);
    var error = document.createElement('p');
    error.id = 'rf-builder-error';
    error.className = 'rf-error';
    error.setAttribute('role', 'alert');
    error.style.gridColumn = '1 / -1';
    form.appendChild(error);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var number = Number(b.number);
      var beds = Number(b.beds);
      var message = '';
      var field = 'rf-builder-number';
      if (!Number.isSafeInteger(number) || number < 1) message = 'Room number must be a positive whole number.';
      else if (!Number.isSafeInteger(beds) || beds < 1) {
        message = 'Bed count must be a positive whole number.';
        field = 'rf-builder-beds';
      } else if (['female', 'male', 'mixed'].indexOf(b.gender) < 0) {
        message = 'Choose Female, Male or Mixed.';
        field = null;
      } else if ((state().server.catalogue || []).some(function (room) { return room.roomNumber != null && Number(room.roomNumber) === number; }) ||
        b.drafts.some(function (draft, index) { return index !== b.editing && draft.number === number; })) {
        message = 'Room ' + number + ' already exists in inventory or your drafts.';
      }
      ['rf-builder-number', 'rf-builder-beds'].forEach(function (id) {
        el(id).removeAttribute('aria-invalid');
        el(id).setAttribute('aria-describedby', error.id);
      });
      error.textContent = message;
      if (message) {
        if (field) { el(field).setAttribute('aria-invalid', 'true'); el(field).focus(); }
        else genders.querySelector('input').focus();
        return;
      }
      var draft = { number: number, beds: beds, gender: b.gender };
      if (b.editing != null) b.drafts[b.editing] = draft;
      else b.drafts.push(draft);
      b.number = ''; b.beds = ''; b.gender = ''; b.editing = null;
      paint();
      el('rf-builder-number').focus();
      say('Room draft saved in this tab. Inventory unchanged.');
    });
    section.appendChild(form);
    if (b.editing != null) form.appendChild(button('Cancel edit', 'rf-builder-cancel', function () {
      b.number = ''; b.beds = ''; b.gender = ''; b.editing = null;
      paint();
      el('rf-builder-number').focus();
    }));
    b.drafts.forEach(function (draft, index) {
      var item = document.createElement('div');
      item.className = 'rf-draft';
      var name = document.createElement('strong');
      name.textContent = 'Room ' + draft.number;
      item.appendChild(name);
      var beds = document.createElement('span');
      beds.className = 'rf-meta';
      beds.textContent = draft.beds + ' beds · Draft';
      item.appendChild(beds);
      var pebble = document.createElement('span');
      pebble.className = 'rf-pebble';
      pebble.dataset.gender = draft.gender;
      pebble.textContent = draft.gender.charAt(0).toUpperCase() + draft.gender.slice(1);
      item.appendChild(pebble);
      var edit = button('Edit', 'rf-draft-edit-' + index, function () {
        b.number = String(draft.number); b.beds = String(draft.beds); b.gender = draft.gender; b.editing = index;
        paint();
        el('rf-builder-number').focus();
      });
      edit.setAttribute('aria-label', 'Edit draft Room ' + draft.number);
      item.appendChild(edit);
      var remove = button('Remove', 'rf-draft-remove-' + index, function () {
        b.drafts.splice(index, 1);
        if (b.editing === index) { b.number = ''; b.beds = ''; b.gender = ''; b.editing = null; }
        else if (b.editing != null && b.editing > index) b.editing--;
        paint();
        el('rf-builder-number').focus();
        say('Room draft removed. Inventory unchanged.');
      });
      remove.setAttribute('aria-label', 'Remove draft Room ' + draft.number);
      item.appendChild(remove);
      section.appendChild(item);
    });
    return section;
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
    bits.push(room.capacity != null ? room.capacity + ' beds' : 'Capacity unknown');
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
    if (s.pending) return;
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
      if (focusLabel && !buttons[i].disabled && buttons[i].getAttribute('aria-label') === focusLabel) {
        buttons[i].focus();
        return;
      }
    }
    if (buttons[0]) buttons[0].focus();
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
      var fields = state().previewFields;
      if (Object.prototype.hasOwnProperty.call(fields, name)) node.value = fields[name];
      node.addEventListener('input', function () {
        fields[name] = node.value;
        state().previewSequence++;
        var result = el('staff-room-fill-preview-out');
        if (result) result.textContent = '';
      });
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
    go.id = 'rf-preview-run';
    go.className = 'rf-primary';
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
        if (status) status.textContent = 'Placement settings saved.';
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
    var sequence = ++s.previewSequence;
    out.textContent = 'Checking placement…';
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
        if (sequence !== s.previewSequence) return;
        out.textContent = '';
        if (!res.body || res.body.success !== true) {
          out.textContent = (res.body && res.body.error) || 'Preview failed.';
          return;
        }
        var decision = res.body.decision || {};
        function note(text, className) {
          var node = document.createElement('p');
          node.className = className || 'rf-help';
          node.textContent = text;
          out.appendChild(node);
          return node;
        }
        note(decision.status === 'placed' ? 'Placement found' : 'Placement result: ' + String(decision.status || 'unknown').replace(/_/g, ' '), 'rf-card-title');
        note('Mode: ' + res.body.mode + ' · Source: ' + res.body.source);
        (decision.selected || []).forEach(function (row) {
          var room = note(row.roomCode || labelFor(roomById(row.roomId)), 'rf-preview-room');
          (row.beds || []).forEach(function (bed) {
            var chip = document.createElement('span');
            chip.className = 'rf-pebble';
            chip.textContent = bed.bedCode || bed.bedId;
            room.appendChild(chip);
          });
        });
        (decision.rationale || []).forEach(function (item) { note(item.text || item.code); });
        (decision.rooms || []).forEach(function (room) {
          if (!room.reasons || !room.reasons.length || room.status === 'selected') return;
          note((room.roomCode || room.roomId) + ': ' + room.reasons.map(function (item) { return item.text || item.code; }).join(' '));
        });
        note(PREVIEW_NOTE);
      })
      .catch(function () { if (sequence === s.previewSequence) out.textContent = 'Preview failed.'; });
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
    var s = state();
    var b = s.builder;
    if (!s.dirty && !b.drafts.length && !b.number && !b.beds && !b.gender) return;
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
