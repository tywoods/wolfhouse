'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Crowsnest static portal HTML (read-only skeleton — no writes, no API calls).
 */

const { getCrowsnestClients, getCrowsnestTemplates } = require('./crowsnest-clients');
const { renderCrowsnestOnboardingSection } = require('./crowsnest-onboarding');

const SUNSET_LOGIN_CSS = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'config', 'staff-portal', 'staff-login-page.css'),
  'utf8',
) + `
/* Crowsnest keeps the Sunset composition, with a more compact operator sign-in card. */
.loginStage{width:min(100%,380px)}
.loginCard{box-sizing:border-box}
.login-logo{display:block;width:min(100%,320px);height:auto;margin-inline:auto;margin-bottom:14px}
.login-error{margin:0 0 14px;padding:10px 13px;border-radius:10px;background:#FEF1EC;border:1px solid #F2C4AC;color:#9B4020;font-size:13px}
`;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderStyleTag(css, nonce) {
  const nonceAttr = nonce ? ` nonce="${escapeHtml(nonce)}"` : '';
  return `<style${nonceAttr}>\n${css}\n  </style>`;
}

function statusPillModifier(status) {
  const key = String(status || '').trim().toLowerCase();
  if (key === 'linked' || key === 'active' || key === 'live') return 'pill--success';
  if (key === 'coming soon' || key === 'coming_soon' || key === 'planned' || key === 'pending') return 'pill--amber';
  if (key === 'template') return 'pill--sea';
  if (key === 'off' || key === 'disabled' || key === 'error') return 'pill--danger';
  return 'pill--neutral';
}

function statusPillLabel(status) {
  const key = String(status || '').trim().toLowerCase();
  if (key === 'linked') return 'Live';
  if (key === 'coming_soon') return 'Coming soon';
  if (key === 'coming soon') return 'Coming soon';
  return String(status || 'Unknown');
}

function renderStatusPill(status) {
  const mod = statusPillModifier(status);
  const label = statusPillLabel(status);
  return `<span class="pill ${mod}"><span class="pill-dot" aria-hidden="true"></span>${escapeHtml(label)}</span>`;
}

function renderMetaChip(label, value) {
  return `<span class="meta-chip"><span class="meta-chip-label">${escapeHtml(label)}</span><span class="meta-chip-value">${escapeHtml(value)}</span></span>`;
}

function renderEnvironmentRow(env) {
  const linked = env.state === 'linked' && env.url;
  const stateClass = linked ? 'env-linked' : 'env-muted';
  let valueHtml;
  if (linked) {
    valueHtml = `<a class="env-link" href="${escapeHtml(env.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(env.url)}</a>`;
  } else {
    valueHtml = '<span class="env-coming-soon">Coming soon</span>';
  }
  const note = env.note ? `<p class="env-note">${escapeHtml(env.note)}</p>` : '';
  const envStatus = linked ? 'linked' : (env.state || 'coming_soon');

  return `<li class="env-row ${stateClass}">
      <div class="env-row-main">
        <div class="env-row-head">
          <span class="env-label">${escapeHtml(env.label)}</span>
          ${renderStatusPill(envStatus)}
        </div>
        <div class="env-value">${valueHtml}</div>
        ${note}
      </div>
    </li>`;
}

function renderClientCard(client) {
  const envRows = (client.environments || []).map(renderEnvironmentRow).join('\n        ');
  return `<article class="card client-card">
        <header class="client-card-head">
          <h2 class="client-name">${escapeHtml(client.name)}</h2>
          <div class="client-meta-row">
            ${renderMetaChip('slug', client.client_slug)}
            ${renderMetaChip('type', client.type)}
            <span class="meta-chip meta-chip--status">${renderStatusPill(client.status)}</span>
          </div>
        </header>
        <section class="env-section">
          <h3 class="env-heading">Environments / status</h3>
          <ul class="env-list">
        ${envRows}
          </ul>
        </section>
      </article>`;
}

const CROWSNEST_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --sand:#F4EFE6;
  --sand-deep:#E9E0D2;
  --surface:#FFFCF7;
  --surface-raised:#FFFFFF;
  --navy:#1E2A36;
  --charcoal:#2C3948;
  --text-2:#4F5D6B;
  --text-3:#6E7C89;
  --sea:#4A7C94;
  --sea-soft:#D8E8F0;
  --sea-link:#2F6F8F;
  --amber:#9A6B1B;
  --amber-soft:#F6EBD3;
  --green:#2F6B52;
  --green-soft:#D9EDE3;
  --red:#9B4545;
  --red-soft:#F4DEDE;
  --border:#E2D8CA;
  --border-soft:#EDE6DB;
  --shadow:0 10px 30px rgba(30,42,54,.07);
  --shadow-soft:0 2px 10px rgba(30,42,54,.05);
  --radius:16px;
  --radius-sm:10px;
  --radius-pill:999px;
  --focus:0 0 0 3px rgba(74,124,148,.28);
  --max:1120px;
}
html{font-size:16px}
body{
  min-height:100vh;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  color:var(--charcoal);
  background:
    radial-gradient(circle at 12% 0%,rgba(201,123,90,.08),transparent 34%),
    radial-gradient(circle at 88% 8%,rgba(74,124,148,.10),transparent 30%),
    linear-gradient(180deg,var(--sand) 0%,#F7F2EA 42%,var(--sand-deep) 100%);
  line-height:1.45;
  -webkit-font-smoothing:antialiased;
}
a{color:var(--sea-link);text-decoration:none}
a:hover{color:#245A75}
a:focus-visible,button:focus-visible{outline:none;box-shadow:var(--focus)}
.wrap{
  max-width:var(--max);
  margin:0 auto;
  padding:20px 16px 40px;
}
@media(min-width:720px){
  .wrap{padding:28px 24px 48px}
}
.page-header{
  margin-bottom:22px;
  padding:22px 20px 18px;
  background:linear-gradient(135deg,rgba(255,252,247,.96),rgba(255,255,255,.88));
  border:1px solid var(--border-soft);
  border-radius:calc(var(--radius) + 2px);
  box-shadow:var(--shadow-soft);
}
@media(min-width:720px){
  .page-header{padding:26px 24px 20px;margin-bottom:26px}
}
.eyebrow-row{
  display:flex;
  align-items:center;
  gap:10px;
  flex-wrap:wrap;
  margin-bottom:10px;
}
.page-header-top{
  display:flex;
  align-items:flex-start;
  justify-content:space-between;
  gap:14px;
  flex-wrap:wrap;
}
.logout-form{
  margin-left:auto;
}
.logout-button{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  min-height:40px;
  padding:0 14px;
  border-radius:var(--radius-sm);
  border:1px solid rgba(155,69,69,.22);
  background:linear-gradient(180deg,#F6E7E7 0%,#EFD8D8 100%);
  color:#7B3030;
  font-size:14px;
  font-weight:800;
  cursor:pointer;
  box-shadow:var(--shadow-soft);
  white-space:nowrap;
}
.logout-button:hover{background:linear-gradient(180deg,#F4E0E0 0%,#E8CCCC 100%)}
.top-nav{
  display:flex;
  flex-wrap:wrap;
  gap:8px;
  align-items:center;
  margin:14px 0 4px;
  padding-bottom:2px;
  overflow-x:auto;
  -webkit-overflow-scrolling:touch;
}
.top-nav-link{
  display:inline-flex;
  align-items:center;
  min-height:36px;
  padding:0 12px;
  border-radius:var(--radius-pill);
  border:1px solid transparent;
  color:var(--text-2);
  font-size:13px;
  font-weight:700;
  white-space:nowrap;
  background:transparent;
}
.top-nav-link:hover{color:var(--navy);background:rgba(74,124,148,.08)}
.top-nav-link.is-active{
  color:var(--navy);
  background:var(--sea-soft);
  border-color:rgba(74,124,148,.22);
}
.overview-grid{
  display:grid;
  grid-template-columns:1fr;
  gap:12px;
}
@media(min-width:720px){
  .overview-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
}
.overview-card h2{
  margin:0 0 8px;
  font-size:13px;
  font-weight:800;
  letter-spacing:.05em;
  text-transform:uppercase;
  color:var(--text-3);
}
.overview-value{
  font-size:1.6rem;
  font-weight:800;
  color:var(--navy);
  letter-spacing:-.02em;
  line-height:1.1;
}
.overview-value--muted{
  font-size:1.05rem;
  font-weight:700;
  color:var(--text-3);
}
.overview-note{
  margin-top:8px;
  font-size:12px;
  color:var(--text-3);
  line-height:1.45;
}
.placeholder-shell{
  padding:18px;
}
.placeholder-shell p{margin:0 0 10px;color:var(--text-2);font-size:15px;max-width:60ch}
.ops-badge{
  display:inline-flex;
  align-items:center;
  gap:6px;
  padding:5px 10px;
  border-radius:var(--radius-pill);
  font-size:11px;
  font-weight:700;
  letter-spacing:.06em;
  text-transform:uppercase;
  color:var(--sea);
  background:var(--sea-soft);
  border:1px solid rgba(74,124,148,.18);
}
.ops-badge-dot{width:6px;height:6px;border-radius:50%;background:var(--sea)}
h1.page-title{
  margin:0 0 6px;
  font-size:clamp(1.75rem,4vw,2.2rem);
  font-weight:800;
  letter-spacing:-.03em;
  color:var(--navy);
  line-height:1.1;
}
.sub{
  color:var(--text-2);
  margin:0;
  font-size:15px;
  max-width:52ch;
}
section{margin-bottom:24px}
h2.section{
  margin:0 0 10px;
  font-size:12px;
  font-weight:800;
  letter-spacing:.08em;
  text-transform:uppercase;
  color:var(--text-3);
}
.section-note{
  margin:0 0 12px;
  font-size:13px;
  color:var(--text-3);
  line-height:1.45;
}
.cards{
  display:grid;
  grid-template-columns:1fr;
  gap:14px;
}
@media(min-width:720px){
  .cards{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
}
.card{
  background:var(--surface-raised);
  border:1px solid var(--border-soft);
  border-radius:var(--radius);
  box-shadow:var(--shadow-soft);
  padding:18px 18px 16px;
  transition:border-color .18s ease,box-shadow .18s ease;
}
.card:hover{border-color:rgba(74,124,148,.28);box-shadow:var(--shadow)}
.card:focus-within{border-color:rgba(74,124,148,.35);box-shadow:var(--shadow),var(--focus)}
.client-name,.template-card h2{
  margin:0 0 10px;
  font-size:1.15rem;
  font-weight:800;
  color:var(--navy);
  letter-spacing:-.02em;
}
.client-meta-row,.template-meta-row{
  display:flex;
  flex-wrap:wrap;
  gap:8px;
  align-items:center;
}
.meta-chip{
  display:inline-flex;
  align-items:center;
  gap:6px;
  padding:5px 10px;
  border-radius:var(--radius-pill);
  background:#F6F1EA;
  border:1px solid var(--border-soft);
  font-size:12px;
  color:var(--text-2);
}
.meta-chip-label{
  font-weight:700;
  color:var(--text-3);
  text-transform:uppercase;
  letter-spacing:.04em;
  font-size:10px;
}
.meta-chip-value{font-weight:600;color:var(--charcoal)}
.meta-chip--status{background:transparent;border:none;padding:0}
.pill{
  display:inline-flex;
  align-items:center;
  gap:6px;
  padding:4px 10px;
  border-radius:var(--radius-pill);
  font-size:11px;
  font-weight:700;
  letter-spacing:.03em;
  text-transform:uppercase;
  border:1px solid transparent;
  white-space:nowrap;
}
.pill-dot{width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.85}
.pill--success{color:var(--green);background:var(--green-soft);border-color:rgba(47,107,82,.18)}
.pill--amber{color:var(--amber);background:var(--amber-soft);border-color:rgba(154,107,27,.18)}
.pill--sea{color:var(--sea);background:var(--sea-soft);border-color:rgba(74,124,148,.18)}
.pill--danger{color:var(--red);background:var(--red-soft);border-color:rgba(155,69,69,.18)}
.pill--neutral{color:var(--text-2);background:#F1ECE5;border-color:var(--border-soft)}
.env-section{
  margin-top:14px;
  padding-top:14px;
  border-top:1px solid var(--border-soft);
}
.env-heading{
  margin:0 0 10px;
  font-size:12px;
  font-weight:700;
  letter-spacing:.05em;
  text-transform:uppercase;
  color:var(--text-3);
}
.env-list{list-style:none;display:grid;gap:10px}
.env-row{
  border:1px solid var(--border-soft);
  border-radius:var(--radius-sm);
  background:linear-gradient(180deg,#FFFCF8 0%,#FAF6F0 100%);
  padding:12px;
}
.env-row-head{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  flex-wrap:wrap;
  margin-bottom:6px;
}
.env-label{
  font-size:13px;
  font-weight:700;
  color:var(--navy);
}
.env-value{font-size:13px;line-height:1.45;word-break:break-word}
.env-link{
  color:var(--sea-link);
  font-weight:600;
  border-bottom:1px solid rgba(47,111,143,.22);
}
.env-link:hover{color:#1F5873;border-bottom-color:rgba(47,111,143,.45)}
.env-coming-soon{color:var(--text-3);font-style:italic}
.env-muted .env-label{color:var(--text-2)}
.env-note{margin-top:6px;font-size:12px;color:var(--text-3)}
.template-card .badge{display:none}
.template-status{margin-top:4px}
.cta-row{
  display:flex;
  align-items:center;
  gap:12px;
  flex-wrap:wrap;
  margin-top:14px;
}
.btn-disabled{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  min-height:42px;
  padding:0 18px;
  border-radius:var(--radius-sm);
  font-size:14px;
  font-weight:700;
  cursor:not-allowed;
  color:#F4F7F9;
  background:linear-gradient(180deg,#A9BEC9 0%,#91A9B6 100%);
  border:1px solid #8AA0AD;
}
.cta-helper{font-size:12px;color:var(--text-3)}
.onboarding-card{padding:18px}
.onboarding-form .form-row{margin-bottom:12px}
.onboarding-form label{
  display:block;
  font-size:12px;
  font-weight:700;
  color:var(--text-3);
  text-transform:uppercase;
  letter-spacing:.04em;
  margin-bottom:6px;
}
.onboarding-form input,.onboarding-form select,.onboarding-form textarea{
  width:100%;
  max-width:100%;
  box-sizing:border-box;
  padding:10px 12px;
  border:1px solid var(--border-soft);
  border-radius:var(--radius-sm);
  font-size:14px;
  background:#F8F4EE;
  color:var(--text-3);
}
.form-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}
.form-actions .btn-disabled{margin-top:0}
.onboarding-checklist{
  margin-top:16px;
  padding-top:16px;
  border-top:1px solid var(--border-soft);
}
.checklist-heading{
  margin:0 0 10px;
  font-size:12px;
  font-weight:700;
  letter-spacing:.05em;
  text-transform:uppercase;
  color:var(--text-3);
}
.checklist{margin:0;padding-left:18px;font-size:13px;color:var(--text-2)}
.checklist li{margin:8px 0;display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.check-label{margin-right:4px}
.checklist .badge{display:none}
.safety{
  margin-top:20px;
  padding:14px 16px;
  border-radius:var(--radius);
  border:1px solid #E8D2A5;
  background:linear-gradient(180deg,#FFF8EA 0%,#F8EFD9 100%);
  color:#6A4E12;
  font-size:14px;
  line-height:1.5;
  box-shadow:var(--shadow-soft);
}
.safety strong{color:#4F3910}
`;

const CROWSNEST_LOGIN_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --sand:#F4EFE6;
  --sand-deep:#E9E0D2;
  --surface:#FFFCF7;
  --surface-raised:#FFFFFF;
  --navy:#1E2A36;
  --charcoal:#2C3948;
  --text-2:#4F5D6B;
  --text-3:#6E7C89;
  --sea:#4A7C94;
  --sea-soft:#D8E8F0;
  --sea-link:#2F6F8F;
  --border:#E2D8CA;
  --border-soft:#EDE6DB;
  --shadow:0 16px 40px rgba(30,42,54,.09);
  --shadow-soft:0 2px 10px rgba(30,42,54,.05);
  --radius:18px;
  --radius-sm:12px;
  --radius-pill:999px;
  --focus:0 0 0 3px rgba(74,124,148,.28);
}
html{font-size:16px}
body{
  min-height:100vh;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  color:var(--charcoal);
  background:
    radial-gradient(circle at 14% 0%,rgba(201,123,90,.08),transparent 32%),
    radial-gradient(circle at 88% 8%,rgba(74,124,148,.10),transparent 30%),
    linear-gradient(180deg,var(--sand) 0%,#F7F2EA 42%,var(--sand-deep) 100%);
  line-height:1.45;
  -webkit-font-smoothing:antialiased;
}
a{color:var(--sea-link);text-decoration:none}
a:focus-visible,button:focus-visible,input:focus-visible{outline:none;box-shadow:var(--focus)}
.login-shell{
  min-height:100vh;
  display:grid;
  place-items:center;
  padding:20px 16px;
}
@media(min-width:720px){
  .login-shell{padding:32px 24px}
}
.login-card{
  width:min(100%, 560px);
  background:linear-gradient(135deg,rgba(255,252,247,.98),rgba(255,255,255,.92));
  border:1px solid var(--border-soft);
  border-radius:calc(var(--radius) + 2px);
  box-shadow:var(--shadow);
  padding:22px 18px 20px;
}
@media(min-width:720px){
  .login-card{padding:28px 28px 26px}
}
.login-logo{
  display:block;
  width:min(100%, 460px);
  height:auto;
  margin-inline:auto;
  margin-bottom:18px;
}
.login-kicker{
  display:inline-flex;
  align-items:center;
  gap:8px;
  margin-bottom:10px;
  padding:5px 10px;
  border-radius:var(--radius-pill);
  font-size:11px;
  font-weight:800;
  letter-spacing:.06em;
  text-transform:uppercase;
  color:var(--sea);
  background:var(--sea-soft);
  border:1px solid rgba(74,124,148,.18);
}
.login-title{
  margin:0 0 8px;
  font-size:clamp(1.65rem,4vw,2.1rem);
  font-weight:800;
  letter-spacing:-.03em;
  color:var(--navy);
  line-height:1.1;
}
.login-copy{
  margin:0 0 18px;
  color:var(--text-2);
  font-size:15px;
  max-width:54ch;
}
.login-error{
  margin:0 0 14px;
  padding:12px 14px;
  border-radius:var(--radius-sm);
  background:#F4DEDE;
  border:1px solid rgba(155,69,69,.18);
  color:#7B3030;
  font-size:14px;
}
.login-form{display:grid;gap:14px}
.field{display:grid;gap:6px}
.field-label{
  font-size:12px;
  font-weight:800;
  letter-spacing:.05em;
  text-transform:uppercase;
  color:var(--text-3);
}
.field-input{
  width:100%;
  padding:12px 14px;
  border:1px solid var(--border);
  border-radius:var(--radius-sm);
  background:#FFFDF9;
  color:var(--charcoal);
  font-size:15px;
}
.field-input::placeholder{color:#9CA7B0}
.login-button{
  min-height:46px;
  padding:0 16px;
  border:1px solid rgba(74,124,148,.28);
  border-radius:var(--radius-sm);
  background:linear-gradient(180deg,#4F8199 0%,#3F6F86 100%);
  color:#FFFFFF;
  font-size:15px;
  font-weight:800;
  cursor:pointer;
  box-shadow:var(--shadow-soft);
}
.login-footer{
  margin-top:14px;
  font-size:12px;
  color:var(--text-3);
}
.sr-only{
  position:absolute;
  width:1px;
  height:1px;
  padding:0;
  margin:-1px;
  overflow:hidden;
  clip:rect(0,0,0,0);
  white-space:nowrap;
  border:0;
}
`;

const CROWSNEST_VIEWS = new Set(['spyglass', 'clients', 'billing', 'communications']);

const CROWSNEST_NAV_ITEMS = [
  { view: 'spyglass', href: '/', label: 'Spyglass' },
  { view: 'clients', href: '/clients', label: 'Clients' },
  { view: 'billing', href: '/billing', label: 'Billing' },
  { view: 'communications', href: '/communications', label: 'Communications' },
];

function normalizeCrowsnestView(raw) {
  const key = String(raw == null ? 'spyglass' : raw).trim().toLowerCase();
  return CROWSNEST_VIEWS.has(key) ? key : 'spyglass';
}

function renderCrowsnestNav(activeView) {
  const view = normalizeCrowsnestView(activeView);
  const links = CROWSNEST_NAV_ITEMS.map((item) => {
    const current = item.view === view;
    const aria = current ? ' aria-current="page"' : '';
    const cls = current ? 'top-nav-link is-active' : 'top-nav-link';
    return `<a class="${cls}" href="${escapeHtml(item.href)}"${aria}>${escapeHtml(item.label)}</a>`;
  }).join('\n        ');
  return `<nav class="top-nav" aria-label="Crowsnest sections">
        ${links}
      </nav>`;
}

function countStaticEnvironmentStats(clients) {
  let linkedEnvironments = 0;
  let staticEnvironments = 0;
  for (const client of clients) {
    for (const env of client.environments || []) {
      if (env && env.state === 'linked') linkedEnvironments += 1;
      else staticEnvironments += 1;
    }
  }
  return {
    clientCount: clients.length,
    linkedEnvironments,
    staticEnvironments,
  };
}

function renderSpyglassMain(clients) {
  const stats = countStaticEnvironmentStats(clients);
  return `<section id="spyglass" aria-labelledby="spyglass-title">
      <p class="section-note">Overview from in-memory static placeholders only — no live health checks, telemetry, or billing feeds.</p>
      <div class="overview-grid">
        <article class="card overview-card">
          <h2>Clients</h2>
          <p class="overview-value">${escapeHtml(String(stats.clientCount))}</p>
          <p class="overview-note">Counted from the static client array.</p>
        </article>
        <article class="card overview-card">
          <h2>Linked environments</h2>
          <p class="overview-value">${escapeHtml(String(stats.linkedEnvironments))}</p>
          <p class="overview-note">Environments marked linked in static data.</p>
        </article>
        <article class="card overview-card">
          <h2>Static / coming soon</h2>
          <p class="overview-value">${escapeHtml(String(stats.staticEnvironments))}</p>
          <p class="overview-note">Placeholder environment rows (not live-checked).</p>
        </article>
        <article class="card overview-card">
          <h2>AI usage</h2>
          <p class="overview-value overview-value--muted">n/a — not connected</p>
          <p class="overview-note">No AI usage data source in this slice.</p>
        </article>
        <article class="card overview-card">
          <h2>Billing</h2>
          <p class="overview-value overview-value--muted">n/a — not connected</p>
          <p class="overview-note">No billing amounts or invoices are available yet.</p>
        </article>
        <article class="card overview-card">
          <h2>Communications</h2>
          <p class="overview-value overview-value--muted">n/a — not connected</p>
          <p class="overview-note">No communications feed or send path is connected.</p>
        </article>
      </div>
      <div class="safety"><strong>Safety:</strong> Read-only Spyglass shell. No live writes, no invented AI/cost/billing numbers, and no production actions are enabled.</div>
    </section>`;
}

function renderClientsMain(clients, templates) {
  const clientCards = clients.map(renderClientCard).join('\n      ');
  const templateCards = templates.map((t) => `<article class="card template-card">
        <h2>${escapeHtml(t.label)}</h2>
        <div class="template-status">${renderStatusPill(t.status)}</div>
      </article>`).join('\n      ');
  const onboardingSection = renderCrowsnestOnboardingSection();
  return `<section id="clients">
      <h2 class="section">Clients</h2>
      <p class="section-note">Static placeholders only — no live health checks yet.</p>
      <div class="cards">
      ${clientCards}
      </div>
      <div class="cta-row">
        <button type="button" class="btn-disabled" disabled aria-disabled="true">Add new client</button>
        <span class="cta-helper">Coming soon</span>
      </div>
    </section>

    ${onboardingSection}

    <section id="templates">
      <h2 class="section">Templates</h2>
      <div class="cards">
      ${templateCards}
      </div>
    </section>

    <div class="safety"><strong>Safety:</strong> Read-only skeleton. No client creation, tenant writes, WhatsApp, Stripe, or production actions are enabled.</div>`;
}

function renderBillingMain() {
  return `<section id="billing" class="card placeholder-shell" aria-labelledby="billing-title">
      <p>Billing data sources are <strong>not connected</strong> yet.</p>
      <p>No invoices, balances, payment mutations, or fake amounts are shown in this slice.</p>
      <div class="safety"><strong>Safety:</strong> Read-only placeholder. No billing writes or live network calls.</div>
    </section>`;
}

function renderCommunicationsMain() {
  return `<section id="communications" class="card placeholder-shell" aria-labelledby="communications-title">
      <p>Communications data sources and actions are <strong>not connected</strong> yet.</p>
      <p>No send controls, address pickers, or invented message counts are available in this slice.</p>
      <div class="safety"><strong>Safety:</strong> Read-only placeholder. No outbound messaging or live network calls.</div>
    </section>`;
}

function renderViewMain(view, clients, templates) {
  if (view === 'clients') return renderClientsMain(clients, templates);
  if (view === 'billing') return renderBillingMain();
  if (view === 'communications') return renderCommunicationsMain();
  return renderSpyglassMain(clients);
}

function viewPageTitle(view) {
  if (view === 'clients') return 'Clients';
  if (view === 'billing') return 'Billing';
  if (view === 'communications') return 'Communications';
  return 'Spyglass';
}

function viewSubtitle(view) {
  if (view === 'clients') return 'Static client cards, templates, and onboarding mockup';
  if (view === 'billing') return 'Billing sources are not connected yet';
  if (view === 'communications') return 'Communications sources are not connected yet';
  return 'Internal Luna Front Desk overview dashboard';
}

function renderCrowsnestPage(options = {}) {
  const nonce = options.cspNonce ? String(options.cspNonce) : '';
  const view = normalizeCrowsnestView(options.view != null ? options.view : options.route);
  const clients = getCrowsnestClients();
  const templates = getCrowsnestTemplates();
  const title = viewPageTitle(view);
  const main = renderViewMain(view, clients, templates);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${escapeHtml(title)} — Crowsnest</title>
  ${renderStyleTag(CROWSNEST_CSS, nonce)}
</head>
<body>
  <div class="wrap">
    <header class="page-header">
      <div class="page-header-top">
        <div class="eyebrow-row">
          <span class="ops-badge"><span class="ops-badge-dot" aria-hidden="true"></span>Internal Ops</span>
        </div>
        <form class="logout-form" method="post" action="/logout">
          <button class="logout-button" type="submit" aria-label="Sign out of Crowsnest">Sign out</button>
        </form>
      </div>
      ${renderCrowsnestNav(view)}
      <h1 class="page-title" id="${escapeHtml(view)}-title">${escapeHtml(title)}</h1>
      <p class="sub">${escapeHtml(viewSubtitle(view))}</p>
    </header>

    ${main}
  </div>
</body>
</html>`;
}

function renderCrowsnestLoginPage(options = {}) {
  const nonce = options.cspNonce ? String(options.cspNonce) : '';
  const errorHtml = options.invalidCredentials
    ? '<p class="login-error" role="alert">Invalid credentials. Try again.</p>'
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Crowsnest sign in</title>
  ${renderStyleTag(SUNSET_LOGIN_CSS, nonce)}
</head>
<body>
  <main class="loginShell">
    <div class="loginStage">
      <div class="loginBotanicalDecor" aria-hidden="true"></div>
      <section class="loginCard" aria-labelledby="login-title">
        <div class="loginLogoBlock">
          <img class="login-logo" src="/crowsnest/assets/logo.png" alt="Crowsnest" width="2172" height="724">
          <h1 class="loginTitle" id="login-title">Sign in to Crowsnest</h1>
          <svg class="loginTitleWave" viewBox="0 0 56 10" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M2 6c4-4 8-4 12 0s8 4 12 0 8-4 12 0 8 4 12 0"/></svg>
        </div>
        ${errorHtml}
        <form id="login-form" method="post" action="/login" accept-charset="utf-8" autocomplete="on">
          <div class="field">
            <label for="username">Username</label>
            <div class="fieldInputWrap">
              <svg class="fieldIcon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5z"/></svg>
              <input id="username" name="username" type="text" autocomplete="username" required>
            </div>
          </div>
          <div class="field">
            <label for="password">Password</label>
            <div class="fieldInputWrap fieldInputWrap--password">
              <svg class="fieldIcon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17 9h-1V7a4 4 0 1 0-8 0v2H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2zm-3 0H10V7a2 2 0 1 1 4 0v2z"/></svg>
              <input id="password" name="password" type="password" autocomplete="current-password" required>
            </div>
          </div>
          <button class="signInButton" type="submit">
            <svg class="signInButtonIcon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 12c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5z"/></svg>
            <span>Sign in</span>
          </button>
        </form>
      </section>
      <footer class="loginFooterBrand">
        <div class="loginFooterBrandTitle">Luna Front Desk</div>
        <svg class="loginFooterWave" viewBox="0 0 44 8" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M2 5c3-3 6-3 9 0s6 3 9 0 6-3 9 0"/></svg>
        <div class="loginFooterTagline">Guest care, always there.</div>
      </footer>
    </div>
  </main>
</body>
</html>`;
}

module.exports = {
  renderCrowsnestPage,
  renderCrowsnestLoginPage,
};
