'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Crowsnest static portal HTML (read-only skeleton — no writes, no API calls).
 */

const { getCrowsnestClients, getCrowsnestTemplates } = require('./crowsnest-clients');
const { renderCrowsnestOnboardingSection } = require('./crowsnest-onboarding');
const { getSampleAiUsage } = require('./crowsnest-sample-telemetry');

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
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,.btn-primary:focus-visible{
  outline:none;box-shadow:var(--focus)
}
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
.sales-form .form-row{margin-bottom:12px}
.sales-form label{
  display:block;
  margin:0 0 6px;
  font-size:11px;
  font-weight:700;
  letter-spacing:.06em;
  text-transform:uppercase;
  color:var(--text-3);
}
.sales-form input,.sales-form textarea,.sales-form select{
  width:100%;
  box-sizing:border-box;
  min-height:40px;
  padding:8px 12px;
  border:1px solid rgba(30,42,54,.16);
  border-radius:10px;
  background:#fff;
  color:var(--navy);
  font:inherit;
}
.sales-form textarea{min-height:88px;resize:vertical}
.sales-error{
  margin:0 0 12px;
  padding:10px 12px;
  border-radius:10px;
  background:#FEF1EC;
  border:1px solid #F2C4AC;
  color:#9B4020;
  font-size:13px;
}
.evidence-entry{
  border-top:1px solid var(--line,#d7e0ea);
  margin-top:14px;
  padding-top:12px;
}
.btn-primary{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  min-height:40px;
  padding:0 16px;
  border:0;
  border-radius:var(--radius-pill);
  background:linear-gradient(180deg,#4A7C94 0%,#3A657A 100%);
  color:#fff;
  font-size:14px;
  font-weight:800;
  cursor:pointer;
  box-shadow:var(--shadow-soft);
  text-decoration:none;
}
.btn-primary:hover{filter:brightness(1.05)}
a.btn-primary:hover{text-decoration:none;color:#fff}
.prospect-list{display:grid;gap:10px;margin:0;padding:0;list-style:none}
.prospect-list a{color:var(--sea);font-weight:700;text-decoration:none}
.prospect-list a:hover{text-decoration:underline}
.prospect-card{
  padding:12px 14px;
  display:grid;
  gap:6px;
}
.prospect-card .overview-note{margin:0;font-size:13px;color:var(--text-3)}
.sales-cockpit-header{
  display:flex;
  flex-wrap:wrap;
  align-items:flex-start;
  justify-content:space-between;
  gap:12px;
  margin-bottom:16px;
}
.sales-cockpit-header .section-note{margin:0;max-width:52ch}
.sales-cockpit-grid{
  display:grid;
  grid-template-columns:1fr;
  gap:18px;
  margin:0 0 18px;
}
.sales-cockpit-primary,.sales-cockpit-prospects{min-width:0}
.sales-secondary-nav{
  display:grid;
  grid-template-columns:1fr;
  gap:12px;
  margin:0 0 18px;
  padding:0;
  list-style:none;
}
@media(min-width:720px){
  .sales-cockpit-grid{grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:20px;align-items:start}
  .sales-secondary-nav{grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
}
.sales-nav-group{
  margin:0;
  padding:12px 14px;
  background:var(--surface-raised);
  border:1px solid var(--border-soft);
  border-radius:var(--radius-sm);
  box-shadow:var(--shadow-soft);
}
.sales-nav-group-title{
  margin:0 0 8px;
  font-size:11px;
  font-weight:800;
  letter-spacing:.06em;
  text-transform:uppercase;
  color:var(--text-3);
}
.sales-nav-group ul{margin:0;padding:0;list-style:none;display:grid;gap:6px}
.sales-nav-group a{color:var(--sea);font-weight:600;text-decoration:none;font-size:14px}
.sales-nav-group a:hover{text-decoration:underline}
.sales-room-back{margin:0 0 12px;font-size:14px}
.sales-room-back a{color:var(--sea);font-weight:600;text-decoration:none}
.sales-room-back a:hover{text-decoration:underline}
.safety-badge,.contextual-safety{
  display:inline-flex;align-items:center;padding:3px 9px;border-radius:var(--radius-pill);
  font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;
  color:#6A4E12;background:linear-gradient(180deg,#FFF7E7 0%,#FBEFD6 100%);
  border:1px solid rgba(154,107,27,.28);vertical-align:middle;
}
.safety-context{
  display:inline;margin-left:6px;font-size:13px;color:#6A4E12;line-height:1.4;
}
.sales-action-safety{
  display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 10px;
}
.sales-pipeline{
  display:grid;
  grid-template-columns:1fr;
  gap:10px;
  margin:0 0 16px;
}
@media(min-width:720px){
  .sales-pipeline{grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}
}
.sales-pipeline .kpi{padding:10px 12px}
.sales-status-chip{
  display:inline-flex;
  align-items:center;
  gap:6px;
  max-width:100%;
  padding:3px 10px;
  border-radius:var(--radius-pill);
  font-size:11px;
  font-weight:700;
  letter-spacing:.02em;
  color:var(--navy);
  background:var(--sea-soft);
  border:1px solid rgba(74,124,148,.22);
  vertical-align:middle;
}
.sales-status-chip-text{
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:11px;
  word-break:break-word;
}
.sales-action-queue{margin:0 0 18px;padding:0;list-style:none;display:grid;gap:8px}
.sales-action-queue .prospect-card,.sales-action-card{padding:10px 12px}
.sales-action-card{
  border-left:3px solid var(--sea);
  background:linear-gradient(180deg,var(--surface-raised) 0%,#F7FBFD 100%);
}
.sales-action-card a{font-weight:800}
.sales-workspace-header{
  display:grid;
  gap:10px;
  margin:0 0 18px;
  padding:16px 18px;
  background:var(--surface-raised);
  border:1px solid var(--border-soft);
  border-radius:var(--radius-sm);
  box-shadow:var(--shadow-soft);
}
.sales-workspace-header h1{
  margin:0;
  font-size:clamp(1.35rem,3vw,1.75rem);
  font-weight:800;
  letter-spacing:-.02em;
  color:var(--navy);
  line-height:1.15;
}
.sales-workspace-meta{
  margin:0;
  display:flex;
  flex-wrap:wrap;
  align-items:center;
  gap:8px 14px;
  font-size:13px;
  color:var(--text-2);
}
.sales-next-step{
  margin:0;
  padding:10px 12px;
  border-radius:10px;
  background:var(--sea-soft);
  border:1px solid rgba(74,124,148,.2);
  color:var(--navy);
  font-size:14px;
  font-weight:700;
  line-height:1.4;
}
.sales-workspace-nav{
  display:flex;
  flex-wrap:wrap;
  gap:8px 12px;
  margin:0 0 18px;
  padding:0;
  list-style:none;
  font-size:13px;
}
.sales-workspace-nav a{color:var(--sea);font-weight:600;text-decoration:none}
.sales-workspace-nav a:hover{text-decoration:underline}
.sales-workspace-section{margin-bottom:18px}
.sales-workspace-section > h2{
  margin:0 0 10px;
  font-size:1.05rem;
  font-weight:800;
  letter-spacing:-.01em;
  color:var(--navy);
}
.sales-workspace-secondary{
  margin:0 0 14px;
  padding:12px 14px;
  border:1px solid var(--border-soft);
  border-radius:var(--radius-sm);
  background:var(--surface-raised);
}
.sales-workspace-secondary > summary{
  cursor:pointer;
  font-weight:700;
  color:var(--navy);
  list-style:disclosure-closed;
}
.sales-workspace-secondary[open] > summary{margin-bottom:12px;list-style:disclosure-open}
.sales-workspace-secondary .card{box-shadow:none}
.review-queue-list{display:grid;gap:12px;margin:0;padding:0;list-style:none}
.review-queue-item{padding:14px 16px}
.review-queue-meta{display:grid;gap:4px;margin-top:8px;color:var(--ink-muted);font-size:.92rem}
.review-filter-form .form-row{display:flex;flex-wrap:wrap;gap:12px;align-items:end}
.review-filter-form .form-actions{margin:0}
.review-bucket-label{font-weight:700}
.audit-list{display:grid;gap:8px;margin:0;padding:0;list-style:none}
.audit-list li{
  padding:10px 12px;
  border:1px solid rgba(30,42,54,.1);
  border-radius:10px;
  background:#fff;
  font-size:13px;
  color:var(--text-2);
}
.fact-list{margin:0;padding-left:18px;color:var(--text-2);font-size:14px}
.decision-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px}
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
.refresh-panel{margin:18px 0 22px}
.refresh-form .form-actions{margin-top:8px}
.refresh-coverage{
  margin-top:14px;
  padding:12px 14px;
  border-radius:var(--radius-sm);
  background:var(--sea-soft);
  border:1px solid #C5D9E4;
}
.refresh-coverage-summary{margin:0 0 10px;font-size:13px;color:var(--text-2);line-height:1.45}
.refresh-coverage-list{list-style:none;display:grid;gap:8px;margin:0;padding:0}
.refresh-coverage-item{
  display:flex;
  flex-wrap:wrap;
  align-items:center;
  justify-content:space-between;
  gap:8px;
  font-size:14px;
}
.refresh-client{font-weight:600;color:var(--navy)}
.refresh-status{color:var(--text-2)}

/* ── Iris: sample banner ── */
.sample-banner{
  display:flex;align-items:flex-start;gap:9px;
  margin-bottom:16px;padding:11px 14px;
  border-radius:var(--radius-sm);
  border:1px solid rgba(154,107,27,.25);
  background:linear-gradient(180deg,#FFF7E7 0%,#FBEFD6 100%);
  color:#6A4E12;font-size:13px;line-height:1.45;
}
.sample-banner strong{color:#4F3910}
.sample-dot{flex:none;width:8px;height:8px;margin-top:5px;border-radius:50%;background:var(--amber)}

/* ── Iris: KPI strip ── */
.kpi-strip{
  display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:18px;
}
@media(min-width:720px){.kpi-strip{grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}}
.kpi{
  background:var(--surface-raised);border:1px solid var(--border-soft);
  border-radius:var(--radius-sm);box-shadow:var(--shadow-soft);padding:12px 14px;
}
.kpi-label{display:block;font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--text-3)}
.kpi-value{display:block;margin-top:4px;font-size:1.5rem;font-weight:800;color:var(--navy);letter-spacing:-.02em;line-height:1.1}
.kpi-sub{display:block;margin-top:2px;font-size:11px;color:var(--text-3)}
.kpi--alert .kpi-value{color:var(--amber)}

/* ── Iris: panels ── */
.panel{
  background:var(--surface-raised);border:1px solid var(--border-soft);
  border-radius:var(--radius);box-shadow:var(--shadow-soft);
  padding:18px;margin-bottom:18px;
}
.panel-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.panel-title{margin:0;font-size:1.1rem;font-weight:800;color:var(--navy);letter-spacing:-.02em}
.sample-badge{
  display:inline-flex;align-items:center;padding:3px 9px;border-radius:var(--radius-pill);
  font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;
  color:var(--amber);background:var(--amber-soft);border:1px solid rgba(154,107,27,.25);
}
.panel-window{margin-left:auto;font-size:12px;color:var(--text-3)}

/* ── Iris: AI usage metric tiles ── */
.metric-tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
@media(min-width:720px){.metric-tiles{grid-template-columns:repeat(5,minmax(0,1fr))}}
.metric-tile{
  background:linear-gradient(180deg,#FFFCF8 0%,#F7F2EA 100%);
  border:1px solid var(--border-soft);border-radius:var(--radius-sm);padding:12px;text-align:left;
}
.metric-tile-label{display:block;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-3)}
.metric-tile-value{display:block;margin-top:5px;font-size:1.35rem;font-weight:800;color:var(--navy);letter-spacing:-.02em}

/* ── Iris: breakdown bars ── */
.ai-breakdowns{display:grid;grid-template-columns:1fr;gap:16px;margin-top:16px}
@media(min-width:720px){.ai-breakdowns{grid-template-columns:1fr 1fr;gap:22px}}
.breakdown-title{margin:0 0 10px;font-size:12px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--text-3)}
.bar-list{list-style:none;display:grid;gap:10px}
.bar-row{display:grid;grid-template-columns:88px 1fr auto;align-items:center;gap:10px}
.bar-row-label{font-size:13px;font-weight:700;color:var(--navy);text-transform:capitalize}
.bar-track{height:8px;border-radius:var(--radius-pill);background:#EDE6DB;overflow:hidden}
.bar-fill{display:block;height:100%;width:var(--w,0%);border-radius:var(--radius-pill);background:var(--amber)}
.bar-fill--sea{background:var(--sea)}
.bar-row-value{font-size:12px;color:var(--text-2);white-space:nowrap;font-variant-numeric:tabular-nums}

/* ── Iris: sparkline ── */
.spark-wrap{margin-top:16px;padding-top:14px;border-top:1px solid var(--border-soft)}
.spark-caption{display:block;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-3);margin-bottom:8px}
.sparkline{display:flex;align-items:flex-end;gap:6px;height:44px}
.spark-bar{flex:1;min-width:0;height:var(--w,0%);border-radius:4px 4px 0 0;background:linear-gradient(180deg,var(--sea) 0%,rgba(74,124,148,.55) 100%)}

/* ── Iris: expandable client rows ── */
.client-rows{display:grid;gap:10px}
.client-row{
  border:1px solid var(--border-soft);border-radius:var(--radius-sm);
  background:linear-gradient(180deg,#FFFCF8 0%,#FAF6F0 100%);overflow:hidden;
}
.client-row[open]{border-color:rgba(74,124,148,.3);box-shadow:var(--shadow-soft)}
.client-row-summary{
  display:flex;align-items:center;gap:12px;flex-wrap:wrap;
  padding:13px 14px;cursor:pointer;list-style:none;
}
.client-row-summary::-webkit-details-marker{display:none}
.client-row-summary:focus-visible{outline:none;box-shadow:var(--focus)}
.cr-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap;min-width:0}
.cr-name{font-size:1rem;font-weight:800;color:var(--navy);letter-spacing:-.01em}
.cr-type{font-size:12px;color:var(--text-3)}
.cr-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}
.cr-chip{
  display:inline-flex;align-items:center;padding:4px 9px;border-radius:var(--radius-pill);
  font-size:11px;font-weight:700;color:var(--text-2);background:#F1ECE5;border:1px solid var(--border-soft);
  font-variant-numeric:tabular-nums;
}
.cr-chip--alert{color:var(--amber);background:var(--amber-soft);border-color:rgba(154,107,27,.25)}
.cr-chip--muted{color:var(--text-3);font-style:italic;font-weight:600}
.cr-caret{flex:none;width:9px;height:9px;border-right:2px solid var(--text-3);border-bottom:2px solid var(--text-3);transform:rotate(-45deg);transition:transform .18s ease}
.client-row[open] .cr-caret{transform:rotate(45deg)}
.client-row-body{padding:0 14px 14px;border-top:1px solid var(--border-soft)}
.cr-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:14px 0}
@media(min-width:720px){.cr-metrics{grid-template-columns:repeat(4,minmax(0,1fr))}}
.cr-metric{background:var(--surface-raised);border:1px solid var(--border-soft);border-radius:var(--radius-sm);padding:10px 12px}
.cr-metric-label{display:block;font-size:10px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--text-3)}
.cr-metric-value{display:block;margin-top:3px;font-size:1.2rem;font-weight:800;color:var(--navy)}
.cr-not-reporting{margin:14px 0;font-size:13px;color:var(--text-3);line-height:1.5;font-style:italic}
.env-mini{margin-top:4px}
.env-mini .env-heading{margin-bottom:10px}

/* ── Iris: bar/spark fill widths (CSP-safe, no inline styles) ── */
.bar-w-0{--w:0%}.bar-w-5{--w:5%}.bar-w-10{--w:10%}.bar-w-15{--w:15%}.bar-w-20{--w:20%}
.bar-w-25{--w:25%}.bar-w-30{--w:30%}.bar-w-35{--w:35%}.bar-w-40{--w:40%}.bar-w-45{--w:45%}
.bar-w-50{--w:50%}.bar-w-55{--w:55%}.bar-w-60{--w:60%}.bar-w-65{--w:65%}.bar-w-70{--w:70%}
.bar-w-75{--w:75%}.bar-w-80{--w:80%}.bar-w-85{--w:85%}.bar-w-90{--w:90%}.bar-w-95{--w:95%}.bar-w-100{--w:100%}
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

const CROWSNEST_VIEWS = new Set(['spyglass', 'clients', 'billing', 'communications', 'sales', 'sales_detail', 'sales_review', 'sales_crm_preview', 'sales_outreach_draft', 'sales_discovery', 'sales_analytics', 'sales_governance']);

const CROWSNEST_NAV_ITEMS = [
  { view: 'spyglass', href: '/', label: 'Spyglass' },
  { view: 'clients', href: '/clients', label: 'Clients' },
  { view: 'billing', href: '/billing', label: 'Billing' },
  { view: 'communications', href: '/communications', label: 'Communications' },
  { view: 'sales', href: '/sales', label: 'Sales' },
];

function normalizeCrowsnestView(raw) {
  const key = String(raw == null ? 'spyglass' : raw).trim().toLowerCase();
  return CROWSNEST_VIEWS.has(key) ? key : 'spyglass';
}

function navActiveView(view) {
  return (view === 'sales_detail' || view === 'sales_review' || view === 'sales_crm_preview' || view === 'sales_outreach_draft' || view === 'sales_discovery' || view === 'sales_analytics' || view === 'sales_governance') ? 'sales' : view;
}

function renderCrowsnestNav(activeView) {
  const view = navActiveView(normalizeCrowsnestView(activeView));
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

function compactNumber(n) {
  const num = Number(n) || 0;
  if (num >= 1e6) return `${(num / 1e6).toFixed(num >= 1e7 ? 0 : 1)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(num >= 1e4 ? 0 : 1)}K`;
  return String(num);
}

function barWidthClass(fraction) {
  const pct = Math.max(0, Math.min(100, Math.round((Number(fraction) || 0) * 100)));
  const bucket = Math.round(pct / 5) * 5; // 0,5,10,...,100
  return `bar-w-${bucket}`;
}

function renderSparkline(values) {
  const nums = (values || []).map((v) => Number(v) || 0);
  const max = Math.max(1, ...nums);
  const bars = nums
    .map((v) => `<span class="spark-bar ${barWidthClass(v / max)}" aria-hidden="true"></span>`)
    .join('');
  return `<div class="sparkline" role="img" aria-label="Sample 7-day request trend">${bars}</div>`;
}

function renderAiUsagePanel(usage) {
  const t = usage.totals;
  const tiles = [
    { label: 'Requests', value: compactNumber(t.requests) },
    { label: 'Tokens', value: compactNumber(t.total_tokens) },
    { label: 'Cost', value: `$${Number(t.cost_usd).toFixed(2)}` },
    { label: 'Avg latency', value: `${t.avg_latency_ms}ms` },
    { label: 'Success', value: `${(t.success_rate * 100).toFixed(1)}%` },
  ]
    .map(
      (tile) => `<div class="metric-tile">
            <span class="metric-tile-label">${escapeHtml(tile.label)}</span>
            <span class="metric-tile-value">${escapeHtml(tile.value)}</span>
          </div>`
    )
    .join('\n          ');

  const providerBars = usage.by_provider
    .map(
      (p) => `<li class="bar-row">
            <span class="bar-row-label">${escapeHtml(p.provider)}</span>
            <span class="bar-track"><span class="bar-fill ${barWidthClass(p.share)}"></span></span>
            <span class="bar-row-value">${compactNumber(p.total_tokens)} tok · $${Number(p.cost_usd).toFixed(2)}</span>
          </li>`
    )
    .join('\n          ');

  const maxClientTokens = Math.max(1, ...usage.by_client.map((c) => c.total_tokens));
  const clientBars = usage.by_client
    .map(
      (c) => `<li class="bar-row">
            <span class="bar-row-label">${escapeHtml(c.name)}</span>
            <span class="bar-track"><span class="bar-fill bar-fill--sea ${barWidthClass(c.total_tokens / maxClientTokens)}"></span></span>
            <span class="bar-row-value">${compactNumber(c.total_tokens)} tok · $${Number(c.cost_usd).toFixed(2)}</span>
          </li>`
    )
    .join('\n          ');

  return `<section class="panel ai-usage-panel" aria-labelledby="ai-usage-title">
        <header class="panel-head">
          <h2 class="panel-title" id="ai-usage-title">AI usage</h2>
          <span class="sample-badge">Sample</span>
          <span class="panel-window">${escapeHtml(usage.window_label)}</span>
        </header>
        <div class="metric-tiles">
          ${tiles}
        </div>
        <div class="ai-breakdowns">
          <div class="breakdown">
            <h3 class="breakdown-title">By provider</h3>
            <ul class="bar-list">
          ${providerBars}
            </ul>
          </div>
          <div class="breakdown">
            <h3 class="breakdown-title">By client</h3>
            <ul class="bar-list">
          ${clientBars}
            </ul>
          </div>
        </div>
        <div class="spark-wrap">
          <span class="spark-caption">Requests · last 7 days (sample)</span>
          ${renderSparkline(usage.daily_requests)}
        </div>
      </section>`;
}

function roundNum(n) {
  return Math.round(Number(n) || 0);
}

// Compact, deterministic last-active from an ISO-8601 UTC instant (no Date.now()).
function formatLastActive(iso) {
  if (!iso || typeof iso !== 'string' || iso.length < 16) return '—';
  return `${iso.slice(11, 16)} UTC · ${iso.slice(5, 10)}`;
}

// Extract display fields from a crowsnest.client_metrics.v1 snapshot, or null when the
// client is not reporting a `measured` snapshot (→ "not reporting yet").
function readClientMetrics(event) {
  const m = event && event.metrics;
  if (!m || m.availability !== 'measured') return null;
  return {
    conversations: roundNum(m.conversations_total),
    messagesPerDay: roundNum(m.messages_per_day_avg),
    needsHuman: roundNum(m.conversations_needing_human),
    lastActive: formatLastActive(m.last_activity_at),
  };
}

function renderSpyglassClientRow(client, event) {
  const m = readClientMetrics(event);
  const humanClass = m && m.needsHuman > 0 ? ' cr-chip--alert' : '';
  const envRows = (client.environments || []).map(renderEnvironmentRow).join('\n            ');
  const summaryChips = !m
    ? '<span class="cr-chip cr-chip--muted">not reporting yet</span>'
    : `<span class="cr-chip">${escapeHtml(String(m.conversations))} convs</span>
            <span class="cr-chip">${escapeHtml(String(m.messagesPerDay))}/day</span>
            <span class="cr-chip${humanClass}">${escapeHtml(String(m.needsHuman))} need human</span>`;
  const detail = !m
    ? '<p class="cr-not-reporting">Not reporting yet — this client isn’t sending metric snapshots. It populates automatically once its reporter is turned on.</p>'
    : `<div class="cr-metrics">
              <div class="cr-metric"><span class="cr-metric-label">Conversations</span><span class="cr-metric-value">${escapeHtml(String(m.conversations))}</span></div>
              <div class="cr-metric"><span class="cr-metric-label">Messages / day</span><span class="cr-metric-value">${escapeHtml(String(m.messagesPerDay))}</span></div>
              <div class="cr-metric"><span class="cr-metric-label">Need human</span><span class="cr-metric-value">${escapeHtml(String(m.needsHuman))}</span></div>
              <div class="cr-metric"><span class="cr-metric-label">Last active</span><span class="cr-metric-value">${escapeHtml(String(m.lastActive))}</span></div>
            </div>`;

  return `<details class="client-row">
          <summary class="client-row-summary">
            <span class="cr-head">
              <span class="cr-name">${escapeHtml(client.name)}</span>
              <span class="cr-type">${escapeHtml(client.type)}</span>
              ${renderStatusPill(client.status)}
            </span>
            <span class="cr-chips">${summaryChips}</span>
            <span class="cr-caret" aria-hidden="true"></span>
          </summary>
          <div class="client-row-body">
            ${detail}
            <div class="env-mini">
              <h4 class="env-heading">Environments / status</h4>
              <ul class="env-list">
            ${envRows}
              </ul>
            </div>
          </div>
        </details>`;
}

function refreshStatusLabel(status) {
  const key = String(status || '').trim().toLowerCase();
  if (key === 'started') return 'Report requested';
  if (key === 'not_configured') return 'Not configured';
  if (key === 'unavailable') return 'Unavailable';
  return 'Unavailable';
}

function renderSpyglassRefreshCoverage(refreshCoverage, clients) {
  const results = refreshCoverage && Array.isArray(refreshCoverage.results)
    ? refreshCoverage.results
    : null;
  if (!results || results.length === 0) return '';
  const nameById = new Map((clients || []).map((c) => [c.id, c.name]));
  const coverage = refreshCoverage.coverage || {};
  const started = Number(coverage.started) || 0;
  const total = Number(coverage.total) || results.length;
  const rows = results.map((row) => {
    const name = nameById.get(row.client_id) || row.client_id;
    return `<li class="refresh-coverage-item">
            <span class="refresh-client">${escapeHtml(name)}</span>
            <span class="refresh-status">${escapeHtml(refreshStatusLabel(row.status))}</span>
          </li>`;
  }).join('\n          ');
  return `<div class="refresh-coverage" role="status" aria-live="polite">
        <p class="refresh-coverage-summary">Coverage after request: ${escapeHtml(String(started))}/${escapeHtml(String(total))} report(s) requested from configured clients. Partial coverage is expected — this does not mean metrics are already updated.</p>
        <ul class="refresh-coverage-list">
          ${rows}
        </ul>
      </div>`;
}

function renderSpyglassRefreshPanel(clients, refreshCoverage) {
  const coverageHtml = renderSpyglassRefreshCoverage(refreshCoverage, clients);
  return `<section class="panel refresh-panel" aria-labelledby="spyglass-refresh-title">
        <header class="panel-head">
          <h2 class="panel-title" id="spyglass-refresh-title">Refresh reports</h2>
        </header>
        <p class="section-note">Requests a new report from each <strong>configured</strong> client's reporter. Only fixed, server-configured clients are contacted — coverage may be partial.</p>
        <form class="refresh-form" method="post" action="/spyglass/refresh-all" accept-charset="utf-8">
          <div class="form-actions">
            <button class="btn-primary" type="submit">Refresh all</button>
          </div>
        </form>
        ${coverageHtml}
      </section>`;
}

// clientMetrics: map of client_slug -> crowsnest.client_metrics.v1 snapshot (from the
// Crowsnest-owned metrics store). Empty map => every client shows "not reporting yet".
function renderSpyglassMain(clients, options = {}) {
  const clientMetrics = options.clientMetrics || {};
  const refreshCoverage = options.refreshCoverage || null;
  const stats = countStaticEnvironmentStats(clients);
  const usage = getSampleAiUsage();
  const reporting = clients
    .map((c) => readClientMetrics(clientMetrics[c.client_slug]))
    .filter(Boolean);
  const reportingCount = reporting.length;
  const totalConversations = reporting.reduce((s, m) => s + m.conversations, 0);
  const totalMsgPerDay = reporting.reduce((s, m) => s + m.messagesPerDay, 0);
  const totalNeedsHuman = reporting.reduce((s, m) => s + m.needsHuman, 0);
  const kv = (n) => (reportingCount === 0 ? '—' : String(n));
  const clientRows = clients.map((c) => renderSpyglassClientRow(c, clientMetrics[c.client_slug])).join('\n        ');

  return `<section id="spyglass" aria-labelledby="spyglass-title">
      <div class="sample-banner">
        <span class="sample-dot" aria-hidden="true"></span>
        <span><strong>Client metrics are live.</strong> Clients report snapshots into Crowsnest's own store — rows show <em>&ldquo;not reporting yet&rdquo;</em> until a client's reporter is turned on. The <strong>AI usage</strong> panel below is still sample data.</span>
      </div>
      <div class="kpi-strip">
        <div class="kpi">
          <span class="kpi-label">Clients</span>
          <span class="kpi-value">${escapeHtml(String(stats.clientCount))}</span>
          <span class="kpi-sub">${escapeHtml(String(reportingCount))} reporting</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Conversations</span>
          <span class="kpi-value">${escapeHtml(kv(totalConversations))}</span>
          <span class="kpi-sub">live</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Messages / day</span>
          <span class="kpi-value">${escapeHtml(kv(totalMsgPerDay))}</span>
          <span class="kpi-sub">live</span>
        </div>
        <div class="kpi kpi--alert">
          <span class="kpi-label">Need human</span>
          <span class="kpi-value">${escapeHtml(kv(totalNeedsHuman))}</span>
          <span class="kpi-sub">live</span>
        </div>
      </div>

      ${renderSpyglassRefreshPanel(clients, refreshCoverage)}

      ${renderAiUsagePanel(usage)}

      <section class="panel clients-panel" aria-labelledby="clients-overview-title">
        <header class="panel-head">
          <h2 class="panel-title" id="clients-overview-title">Clients</h2>
          <span class="panel-window">${escapeHtml(String(reportingCount))}/${escapeHtml(String(stats.clientCount))} reporting · tap a client to expand</span>
        </header>
        <div class="client-rows">
        ${clientRows}
        </div>
      </section>

      <div class="safety"><strong>Safety:</strong> Read-only Spyglass. Client metrics are read from Crowsnest's own metrics store (clients push snapshots in) — no direct access to tenant databases and no writes. Refresh all only requests reports from configured clients and never claims metrics are refreshed. The AI usage panel is still clearly-labelled <strong>sample data</strong>, not live telemetry.</div>
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

const COCKPIT_PIPELINE_STAGES = [
  ['ready_for_review', 'Ready for review'],
  ['needs_more_research', 'Needs more research'],
  ['qualified', 'Qualified'],
  ['not_qualified', 'Not qualified'],
  ['crm_ready', 'CRM ready'],
];

const COCKPIT_ATTENTION_STATUSES = new Set(['ready_for_review', 'needs_more_research']);

function renderSalesStatusChip(status) {
  const raw = String(status || '').trim() || 'unknown';
  return `<span class="sales-status-chip" role="status"><span class="sales-status-chip-text">${escapeHtml(raw)}</span></span>`;
}

function countProspectLifecycleStages(prospects) {
  const counts = Object.create(null);
  for (const [status] of COCKPIT_PIPELINE_STAGES) {
    counts[status] = 0;
  }
  for (const prospect of prospects) {
    const status = String(prospect && prospect.lifecycle_status || '');
    if (Object.prototype.hasOwnProperty.call(counts, status)) {
      counts[status] += 1;
    }
  }
  return counts;
}

function renderSalesPipelineCounts(prospects) {
  const counts = countProspectLifecycleStages(prospects);
  const tiles = COCKPIT_PIPELINE_STAGES.map(([status, label]) => (
    `<div class="kpi">
        <span class="kpi-label">${escapeHtml(label)}</span>
        <span class="kpi-value">${escapeHtml(String(counts[status] || 0))}</span>
      </div>`
  )).join('\n      ');
  return `<div class="sales-pipeline" id="sales-pipeline" aria-label="Sales pipeline stage counts">
      ${tiles}
    </div>`;
}

function renderSalesAttentionItems(prospects) {
  const actionable = prospects.filter((p) => COCKPIT_ATTENTION_STATUSES.has(String(p && p.lifecycle_status || '')));
  if (!actionable.length) {
    return '<p class="section-note">No prospects need attention right now.</p>';
  }
  const items = actionable.map((p) => {
    const label = p.canonical_name || p.website_url || p.id;
    return `<li class="card prospect-card compact-prospect sales-action-card">
        <a href="/sales/prospects/${escapeHtml(p.id)}">${escapeHtml(label)}</a>
        <div class="overview-note">Status: ${renderSalesStatusChip(p.lifecycle_status)}</div>
      </li>`;
  }).join('\n      ');
  return `<ul class="sales-action-queue" id="sales-action-queue" aria-label="Sales action queue">
      ${items}
    </ul>`;
}

function renderSalesSecondaryNav(options = {}) {
  const governanceHref = options.governanceHref || '/sales#sales-governance';
  return `<nav class="sales-secondary-nav" aria-label="Sales secondary navigation">
      <div class="sales-nav-group">
        <h3 class="sales-nav-group-title">Work</h3>
        <ul>
          <li><a href="/sales/review">Review queue</a></li>
          <li><a href="/sales?mode=add">Prospect intake</a></li>
        </ul>
      </div>
      <div class="sales-nav-group">
        <h3 class="sales-nav-group-title">Tools</h3>
        <ul>
          <li><a href="/sales/discovery">Discovery</a></li>
        </ul>
      </div>
      <div class="sales-nav-group">
        <h3 class="sales-nav-group-title">Monitor</h3>
        <ul>
          <li><a href="/sales/analytics">Analytics</a></li>
        </ul>
      </div>
      <div class="sales-nav-group">
        <h3 class="sales-nav-group-title">Reference</h3>
        <ul>
          <li><a href="${escapeHtml(governanceHref)}">Governance</a></li>
        </ul>
      </div>
    </nav>`;
}

function renderSalesSupportingRoomNav(options = {}) {
  const backHref = options.backHref || '/sales';
  const backLabel = options.backLabel || 'Back to Sales cockpit';
  const governanceHref = options.governanceHref || '/sales#sales-governance';
  return `<p class="sales-room-back"><a href="${escapeHtml(backHref)}">← ${escapeHtml(backLabel)}</a></p>
      ${renderSalesSecondaryNav({ governanceHref })}`;
}

function renderSalesSafetyBadge(label, context) {
  const badge = `<span class="safety-badge" role="status">${escapeHtml(label)}</span>`;
  if (!context) return badge;
  return `<span class="sales-action-safety">${badge}<span class="safety-context">${escapeHtml(context)}</span></span>`;
}

function renderProspectListItems(prospects) {
  if (!prospects.length) {
    return '<p class="section-note">No prospects yet. Use Add prospect when you are ready to record one.</p>';
  }
  const items = prospects.map((p) => {
    const label = p.canonical_name || p.website_url || p.id;
    return `<li class="card prospect-card compact-prospect">
        <a href="/sales/prospects/${escapeHtml(p.id)}">${escapeHtml(label)}</a>
        <div class="overview-note">Status: ${renderSalesStatusChip(p.lifecycle_status)}</div>
      </li>`;
  }).join('\n      ');
  return `<ul class="prospect-list">${items}</ul>`;
}

function renderSalesIntakeForm(options = {}) {
  const errorHtml = options.intakeError
    ? `<p class="sales-error" role="alert">${escapeHtml(options.intakeError)}</p>`
    : '';
  return `<h2 class="section">Manual intake</h2>
      <article class="card">
        <p class="section-note">Provide a business website <strong>or</strong> a business name (Northern Spain pilot).</p>
        ${errorHtml}
        <form class="sales-form" method="post" action="/sales/prospects" accept-charset="utf-8">
          <div class="form-row">
            <label for="website_url">Business website</label>
            <input id="website_url" name="website_url" type="url" placeholder="https://example-surf-house.example" value="${escapeHtml(options.intakeWebsiteUrl || '')}">
          </div>
          <div class="form-row">
            <label for="business_name">Business name</label>
            <input id="business_name" name="business_name" type="text" placeholder="Somo Surf House" value="${escapeHtml(options.intakeBusinessName || '')}">
          </div>
          <div class="form-actions">
            <button class="btn-primary" type="submit">Create prospect</button>
          </div>
        </form>
      </article>`;
}

const REVIEW_BUCKET_LABELS = {
  ready_for_review: 'Ready for review',
  needs_more_research: 'Needs more research',
  qualified: 'Qualified',
  not_qualified: 'Not qualified',
  crm_ready: 'Ready for CRM review',
};

function reviewBucketLabel(bucket) {
  return REVIEW_BUCKET_LABELS[String(bucket || '')] || String(bucket || 'Unknown');
}

function renderReviewQueueFilterForm(currentFilter) {
  const selected = String(currentFilter || 'all');
  const options = [
    ['all', 'All'],
    ['actionable', 'Actionable'],
    ['needs_more_research', 'Needs more research'],
    ['qualified', 'Qualified'],
    ['not_qualified', 'Not qualified'],
    ['crm_ready', 'Ready for CRM review'],
  ].map(([value, label]) => {
    const isSelected = selected === value ? ' selected' : '';
    return `<option value="${escapeHtml(value)}"${isSelected}>${escapeHtml(label)}</option>`;
  }).join('\n            ');
  return `<form class="sales-form review-filter-form" method="get" action="/sales/review" accept-charset="utf-8">
        <div class="form-row">
          <div>
            <label for="state">Filter by current state</label>
            <select id="state" name="state">
            ${options}
            </select>
          </div>
          <div class="form-actions">
            <button class="btn-primary" type="submit">Apply filter</button>
          </div>
        </div>
      </form>`;
}

function renderReviewQueueItems(items) {
  if (!items.length) {
    return '<p class="section-note">No prospects in this filter. Try another state, or add research and qualification on the Sales intake page.</p>';
  }
  const rows = items.map((item) => {
    const name = item.canonical_name || item.website_url || item.id;
    const website = item.website_url
      ? `<div>Website: ${escapeHtml(item.website_url)}</div>`
      : '';
    const qual = item.latest_qualification_decision
      ? `<code>${escapeHtml(item.latest_qualification_decision)}</code>`
      : '<code>none</code>';
    const draftReadyLabel = item.draft_ready ? 'Yes' : 'No';
    const draftPresentLabel = item.draft_present ? 'Yes' : 'No';
    return `<li class="card review-queue-item">
        <p><a href="/sales/prospects/${escapeHtml(item.id)}">${escapeHtml(name)}</a></p>
        <div class="review-queue-meta">
          <div><span class="review-bucket-label">${escapeHtml(reviewBucketLabel(item.bucket))}</span></div>
          ${website}
          <div>Latest qualification: ${qual}</div>
          <div>Evidence count: <code>${escapeHtml(String(item.evidence_count == null ? 0 : item.evidence_count))}</code></div>
          <div>Draft ready: <code>${escapeHtml(draftReadyLabel)}</code></div>
          <div>Draft present: <code>${escapeHtml(draftPresentLabel)}</code></div>
          <div>Most recent activity: <code>${escapeHtml(item.most_recent_activity || '')}</code></div>
        </div>
      </li>`;
  }).join('\n      ');
  return `<ul class="review-queue-list" aria-label="Sales review queue">
      ${rows}
    </ul>`;
}

function renderSalesReviewMain(options = {}) {
  const items = Array.isArray(options.reviewQueueItems) ? options.reviewQueueItems : [];
  const filter = options.reviewQueueFilter || 'all';
  return `<section id="sales-review" aria-labelledby="sales-review-title">
      <h2 class="section" id="sales-review-title">Review queue</h2>
      <p class="section-note">Filter and act on durable Sales prospects. Operators decide qualification and next steps. No CRM writes, no outreach delivery, and no provider discovery in this chapter.</p>
      ${renderSalesSupportingRoomNav()}
      <h2 class="section">Filter</h2>
      ${renderReviewQueueFilterForm(filter)}
      <h2 class="section">Queue</h2>
      <p class="section-note">Buckets: Ready for review (has evidence, no current qualification), Needs more research, Qualified, Not qualified, and Ready for CRM review. Ordered newest actionable first.</p>
      ${renderReviewQueueItems(items)}
    </section>`;
}

function renderAnalyticsKpi(label, value, sub) {
  const subHtml = sub
    ? `<span class="kpi-sub">${escapeHtml(sub)}</span>`
    : '';
  return `<div class="kpi">
        <span class="kpi-label">${escapeHtml(label)}</span>
        <span class="kpi-value">${escapeHtml(String(value))}</span>
        ${subHtml}
      </div>`;
}

function renderAnalyticsQualificationTiles(qualification = {}) {
  const q = qualification || {};
  return `<div class="metric-tiles" aria-label="Qualification states">
        <div class="metric-tile">
          <span class="metric-tile-label">Qualified</span>
          <span class="metric-tile-value">${escapeHtml(String(Number(q.qualified) || 0))}</span>
        </div>
        <div class="metric-tile">
          <span class="metric-tile-label">Not qualified</span>
          <span class="metric-tile-value">${escapeHtml(String(Number(q.not_qualified) || 0))}</span>
        </div>
        <div class="metric-tile">
          <span class="metric-tile-label">Needs more research</span>
          <span class="metric-tile-value">${escapeHtml(String(Number(q.needs_more_research) || 0))}</span>
        </div>
        <div class="metric-tile">
          <span class="metric-tile-label">Unassessed</span>
          <span class="metric-tile-value">${escapeHtml(String(Number(q.unassessed) || 0))}</span>
        </div>
      </div>`;
}

function renderAnalyticsRecentActivity(items) {
  if (!items.length) {
    return '<p class="section-note">No recent audit activity yet.</p>';
  }
  const rows = items.map((item) => {
    const prospectId = item.prospect_id ? String(item.prospect_id) : '';
    const name = String(item.canonical_name || '').trim();
    const prospectBit = prospectId
      ? (name
        ? `<a href="/sales/prospects/${escapeHtml(prospectId)}">${escapeHtml(name)}</a>`
        : `<a href="/sales/prospects/${escapeHtml(prospectId)}"><code>${escapeHtml(prospectId)}</code></a>`)
      : 'n/a';
    return `<li>
        <strong>${escapeHtml(item.action || '')}</strong>
        · actor=${escapeHtml(item.actor || 'unknown')}
        · at=<code>${escapeHtml(item.at || '')}</code>
        · prospect=${prospectBit}
      </li>`;
  }).join('\n        ');
  return `<ul class="audit-list" aria-label="Recent Sales activity">
        ${rows}
      </ul>`;
}

function renderAnalyticsDataQualityAlerts(alerts) {
  if (!alerts.length) {
    return '<p class="section-note">No data-quality alerts right now.</p>';
  }
  const rows = alerts.map((alert) => {
    const prospectId = alert.prospect_id ? String(alert.prospect_id) : '';
    const name = String(alert.canonical_name || '').trim() || prospectId || 'Prospect';
    const link = prospectId
      ? `<a href="/sales/prospects/${escapeHtml(prospectId)}">${escapeHtml(name)}</a>`
      : escapeHtml(name);
    return `<li>
        <strong>${escapeHtml(alert.code || 'alert')}</strong>
        · ${link}
        · ${escapeHtml(alert.message || '')}
      </li>`;
  }).join('\n        ');
  return `<ul class="review-queue-list" aria-label="Data-quality alerts">
        ${rows}
      </ul>`;
}

function renderSalesAnalyticsMain(options = {}) {
  const counts = options.analyticsCounts || {
    prospects: 0,
    evidence_records: 0,
    crm_ready: 0,
    drafts_present: 0,
    contacts: 0,
    qualification: {
      qualified: 0,
      not_qualified: 0,
      needs_more_research: 0,
      unassessed: 0,
    },
  };
  const recent = Array.isArray(options.analyticsRecentActivity) ? options.analyticsRecentActivity : [];
  const alerts = Array.isArray(options.analyticsDataQualityAlerts) ? options.analyticsDataQualityAlerts : [];
  const disclaimer = options.analyticsDisclaimer
    || 'Read-only monitoring from persisted Sales records. Informational data-quality alerts only — operators decide. No AI/agent scores, no external calls, no writes, no automatic actions.';

  return `<section id="sales-analytics" aria-labelledby="sales-analytics-title">
      <h2 class="section" id="sales-analytics-title">Sales analytics</h2>
      <p class="section-note">${escapeHtml(disclaimer)}</p>
      ${renderSalesSupportingRoomNav()}

      <h2 class="section">Pipeline counts</h2>
      <div class="kpi-strip" aria-label="Pipeline counts">
        ${renderAnalyticsKpi('Prospects', counts.prospects || 0)}
        ${renderAnalyticsKpi('Evidence', counts.evidence_records || 0, 'research records')}
        ${renderAnalyticsKpi('CRM-ready', counts.crm_ready || 0)}
        ${renderAnalyticsKpi('Drafts', counts.drafts_present || 0, 'prospects with a draft')}
        ${renderAnalyticsKpi('Contacts', counts.contacts || 0, 'contact candidates')}
      </div>

      <article class="panel">
        <div class="panel-head">
          <h3 class="panel-title">Qualification states</h3>
        </div>
        ${renderAnalyticsQualificationTiles(counts.qualification)}
      </article>

      <h2 class="section">Recent activity</h2>
      ${renderAnalyticsRecentActivity(recent)}

      <h2 class="section">Data-quality alerts</h2>
      <p class="section-note">Informational only — operators decide; nothing is auto-fixed.</p>
      ${renderAnalyticsDataQualityAlerts(alerts)}
    </section>`;
}

function isSalesAddMode(options = {}) {
  const mode = String(options.salesMode || options.mode || '').trim().toLowerCase();
  return mode === 'add' || Boolean(options.intakeError);
}

function renderSalesAddModeMain(options = {}) {
  return `<section id="sales" aria-labelledby="sales-title">
      <p><a href="/sales">← Back to Sales cockpit</a></p>
      <p class="section-note">Manual prospect intake — durable Sales store when configured; local/test may use in-memory fallback.</p>
      ${renderSalesIntakeForm(options)}
      <div class="safety"><strong>Safety:</strong> Durable Sales intake when the dedicated store is configured; local/test may use in-memory fallback. Authenticated Crowsnest operators can record decisions. No CRM writes and no outreach delivery.</div>
    </section>`;
}

function renderSalesCockpitMain(options = {}) {
  const prospects = Array.isArray(options.prospects) ? options.prospects : [];
  const attentionBody = prospects.length
    ? renderSalesAttentionItems(prospects)
    : '<p class="section-note">No prospects yet. No prospects need attention right now.</p>';
  const attentionRegion = attentionBody.includes('id="sales-action-queue"')
    ? attentionBody
    : `<div id="sales-action-queue" aria-label="Sales action queue">${attentionBody}</div>`;

  return `<section id="sales-cockpit" aria-labelledby="sales-cockpit-title">
      <div class="sales-cockpit-header">
        <div>
          <h2 class="section" id="sales-cockpit-title">Sales cockpit</h2>
          <p class="section-note">See current pipeline work, open the next prospect that needs attention, then complete existing human-approved manual intake and review actions. No CRM writes and no outreach delivery.</p>
        </div>
        <p class="cta-row"><a class="btn-primary" href="/sales?mode=add">Add prospect</a></p>
      </div>

      ${renderSalesSecondaryNav()}

      <div class="sales-cockpit-grid" id="sales-cockpit-grid">
        <div class="sales-cockpit-primary">
          <h2 class="section">Pipeline</h2>
          ${renderSalesPipelineCounts(prospects)}

          <h2 class="section">Needs attention</h2>
          ${attentionRegion}
        </div>
        <div class="sales-cockpit-prospects">
          <h2 class="section">Prospects</h2>
          ${renderProspectListItems(prospects)}
        </div>
      </div>

      <div class="safety" id="sales-governance">
        <strong>Governance &amp; safeguards</strong>
        <p class="section-note" style="margin:8px 0 0;color:#6A4E12">Detailed Sales policy lives here. Supporting rooms keep only action-adjacent badges.</p>
        <ul class="checklist" style="margin-top:10px">
          <li><span class="check-label">CRM:</span> Preview only — no CRM record has been sent; no CRM writes; no provider SDK/HTTP.</li>
          <li><span class="check-label">Outreach:</span> Draft only — no message has been sent; no SMTP, WhatsApp, LinkedIn, HubSpot send, webhooks, or AI generation.</li>
          <li><span class="check-label">Discovery:</span> Manual proposal plus Maps sample / dry-run fixtures only — no live Maps, Apollo, web search, or external discovery HTTP; preview never auto-creates prospects.</li>
          <li><span class="check-label">Analytics:</span> Read-only monitoring — informational alerts only; no remediation controls or automatic actions.</li>
          <li><span class="check-label">Access:</span> Durable Sales when configured; local/test may use in-memory fallback. Authenticated operators decide.</li>
        </ul>
      </div>
    </section>`;
}

function renderGovernanceList(items, ariaLabel) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    return `<p class="section-note">No items recorded.</p>`;
  }
  const rows = list.map((item) => {
    const title = escapeHtml(item.title || item.name || item.id || 'item');
    const body = escapeHtml(item.summary || item.rule || item.note || item.action || '');
    const meta = item.human_approval_required === true
      ? ' · Human approval required'
      : (item.state ? ` · ${escapeHtml(String(item.state))}` : '');
    return `<li>
        <strong>${title}</strong>${meta}
        · ${body}
      </li>`;
  }).join('\n        ');
  return `<ul class="review-queue-list" aria-label="${escapeHtml(ariaLabel)}">
        ${rows}
      </ul>`;
}

function renderGovernanceRetention(notes = {}) {
  const rows = [
    ['Schema', notes.schema],
    ['DSN', notes.dsn_env],
    ['Ownership', notes.ownership],
    ['Retention', notes.retention_note],
    ['Isolation', notes.isolation_note],
    ['Audit', notes.audit_note],
  ].filter(([, value]) => value);
  if (!rows.length) {
    return '<p class="section-note">No retention notes available.</p>';
  }
  const body = rows.map(([label, value]) => `<li><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</li>`).join('\n        ');
  return `<ul class="review-queue-list" aria-label="Data retention and ownership">
        ${body}
      </ul>`;
}

function renderGovernanceBoundaries(boundaries = {}) {
  const allowed = Array.isArray(boundaries.allowed_manual) ? boundaries.allowed_manual : [];
  const forbidden = Array.isArray(boundaries.forbidden_automatic) ? boundaries.forbidden_automatic : [];
  const allowedRows = allowed.map((item) => `<li>
        <strong>${escapeHtml(item.id || 'allowed')}</strong>
        · ${escapeHtml(item.action || '')}
        · Human approval required
        ${item.audited_as ? `· Audited as <code>${escapeHtml(item.audited_as)}</code>` : ''}
      </li>`).join('\n        ');
  const forbiddenRows = forbidden.map((item) => `<li>
        <strong>${escapeHtml(item.id || 'forbidden')}</strong>
        · ${escapeHtml(item.action || '')}
        · Not permitted / must not run automatically
      </li>`).join('\n        ');
  return `<article class="panel">
        <div class="panel-head">
          <h3 class="panel-title">Allowed manual (operator-triggered)</h3>
        </div>
        <ul class="review-queue-list" aria-label="Allowed manual actions">
        ${allowedRows || '<li>None listed.</li>'}
        </ul>
      </article>
      <article class="panel">
        <div class="panel-head">
          <h3 class="panel-title">Forbidden automatic</h3>
        </div>
        <ul class="review-queue-list" aria-label="Forbidden automatic actions">
        ${forbiddenRows || '<li>None listed.</li>'}
        </ul>
      </article>`;
}

function renderSalesGovernanceMain(options = {}) {
  const disclaimer = options.governanceDisclaimer
    || 'Read-only Sales scale and governance. Explicit human approval required for workflow gates. No automatic CRM writes, no automatic outreach, no external provider calls, and no roles changes in this chapter.';
  const safeguards = Array.isArray(options.governanceWorkflowSafeguards) ? options.governanceWorkflowSafeguards : [];
  const rules = Array.isArray(options.governanceHumanApprovalRules) ? options.governanceHumanApprovalRules : [];
  const retention = options.governanceDataRetention || {};
  const integrations = Array.isArray(options.governanceExternalIntegrations) ? options.governanceExternalIntegrations : [];
  const boundaries = options.governanceActionBoundaries || { allowed_manual: [], forbidden_automatic: [] };

  return `<section id="sales-governance" aria-labelledby="sales-governance-title">
      <p class="section-note">${escapeHtml(disclaimer)}</p>
      <p><a href="/sales">← Back to Sales intake</a> · <a href="/sales/review">Sales review queue</a> · <a href="/sales/analytics">Sales analytics</a></p>

      <h2 class="section">Workflow safeguards</h2>
      <p class="section-note">Each gate requires authenticated human approval — nothing auto-advances.</p>
      ${renderGovernanceList(safeguards, 'Workflow safeguards')}

      <h2 class="section">Human-approval rules</h2>
      ${renderGovernanceList(rules.map((rule) => ({
    id: rule.id,
    title: rule.id,
    rule: rule.rule,
  })), 'Human-approval rules')}

      <h2 class="section">Data retention and ownership</h2>
      ${renderGovernanceRetention(retention)}

      <h2 class="section">External integration state</h2>
      <p class="section-note">No automatic CRM writes and no live outreach delivery from Sales.</p>
      ${renderGovernanceList(integrations, 'External integration state')}

      <h2 class="section">Action boundary audit summary</h2>
      ${renderGovernanceBoundaries(boundaries)}

      <div class="safety"><strong>Safety:</strong> Read-only governance documentation for Luna Sales. Explicit human approval at workflow gates. No automatic CRM writes, no automatic outreach, no external provider calls, and no roles changes in this chapter.</div>
    </section>`;
}

function renderSalesMain(options = {}) {
  if (isSalesAddMode(options)) {
    return renderSalesAddModeMain(options);
  }
  return renderSalesCockpitMain(options);
}

function renderAuditList(events) {
  if (!events.length) {
    return '<p class="section-note">No audit events yet.</p>';
  }
  const items = events.map((event) => {
    const detail = event.detail || {};
    const bits = [
      `<strong>${escapeHtml(event.action)}</strong>`,
      `actor=${escapeHtml(event.actor || 'unknown')}`,
      event.at ? `at=${escapeHtml(event.at)}` : '',
      detail.decision ? `decision=${escapeHtml(detail.decision)}` : '',
      detail.reason ? `reason=${escapeHtml(detail.reason)}` : '',
      detail.rationale ? `rationale=${escapeHtml(detail.rationale)}` : '',
      detail.reviewer_id ? `reviewer=${escapeHtml(detail.reviewer_id)}` : '',
      detail.qualification_assessment_id
        ? `qualification=${escapeHtml(detail.qualification_assessment_id)}`
        : '',
      detail.source_label ? `source=${escapeHtml(detail.source_label)}` : '',
      detail.source_note ? `source_note=${escapeHtml(detail.source_note)}` : '',
      detail.source_name ? `discovery_source=${escapeHtml(detail.source_name)}` : '',
      detail.confidence ? `confidence=${escapeHtml(detail.confidence)}` : '',
      Array.isArray(detail.evidence_ids) && detail.evidence_ids.length
        ? `evidence_refs=${escapeHtml(detail.evidence_ids.join(','))}`
        : '',
    ].filter(Boolean);
    return `<li>${bits.join(' · ')}</li>`;
  }).join('\n        ');
  return `<ul class="audit-list" aria-label="Append-only audit trail">
        ${items}
      </ul>`;
}

function renderResearchFacts(facts) {
  if (!facts.length) return '<li>No facts</li>';
  return facts.map((fact) => (
    `<li><strong>${escapeHtml(fact.type)}:</strong> ${escapeHtml(fact.value)} <em>(citation: ${escapeHtml(fact.citation)})</em></li>`
  )).join('\n          ');
}

function renderResearchLimitations(limitations) {
  if (!limitations.length) return '<li>None listed</li>';
  return limitations.map((line) => `<li>${escapeHtml(line)}</li>`).join('\n          ');
}

function renderManualEvidenceEntries(entries) {
  if (!entries.length) {
    return '<p class="section-note">No manual evidence recorded yet.</p>';
  }
  return entries.map((entry) => {
    const facts = Array.isArray(entry.facts) ? entry.facts : [];
    const limitations = Array.isArray(entry.limitations) ? entry.limitations : [];
    return `<article class="evidence-entry">
        <p><strong>${escapeHtml(entry.job_label || 'Manual evidence')}</strong>
          · <code>${escapeHtml(entry.created_at || '')}</code>
          · confidence=<code>${escapeHtml(entry.confidence || 'n/a')}</code></p>
        <p>Source URL: ${escapeHtml(entry.source_url || 'n/a')}</p>
        <p>${escapeHtml(entry.summary || '')}</p>
        <h3>Factual notes</h3>
        <ul class="fact-list">
          ${renderResearchFacts(facts)}
        </ul>
        <h3>Limitations</h3>
        <ul class="fact-list">
          ${renderResearchLimitations(limitations)}
        </ul>
      </article>`;
  }).join('\n      ');
}

function renderContactCandidates(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) {
    return '<p class="section-note">No manual contacts recorded yet.</p>';
  }
  return list.map((entry) => `<article class="evidence-entry">
        <p><strong>${escapeHtml(entry.full_name || 'Contact')}</strong>
          · role=<code>${escapeHtml(entry.role || '')}</code>
          · confidence=<code>${escapeHtml(entry.confidence || 'n/a')}</code>
          · <code>${escapeHtml(entry.created_at || '')}</code></p>
        <p>Email: <code>${escapeHtml(entry.email || 'n/a')}</code>
          · Phone: <code>${escapeHtml(entry.phone || 'n/a')}</code></p>
        <p>LinkedIn: <code>${escapeHtml(entry.linkedin_url || 'n/a')}</code></p>
        <p>Source: <code>${escapeHtml(entry.source || '')}</code>
          · author=<code>${escapeHtml(entry.author_id || '')}</code></p>
      </article>`).join('\n      ');
}

function renderEvidenceRefOptions(researchJobs, selectedIds) {
  const jobs = Array.isArray(researchJobs) ? researchJobs : [];
  if (!jobs.length) {
    return '<p class="section-note">No research evidence on this prospect yet. Record manual evidence first.</p>';
  }
  const selected = new Set((Array.isArray(selectedIds) ? selectedIds : []).map(String));
  return jobs.map((job) => {
    const label = job.job_label || job.summary || job.source || job.id;
    const checked = selected.has(String(job.id)) ? ' checked' : '';
    return `<label class="evidence-ref-option">
          <input type="checkbox" name="evidence_ids" value="${escapeHtml(job.id)}"${checked}>
          <span><code>${escapeHtml(job.source || '')}</code> — ${escapeHtml(label)}
            <em>(${escapeHtml(job.created_at || '')})</em></span>
        </label>`;
  }).join('\n        ');
}

function renderQualificationEvidenceLinks(assessment, researchJobs) {
  const ids = Array.isArray(assessment && assessment.evidence_ids) ? assessment.evidence_ids : [];
  if (!ids.length) {
    return '<p class="section-note">No evidence references.</p>';
  }
  const byId = new Map((researchJobs || []).map((job) => [String(job.id), job]));
  const items = ids.map((id) => {
    const job = byId.get(String(id));
    if (!job) {
      return `<li><code>${escapeHtml(String(id))}</code></li>`;
    }
    const label = job.job_label || job.summary || job.source || job.id;
    return `<li><code>${escapeHtml(job.source || '')}</code> — ${escapeHtml(label)} · <code>${escapeHtml(job.id)}</code></li>`;
  }).join('\n          ');
  return `<ul class="fact-list" aria-label="Qualification evidence references">
          ${items}
        </ul>`;
}

function renderQualificationHistory(assessments, researchJobs) {
  const list = Array.isArray(assessments) ? assessments : [];
  if (!list.length) {
    return '<p class="section-note">No qualification assessments yet.</p>';
  }
  return list.map((assessment) => (
    `<article class="qualification-entry">
        <p><strong>Decision:</strong> <code>${escapeHtml(assessment.decision || '')}</code>
          · <code>${escapeHtml(assessment.created_at || '')}</code>
          · reviewer=<code>${escapeHtml(assessment.reviewer_id || '')}</code></p>
        <p>${escapeHtml(assessment.rationale || '')}</p>
        <h3>Evidence references</h3>
        ${renderQualificationEvidenceLinks(assessment, researchJobs)}
      </article>`
  )).join('\n      ');
}

function renderLatestQualification(assessment, researchJobs) {
  if (!assessment) {
    return '<p class="section-note">No qualification assessment recorded yet.</p>';
  }
  return `<div class="latest-qualification">
        <p><strong>Latest qualification:</strong> <code>${escapeHtml(assessment.decision || '')}</code>
          · reviewer=<code>${escapeHtml(assessment.reviewer_id || '')}</code>
          · <code>${escapeHtml(assessment.created_at || '')}</code></p>
        <p>${escapeHtml(assessment.rationale || '')}</p>
        <h3>Evidence links</h3>
        ${renderQualificationEvidenceLinks(assessment, researchJobs)}
      </div>`;
}

/**
 * Truthful next permitted Sales action from existing detail state only.
 * Gates: evidence → qualification → CRM-ready → outreach draft. No invented scores.
 */
function deriveSalesWorkspaceNextStep({
  hasEvidence,
  latestQualification,
  isCrmReady,
  draftPresent,
}) {
  if (!hasEvidence) {
    return 'Record research evidence';
  }
  const decision = latestQualification
    ? String(latestQualification.decision || '').trim().toLowerCase()
    : '';
  if (!decision) {
    return 'Record qualification';
  }
  if (decision === 'needs_more_research') {
    return 'Record research evidence';
  }
  if (decision === 'not_qualified') {
    return 'Review qualification';
  }
  if (decision === 'qualified' && !isCrmReady) {
    return 'Mark ready for CRM review';
  }
  if (isCrmReady && !draftPresent) {
    return 'Open outreach draft workspace';
  }
  if (draftPresent) {
    return 'Review outreach draft';
  }
  return 'Review prospect status';
}

function renderSalesDetailMain(options = {}) {
  const prospect = options.prospect || null;
  if (!prospect) {
    return `<section id="sales-detail" class="card placeholder-shell">
      <p>Prospect not found.</p>
      <p><a href="/sales">Back to Sales</a></p>
    </section>`;
  }
  const researchJobs = Array.isArray(options.researchJobs)
    ? options.researchJobs
    : (options.research ? [options.research] : []);
  const fixtureResearch = researchJobs.find((job) => job && job.source === 'fixture')
    || (options.research && options.research.source === 'fixture' ? options.research : null)
    || researchJobs.find((job) => job && job.source !== 'manual')
    || null;
  const evidenceEntries = researchJobs.filter((job) => job && job.source === 'manual');
  const audit = Array.isArray(options.auditEvents) ? options.auditEvents : [];
  const decisionErrorHtml = options.decisionError
    ? `<p class="sales-error" role="alert">${escapeHtml(options.decisionError)}</p>`
    : '';
  const evidenceErrorHtml = options.evidenceError
    ? `<p class="sales-error" role="alert">${escapeHtml(options.evidenceError)}</p>`
    : '';
  const qualificationErrorHtml = options.qualificationError
    ? `<p class="sales-error" role="alert">${escapeHtml(options.qualificationError)}</p>`
    : '';
  const crmReadyErrorHtml = options.crmReadyError
    ? `<p class="sales-error" role="alert">${escapeHtml(options.crmReadyError)}</p>`
    : '';
  const outreachDraftErrorHtml = options.outreachDraftError
    ? `<p class="sales-error" role="alert">${escapeHtml(options.outreachDraftError)}</p>`
    : '';
  const contactErrorHtml = options.contactError
    ? `<p class="sales-error" role="alert">${escapeHtml(options.contactError)}</p>`
    : '';
  const facts = (fixtureResearch && fixtureResearch.facts) || [];
  const limitations = (fixtureResearch && fixtureResearch.limitations) || [];
  const lastDecision = prospect.last_decision
    ? `<p>Last Admin decision: <code>${escapeHtml(prospect.last_decision.decision)}</code> — ${escapeHtml(prospect.last_decision.reason)} (reviewer: ${escapeHtml(prospect.last_decision.reviewer_id)})</p>`
    : '<p>No Admin decision recorded yet.</p>';
  const qualificationAssessments = Array.isArray(options.qualificationAssessments)
    ? options.qualificationAssessments
    : [];
  const latestQualification = options.latestQualification
    || (qualificationAssessments.length ? qualificationAssessments[0] : null);
  const selectedEvidenceIds = Array.isArray(options.qualificationEvidenceIds)
    ? options.qualificationEvidenceIds
    : [];
  const isCurrentlyQualified = latestQualification
    && String(latestQualification.decision || '').toLowerCase() === 'qualified';
  const latestCrmReviewMark = options.latestCrmReviewMark || null;
  const currentOutreachDraft = options.currentOutreachDraft || null;
  const draftReady = Boolean(latestCrmReviewMark) || options.draftReady === true;
  const draftPresent = Boolean(currentOutreachDraft) || options.draftPresent === true;
  const hasEvidence = researchJobs.length > 0;
  const nextStepLabel = deriveSalesWorkspaceNextStep({
    hasEvidence,
    latestQualification,
    isCrmReady: draftReady,
    draftPresent,
  });
  const crmReadyStatus = latestCrmReviewMark
    ? `<p>Marked ready for CRM review at <code>${escapeHtml(latestCrmReviewMark.created_at || '')}</code>
         by <code>${escapeHtml(latestCrmReviewMark.reviewer_id || '')}</code>
         (qualification <code>${escapeHtml(latestCrmReviewMark.qualification_assessment_id || '')}</code>).</p>`
    : '<p>Not marked ready for CRM review yet.</p>';
  const crmActions = isCurrentlyQualified
    ? `<p><a href="/sales/prospects/${escapeHtml(prospect.id)}/crm-preview">Open CRM sync preview</a></p>
        <form class="sales-form" method="post" action="/sales/prospects/${escapeHtml(prospect.id)}/crm-ready" accept-charset="utf-8">
          <div class="form-actions">
            <button class="btn-primary" type="submit">Mark ready for CRM review</button>
          </div>
        </form>`
    : '<p class="section-note">CRM preview and ready-for-review are available only when the latest qualification is <code>qualified</code>.</p>';
  const outreachDraftStatus = `<p>Draft ready: <code>${draftReady ? 'Yes' : 'No'}</code>
       · Draft present: <code>${draftPresent ? 'Yes' : 'No'}</code>
       ${draftPresent && currentOutreachDraft
    ? `(revision <code>${escapeHtml(String(currentOutreachDraft.revision_number || ''))}</code>, channel <code>${escapeHtml(currentOutreachDraft.channel || '')}</code>)`
    : '(no outreach draft yet)'}</p>
      <p class="section-note">Draft only — no message has been sent. Indicators are not delivery status.</p>`;
  const outreachDraftActions = draftReady
    ? `<p><a href="/sales/prospects/${escapeHtml(prospect.id)}/outreach-draft">Open outreach draft workspace</a></p>`
    : '<p class="section-note">Outreach drafts are available only after the prospect is marked CRM-ready.</p>';

  return `<section id="sales-detail" class="sales-workspace" aria-labelledby="sales-workspace-title">
      <p><a href="/sales">← Back to Sales</a></p>

      <header class="sales-workspace-header" id="sales-workspace-header">
        <h1 id="sales-workspace-title">${escapeHtml(prospect.canonical_name || 'Prospect')}</h1>
        <p class="sales-workspace-meta">
          <span><strong>Website:</strong> ${escapeHtml(prospect.website_url || 'n/a')}</span>
          <span><strong>Lifecycle:</strong> ${renderSalesStatusChip(prospect.lifecycle_status)}</span>
        </p>
        <p class="sales-next-step" id="sales-next-step" aria-label="Next step">Next step: ${escapeHtml(nextStepLabel)}</p>
      </header>

      <ul class="sales-workspace-nav" aria-label="Prospect workspace sections">
        <li><a href="#sales-workspace-overview">Overview</a></li>
        <li><a href="#sales-workspace-research">Research</a></li>
        <li><a href="#sales-workspace-qualification">Qualification</a></li>
        <li><a href="#sales-workspace-crm">CRM review</a></li>
        <li><a href="#sales-workspace-outreach">Draft outreach</a></li>
      </ul>

      <article class="card sales-workspace-section" id="sales-workspace-overview">
        <h2>Overview</h2>
        <p><strong>Business name:</strong> ${escapeHtml(prospect.canonical_name || 'n/a')}</p>
        <p><strong>Website:</strong> ${escapeHtml(prospect.website_url || 'n/a')}</p>
        <p><strong>Lifecycle status:</strong> <code>${escapeHtml(prospect.lifecycle_status)}</code></p>
        ${lastDecision}
        <p class="section-note">Review detail workspace — complete Research → Qualification → CRM review → Draft outreach using existing manual actions only.</p>
      </article>

      <article class="card sales-workspace-section" id="sales-workspace-research">
        <h2>Research</h2>
        <h3>Fixture research</h3>
        <p class="section-note">${escapeHtml((fixtureResearch && fixtureResearch.job_label) || 'Manual / fixture research job')}</p>
        <p>${escapeHtml((fixtureResearch && fixtureResearch.summary) || 'No research snapshot.')}</p>
        <p><strong>Research status:</strong> <code>${escapeHtml((fixtureResearch && fixtureResearch.status) || 'n/a')}</code> · source=<code>${escapeHtml((fixtureResearch && fixtureResearch.source) || 'fixture')}</code></p>
        <h3>Evidence / facts</h3>
        <ul class="fact-list">
          ${renderResearchFacts(facts)}
        </ul>
        <h3>Limitations</h3>
        <ul class="fact-list">
          ${renderResearchLimitations(limitations)}
        </ul>
        <h3>Manual research evidence</h3>
        <p class="section-note">Operator-entered dated notes only. Fixture research is preserved above. No live crawl, HubSpot, Maps, Apollo, or automated AI research in this chapter.</p>
        ${evidenceErrorHtml}
        <form class="sales-form" method="post" action="/sales/prospects/${escapeHtml(prospect.id)}/evidence" accept-charset="utf-8">
          <div class="form-row">
            <label for="source_label">Source label</label>
            <input id="source_label" name="source_label" type="text" required maxlength="200" placeholder="Hostel website" value="${escapeHtml(options.evidenceSourceLabel || '')}">
          </div>
          <div class="form-row">
            <label for="source_url">Source URL</label>
            <input id="source_url" name="source_url" type="url" required maxlength="2000" placeholder="https://example.com/about" value="${escapeHtml(options.evidenceSourceUrl || '')}">
          </div>
          <div class="form-row">
            <label for="summary">Summary</label>
            <textarea id="summary" name="summary" required maxlength="4000" placeholder="What did you learn?">${escapeHtml(options.evidenceSummary || '')}</textarea>
          </div>
          <div class="form-row">
            <label for="factual_notes">Factual notes</label>
            <textarea id="factual_notes" name="factual_notes" required maxlength="8000" placeholder="One fact per line">${escapeHtml(options.evidenceFactualNotes || '')}</textarea>
          </div>
          <div class="form-row">
            <label for="limitations">Limitations</label>
            <textarea id="limitations" name="limitations" required maxlength="4000" placeholder="What is incomplete or uncertain?">${escapeHtml(options.evidenceLimitations || '')}</textarea>
          </div>
          <div class="form-row">
            <label for="confidence">Confidence</label>
            <select id="confidence" name="confidence" required>
              <option value="low"${options.evidenceConfidence === 'low' ? ' selected' : ''}>Low</option>
              <option value="medium"${!options.evidenceConfidence || options.evidenceConfidence === 'medium' ? ' selected' : ''}>Medium</option>
              <option value="high"${options.evidenceConfidence === 'high' ? ' selected' : ''}>High</option>
            </select>
          </div>
          <div class="form-actions">
            <button class="btn-primary" type="submit">Record manual evidence</button>
          </div>
        </form>
        <h3>Recorded evidence (newest first)</h3>
        ${renderManualEvidenceEntries(evidenceEntries)}
      </article>

      <article class="card sales-workspace-section" id="sales-workspace-qualification">
        <h2>Qualification</h2>
        <p class="section-note">Operator-controlled qualification policy only. Transparent decisions with cited evidence — never automatic AI scoring, never a numeric lead score, never HubSpot sync, external research, or outreach in this chapter.</p>
        ${renderLatestQualification(latestQualification, researchJobs)}
        ${qualificationErrorHtml}
        <form class="sales-form" method="post" action="/sales/prospects/${escapeHtml(prospect.id)}/qualification" accept-charset="utf-8">
          <div class="form-row">
            <label for="qualification_decision">Qualification decision</label>
            <select id="qualification_decision" name="qualification_decision" required>
              <option value="qualified"${options.qualificationDecision === 'qualified' ? ' selected' : ''}>Qualified</option>
              <option value="not_qualified"${options.qualificationDecision === 'not_qualified' ? ' selected' : ''}>Not qualified</option>
              <option value="needs_more_research"${!options.qualificationDecision || options.qualificationDecision === 'needs_more_research' ? ' selected' : ''}>Needs more research</option>
            </select>
          </div>
          <div class="form-row">
            <label for="rationale">Rationale</label>
            <textarea id="rationale" name="rationale" required maxlength="2000" placeholder="Why this qualification decision?">${escapeHtml(options.qualificationRationale || '')}</textarea>
          </div>
          <fieldset class="form-row">
            <legend>Evidence references</legend>
            <p class="section-note">Select evidence already on this prospect (fixture and/or manual).</p>
            ${renderEvidenceRefOptions(researchJobs, selectedEvidenceIds)}
          </fieldset>
          <div class="form-actions">
            <button class="btn-primary" type="submit">Record qualification</button>
          </div>
        </form>
        <details class="sales-workspace-secondary">
          <summary>Qualification history (newest first)</summary>
          ${renderQualificationHistory(qualificationAssessments, researchJobs)}
        </details>
      </article>

      <article class="card sales-workspace-section" id="sales-workspace-crm">
        <h2>CRM review</h2>
        <p class="section-note">Provider-neutral preview of what would become one Company and zero-or-more Contacts under the accepted future mapping (lifecycle <code>Lead</code>, Company property <code>Luna Sales Status = Qualified Prospect</code>). Preview only — no CRM record has been sent. No Deal. No automatic writes.</p>
        ${crmReadyErrorHtml}
        ${crmReadyStatus}
        ${crmActions}
      </article>

      <article class="card sales-workspace-section" id="sales-workspace-outreach">
        <h2>Draft outreach</h2>
        <p class="section-note">Manual internal draft only for CRM-ready prospects. Draft only — no message has been sent. No SMTP, WhatsApp, LinkedIn, HubSpot, or send controls.</p>
        ${outreachDraftErrorHtml}
        ${outreachDraftStatus}
        ${outreachDraftActions}
      </article>

      <details class="sales-workspace-secondary" id="sales-workspace-contacts">
        <summary>Manual contact enrichment</summary>
        <p class="section-note">Manual contact records only — no Apollo lookup, no auto-find, no CRM write, no message sent. Name and role required; email, phone, and LinkedIn optional.</p>
        ${contactErrorHtml}
        <form class="sales-form" method="post" action="/sales/prospects/${escapeHtml(prospect.id)}/contacts" accept-charset="utf-8">
          <div class="form-row">
            <label for="full_name">Full name</label>
            <input id="full_name" name="full_name" type="text" required maxlength="200" placeholder="Ada Owner" value="${escapeHtml(options.contactFullName || '')}">
          </div>
          <div class="form-row">
            <label for="role">Role</label>
            <input id="role" name="role" type="text" required maxlength="200" placeholder="Owner" value="${escapeHtml(options.contactRole || '')}">
          </div>
          <div class="form-row">
            <label for="email">Email (optional)</label>
            <input id="email" name="email" type="email" maxlength="320" placeholder="ada@example.com" value="${escapeHtml(options.contactEmail || '')}">
          </div>
          <div class="form-row">
            <label for="phone">Phone (optional)</label>
            <input id="phone" name="phone" type="text" maxlength="40" placeholder="+34 600 000 000" value="${escapeHtml(options.contactPhone || '')}">
          </div>
          <div class="form-row">
            <label for="linkedin_url">LinkedIn URL (optional)</label>
            <input id="linkedin_url" name="linkedin_url" type="url" maxlength="2000" placeholder="https://linkedin.com/in/ada-owner" value="${escapeHtml(options.contactLinkedinUrl || '')}">
          </div>
          <div class="form-row">
            <label for="contact_source">Source</label>
            <input id="contact_source" name="source" type="text" required maxlength="200" placeholder="Hostel website team page" value="${escapeHtml(options.contactSource || '')}">
          </div>
          <div class="form-row">
            <label for="contact_confidence">Confidence</label>
            <select id="contact_confidence" name="confidence" required>
              <option value="low"${options.contactConfidence === 'low' ? ' selected' : ''}>Low</option>
              <option value="medium"${!options.contactConfidence || options.contactConfidence === 'medium' ? ' selected' : ''}>Medium</option>
              <option value="high"${options.contactConfidence === 'high' ? ' selected' : ''}>High</option>
            </select>
          </div>
          <div class="form-actions">
            <button class="btn-primary" type="submit">Record manual contact</button>
          </div>
        </form>
        <h3>Recorded contacts (newest first)</h3>
        ${renderContactCandidates(options.contactCandidates)}
      </details>

      <details class="sales-workspace-secondary" id="sales-workspace-admin-decision">
        <summary>Admin status decision</summary>
        <p class="section-note">Any authenticated Crowsnest operator may record approve, reject, or needs_research in this MVP. HubSpot sync is a separate explicit action available only after qualification and CRM review; outreach remains draft-only.</p>
        ${decisionErrorHtml}
        <form class="sales-form" method="post" action="/sales/prospects/${escapeHtml(prospect.id)}/decision" accept-charset="utf-8">
          <div class="form-row">
            <label for="decision">Decision</label>
            <select id="decision" name="decision" required>
              <option value="approved">Approve</option>
              <option value="rejected">Reject</option>
              <option value="needs_research">Needs research</option>
            </select>
          </div>
          <div class="form-row">
            <label for="reason">Reason</label>
            <textarea id="reason" name="reason" required placeholder="Why this decision?"></textarea>
          </div>
          <div class="decision-actions">
            <button class="btn-primary" type="submit">Record Admin decision</button>
          </div>
        </form>
      </details>

      <details class="sales-workspace-secondary" id="sales-workspace-audit">
        <summary>Append-only audit trail</summary>
        ${renderAuditList(audit)}
      </details>

      <div class="safety"><strong>Safety:</strong> Durable Sales decisions, manual evidence, manual contacts, operator qualification, CRM preview/readiness, and internal outreach drafts use the dedicated store when configured; local/test may use in-memory fallback. HubSpot Company/Contact sync is an explicit operator action from CRM Preview only, with no automatic CRM writes. No outreach delivery, Apollo/auto-find, live provider calls beyond that explicit sync, or automatic AI scoring.</div>
    </section>`;
}

function renderCrmPreviewContacts(contacts) {
  const list = Array.isArray(contacts) ? contacts : [];
  if (!list.length) {
    return '<p class="section-note">Contacts: none (zero Contacts in this preview).</p>';
  }
  const items = list.map((contact) => {
    const name = escapeHtml(contact.full_name || 'n/a');
    const email = escapeHtml(contact.email || 'n/a');
    const role = escapeHtml(contact.role || 'n/a');
    return `<li><strong>${name}</strong> · email=<code>${email}</code> · role=<code>${role}</code></li>`;
  }).join('\n          ');
  return `<ul class="fact-list" aria-label="CRM preview contacts">
          ${items}
        </ul>`;
}

function renderApprovedCrmSyncStatus(attempt) {
  if (!attempt || typeof attempt !== 'object') {
    return '<p class="section-note">No HubSpot sync attempt recorded yet.</p>';
  }
  const status = String(attempt.status || '').toLowerCase();
  const companyId = String(attempt.provider_company_id || '').trim();
  const contactIds = Array.isArray(attempt.provider_contact_ids)
    ? attempt.provider_contact_ids.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const errorCategory = String(attempt.error_category || '').trim();

  if (status === 'succeeded' && companyId) {
    return `<p>HubSpot sync status: <code>succeeded</code></p>
        <p>Confirmed Company ID: <code>${escapeHtml(companyId)}</code></p>
        <p>Confirmed Contact IDs: <code>${escapeHtml(contactIds.join(', ') || 'none')}</code></p>
        <p class="section-note">Success is shown only after provider IDs were confirmed. This did not send outreach.</p>`;
  }
  if (status === 'pending') {
    return `<p>HubSpot sync status: <code>pending</code></p>
        <p class="section-note">Attempt recorded; provider IDs are not confirmed yet — do not treat this as success.</p>`;
  }
  if (status === 'failed') {
    return `<p>HubSpot sync status: <code>failed</code></p>
        <p>Error category: <code>${escapeHtml(errorCategory || 'unknown')}</code></p>
        <p class="section-note">No confirmed HubSpot Company/Contact IDs. Retry only with an explicit Send to HubSpot action.</p>`;
  }
  return `<p>HubSpot sync status: <code>${escapeHtml(status || 'unknown')}</code></p>
        <p class="section-note">Provider IDs are not confirmed — do not treat this as success.</p>`;
}

function renderApprovedCrmSyncControls(options = {}) {
  const prospect = options.prospect || null;
  if (!prospect || !prospect.id) return '';
  const eligible = options.approvedCrmSyncEligible === true;
  if (!eligible) {
    return '';
  }

  const attempt = options.approvedCrmSyncAttempt || null;
  const mark = options.latestCrmReviewMark || null;
  const statusHtml = renderApprovedCrmSyncStatus(attempt);
  const succeeded = attempt
    && String(attempt.status || '').toLowerCase() === 'succeeded'
    && String(attempt.provider_company_id || '').trim();

  const formHtml = succeeded
    ? '<p class="section-note">A confirmed HubSpot Company already exists for this review mark. Repeating Send returns the durable prior attempt and does not create a duplicate.</p>'
    : `<form class="sales-form" method="post" action="/sales/prospects/${escapeHtml(prospect.id)}/approved-crm-sync" accept-charset="utf-8">
          <input type="hidden" name="operator_command" value="send_approved_crm_sync">
          ${mark && mark.id
    ? `<input type="hidden" name="crm_review_mark_id" value="${escapeHtml(mark.id)}">`
    : ''}
          <p>This creates/updates a Company and optional Contacts. It does not send outreach.</p>
          <div class="form-actions">
            <button class="btn-primary" type="submit">Send to HubSpot</button>
          </div>
        </form>`;

  return `<article class="card" id="sales-approved-crm-sync">
        <h2>Send to HubSpot</h2>
        ${statusHtml}
        ${formHtml}
      </article>`;
}

function renderSalesCrmPreviewMain(options = {}) {
  const prospect = options.prospect || null;
  const preview = options.crmPreview || null;
  if (!prospect || !preview) {
    return `<section id="sales-crm-preview" class="card placeholder-shell">
      <p>CRM preview is unavailable.</p>
      <p><a href="/sales">Back to Sales</a></p>
    </section>`;
  }
  const company = preview.company || {};
  const properties = company.properties || {};
  const propertyRows = Object.keys(properties).map((key) => (
    `<li><strong>${escapeHtml(key)}:</strong> <code>${escapeHtml(String(properties[key]))}</code></li>`
  )).join('\n          ') || '<li>None</li>';
  const trace = preview.traceability || {};
  const evidenceIds = Array.isArray(trace.evidence_ids) ? trace.evidence_ids : [];
  const mark = options.latestCrmReviewMark || null;
  const markHtml = mark
    ? `<p>Ready for CRM review marked at <code>${escapeHtml(mark.created_at || '')}</code>
         by <code>${escapeHtml(mark.reviewer_id || '')}</code>.</p>`
    : '<p class="section-note">Not yet marked ready for CRM review.</p>';
  const audit = Array.isArray(options.auditEvents) ? options.auditEvents : [];
  const syncError = options.approvedCrmSyncError
    ? `<p class="form-error" role="alert">${escapeHtml(options.approvedCrmSyncError)}</p>`
    : '';

  return `<section id="sales-crm-preview" aria-labelledby="sales-crm-preview-title">
      ${renderSalesSupportingRoomNav({
    backHref: `/sales/prospects/${prospect.id}`,
    backLabel: 'Back to prospect detail',
  })}
      <article class="card">
        <h2 id="sales-crm-preview-title">CRM sync preview</h2>
        ${renderSalesSafetyBadge('Preview only', 'No CRM record has been sent. Provider-neutral Company + Contacts mapping only — no Deal, no automatic CRM write.')}
        ${markHtml}
        <p><strong>Business name:</strong> ${escapeHtml(prospect.canonical_name || 'n/a')}</p>
        <p><strong>Website:</strong> ${escapeHtml(prospect.website_url || 'n/a')}</p>
      </article>

      <article class="card">
        <h2>Company (1)</h2>
        <p><strong>Name:</strong> ${escapeHtml(company.name || '')}</p>
        <p><strong>Website:</strong> ${escapeHtml(company.website_url || 'n/a')}</p>
        <p><strong>Domain:</strong> <code>${escapeHtml(company.domain || 'n/a')}</code></p>
        <p><strong>Lifecycle stage:</strong> <code>${escapeHtml(company.lifecycle_stage || '')}</code></p>
        <h3>Company properties</h3>
        <ul class="fact-list">
          ${propertyRows}
        </ul>
      </article>

      <article class="card">
        <h2>Contacts (${escapeHtml(String((preview.contacts || []).length))})</h2>
        ${renderCrmPreviewContacts(preview.contacts)}
      </article>

      <article class="card">
        <h2>Deal</h2>
        <p class="section-note">No Deal — this preview does not create or propose a Deal.</p>
      </article>

      <article class="card">
        <h2>Qualification evidence / reason traceability</h2>
        <p>Decision: <code>${escapeHtml(trace.decision || '')}</code></p>
        <p>Rationale: ${escapeHtml(trace.rationale || '')}</p>
        <p>Qualification id: <code>${escapeHtml(trace.qualification_assessment_id || '')}</code></p>
        <p>Evidence refs: <code>${escapeHtml(evidenceIds.join(',') || 'none')}</code></p>
        <form class="sales-form" method="post" action="/sales/prospects/${escapeHtml(prospect.id)}/crm-ready" accept-charset="utf-8">
          <div class="form-actions">
            ${renderSalesSafetyBadge('Preview only', 'No CRM writes from this action.')}
            <button class="btn-primary" type="submit">Mark ready for CRM review</button>
          </div>
        </form>
      </article>

      ${syncError}
      ${renderApprovedCrmSyncControls(options)}

      <article class="card">
        <h2>Append-only audit trail</h2>
        ${renderAuditList(audit)}
      </article>
    </section>`;
}

function renderOutreachDraftRevisionList(revisions) {
  const list = Array.isArray(revisions) ? revisions : [];
  if (!list.length) {
    return '<p class="section-note">No draft revisions yet. Save the first current draft below.</p>';
  }
  const items = list.map((rev) => {
    return `<li class="card">
        <p><strong>Revision ${escapeHtml(String(rev.revision_number || ''))}</strong>
          · channel=<code>${escapeHtml(rev.channel || '')}</code>
          · author=<code>${escapeHtml(rev.author_id || '')}</code>
          · at=<code>${escapeHtml(rev.created_at || '')}</code></p>
        <p><strong>Subject:</strong> ${escapeHtml(rev.subject || '')}</p>
        <p><strong>Body:</strong> ${escapeHtml(rev.body || '')}</p>
        <p><strong>Next-step note:</strong> ${escapeHtml(rev.next_step_note || '')}</p>
        <p class="section-note">Draft only — no message has been sent.</p>
      </li>`;
  }).join('\n        ');
  return `<ul class="fact-list" aria-label="Outreach draft revision history">
        ${items}
      </ul>`;
}

function renderSalesOutreachDraftMain(options = {}) {
  const prospect = options.prospect || null;
  if (!prospect) {
    return `<section id="sales-outreach-draft" class="card placeholder-shell">
      <p>Outreach draft workspace is unavailable.</p>
      <p><a href="/sales">Back to Sales</a></p>
    </section>`;
  }
  const current = options.currentOutreachDraft || options.currentDraft || null;
  const revisions = Array.isArray(options.outreachDraftRevisions)
    ? options.outreachDraftRevisions
    : (Array.isArray(options.revisions) ? options.revisions : []);
  const draftErrorHtml = options.outreachDraftError
    ? `<p class="sales-error" role="alert">${escapeHtml(options.outreachDraftError)}</p>`
    : '';
  const subjectValue = options.outreachDraftSubject != null
    ? options.outreachDraftSubject
    : (current && current.subject) || '';
  const bodyValue = options.outreachDraftBody != null
    ? options.outreachDraftBody
    : (current && current.body) || '';
  const channelValue = options.outreachDraftChannel != null
    ? options.outreachDraftChannel
    : (current && current.channel) || 'email';
  const nextStepValue = options.outreachDraftNextStepNote != null
    ? options.outreachDraftNextStepNote
    : (current && current.next_step_note) || '';
  const audit = Array.isArray(options.auditEvents) ? options.auditEvents : [];

  return `<section id="sales-outreach-draft" aria-labelledby="sales-outreach-draft-title">
      ${renderSalesSupportingRoomNav({
    backHref: `/sales/prospects/${prospect.id}`,
    backLabel: 'Back to prospect detail',
  })}
      <article class="card">
        <h2 id="sales-outreach-draft-title">Outreach draft</h2>
        ${renderSalesSafetyBadge('Draft only', 'No message has been sent. Manual internal workspace — no SMTP, WhatsApp, LinkedIn, HubSpot API, send endpoint, webhooks, or auto-generation.')}
        <p><strong>Business name:</strong> ${escapeHtml(prospect.canonical_name || 'n/a')}</p>
        <p><strong>Website:</strong> ${escapeHtml(prospect.website_url || 'n/a')}</p>
        <p>Draft ready: <code>Yes</code> · Draft present: <code>${current ? 'Yes' : 'No'}</code></p>
      </article>

      <article class="card">
        <h2>${current ? 'Edit current draft' : 'Create current draft'}</h2>
        ${draftErrorHtml}
        <form class="sales-form" method="post" action="/sales/prospects/${escapeHtml(prospect.id)}/outreach-draft" accept-charset="utf-8">
          <div class="form-row">
            <label for="subject">Subject</label>
            <input id="subject" name="subject" type="text" required maxlength="500" value="${escapeHtml(subjectValue)}">
          </div>
          <div class="form-row">
            <label for="body">Body</label>
            <textarea id="body" name="body" required maxlength="10000">${escapeHtml(bodyValue)}</textarea>
          </div>
          <div class="form-row">
            <label for="channel">Channel</label>
            <select id="channel" name="channel" required>
              <option value="email"${channelValue === 'email' ? ' selected' : ''}>Email</option>
              <option value="linkedin"${channelValue === 'linkedin' ? ' selected' : ''}>LinkedIn</option>
              <option value="other"${channelValue === 'other' ? ' selected' : ''}>Other</option>
            </select>
          </div>
          <div class="form-row">
            <label for="next_step_note">Next-step note</label>
            <textarea id="next_step_note" name="next_step_note" required maxlength="2000" placeholder="What should happen after this draft?">${escapeHtml(nextStepValue)}</textarea>
          </div>
          <div class="form-actions">
            ${renderSalesSafetyBadge('Draft only', 'No message has been sent.')}
            <button class="btn-primary" type="submit">${current ? 'Save draft revision' : 'Create draft'}</button>
          </div>
        </form>
      </article>

      <article class="card">
        <h2>Revision history (newest first)</h2>
        ${renderOutreachDraftRevisionList(revisions)}
      </article>

      <article class="card">
        <h2>Append-only audit trail</h2>
        ${renderAuditList(audit)}
      </article>
    </section>`;
}

function renderDiscoveryDedupMatches(matches) {
  if (!Array.isArray(matches) || matches.length === 0) {
    return '<p class="section-note">No duplicate matches against existing prospects.</p>';
  }
  const items = matches.map((match) => {
    const label = escapeHtml(match.canonical_name || match.prospect_id || 'prospect');
    const reason = escapeHtml(match.reason || match.match_type || 'match');
    const website = match.website_url ? ` · ${escapeHtml(match.website_url)}` : '';
    const href = match.prospect_id ? `/sales/prospects/${encodeURIComponent(match.prospect_id)}` : '';
    const link = href
      ? `<a href="${escapeHtml(href)}">${label}</a>`
      : label;
    return `<li>${link} · match=${reason}${website}</li>`;
  }).join('\n        ');
  return `<ul class="fact-list" aria-label="Discovery dedup matches">
        ${items}
      </ul>`;
}

function renderDiscoveryPreviewPanel(options = {}) {
  const preview = options.discoveryPreview || null;
  if (!preview) return '';
  const proposal = preview.proposal || {};
  const location = proposal.location || {};
  const sourceRef = proposal.source_reference || {};
  const quality = preview.quality || {};
  const dedup = preview.dedup || {};
  const formValues = options.discoveryForm || {};
  const importFields = [
    ['business_name', formValues.business_name || proposal.business_name || ''],
    ['website_url', formValues.website_url || proposal.website_url || ''],
    ['city', formValues.city || location.city || ''],
    ['country_code', formValues.country_code || location.country_code || ''],
    ['category', formValues.category || proposal.category || ''],
    ['source_note', formValues.source_note || sourceRef.request_reference || ''],
  ].map(([name, value]) => (
    `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`
  )).join('\n          ');

  return `<article class="card" id="discovery-preview-result">
        <h2>Normalized proposal preview</h2>
        <p class="section-note"><strong>${escapeHtml(preview.disclaimer || 'Preview only — no prospect has been created.')}</strong></p>
        <ul class="fact-list" aria-label="Normalized proposed prospect">
          <li><strong>Business name:</strong> ${escapeHtml(proposal.business_name || '—')}</li>
          <li><strong>Website:</strong> ${escapeHtml(proposal.website_url || '—')}</li>
          <li><strong>Location:</strong> ${escapeHtml([location.city, location.country_code].filter(Boolean).join(', ') || '—')}</li>
          <li><strong>Category:</strong> ${escapeHtml(proposal.category || '—')}</li>
          <li><strong>Source reference:</strong> ${escapeHtml(sourceRef.source_name || 'manual')} · ${escapeHtml(sourceRef.request_reference || 'operator-entry')}</li>
          <li><strong>Completeness:</strong> ${escapeHtml((quality.completeness) || '—')}</li>
        </ul>
        <h2>Deduplication preview</h2>
        ${renderDiscoveryDedupMatches(dedup.matches)}
        <form class="sales-form" method="post" action="/sales/discovery/import" accept-charset="utf-8">
          ${importFields}
          <div class="form-actions">
            <button class="btn-primary" type="submit">Import as prospect (explicit)</button>
          </div>
        </form>
        <p class="section-note">Import is an explicit operator action. Discovery never auto-creates prospects.</p>
      </article>`;
}

function renderMapsDiscoveryCandidateCards(preview) {
  const candidates = preview && Array.isArray(preview.candidates) ? preview.candidates : [];
  if (!candidates.length) {
    return `<p class="section-note">No in-scope dry-run candidates matched. Northern Spain sample fixtures only — not live Google Maps.</p>`;
  }
  return candidates.map((entry, index) => {
    const proposal = entry.proposal || {};
    const location = proposal.location || {};
    const sourceRef = proposal.source_reference || {};
    const dedup = entry.dedup || {};
    const matchCount = Array.isArray(dedup.matches) ? dedup.matches.length : 0;
    return `<article class="card" id="maps-candidate-${index}">
        <h3>${escapeHtml(proposal.business_name || 'Candidate')}</h3>
        <ul class="fact-list" aria-label="Maps dry-run candidate">
          <li><strong>Website:</strong> ${escapeHtml(proposal.website_url || '—')}</li>
          <li><strong>Location:</strong> ${escapeHtml([location.city, location.country_code].filter(Boolean).join(', ') || '—')}</li>
          <li><strong>Category:</strong> ${escapeHtml(proposal.category || '—')}</li>
          <li><strong>Place ID:</strong> ${escapeHtml(entry.place_id || sourceRef.external_id || '—')}</li>
          <li><strong>Search area:</strong> ${escapeHtml(entry.search_area || sourceRef.request_reference || '—')}</li>
          <li><strong>Source:</strong> ${escapeHtml(sourceRef.source_name || 'google_maps_dry_run')}</li>
          <li><strong>Dedup matches:</strong> ${escapeHtml(String(matchCount))}</li>
        </ul>
        ${renderDiscoveryDedupMatches(dedup.matches)}
        <form class="sales-form" method="post" action="/sales/discovery/maps/import" accept-charset="utf-8">
          <input type="hidden" name="place_id" value="${escapeHtml(entry.place_id || sourceRef.external_id || '')}">
          <input type="hidden" name="search_area" value="${escapeHtml(entry.search_area || sourceRef.request_reference || '')}">
          <div class="form-actions">
            <button class="btn-primary" type="submit">Import candidate (explicit)</button>
          </div>
        </form>
      </article>`;
  }).join('\n      ');
}

function renderMapsDiscoveryPreviewPanel(options = {}) {
  const preview = options.mapsDiscoveryPreview || null;
  if (!preview) return '';
  return `<article class="card" id="maps-discovery-preview-result">
        <h2>Maps dry-run candidates</h2>
        <p class="section-note"><strong>${escapeHtml(preview.disclaimer || 'Sample / dry-run data only — not live Google Maps results.')}</strong></p>
        <ul class="fact-list" aria-label="Maps dry-run search summary">
          <li><strong>Search area:</strong> ${escapeHtml(preview.search_area || '—')}</li>
          <li><strong>Discarded out of Northern Spain scope:</strong> ${escapeHtml(String(preview.discarded_out_of_scope_count == null ? 0 : preview.discarded_out_of_scope_count))}</li>
          <li><strong>Candidates:</strong> ${escapeHtml(String(Array.isArray(preview.candidates) ? preview.candidates.length : 0))}</li>
        </ul>
        <p class="section-note">Preview only — no prospect has been created. Import is an explicit operator action per candidate.</p>
      </article>
      ${renderMapsDiscoveryCandidateCards(preview)}`;
}

function renderSalesDiscoveryMain(options = {}) {
  const form = options.discoveryForm || {};
  const mapsForm = options.mapsDiscoveryForm || {};
  const errorHtml = options.discoveryError
    ? `<p class="sales-error" role="alert">${escapeHtml(options.discoveryError)}</p>`
    : '';
  const mapsErrorHtml = options.mapsDiscoveryError
    ? `<p class="sales-error" role="alert">${escapeHtml(options.mapsDiscoveryError)}</p>`
    : '';
  return `<section id="sales-discovery" aria-labelledby="sales-discovery-title">
      <h2 class="section" id="sales-discovery-title">Sales discovery</h2>
      <p class="section-note">Preview normalization and deduplication, then optionally import. Preview only — no prospect has been created until you explicitly import.</p>
      ${renderSalesSupportingRoomNav()}
      <article class="card" id="manual-discovery-proposal">
        <h2>Manual discovery proposal</h2>
        <p class="section-note">Primary path. Provider-neutral fields. No live Google Maps, Apollo, web search, or external API calls.</p>
        ${errorHtml}
        <form class="sales-form" method="post" action="/sales/discovery/preview" accept-charset="utf-8">
          <div class="form-row">
            <label for="discovery_business_name">Business name</label>
            <input id="discovery_business_name" name="business_name" type="text" placeholder="Somo Surf House" value="${escapeHtml(form.business_name || '')}">
          </div>
          <div class="form-row">
            <label for="discovery_website_url">Website</label>
            <input id="discovery_website_url" name="website_url" type="url" placeholder="https://example-surf-house.example" value="${escapeHtml(form.website_url || '')}">
          </div>
          <div class="form-row">
            <label for="discovery_city">Location city</label>
            <input id="discovery_city" name="city" type="text" placeholder="Somo" value="${escapeHtml(form.city || '')}">
          </div>
          <div class="form-row">
            <label for="discovery_country_code">Location country code</label>
            <input id="discovery_country_code" name="country_code" type="text" placeholder="ES" value="${escapeHtml(form.country_code || '')}">
          </div>
          <div class="form-row">
            <label for="discovery_category">Category</label>
            <input id="discovery_category" name="category" type="text" placeholder="surf_hostel" value="${escapeHtml(form.category || '')}">
          </div>
          <div class="form-row">
            <label for="discovery_source_note">Source reference note</label>
            <input id="discovery_source_note" name="source_note" type="text" placeholder="operator typed from brochure" value="${escapeHtml(form.source_note || '')}">
          </div>
          <div class="form-actions">
            <button class="btn-primary" type="submit">Preview proposal</button>
          </div>
        </form>
      </article>
      ${renderDiscoveryPreviewPanel(options)}
      <article class="card" id="maps-discovery-dry-run">
        <h2>Google Maps discovery (dry-run)</h2>
        ${renderSalesSafetyBadge('Sample / dry-run data only', 'Local test fixtures only — no live Maps HTTP, API key, Google SDK, or scraping. No live Maps / no external discovery from this room.')}
        <p class="section-note">Northern Spain scope enforced. Search returns sample place candidates with exact place ID and search area provenance. Dedup uses the existing discovery preview. No prospect is created until you explicitly import one candidate.</p>
        ${mapsErrorHtml}
        <form class="sales-form" method="post" action="/sales/discovery/maps/preview" accept-charset="utf-8">
          <div class="form-row">
            <label for="maps_discovery_city">City (Northern Spain)</label>
            <input id="maps_discovery_city" name="city" type="text" placeholder="Somo" value="${escapeHtml(mapsForm.city || '')}">
          </div>
          <div class="form-row">
            <label for="maps_discovery_country_code">Country code</label>
            <input id="maps_discovery_country_code" name="country_code" type="text" placeholder="ES" value="${escapeHtml(mapsForm.country_code || 'ES')}">
          </div>
          <div class="form-row">
            <label for="maps_discovery_category">Category</label>
            <input id="maps_discovery_category" name="category" type="text" placeholder="lodging" value="${escapeHtml(mapsForm.category || '')}">
          </div>
          <div class="form-row">
            <label for="maps_discovery_query">Query</label>
            <input id="maps_discovery_query" name="query" type="text" placeholder="surf" value="${escapeHtml(mapsForm.query || '')}">
          </div>
          <input type="hidden" name="market" value="northern_spain">
          <div class="form-actions">
            <button class="btn-primary" type="submit">Preview dry-run Maps candidates</button>
          </div>
        </form>
      </article>
      ${renderMapsDiscoveryPreviewPanel(options)}
    </section>`;
}

function renderViewMain(view, clients, templates, options = {}) {
  if (view === 'clients') return renderClientsMain(clients, templates);
  if (view === 'billing') return renderBillingMain();
  if (view === 'communications') return renderCommunicationsMain();
  if (view === 'sales') return renderSalesMain(options);
  if (view === 'sales_detail') return renderSalesDetailMain(options);
  if (view === 'sales_review') return renderSalesReviewMain(options);
  if (view === 'sales_analytics') return renderSalesAnalyticsMain(options);
  if (view === 'sales_governance') return renderSalesGovernanceMain(options);
  if (view === 'sales_crm_preview') return renderSalesCrmPreviewMain(options);
  if (view === 'sales_outreach_draft') return renderSalesOutreachDraftMain(options);
  if (view === 'sales_discovery') return renderSalesDiscoveryMain(options);
  return renderSpyglassMain(clients, options);
}

function viewPageTitle(view) {
  if (view === 'clients') return 'Clients';
  if (view === 'billing') return 'Billing';
  if (view === 'communications') return 'Communications';
  if (view === 'sales_review') return 'Sales review queue';
  if (view === 'sales_analytics') return 'Sales analytics';
  if (view === 'sales_governance') return 'Sales governance';
  if (view === 'sales_crm_preview') return 'CRM sync preview';
  if (view === 'sales_outreach_draft') return 'Outreach draft';
  if (view === 'sales_discovery') return 'Sales discovery';
  if (view === 'sales' || view === 'sales_detail') return 'Sales';
  return 'Spyglass';
}

function viewSubtitle(view) {
  if (view === 'clients') return 'Static client cards, templates, and onboarding mockup';
  if (view === 'billing') return 'Billing sources are not connected yet';
  if (view === 'communications') return 'Communications sources are not connected yet';
  if (view === 'sales') return 'Operator Sales cockpit — pipeline, attention queue, and human-approved intake';
  if (view === 'sales_detail') return 'Prospect review detail, fixture research, manual evidence, manual contacts, qualification, CRM preview, outreach draft, and Admin decision';
  if (view === 'sales_review') return 'Sales review queue — operating buckets for operator decisions';
  if (view === 'sales_analytics') return 'Sales analytics — truthful pipeline counts, recent activity, and data-quality alerts';
  if (view === 'sales_governance') return 'Sales governance — workflow safeguards, human-approval rules, retention, integrations, action boundaries';
  if (view === 'sales_crm_preview') return 'Provider-neutral CRM sync preview — no record sent';
  if (view === 'sales_outreach_draft') return 'Internal outreach draft workspace — draft only, no message sent';
  if (view === 'sales_discovery') return 'Manual + Maps dry-run discovery — sample data only; no prospect auto-created';
  return 'Internal Luna Front Desk overview dashboard';
}

function renderCrowsnestPage(options = {}) {
  const nonce = options.cspNonce ? String(options.cspNonce) : '';
  const view = normalizeCrowsnestView(options.view != null ? options.view : options.route);
  const clients = getCrowsnestClients();
  const templates = getCrowsnestTemplates();
  const title = viewPageTitle(view);
  const main = renderViewMain(view, clients, templates, options);

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
      <h1 class="page-title" id="${escapeHtml(view === 'sales_detail' ? 'sales' : (view === 'sales_review' ? 'sales-review' : (view === 'sales_analytics' ? 'sales-analytics' : (view === 'sales_governance' ? 'sales-governance' : (view === 'sales_crm_preview' ? 'sales-crm-preview' : (view === 'sales_outreach_draft' ? 'sales-outreach-draft' : (view === 'sales_discovery' ? 'sales-discovery' : view)))))))}-title">${escapeHtml(title)}</h1>
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
