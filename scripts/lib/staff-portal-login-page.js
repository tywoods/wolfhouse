'use strict';

const fs = require('fs');
const path = require('path');

const {
  getStaffPortalI18nBootstrapScript,
  getStaffPortalThemeEarlyScript,
} = require('./staff-portal-i18n');

const STAFF_LOGIN_CSS_PATH = path.join(__dirname, '..', '..', 'config', 'staff-portal', 'staff-login-page.css');
const STAFF_LOGIN_CSS_RAW = fs.readFileSync(STAFF_LOGIN_CSS_PATH, 'utf8');
const STAFF_LOGIN_CSS = STAFF_LOGIN_CSS_RAW.charCodeAt(0) === 0xFEFF ? STAFF_LOGIN_CSS_RAW.slice(1) : STAFF_LOGIN_CSS_RAW;

const ICON_BUILDING = '<svg class="fieldIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M4 21V5a1 1 0 0 1 1-1h5v3h4V4h5a1 1 0 0 1 1 1v16H4zm2-2h3v-3H6v3zm0-5h3v-3H6v3zm5 5h3v-3h-3v3zm0-5h3v-3h-3v3zm5 5h3v-3h-3v3zm0-5h3v-3h-3v3z"/></svg>';
const ICON_ENVELOPE = '<svg class="fieldIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4-8 5L4 8V6l8 5 8-5v2z"/></svg>';
const ICON_LOCK = '<svg class="fieldIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M17 9h-1V7a4 4 0 1 0-8 0v2H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2zm-3 0H10V7a2 2 0 1 1 4 0v2z"/></svg>';
const ICON_EYE = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 5C7 5 2.7 8.1 1 12c1.7 3.9 6 7 11 7s9.3-3.1 11-7c-1.7-3.9-6-7-11-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"/></svg>';
const ICON_EYE_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3.3 2.3 2 3.6l2.5 2.5C2.7 8.1 1 11 1 12c1.7 3.9 6 7 11 7 2.1 0 4-.5 5.7-1.3l2.8 2.8 1.3-1.3L3.3 2.3zM12 17c-2.8 0-5.2-1.4-6.7-3.5l1.5-1.5A6.9 6.9 0 0 0 12 15c1.2 0 2.3-.3 3.3-.8l1.5 1.5C14.2 16.5 13.1 17 12 17zm7-5c0-.7-.2-1.4-.5-2l1.4-1.4c.8 1 1.3 2.2 1.5 3.4l-2.4-2.4z"/></svg>';
const WAVE_DIVIDER = '<svg class="loginTitleWave" viewBox="0 0 56 10" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M2 6c4-4 8-4 12 0s8 4 12 0 8-4 12 0 8 4 12 0"/></svg>';
const FOOTER_WAVE = '<svg class="loginFooterWave" viewBox="0 0 44 8" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M2 5c3-3 6-3 9 0s6 3 9 0 6-3 9 0"/></svg>';
const SIGNIN_ICON = '<svg class="signInButtonIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 12c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5z"/></svg>';

const LOGIN_AUTH_SCRIPT = `
(function(){
  'use strict';
  var btn   = document.getElementById('btn-signin');
  var msg   = document.getElementById('msg');

  function showMsg(text, isError){
    msg.className = 'msg ' + (isError ? 'error' : 'ok');
    msg.textContent = text;
    msg.style.display = 'block';
  }

  function doSignIn(){
    btn.disabled = true;
    msg.style.display = 'none';

    var client   = document.getElementById('client').value.trim();
    var email    = document.getElementById('email').value.trim();
    var password = document.getElementById('password').value;

    if (!client || !email || !password){
      showMsg(window.t('login.allFieldsRequired'), true);
      btn.disabled = false;
      return;
    }

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/staff/auth/login', true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function(){
      var d = {};
      try { d = JSON.parse(xhr.responseText); } catch(_){}
      if (xhr.status === 200 && d.success){
        showMsg(window.t('login.success'), false);
        window.location.href = '/staff/ui';
      } else {
        showMsg(d.error || window.t('login.failed'), true);
        btn.disabled = false;
      }
    };
    xhr.onerror = function(){
      showMsg(window.t('login.networkError'), true);
      btn.disabled = false;
    };
    xhr.send(JSON.stringify({ client: client, email: email, password: password }));
  }

  btn.addEventListener('click', doSignIn);
  document.getElementById('password').addEventListener('keydown', function(e){
    if (e.key === 'Enter') doSignIn();
  });
  document.getElementById('email').addEventListener('keydown', function(e){
    if (e.key === 'Enter') doSignIn();
  });

  var pwInput = document.getElementById('password');
  var pwToggle = document.getElementById('password-toggle');
  if (pwInput && pwToggle){
    pwToggle.addEventListener('click', function(){
      var show = pwInput.type === 'password';
      pwInput.type = show ? 'text' : 'password';
      pwToggle.setAttribute('aria-pressed', show ? 'true' : 'false');
      pwToggle.setAttribute('aria-label', show ? window.t('login.hidePassword') : window.t('login.showPassword'));
      pwToggle.innerHTML = show ? ${JSON.stringify(ICON_EYE_OFF)} : ${JSON.stringify(ICON_EYE)};
    });
  }

  var helpBtn = document.getElementById('login-help-link');
  if (helpBtn){
    helpBtn.addEventListener('click', function(){
      showMsg(window.t('login.needHelpDetail'), false);
    });
  }
})();
`;

function buildStaffLoginHtml(loginDefaultClient, enabledLocales, langSwitchHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Luna Front Desk — Sign in</title>
${getStaffPortalThemeEarlyScript()}
<style>
${STAFF_LOGIN_CSS}
</style>
</head>
<body>
${getStaffPortalI18nBootstrapScript(enabledLocales)}
<div class="loginShell">
  <div class="loginStage">
    <div class="loginBotanicalDecor" aria-hidden="true"></div>
    <div class="loginCard">
      <div class="loginControlPill">
        <div class="staff-lang-switch-login" id="staff-lang-switch" aria-label="Language">
          ${langSwitchHtml}
        </div>
        <button type="button" class="staff-theme-toggle" id="staff-theme-toggle" aria-pressed="false" data-i18n-aria="app.theme.switchToDark" title="Switch to dark mode">
          <svg class="staff-theme-icon staff-theme-icon-moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M15.5 3.5a8.5 8.5 0 1 0 4.2 15.8 7 7 0 1 1-4.2-15.8z"/></svg>
          <svg class="staff-theme-icon staff-theme-icon-sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4.2" fill="currentColor"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="12" y1="2.2" x2="12" y2="5.2"/><line x1="12" y1="18.8" x2="12" y2="21.8"/><line x1="2.2" y1="12" x2="5.2" y2="12"/><line x1="18.8" y1="12" x2="21.8" y2="12"/><line x1="4.9" y1="4.9" x2="7.1" y2="7.1"/><line x1="16.9" y1="16.9" x2="19.1" y2="19.1"/><line x1="16.9" y1="7.1" x2="19.1" y2="4.9"/><line x1="4.9" y1="19.1" x2="7.1" y2="16.9"/></g></svg>
        </button>
      </div>

      <div class="loginLogoBlock">
        <img src="/staff/assets/luna-front-desk-logo.png?v=2" alt="Luna Front Desk" class="logo-img">
        <h1 class="loginTitle" data-i18n="login.sub">Staff sign in</h1>
        ${WAVE_DIVIDER}
      </div>

      <form id="login-form" autocomplete="on">
        <div class="field">
          <label for="client" data-i18n="login.company">Company</label>
          <div class="fieldInputWrap">
            ${ICON_BUILDING}
            <input id="client" name="client" type="text" value="${loginDefaultClient}" autocomplete="organization" spellcheck="false">
          </div>
        </div>
        <div class="field">
          <label for="email" data-i18n="login.email">Email</label>
          <div class="fieldInputWrap">
            ${ICON_ENVELOPE}
            <input id="email" name="email" type="email" placeholder="staff@example.com" autocomplete="username" required>
          </div>
        </div>
        <div class="field">
          <label for="password" data-i18n="login.password">Password</label>
          <div class="fieldInputWrap fieldInputWrap--password">
            ${ICON_LOCK}
            <input id="password" name="password" type="password" autocomplete="current-password" required>
            <button type="button" class="fieldPasswordToggle" id="password-toggle" aria-pressed="false" data-i18n-aria="login.showPassword" aria-label="Show password">
              ${ICON_EYE}
            </button>
          </div>
        </div>
        <button class="signInButton" id="btn-signin" type="button" data-i18n-aria="login.signIn" aria-label="Sign in">
          ${SIGNIN_ICON}
          <span data-i18n="login.signIn">Sign in</span>
        </button>
        <button type="button" class="loginHelpLink" id="login-help-link" data-i18n="login.needHelp">Need help signing in?</button>
        <div class="msg" id="msg"></div>
      </form>
    </div>

    <footer class="loginFooterBrand">
      <div class="loginFooterBrandTitle" data-i18n="login.footerTitle">Luna Front Desk</div>
      ${FOOTER_WAVE}
      <div class="loginFooterTagline" data-i18n="login.footerTagline">Guest care, always there.</div>
    </footer>
  </div>
</div>

<script>
${LOGIN_AUTH_SCRIPT}
</script>
</body>
</html>`;
}

module.exports = {
  buildStaffLoginHtml,
  STAFF_LOGIN_CSS_PATH,
};
