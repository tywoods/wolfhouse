'use strict';

/**
 * Sunset Schedule drawer — waiver presentation + action controller (Slice 15).
 *
 * Injected after portal, view, edit and payment modules. Owns waiver fetch lifecycle,
 * create/send action, status/answer rendering, copy/open wiring and authoritative
 * waiver refetch after successful mutations.
 *
 * Compatibility hooks (monolith): scheduleWireViewDrawer calls scheduleLoadDrawerWaiver;
 * edit module calls scheduleLoadDrawerWaiver after save. Drawer orchestration unchanged.
 */

var scheduleDrawerWaiverCreateInFlight = false;

function scheduleWaiverStatusLabel(status){
  if (status === 'pending') return portalT('schedule.drawer.waiverPending');
  if (status === 'completed') return portalT('schedule.drawer.waiverCompleted');
  if (status === 'needs_review') return portalT('schedule.drawer.waiverNeedsReview');
  if (status === 'expired') return portalT('schedule.drawer.waiverExpired');
  if (status === 'revoked') return portalT('schedule.drawer.waiverRevoked');
  return status || '—';
}

function scheduleWaiverIsGroup(data){
  var w = data && data.waiver;
  var guestCount = Number(data && data.guest_count) || 1;
  if (w && w.request_mode === 'group') return true;
  if (data && data.expected_request_mode === 'group') return true;
  return guestCount > 1;
}

function scheduleWaiverTargetCount(data){
  var w = data && data.waiver;
  if (w && w.target_count != null) return Number(w.target_count);
  if (data && data.target_count != null) return Number(data.target_count);
  var guestCount = Number(data && data.guest_count) || 1;
  return guestCount > 1 ? guestCount : null;
}

function scheduleWaiverCompletedCount(data){
  var w = data && data.waiver;
  if (w && w.completed_count != null) return Number(w.completed_count);
  if (data && data.completed_count != null) return Number(data.completed_count);
  return 0;
}

function scheduleDrawerWaiverRemountFromData(data){
  var box = el('ps-drawer-waiver-box');
  if (!box) return;
  box.innerHTML = scheduleRenderWaiverBoxInner(data);
  scheduleWireDrawerWaiver(data);
}

function scheduleRenderWaiverBoxInner(data){
  var html = '';
  var isGroup = scheduleWaiverIsGroup(data);
  if (data && data.migration_pending) {
    html += '<p class="portal-schedule-drawer-hint" style="margin:0">' + escHtml(portalT('schedule.drawer.waiverMigrationPending')) + '</p>';
    return html;
  }
  var w = data && data.waiver;
  var targetCount = scheduleWaiverTargetCount(data);
  var completedCount = scheduleWaiverCompletedCount(data);
  if (isGroup) {
    if (data && data.multi_student_note) {
      html += '<p class="portal-schedule-drawer-hint" style="margin:0 0 8px">' + escHtml(data.multi_student_note) + '</p>';
    }
    html += '<p class="portal-schedule-drawer-kv" style="margin:0 0 6px"><strong>' + escHtml(portalT('schedule.drawer.waiverGroupLabel')) + ':</strong> ' + escHtml(String(targetCount || (data && data.guest_count) || '—')) + ' ' + escHtml(portalT('schedule.drawer.waiverStudents')) + '</p>';
    if (targetCount != null && targetCount > 0) {
      var pct = Math.max(0, Math.min(100, Math.round((completedCount / targetCount) * 100)));
      var complete = completedCount >= targetCount;
      html += '<div class="ps-reg-progress"><div class="ps-reg-progress-bar' + (complete ? ' is-complete' : '') + '" style="width:' + pct + '%"></div></div>';
      html += '<p class="portal-schedule-drawer-kv" style="margin:0 0 10px"><strong>' + escHtml(portalT('schedule.drawer.waiverCompletedProgress')) + ':</strong> ' + escHtml(String(completedCount) + ' / ' + String(targetCount)) + '</p>';
    } else if (completedCount > 0) {
      html += '<p class="portal-schedule-drawer-kv" style="margin:0 0 10px"><strong>' + escHtml(portalT('schedule.drawer.waiverCompletedProgress')) + ':</strong> ' + escHtml(String(completedCount)) + '</p>';
    }
  }
  if (!w) {
    if (!isGroup) {
      html += '<p class="portal-schedule-drawer-kv" style="margin:0 0 10px">' + escHtml(portalT('schedule.drawer.waiverNone')) + '</p>';
    }
    var createLabel = isGroup ? portalT('schedule.drawer.waiverCreateGroup') : portalT('schedule.drawer.waiverCreate');
    html += '<button type="button" class="btn btn-primary" id="ps-drawer-waiver-create">' + escHtml(createLabel) + '</button>';
    html += '<p id="ps-drawer-waiver-msg" class="state-msg" style="display:none;margin-top:8px"></p>';
    return html;
  }
  html += '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.drawer.waiverStatus')) + ':</strong> ' + escHtml(scheduleWaiverStatusLabel(w.status)) + '</p>';
  if (w.status === 'completed' && w.completed_at) {
    html += '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.drawer.waiverCompletedAt')) + ':</strong> ' + escHtml(scheduleDateOnlyLabel(w.completed_at)) + '</p>';
  }
  var showAnswers = isGroup ? completedCount > 0 : w.status === 'completed';
  if (w.public_url) {
    var copyLabelKey = isGroup ? 'schedule.drawer.waiverCopyGroup' : 'schedule.drawer.waiverCopy';
    html += '<div class="ps-money-link-row"><a id="ps-drawer-waiver-url" href="' + escHtml(w.public_url) + '" target="_blank" rel="noopener" class="ps-money-link-a">' + escHtml(w.public_url) + '</a>' + scheduleDrawerCopyIconBtnHtml('ps-drawer-waiver-copy', copyLabelKey) + '</div>';
    if (showAnswers) {
      html += '<div class="portal-schedule-drawer-actions" style="margin-top:8px"><button type="button" class="btn btn-ghost" id="ps-drawer-waiver-view">' + escHtml(portalT('schedule.drawer.waiverViewAnswers')) + '</button></div>';
    }
  } else if (w.status === 'pending' || w.status === 'needs_review') {
    var retryLabel = isGroup ? portalT('schedule.drawer.waiverCreateGroup') : portalT('schedule.drawer.waiverCreate');
    html += '<button type="button" class="btn btn-primary" id="ps-drawer-waiver-create">' + escHtml(retryLabel) + '</button>';
  }
  html += '<div id="ps-drawer-waiver-answers" style="display:none;margin-top:10px"></div>';
  html += '<p id="ps-drawer-waiver-msg" class="state-msg" style="display:none;margin-top:8px"></p>';
  return html;
}

function scheduleWireDrawerWaiver(data){
  var createBtn = el('ps-drawer-waiver-create');
  if (createBtn) {
    createBtn.onclick = function(){ scheduleCreateDrawerWaiver(); };
  }
  var copyBtn = el('ps-drawer-waiver-copy');
  var url = data && data.waiver && data.waiver.public_url;
  if (copyBtn && url) {
    copyBtn.onclick = function(){ scheduleCopyTextFallback(url); scheduleDrawerFlashCopied(copyBtn); };
  }
  var viewBtn = el('ps-drawer-waiver-view');
  if (viewBtn) {
    viewBtn.onclick = function(){ scheduleViewDrawerWaiverAnswers(data); };
  }
}

function scheduleViewDrawerWaiverAnswers(data){
  var box = el('ps-drawer-waiver-answers');
  if (!box) return;
  var w = data && data.waiver;
  var isGroup = scheduleWaiverIsGroup(data);
  var completedCount = scheduleWaiverCompletedCount(data);
  var sub = w && w.submission;
  if (!isGroup && sub) {
    scheduleRenderWaiverAnswers(sub);
    return;
  }
  if (isGroup && completedCount < 1) return;
  var bookingId = scheduleDrawerState && scheduleDrawerState.ctx && scheduleDrawerState.ctx.booking_id;
  if (!bookingId) return;
  fetch('/staff/schedule/bookings/' + encodeURIComponent(bookingId) + '/waiver/submission?client=' + encodeURIComponent(getClient()) + sunsetLocationQuerySuffix())
    .then(function(r){ return r.json(); })
    .then(function(res){
      if (!res || !res.success) throw new Error((res && res.error) || 'No submission');
      if (res.submissions && res.submissions.length) {
        scheduleRenderWaiverAnswers(res);
      } else if (res.submission) {
        scheduleRenderWaiverAnswers(res.submission);
      } else {
        throw new Error('No submission');
      }
    })
    .catch(function(err){
      var m = el('ps-drawer-waiver-msg');
      if (m){ m.className = 'state-msg error'; m.textContent = err.message; m.style.display = 'block'; }
    });
}

function scheduleRenderWaiverSubmissionBlock(sub){
  var answers = (sub.raw_answers_json && sub.raw_answers_json.answers) || sub.raw_answers_json || {};
  var html = '';
  Object.keys(answers).forEach(function(key){
    var a = answers[key];
    if (!a || typeof a !== 'object') return;
    var val = a.value;
    if (val && typeof val === 'object') {
      if (Array.isArray(val)) val = val.join(', ');
      else if (val.option_label) val = val.option_label;
      else val = JSON.stringify(val);
    }
    if (val === true) val = 'Sí';
    if (val === false) val = '—';
    html += '<p class="portal-schedule-drawer-kv" style="margin:6px 0 0"><strong>' + escHtml(a.label || key) + ':</strong> ' + escHtml(String(val == null ? '—' : val)) + '</p>';
  });
  return html;
}

function scheduleRenderWaiverAnswers(payload){
  var box = el('ps-drawer-waiver-answers');
  if (!box) return;
  var subs = [];
  if (payload && payload.submissions && payload.submissions.length) {
    subs = payload.submissions;
  } else if (Array.isArray(payload)) {
    subs = payload;
  } else if (payload) {
    subs = [payload];
  }
  var html = '<div style="font-size:12px;border-top:1px solid var(--border-soft);padding-top:8px">';
  html += '<strong>' + escHtml(portalT('schedule.drawer.waiverAnswers')) + '</strong>';
  subs.forEach(function(sub, idx){
    if (subs.length > 1) {
      html += '<div style="margin-top:12px;padding-top:8px;border-top:1px solid var(--border-soft)">';
      html += '<p class="portal-schedule-drawer-kv" style="margin:0 0 4px"><strong>' + escHtml(portalT('schedule.drawer.waiverStudentLabel')) + ' ' + (idx + 1);
      if (sub.respondent_name) html += ': ' + escHtml(sub.respondent_name);
      html += '</strong></p>';
      if (sub.submitted_at) {
        html += '<p class="portal-schedule-drawer-kv" style="margin:0 0 6px;color:var(--text-muted)">' + escHtml(scheduleDateOnlyLabel(sub.submitted_at)) + '</p>';
      }
    }
    html += scheduleRenderWaiverSubmissionBlock(sub);
    if (subs.length > 1) html += '</div>';
  });
  html += '</div>';
  box.innerHTML = html;
  box.style.display = 'block';
}

function scheduleLoadDrawerWaiver(ctx){
  var box = el('ps-drawer-waiver-box');
  if (!box || !(ctx && ctx.booking_id) || getClient() !== 'sunset') return Promise.resolve();
  return fetch('/staff/schedule/bookings/' + encodeURIComponent(ctx.booking_id) + '/waiver?client=' + encodeURIComponent(getClient()) + sunsetLocationQuerySuffix())
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (!box) return;
      scheduleDrawerWaiverRemountFromData(data);
    })
    .catch(function(err){
      if (!box) return;
      box.innerHTML = '<p class="state-msg error" style="margin:0">' + escHtml(portalT('schedule.drawer.waiverLoadFailed')) + ' ' + escHtml(err.message || '') + '</p>';
    });
}

function scheduleCreateDrawerWaiver(){
  if (scheduleDrawerWaiverCreateInFlight) return;
  var ctx = scheduleDrawerState && scheduleDrawerState.ctx;
  var bookingId = ctx && ctx.booking_id;
  if (!bookingId) return;
  scheduleDrawerWaiverCreateInFlight = true;
  var btn = el('ps-drawer-waiver-create');
  if (btn) btn.disabled = true;
  var msg = el('ps-drawer-waiver-msg');
  if (msg){ msg.style.display = 'none'; msg.textContent = ''; }
  fetch('/staff/schedule/bookings/' + encodeURIComponent(bookingId) + '/waiver?client=' + encodeURIComponent(getClient()) + sunsetLocationQuerySuffix(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }).then(function(r){ return r.json().then(function(data){ return { ok: r.ok, data: data }; }); })
    .then(function(res){
      if (!res.ok || !res.data || res.data.success !== true) {
        throw new Error((res.data && (res.data.error || res.data.message)) || 'Create failed');
      }
      return scheduleLoadDrawerWaiver(ctx).then(function(){
        var m = el('ps-drawer-waiver-msg');
        if (m){ m.className = 'state-msg success'; m.textContent = portalT('schedule.drawer.waiverCreated'); m.style.display = 'block'; }
      });
    })
    .catch(function(err){
      var m = el('ps-drawer-waiver-msg');
      if (m){ m.className = 'state-msg error'; m.textContent = portalT('schedule.drawer.waiverCreateFailed') + ' ' + err.message; m.style.display = 'block'; }
      if (btn) btn.disabled = false;
    })
    .finally(function(){ scheduleDrawerWaiverCreateInFlight = false; });
}
