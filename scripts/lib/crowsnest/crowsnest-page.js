'use strict';

/**
 * Crowsnest static portal HTML (read-only skeleton — no writes, no API calls).
 */

const { getCrowsnestClients, getCrowsnestTemplates } = require('./crowsnest-clients');

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderUrlField(label, value, href) {
  const safe = escapeHtml(value);
  const inner = href
    ? `<a href="${escapeHtml(value)}" target="_blank" rel="noopener noreferrer">${safe}</a>`
    : safe;
  return `<div class="field"><span class="field-label">${escapeHtml(label)}</span> ${inner}</div>`;
}

function renderClientCard(client) {
  return `<div class="card client-card">
        <h2>${escapeHtml(client.name)}</h2>
        <div class="meta">
          ${renderUrlField('client slug:', client.client_slug, false)}
          ${renderUrlField('type:', client.type, false)}
          ${renderUrlField('staging URL:', client.staging_url, client.staging_url_href)}
          ${renderUrlField('production URL:', client.production_url, client.production_url_href)}
          ${renderUrlField('status:', client.status, false)}
        </div>
      </div>`;
}

function renderCrowsnestPage() {
  const clients = getCrowsnestClients();
  const templates = getCrowsnestTemplates();
  const clientCards = clients.map(renderClientCard).join('\n      ');
  const templateCards = templates.map((t) => `<div class="card template-card">
        <h2>${escapeHtml(t.label)}</h2>
        <span class="badge">${escapeHtml(t.status)}</span>
      </div>`).join('\n      ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Crowsnest</title>
  <style>
    :root { font-family: system-ui, sans-serif; color: #1a1a1a; background: #f4f6f8; }
    body { margin: 0; padding: 2rem; }
    .wrap { max-width: 820px; margin: 0 auto; }
    h1 { margin: 0 0 0.25rem; font-size: 1.75rem; }
    .sub { color: #555; margin: 0 0 1.5rem; }
    h2.section { margin: 0 0 0.75rem; font-size: 1.1rem; font-weight: 600; }
    section { margin-bottom: 1.75rem; }
    .cards { display: grid; gap: 0.75rem; }
    .card {
      background: #fff; border: 1px solid #dde3ea; border-radius: 8px;
      padding: 1rem 1.25rem;
    }
    .card h2 { margin: 0 0 0.5rem; font-size: 1rem; }
    .meta .field { margin: 0.25rem 0; font-size: 0.88rem; color: #444; }
    .field-label { color: #666; font-weight: 500; }
    .card a { color: #0b5cab; }
    .badge { display: inline-block; font-size: 0.75rem; color: #888; margin-top: 0.35rem; }
    .btn-disabled {
      display: inline-block; margin-top: 0.75rem; padding: 0.5rem 1rem;
      background: #eef1f4; border: 1px solid #ccd3db; border-radius: 6px;
      color: #888; font-size: 0.9rem; cursor: not-allowed;
    }
    .safety {
      margin-top: 1.5rem; padding: 0.75rem 1rem; background: #fff8e6;
      border: 1px solid #f0d78c; border-radius: 8px; font-size: 0.85rem;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Crowsnest</h1>
    <p class="sub">Internal Luna Front Desk control portal</p>

    <section id="clients">
      <h2 class="section">Clients</h2>
      <div class="cards">
      ${clientCards}
      </div>
      <button type="button" class="btn-disabled" disabled aria-disabled="true">Add new client — Coming soon</button>
    </section>

    <section id="templates">
      <h2 class="section">Templates</h2>
      <div class="cards">
      ${templateCards}
      </div>
    </section>

    <div class="safety"><strong>Safety:</strong> Read-only skeleton. No client creation, tenant writes, WhatsApp, Stripe, or production actions are enabled.</div>
  </div>
</body>
</html>`;
}

module.exports = {
  renderCrowsnestPage,
};
