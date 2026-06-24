/* Wolfhouse Services admin — CRUD tab.
   Injected into buildUiHtml() AFTER sunset-admin-ui.js, so globals like
   adminApiRequest, adminClientQuery, escHtml, el are available. Self-guarded anyway. */
(function () {
  function svcEl(id) { return document.getElementById(id); }
  function esc(s) { return (typeof escHtml === 'function') ? escHtml(s == null ? '' : String(s)) : String(s == null ? '' : s); }
  function eur(cents) { return (Number(cents || 0) / 100).toFixed(2); }
  function svcDateOnly(v) { return v ? String(v).slice(0, 10) : ''; }
  function svcQuery() { return (typeof adminClientQuery === 'function') ? adminClientQuery() : '?client=wolfhouse-somo'; }

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

  window.loadServicesTab = function loadServicesTab() {
    wireServicesTab();
    var body = svcEl('svc-list-body'); if (body) body.innerHTML = '<p class="portal-admin-muted">Loading…</p>';
    servicesApi('GET', '/staff/admin/services' + svcQuery(), null).then(function (res) {
      if (res.status !== 200 || !res.data || res.data.success !== true) {
        if (body) body.innerHTML = '<p class="portal-admin-muted">Could not load services.</p>';
        return;
      }
      renderServices(res.data.services || []);
    });
  };

  function renderServices(list) {
    var body = svcEl('svc-list-body'); if (!body) return;
    window.__svcCache = list;
    if (!list.length) { body.innerHTML = '<p class="portal-admin-muted">No services yet. Click “+ Create service”.</p>'; return; }
    var html = '<div class="portal-admin-pack-grid" id="svc-grid">';
    list.forEach(function (s) {
      var dates = (s.start_date || s.end_date) ? (esc(svcDateOnly(s.start_date) || '…') + ' → ' + esc(svcDateOnly(s.end_date) || '…')) : 'Always';
      var tags = [];
      if (s.price_unit === 'per_day') tags.push('spans stay');
      if (!s.active) tags.push('inactive');
      if (s.luna_visible === false) tags.push('hidden from Luna');
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
    svcEl('svc-modal-title').textContent = s.id ? 'Edit service' : 'Create service';
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
  }
  function openSvcModal(s) { fillForm(s); var m = svcEl('svc-modal'); if (m) { m.style.display = 'flex'; m.setAttribute('aria-hidden', 'false'); } }
  function closeSvcModal() { var m = svcEl('svc-modal'); if (m) { m.style.display = 'none'; m.setAttribute('aria-hidden', 'true'); } }

  function readForm() {
    var priceRaw = (svcEl('svc-f-price').value || '').trim();
    var kws = (svcEl('svc-f-keywords').value || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
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
    };
    if (!body.category) delete body.category;
    if (Number.isNaN(body.price_cents)) body.price_cents = 0;
    return body;
  }

  function submitSvc() {
    var id = (svcEl('svc-f-id').value || '').trim();
    var body = readForm();
    if (!body.name) { svcMsg('error', 'Name is required.'); return; }
    var method = id ? 'PATCH' : 'POST';
    var path = '/staff/admin/services' + (id ? ('/' + encodeURIComponent(id)) : '') + svcQuery();
    servicesApi(method, path, body).then(function (res) {
      if ((res.status === 200 || res.status === 201) && res.data && res.data.success) {
        closeSvcModal(); svcMsg('ok', id ? 'Service updated.' : 'Service created.'); loadServicesTab();
      } else {
        svcMsg('error', (res.data && (res.data.error || ('error ' + res.status))) || ('error ' + res.status));
      }
    });
  }
  function deleteSvc(id) {
    if (!id) return;
    servicesApi('DELETE', '/staff/admin/services/' + encodeURIComponent(id) + svcQuery(), null).then(function (res) {
      if (res.status === 200 && res.data && res.data.success) { svcMsg('ok', 'Service removed.'); loadServicesTab(); }
      else svcMsg('error', (res.data && res.data.error) || ('error ' + res.status));
    });
  }

  window.wireServicesTab = function wireServicesTab() {
    var pairs = [['svc-create-open', function () { openSvcModal(null); }], ['svc-modal-cancel', closeSvcModal], ['svc-modal-submit', submitSvc]];
    pairs.forEach(function (p) { var n = svcEl(p[0]); if (n && !n.dataset.wired) { n.dataset.wired = '1'; n.addEventListener('click', p[1]); } });
    var bd = svcEl('svc-modal-backdrop'); if (bd && !bd.dataset.wired) { bd.dataset.wired = '1'; bd.addEventListener('click', closeSvcModal); }
  };
})();
