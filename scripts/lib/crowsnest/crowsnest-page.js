'use strict';

/**
 * Crowsnest static portal HTML (read-only skeleton — no writes, no API calls).
 */

const { getCrowsnestClients, getCrowsnestTemplates } = require('./crowsnest-clients');
const { renderCrowsnestOnboardingSection } = require('./crowsnest-onboarding');
const { getSampleClientMetrics, getSampleAiUsage } = require('./crowsnest-sample-telemetry');

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

function renderSpyglassClientRow(client, metrics) {
  const m = metrics || {};
  const notLive = m.live === false;
  const humanClass = m.needs_human > 0 ? ' cr-chip--alert' : '';
  const envRows = (client.environments || []).map(renderEnvironmentRow).join('\n            ');
  const summaryChips = notLive
    ? '<span class="cr-chip cr-chip--muted">not reporting yet</span>'
    : `<span class="cr-chip">${escapeHtml(String(m.conversations))} convs</span>
            <span class="cr-chip">${escapeHtml(String(m.messages_per_day))}/day</span>
            <span class="cr-chip${humanClass}">${escapeHtml(String(m.needs_human))} need human</span>`;

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
            <div class="cr-metrics">
              <div class="cr-metric"><span class="cr-metric-label">Conversations</span><span class="cr-metric-value">${escapeHtml(String(m.conversations || 0))}</span></div>
              <div class="cr-metric"><span class="cr-metric-label">Messages / day</span><span class="cr-metric-value">${escapeHtml(String(m.messages_per_day || 0))}</span></div>
              <div class="cr-metric"><span class="cr-metric-label">Need human</span><span class="cr-metric-value">${escapeHtml(String(m.needs_human || 0))}</span></div>
              <div class="cr-metric"><span class="cr-metric-label">Last active</span><span class="cr-metric-value">${escapeHtml(String(m.last_active || '—'))}</span></div>
            </div>
            <div class="env-mini">
              <h4 class="env-heading">Environments / status</h4>
              <ul class="env-list">
            ${envRows}
              </ul>
            </div>
          </div>
        </details>`;
}

function renderSpyglassMain(clients) {
  const stats = countStaticEnvironmentStats(clients);
  const metrics = getSampleClientMetrics();
  const usage = getSampleAiUsage();
  const liveClients = clients.filter((c) => (metrics[c.id] || {}).live !== false);
  const totalConversations = liveClients.reduce((sum, c) => sum + (metrics[c.id] || {}).conversations || 0, 0);
  const totalMsgPerDay = liveClients.reduce((sum, c) => sum + ((metrics[c.id] || {}).messages_per_day || 0), 0);
  const totalNeedsHuman = liveClients.reduce((sum, c) => sum + ((metrics[c.id] || {}).needs_human || 0), 0);
  const clientRows = clients.map((c) => renderSpyglassClientRow(c, metrics[c.id])).join('\n        ');

  return `<section id="spyglass" aria-labelledby="spyglass-title">
      <div class="sample-banner">
        <span class="sample-dot" aria-hidden="true"></span>
        <span><strong>Sample data (Iris preview).</strong> Numbers are illustrative placeholders, not live telemetry. Pupil wires real sources next.</span>
      </div>
      <div class="kpi-strip">
        <div class="kpi">
          <span class="kpi-label">Clients</span>
          <span class="kpi-value">${escapeHtml(String(stats.clientCount))}</span>
          <span class="kpi-sub">${escapeHtml(String(liveClients.length))} reporting</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Conversations</span>
          <span class="kpi-value">${escapeHtml(String(totalConversations))}</span>
          <span class="kpi-sub">sample</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Messages / day</span>
          <span class="kpi-value">${escapeHtml(String(totalMsgPerDay))}</span>
          <span class="kpi-sub">sample</span>
        </div>
        <div class="kpi kpi--alert">
          <span class="kpi-label">Need human</span>
          <span class="kpi-value">${escapeHtml(String(totalNeedsHuman))}</span>
          <span class="kpi-sub">sample</span>
        </div>
      </div>

      ${renderAiUsagePanel(usage)}

      <section class="panel clients-panel" aria-labelledby="clients-overview-title">
        <header class="panel-head">
          <h2 class="panel-title" id="clients-overview-title">Clients</h2>
          <span class="sample-badge">Sample metrics</span>
          <span class="panel-window">Tap a client to expand</span>
        </header>
        <div class="client-rows">
        ${clientRows}
        </div>
      </section>

      <div class="safety"><strong>Safety:</strong> Read-only Spyglass shell. All AI usage and client metrics shown are clearly-labeled <strong>sample data</strong>, not live telemetry — no live writes, no billing feeds, and no production actions are enabled.</div>
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
  ${renderStyleTag(CROWSNEST_LOGIN_CSS, nonce)}
</head>
<body>
  <main class="login-shell">
    <section class="login-card" aria-labelledby="login-title">
      <img class="login-logo" src="/crowsnest/assets/logo.png" alt="Crowsnest" width="2172" height="724">
      <p class="login-kicker">Private operator portal</p>
      <h1 class="login-title" id="login-title">Sign in to Crowsnest</h1>
      ${errorHtml}
      <form class="login-form" method="post" action="/login" accept-charset="utf-8">
        <div class="field">
          <label class="field-label" for="username">Username</label>
          <input class="field-input" id="username" name="username" type="text" autocomplete="username" required>
        </div>
        <div class="field">
          <label class="field-label" for="password">Password</label>
          <input class="field-input" id="password" name="password" type="password" autocomplete="current-password" required>
        </div>
        <button class="login-button" type="submit">Sign in</button>
      </form>
      <p class="login-footer">Private access only. No browser Basic Auth prompt.</p>
    </section>
  </main>
</body>
</html>`;
}

module.exports = {
  renderCrowsnestPage,
  renderCrowsnestLoginPage,
};
