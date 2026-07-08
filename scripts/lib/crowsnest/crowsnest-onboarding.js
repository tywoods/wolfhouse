'use strict';

/**
 * Static New client onboarding mockup data — no writes, no submit.
 */

function getCrowsnestOnboardingTemplates() {
  return [
    { id: 'surf_house', label: 'Surf house' },
    { id: 'surf_school', label: 'Surf school' },
  ];
}

function getCrowsnestOnboardingChecklist() {
  return [
    { id: 'tenant_record', label: 'Create tenant record', status: 'coming_soon' },
    { id: 'database_schema', label: 'Create database/schema', status: 'coming_soon' },
    { id: 'staff_api', label: 'Configure Staff API environment', status: 'coming_soon' },
    { id: 'luna_identity', label: 'Configure Luna identity', status: 'coming_soon' },
    { id: 'whatsapp', label: 'Configure WhatsApp', status: 'coming_soon' },
    { id: 'stripe', label: 'Configure Stripe', status: 'coming_soon' },
    { id: 'dns_domain', label: 'Configure DNS/domain', status: 'coming_soon' },
    { id: 'smoke_tests', label: 'Run smoke tests', status: 'coming_soon' },
  ];
}

function getCrowsnestOnboardingFormFields() {
  return [
    { id: 'client_name', label: 'Client name', type: 'text', placeholder: 'Example Surf House' },
    { id: 'client_slug', label: 'Client slug', type: 'text', placeholder: 'example-surf-house' },
    { id: 'client_type', label: 'Client type / template', type: 'select', options: getCrowsnestOnboardingTemplates() },
    { id: 'primary_location', label: 'Primary location', type: 'text', placeholder: 'Somo, Spain' },
    { id: 'contact_email', label: 'Contact email', type: 'email', placeholder: 'hello@example.com' },
    { id: 'whatsapp_number', label: 'WhatsApp number', type: 'text', placeholder: '+34…' },
    { id: 'staff_portal_domain', label: 'Staff portal domain', type: 'text', placeholder: 'example.lunafrontdesk.com' },
    { id: 'staging_domain', label: 'Staging domain', type: 'text', placeholder: 'example-staging.lunafrontdesk.com' },
    { id: 'notes', label: 'Notes', type: 'textarea', placeholder: 'Internal setup notes…' },
  ];
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderOnboardingFormField(field) {
  const id = escapeHtml(field.id);
  const label = escapeHtml(field.label);
  const ph = escapeHtml(field.placeholder || '');
  const disabled = ' disabled readonly aria-disabled="true"';
  if (field.type === 'select') {
    const opts = (field.options || []).map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.label)}</option>`).join('');
    return `<div class="form-row">
      <label for="${id}">${label}</label>
      <select id="${id}" name="${id}"${disabled}>${opts}</select>
    </div>`;
  }
  if (field.type === 'textarea') {
    return `<div class="form-row">
      <label for="${id}">${label}</label>
      <textarea id="${id}" name="${id}" rows="3" placeholder="${ph}"${disabled}></textarea>
    </div>`;
  }
  const inputType = field.type === 'email' ? 'email' : 'text';
  return `<div class="form-row">
      <label for="${id}">${label}</label>
      <input type="${inputType}" id="${id}" name="${id}" placeholder="${ph}"${disabled} />
    </div>`;
}

function renderCrowsnestOnboardingSection() {
  const fields = getCrowsnestOnboardingFormFields();
  const checklist = getCrowsnestOnboardingChecklist();
  const fieldHtml = fields.map(renderOnboardingFormField).join('\n        ');
  const checklistHtml = checklist.map((item) => `<li><span class="check-label">${escapeHtml(item.label)}</span> <span class="badge">Coming soon</span></li>`).join('\n          ');

  return `<section id="onboarding">
      <h2 class="section">New client onboarding</h2>
      <p class="section-note">Draft form only. No client creation, writes, Azure, database, WhatsApp, Stripe, or DNS actions are enabled.</p>
      <div class="card onboarding-card">
        <form class="onboarding-form" action="#" method="get" aria-readonly="true">
          ${fieldHtml}
          <div class="form-actions">
            <button type="button" class="btn-disabled" disabled aria-disabled="true">Preview setup</button>
            <button type="button" class="btn-disabled" disabled aria-disabled="true">Create client</button>
          </div>
        </form>
        <div class="onboarding-checklist">
          <h3 class="checklist-heading">Future setup steps</h3>
          <ul class="checklist">
          ${checklistHtml}
          </ul>
        </div>
      </div>
    </section>`;
}

module.exports = {
  getCrowsnestOnboardingTemplates,
  getCrowsnestOnboardingChecklist,
  getCrowsnestOnboardingFormFields,
  renderCrowsnestOnboardingSection,
};
