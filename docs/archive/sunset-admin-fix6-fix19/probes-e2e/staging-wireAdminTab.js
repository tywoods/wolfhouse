function wireAdminTab(){
  var root = el('tab-admin');
  if (!root || root.dataset.adminWired === '1') return;
  root.dataset.adminWired = '1';
  root.addEventListener('click', function(ev){
    var btn = ev.target && ev.target.closest ? ev.target.closest('[data-admin-action]') : null;
    if (!btn || adminSaveBusy) return;
    ev.preventDefault();
    var action = btn.getAttribute('data-admin-action');
    var cfg = adminConfigCache;
    if (!cfg && action !== 'toggle-pill'){
      adminShowMessage('error', portalT('admin.loading'));
      return;
    }
    if (action === 'toggle-pill'){
      var row = btn.closest('.portal-admin-pill-row');
      var multi = row && row.getAttribute('data-admin-pill-multi') === '1';
      if (!row) return;
      if (!multi){
        if (btn.classList.contains('is-selected')){
          btn.classList.remove('is-selected');
        } else {
          row.querySelectorAll('.portal-admin-pill').forEach(function(p){ p.classList.remove('is-selected'); });
          btn.classList.add('is-selected');
        }
      } else {
        btn.classList.toggle('is-selected');
      }
      return;
    }
    if (action === 'edit-capacity' || action === 'edit-price-group' || action === 'add-price' || action === 'delete-price' || action === 'save-price-group' || action === 'edit-time' || action === 'add-time' || action === 'delete-time' || action === 'save-capacity' || action === 'save-price' || action === 'save-new-price' || action === 'save-time' || action === 'save-new-time' || action === 'add-pack' || action === 'edit-pack' || action === 'delete-pack' || action === 'save-pack' || action === 'save-new-pack'){
      if (!adminCfgWritesEnabled(cfg)){ adminShowMessage('error', portalT('admin.banner.writesDisabled')); return; }
    }
    if (action === 'edit-capacity'){
      adminEditTarget = 'capacity';
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'cancel-edit'){
      adminEditTarget = null;
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'edit-price-group'){
      adminEditTarget = 'price-group:' + String(btn.getAttribute('data-price-group') || '');
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'add-price'){
      adminEditTarget = 'price-add:' + String(btn.getAttribute('data-price-group') || '');
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'delete-price'){
      var deletePriceId = String(btn.getAttribute('data-price-id') || '');
      if (!deletePriceId || !window.confirm(portalT('admin.edit.confirmRemovePrice'))) return;
      var keepGroupEdit = adminEditTarget && String(adminEditTarget).indexOf('price-group:') === 0 ? adminEditTarget : null;
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('DELETE', '/staff/admin/config/prices/' + encodeURIComponent(deletePriceId) + adminClientQuery(), {})
        .then(function(res){
          adminSaveBusy = false;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.removedPrice'));
          adminReloadConfigKeepingEdit(keepGroupEdit);
        }).catch(function(err){
          adminSaveBusy = false;
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      return;
    }
    if (action === 'edit-time'){
      adminEditTarget = 'time:' + String(btn.getAttribute('data-time-id') || '');
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'add-time'){
      adminEditTarget = 'time:new';
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'delete-time'){
      var deleteTimeId = String(btn.getAttribute('data-time-id') || '');
      if (!deleteTimeId || !window.confirm(portalT('admin.edit.confirmRemoveLesson'))) return;
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('DELETE', '/staff/admin/config/lesson-times/' + encodeURIComponent(deleteTimeId) + adminClientQuery(), {})
        .then(function(res){
          adminSaveBusy = false;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.removedTime'));
          adminReloadConfig();
        }).catch(function(err){
          adminSaveBusy = false;
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      return;
    }
    if (action === 'save-capacity'){
      var capInput = el('admin-capacity-input');
      var capParsed = adminParseCapacity(capInput && capInput.value);
      if (!capParsed.ok){ adminShowMessage('error', capParsed.error); return; }
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('PUT', '/staff/admin/config/lesson-capacity' + adminClientQuery(), { default_daily_cap: capParsed.value })
        .then(function(res){
          adminSaveBusy = false;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.savedCapacity'));
          adminReloadConfig();
        }).catch(function(err){
          adminSaveBusy = false;
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      return;
    }
    if (action === 'save-price-group'){
      var saveGroup = String(btn.getAttribute('data-price-group') || '');
      var grid = el('admin-prices-card-grid-' + saveGroup);
      if (!grid){ adminShowMessage('error', portalT('admin.edit.saveFailed')); return; }
      var cards = grid.querySelectorAll('[data-admin-price-card]');
      var jobs = [];
      var validationError = '';
      cards.forEach(function(card){
        var pid = card.getAttribute('data-admin-price-card');
        if (!pid) return;
        var periodInput = card.querySelector('[data-admin-price-field="period"]');
        var amountInput = card.querySelector('[data-admin-price-field="amount"]');
        var period = periodInput ? String(periodInput.value || '').trim() : '';
        if (!period){ validationError = portalT('admin.edit.periodRequired'); return; }
        var centsParsed = adminParseEurosToCents(amountInput && amountInput.value);
        if (!centsParsed.ok){ validationError = centsParsed.error; return; }
        jobs.push(adminApiRequest('PATCH', '/staff/admin/config/prices/' + encodeURIComponent(pid) + adminClientQuery(), {
          period_window: period,
          amount_cents: centsParsed.value,
        }));
      });
      if (validationError){ adminShowMessage('error', validationError); return; }
      if (!jobs.length){ adminShowMessage('error', portalT('admin.prices.emptyCategory')); return; }
      adminSaveBusy = true;
      adminShowMessage('', '');
      Promise.all(jobs).then(function(results){
        adminSaveBusy = false;
        var failed = results.find(function(res){ return res.status !== 200 || !res.data || res.data.success !== true; });
        if (failed){
          adminShowMessage('error', (failed.data && (failed.data.message || failed.data.error)) || ('HTTP ' + failed.status));
          return;
        }
        adminShowMessage('success', portalT('admin.edit.savedPrice'));
        adminReloadConfig();
      }).catch(function(err){
        adminSaveBusy = false;
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
      });
      return;
    }

    if (action === 'save-price'){
      var priceId = String(btn.getAttribute('data-price-id') || '');
      var periodInput = el('admin-price-period-' + priceId);
      var amountInput = el('admin-price-amount-' + priceId);
      var period = periodInput ? String(periodInput.value || '').trim() : '';
      if (!period){ adminShowMessage('error', portalT('admin.edit.periodRequired')); return; }
      var centsParsed = adminParseEurosToCents(amountInput && amountInput.value);
      if (!centsParsed.ok){ adminShowMessage('error', centsParsed.error); return; }
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('PATCH', '/staff/admin/config/prices/' + encodeURIComponent(priceId) + adminClientQuery(), {
        period_window: period,
        amount_cents: centsParsed.value,
      }).then(function(res){
        adminSaveBusy = false;
        if (res.status !== 200 || !res.data || res.data.success !== true){
          adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
          return;
        }
        adminShowMessage('success', portalT('admin.edit.savedPrice'));
        adminReloadConfig();
      }).catch(function(err){
        adminSaveBusy = false;
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
      });
      return;
    }
    if (action === 'save-new-price'){
      var rentalGroup = String(btn.getAttribute('data-price-group') || '');
      var newPeriodInput = el('admin-new-price-period');
      var newAmountInput = el('admin-new-price-amount');
      var newPeriod = newPeriodInput ? String(newPeriodInput.value || '').trim() : '';
      if (!newPeriod){ adminShowMessage('error', portalT('admin.edit.periodRequired')); return; }
      var newCents = adminParseEurosToCents(newAmountInput && newAmountInput.value);
      if (!newCents.ok){ adminShowMessage('error', newCents.error); return; }
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('POST', '/staff/admin/config/prices' + adminClientQuery(), {
        rental_group: rentalGroup,
        period_window: newPeriod,
        amount_cents: newCents.value,
      }).then(function(res){
        adminSaveBusy = false;
        if ((res.status !== 201 && res.status !== 200) || !res.data || res.data.success !== true){
          adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
          return;
        }
        adminShowMessage('success', portalT('admin.edit.addedPrice'));
        adminReloadConfig();
      }).catch(function(err){
        adminSaveBusy = false;
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
      });
      return;
    }
    if (action === 'save-time'){
      var timeId = String(btn.getAttribute('data-time-id') || '');
      var labelInput = el('admin-time-label');
      var startInput = el('admin-time-start');
      var endInput = el('admin-time-end');
      var capInput = el('admin-time-capacity');
      var label = labelInput ? String(labelInput.value || '').trim() : '';
      if (!label){ adminShowMessage('error', portalT('admin.edit.nameRequired')); return; }
      var timeParsed = adminParseTimeHm(startInput && startInput.value);
      if (!timeParsed.ok){ adminShowMessage('error', timeParsed.error); return; }
      var endRaw = endInput ? String(endInput.value || '').trim() : '';
      var endParsed = { ok: true, value: null };
      if (endRaw){
        endParsed = adminParseTimeHm(endRaw);
        if (!endParsed.ok){ adminShowMessage('error', endParsed.error); return; }
        if (endParsed.value <= timeParsed.value){ adminShowMessage('error', portalT('admin.edit.endAfterStart')); return; }
      }
      var capacityParsed = adminParseCapacity(capInput && capInput.value);
      if (!capacityParsed.ok){ adminShowMessage('error', capacityParsed.error); return; }
      var ageInput = el('admin-time-age');
      var freqInput = el('admin-time-frequency');
      var costInput = el('admin-time-cost');
      var costParsed = adminParseEurosToCents(costInput && costInput.value);
      if (!costParsed.ok){ adminShowMessage('error', costParsed.error); return; }
      var timePayload = {
        label: label,
        kind: 'lesson',
        age_band: ageInput ? String(ageInput.value || 'all_ages') : 'all_ages',
        frequency: freqInput ? String(freqInput.value || 'daily') : 'daily',
        time_local: timeParsed.value,
        capacity: capacityParsed.value,
        amount_cents: costParsed.value,
      };
      if (endParsed.value) timePayload.time_local_end = endParsed.value;
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('PATCH', '/staff/admin/config/lesson-times/' + encodeURIComponent(timeId) + adminClientQuery(), timePayload).then(function(res){
        adminSaveBusy = false;
        if (res.status !== 200 || !res.data || res.data.success !== true){
          adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
          return;
        }
        adminShowMessage('success', portalT('admin.edit.savedTime'));
        adminReloadConfig();
      }).catch(function(err){
        adminSaveBusy = false;
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
      });
      return;
    }

    if (action === 'add-pack'){
      adminEditTarget = 'pack:new';
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'edit-pack'){
      adminEditTarget = 'pack:' + String(btn.getAttribute('data-pack-id') || '');
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'delete-pack'){
      var deletePackId = String(btn.getAttribute('data-pack-id') || '');
      if (!deletePackId || !window.confirm(portalT('admin.edit.confirmRemovePack'))) return;
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('DELETE', '/staff/admin/config/surf-packs/' + encodeURIComponent(deletePackId) + adminClientQuery(), {})
        .then(function(res){
          adminSaveBusy = false;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.removedPack'));
          adminReloadConfig();
        }).catch(function(err){
          adminSaveBusy = false;
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      return;
    }
    if (action === 'save-pack' || action === 'save-new-pack'){
      var packId = action === 'save-pack' ? String(btn.getAttribute('data-pack-id') || '') : '';
      var payload = adminReadPackFormPayload(packId || null);
      if (payload._scheduleError){ adminShowMessage('error', payload._scheduleError); return; }
      delete payload._scheduleError;
      if (!payload.label){ adminShowMessage('error', portalT('admin.edit.nameRequired')); return; }
      adminSaveBusy = true;
      adminShowMessage('', '');
      var packReq = packId
        ? adminApiRequest('PATCH', '/staff/admin/config/surf-packs/' + encodeURIComponent(packId) + adminClientQuery(), payload)
        : adminApiRequest('POST', '/staff/admin/config/surf-packs' + adminClientQuery(), payload);
      packReq.then(function(res){
        adminSaveBusy = false;
        if ((res.status !== 200 && res.status !== 201) || !res.data || res.data.success !== true){
          adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
          return;
        }
        adminShowMessage('success', packId ? portalT('admin.edit.savedPack') : portalT('admin.edit.addedPack'));
        adminReloadConfig();
      }).catch(function(err){
        adminSaveBusy = false;
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
      });
      return;
    }

    if (action === 'save-new-time'){
      var newLabelInput = el('admin-new-time-label');
      var newStartInput = el('admin-new-time-start');
      var newEndInput = el('admin-new-time-end');
      var newLabel = newLabelInput ? String(newLabelInput.value || '').trim() : '';
      if (!newLabel){ adminShowMessage('error', portalT('admin.edit.nameRequired')); return; }
      var newStart = adminParseTimeHm(newStartInput && newStartInput.value);
      if (!newStart.ok){ adminShowMessage('error', newStart.error); return; }
      var newCapInput = el('admin-new-time-capacity');
      var newKindInput = el('admin-new-time-kind');
      var newAgeInput = el('admin-new-time-age');
      var newFreqInput = el('admin-new-time-frequency');
      var newCostInput = el('admin-new-time-cost');
      var newCapParsed = adminParseCapacity(newCapInput && newCapInput.value);
      if (!newCapParsed.ok){ adminShowMessage('error', newCapParsed.error); return; }
      var newCostParsed = adminParseEurosToCents(newCostInput && newCostInput.value);
      if (!newCostParsed.ok){ adminShowMessage('error', newCostParsed.error); return; }
      var payload = {
        label: newLabel,
        kind: 'lesson',
        age_band: newAgeInput ? String(newAgeInput.value || 'all_ages') : 'all_ages',
        frequency: newFreqInput ? String(newFreqInput.value || 'daily') : 'daily',
        time_local: newStart.value,
        capacity: newCapParsed.value,
        amount_cents: newCostParsed.value,
        active: true,
      };
      var newEndRaw = newEndInput ? String(newEndInput.value || '').trim() : '';
      if (newEndRaw){
        var newEnd = adminParseTimeHm(newEndRaw);
        if (!newEnd.ok){ adminShowMessage('error', newEnd.error); return; }
        if (newEnd.value <= newStart.value){ adminShowMessage('error', portalT('admin.edit.endAfterStart')); return; }
        payload.time_local_end = newEnd.value;
      }
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('POST', '/staff/admin/config/lesson-times' + adminClientQuery(), payload)
        .then(function(res){
          adminSaveBusy = false;
          if (res.status !== 201 || !res.data || res.data.success !== true){
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.addedTime'));
          adminReloadConfig();
        }).catch(function(err){
          adminSaveBusy = false;
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      return;
    }
  });
}


