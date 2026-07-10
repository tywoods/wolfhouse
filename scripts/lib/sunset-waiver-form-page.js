'use strict';

/**
 * Sunset public waiver form HTML (unauthenticated, mobile-first).
 * All guest-visible labels/legal text come from sunset.waiver-form.json — do not invent copy.
 */

const {
  loadWaiverFormConfig,
  DEFAULT_STAGING_BASE_URL,
} = require('./sunset-waiver-model');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function normalizePrefill(prefill) {
  const p = prefill && typeof prefill === 'object' ? prefill : {};
  return {
    phone: trimStr(p.phone || p.sent_to_phone),
    email: trimStr(p.email || p.sent_to_email),
    full_name: trimStr(p.full_name || p.guest_name || p.name),
    lesson_days: trimStr(p.lesson_days || p.lessonDates || p.dates),
    summary: trimStr(p.summary || p.booking_summary || p.lesson_summary || p.location_summary),
  };
}

function hasPrefillPhone(prefill) {
  return !!normalizePrefill(prefill).phone;
}

function hasPrefillEmail(prefill) {
  return !!normalizePrefill(prefill).email;
}

function pageShell(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>
    :root {
      --cream: #F4F0E8;
      --navy: #1B2A4A;
      --navy-soft: #2C3E5F;
      --card: #FFFFFF;
      --border: #E2DDD4;
      --muted: #5A6578;
      --accent: #1B2A4A;
      --danger: #8B3A2F;
      --ok: #2F5D3A;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Iowan Old Style", Palatino, "Palatino Linotype", Georgia, serif;
      background: var(--cream);
      color: var(--navy);
      line-height: 1.45;
      padding: 20px 14px 48px;
    }
    .wrap { max-width: 640px; margin: 0 auto; }
    h1 { font-size: 1.35rem; margin: 0 0 10px; letter-spacing: -0.02em; }
    h2 { font-size: 1.05rem; margin: 0 0 12px; }
    h3 { font-size: 0.95rem; margin: 18px 0 8px; }
    p { margin: 0 0 10px; }
    .muted { color: var(--muted); font-size: 0.92rem; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 18px 16px;
      margin: 0 0 14px;
      box-shadow: 0 1px 0 rgba(27,42,74,0.04);
    }
    .school { font-size: 0.92rem; }
    .school strong { display: block; margin-bottom: 4px; }
    .summary {
      background: #EEF2F8;
      border-radius: 10px;
      padding: 10px 12px;
      margin: 10px 0 0;
      font-size: 0.92rem;
    }
    .field { margin: 0 0 14px; }
    .field label.main {
      display: block;
      font-weight: 700;
      font-size: 0.88rem;
      margin-bottom: 6px;
    }
    .req { color: var(--danger); }
    input[type=text], input[type=tel], input[type=email], input[type=number] {
      width: 100%;
      padding: 11px 12px;
      border: 1px solid var(--border);
      border-radius: 10px;
      font: inherit;
      color: var(--navy);
      background: #FFFEFB;
    }
    .choice { display: block; margin: 8px 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: #FFFEFB; }
    .choice input { margin-right: 8px; vertical-align: top; }
    .choice span { display: inline-block; max-width: calc(100% - 28px); vertical-align: top; font-size: 0.9rem; }
    .saved {
      font-size: 0.9rem;
      color: var(--muted);
      padding: 10px 12px;
      background: #F7F5F0;
      border-radius: 10px;
      border: 1px dashed var(--border);
    }
    .terms ol { margin: 0 0 14px; padding-left: 1.25rem; }
    .terms li { margin: 0 0 10px; font-size: 0.9rem; }
    .errors {
      background: #F8E8E4;
      color: var(--danger);
      border: 1px solid #E7C4BC;
      border-radius: 10px;
      padding: 12px 14px;
      margin: 0 0 14px;
      font-size: 0.92rem;
    }
    .errors ul { margin: 6px 0 0; padding-left: 1.1rem; }
    .submit {
      display: block;
      width: 100%;
      border: 0;
      border-radius: 12px;
      background: var(--accent);
      color: #fff;
      font: inherit;
      font-weight: 700;
      font-size: 1.05rem;
      padding: 14px 16px;
      cursor: pointer;
      margin-top: 8px;
    }
    .status-title { font-size: 1.2rem; margin: 0 0 10px; }
    .ok-msg { color: var(--ok); }
  </style>
</head>
<body>
  <div class="wrap">
    ${bodyHtml}
  </div>
</body>
</html>`;
}

function buildStatusPageHtml(opts) {
  const o = opts || {};
  const title = o.title || 'Sunset';
  const message = o.message || '';
  const toneClass = o.tone === 'ok' ? 'ok-msg' : '';
  return pageShell(title, `
    <div class="card">
      <p class="status-title ${toneClass}">${esc(message)}</p>
    </div>
  `);
}

function buildInvalidLinkHtml() {
  return buildStatusPageHtml({
    title: 'Enlace no válido',
    message: 'Este enlace no es válido o ha caducado.',
  });
}

function buildUnavailableLinkHtml() {
  return buildStatusPageHtml({
    title: 'Enlace no disponible',
    message: 'Este enlace ya no está disponible. Contacta con Sunset para recibir uno nuevo.',
  });
}

function buildAlreadySubmittedHtml() {
  return buildStatusPageHtml({
    title: 'Formulario enviado',
    message: 'Este formulario ya fue enviado. Puedes volver a WhatsApp.',
    tone: 'ok',
  });
}

function buildSuccessHtml() {
  return buildStatusPageHtml({
    title: 'Formulario completo',
    message: 'Gracias — tu formulario de Sunset está completo. Puedes volver a WhatsApp.',
    tone: 'ok',
  });
}

function fieldLabelHtml(field) {
  const num = field.number != null ? `${field.number} - ` : '';
  const star = field.required ? ' <span class="req">*</span>' : '';
  return `${esc(num + field.label)}${star}`;
}

function renderTextField(field, value, opts) {
  const o = opts || {};
  const type = field.input_type === 'email' ? 'email'
    : field.input_type === 'tel' ? 'tel'
      : 'text';
  const example = field.example
    ? `<p class="muted">Ejemplo: ${esc(field.example)}</p>`
    : '';
  const requiredAttr = field.required && !o.skipHtmlRequired ? ' required' : '';
  return `
    <div class="field">
      <label class="main" for="${esc(field.key)}">${fieldLabelHtml(field)}</label>
      ${example}
      <input id="${esc(field.key)}" name="${esc(field.key)}" type="${type}" value="${esc(value || '')}"${requiredAttr} autocomplete="on">
    </div>`;
}

function renderSavedRow(kind, value) {
  if (kind === 'phone') {
    return `<div class="field"><div class="saved">Teléfono: ya guardado desde WhatsApp</div>
      <input type="hidden" name="phone" value="${esc(value)}"></div>`;
  }
  if (kind === 'email') {
    return `<div class="field"><div class="saved">E-mail: ya guardado desde la reserva</div>
      <input type="hidden" name="email" value="${esc(value)}"></div>`;
  }
  return '';
}

function renderSingleChoice(field, selected) {
  const opts = Array.isArray(field.options) ? field.options : [];
  const choices = opts.map((opt, i) => {
    const value = typeof opt === 'string' ? opt : (opt.value || opt.label);
    const label = typeof opt === 'string' ? opt : (opt.label || opt.value);
    const id = `${field.key}_${i}`;
    const checked = String(selected || '') === String(value) ? ' checked' : '';
    return `<label class="choice" for="${esc(id)}">
      <input id="${esc(id)}" type="radio" name="${esc(field.key)}" value="${esc(value)}"${checked}${field.required ? ' required' : ''}>
      <span>${esc(label)}</span>
    </label>`;
  }).join('\n');
  return `
    <div class="field">
      <div class="main">${fieldLabelHtml(field)}</div>
      ${choices}
    </div>`;
}

function renderMultiChoice(field, selectedList) {
  const selected = new Set(Array.isArray(selectedList) ? selectedList.map(String) : []);
  const opts = Array.isArray(field.options) ? field.options : [];
  const choices = opts.map((opt, i) => {
    const value = typeof opt === 'string' ? opt : (opt.value || opt.label);
    const label = typeof opt === 'string' ? opt : (opt.label || opt.value);
    const id = `${field.key}_${i}`;
    const checked = selected.has(String(value)) ? ' checked' : '';
    return `<label class="choice" for="${esc(id)}">
      <input id="${esc(id)}" type="checkbox" name="${esc(field.key)}" value="${esc(value)}"${checked}>
      <span>${esc(label)}</span>
    </label>`;
  }).join('\n');
  return `
    <div class="field">
      <div class="main">${fieldLabelHtml({ ...field, required: !!field.required })}</div>
      ${choices}
    </div>`;
}

function renderCheckbox(field, checked) {
  return `
    <div class="field">
      <label class="choice" for="${esc(field.key)}">
        <input id="${esc(field.key)}" type="checkbox" name="${esc(field.key)}" value="yes"${checked ? ' checked' : ''}${field.required ? ' required' : ''}>
        <span>${esc(field.label)}${field.required ? ' <span class="req">*</span>' : ''}</span>
      </label>
    </div>`;
}

function renderInscriptionSection(section, prefill, posted) {
  const p = normalizePrefill(prefill);
  const body = posted || {};
  const fieldsHtml = (section.fields || []).map((field) => {
    if (field.key === 'phone' && p.phone) return renderSavedRow('phone', p.phone);
    if (field.key === 'email' && p.email) return renderSavedRow('email', p.email);
    let value = trimStr(body[field.key]);
    if (!value) {
      if (field.key === 'full_name') value = p.full_name;
      if (field.key === 'lesson_days') value = p.lesson_days;
      if (field.key === 'phone') value = p.phone;
      if (field.key === 'email') value = p.email;
    }
    if (field.input_type === 'single_choice') return renderSingleChoice(field, value);
    return renderTextField(field, value);
  }).join('\n');

  const minor = section.minor_authorization || null;
  let minorHtml = '';
  if (minor) {
    const minorFields = (minor.fields || []).map((field) => {
      const value = trimStr(body[field.key]);
      if (field.input_type === 'single_choice') return renderSingleChoice(field, value);
      return renderTextField(field, value);
    }).join('\n');
    minorHtml = `
      <div class="field">
        <p class="muted">${esc(minor.intro || '')}</p>
        <h3>${esc((minor.number != null ? `${minor.number} - ` : '') + (minor.heading || 'AUTORIZACIÓN:'))}</h3>
        ${minorFields}
      </div>`;
  }

  return `
    <section class="card" id="section-inscription">
      <h2>FICHA DE INSCRIPCIÓN</h2>
      ${fieldsHtml}
      ${minorHtml}
    </section>`;
}

function renderContractSection(section, posted) {
  const body = posted || {};
  const insurance = (section.fields || [])[0];
  const insuranceHtml = insurance
    ? renderSingleChoice(insurance, trimStr(body[insurance.key]))
    : '';
  const terms = (section.general_conditions || []).map((c) =>
    `<li><strong>${esc(String(c.number))}.</strong> ${esc(c.text)}</li>`
  ).join('\n');
  const acceptance = section.acceptance
    ? renderCheckbox(section.acceptance, body[section.acceptance.key] === 'yes' || body[section.acceptance.key] === 'on')
    : '';
  return `
    <section class="card terms" id="section-contract">
      <h2>${esc(section.title || 'CONDICIONES GENERALES DEL CONTRATO')}</h2>
      ${insuranceHtml}
      <ol>
        ${terms}
      </ol>
      ${acceptance}
    </section>`;
}

function renderPrivacySection(section, posted) {
  const body = posted || {};
  const purposes = (section.purposes || []).map((p) => `<li>${esc(p)}</li>`).join('\n');
  const consent = section.consent_prompt
    ? renderMultiChoice(
      section.consent_prompt,
      [].concat(body[section.consent_prompt.key] || []).filter(Boolean),
    )
    : '';
  const under14 = section.minors_under_14 || {};
  const from14 = section.data_subject_from_14 || {};
  const under14Fields = (under14.fields || []).map((f) => renderTextField(f, trimStr(body[f.key]))).join('\n');
  const from14Fields = (from14.fields || []).map((f) => renderTextField(f, trimStr(body[f.key]))).join('\n');
  const acceptance = section.acceptance
    ? renderCheckbox(section.acceptance, body[section.acceptance.key] === 'yes' || body[section.acceptance.key] === 'on')
    : '';
  return `
    <section class="card" id="section-privacy">
      <h2>${esc(section.title || 'INFORMACIÓN Y CONSENTIMIENTO')}</h2>
      <h3>${esc(section.heading || '')}</h3>
      <p>${esc(section.controller_notice || '')}</p>
      <ul>${purposes}</ul>
      <p>${esc(section.rights_notice || '')}</p>
      ${consent}
      <h3>${esc(under14.heading || '')}</h3>
      <p class="muted">${esc(under14.subheading || '')}</p>
      ${under14Fields}
      <h3>${esc(from14.heading || '')}</h3>
      ${from14Fields}
      ${acceptance}
    </section>`;
}

function buildPendingFormHtml(opts) {
  const o = opts || {};
  const cfg = o.config || loadWaiverFormConfig();
  const prefill = o.prefill || {};
  const posted = o.posted || {};
  const errors = Array.isArray(o.errors) ? o.errors : [];
  const actionPath = o.actionPath || '#';
  const p = normalizePrefill(prefill);
  const school = cfg.school || {};
  const address = (school.address_lines || []).map((l) => esc(l)).join('<br>');
  const sections = cfg.sections || [];
  const inscription = sections.find((s) => s.id === 'inscription') || sections[0];
  const contract = sections.find((s) => s.id === 'contract_conditions') || sections[1];
  const privacy = sections.find((s) => s.id === 'personal_data_consent') || sections[2];

  const errorsHtml = errors.length
    ? `<div class="errors" role="alert"><strong>Revisa estos campos:</strong><ul>${
      errors.map((e) => `<li>${esc(e)}</li>`).join('')
    }</ul></div>`
    : '';

  const summaryHtml = p.summary
    ? `<div class="summary">${esc(p.summary)}</div>`
    : '';

  const body = `
    <header class="card">
      <h1>${esc(cfg.title || 'FICHA DE INSCRIPCIÓN - CLASES DE SURF')}</h1>
      <p>${esc(cfg.intro || '')}</p>
      <div class="school">
        <strong>${esc(school.name || '')}</strong>
        ${address}<br>
        ${esc(school.phones || '')}<br>
        ${esc(school.email || '')}
      </div>
      ${summaryHtml}
    </header>
    ${errorsHtml}
    <form method="POST" action="${esc(actionPath)}" novalidate>
      ${renderInscriptionSection(inscription, prefill, posted)}
      ${renderContractSection(contract, posted)}
      ${renderPrivacySection(privacy, posted)}
      <button class="submit" type="submit">Enviar formulario</button>
    </form>
  `;

  return pageShell(cfg.title || 'Sunset', body);
}

/**
 * Build raw_answers_json entries + validate required fields for POST.
 */
function collectAndValidateAnswers(cfg, prefill, body) {
  const p = normalizePrefill(prefill);
  const b = body && typeof body === 'object' ? body : {};
  const answers = {};
  const errors = [];

  function asList(v) {
    if (Array.isArray(v)) return v.map((x) => trimStr(x)).filter(Boolean);
    const s = trimStr(v);
    return s ? [s] : [];
  }

  function put(key, label, value, source) {
    answers[key] = {
      key,
      label: label || key,
      value,
      source: source || 'user',
    };
  }

  const sections = cfg.sections || [];
  const inscription = sections.find((s) => s.id === 'inscription') || {};
  for (const field of inscription.fields || []) {
    if (field.key === 'phone' && p.phone) {
      put(field.key, field.label, p.phone, 'prefill');
      continue;
    }
    if (field.key === 'email' && p.email) {
      put(field.key, field.label, p.email, 'prefill');
      continue;
    }
    let value = trimStr(b[field.key]);
    let source = 'user';
    if (!value && field.key === 'full_name' && p.full_name && !trimStr(b.full_name)) {
      // allow posted empty to fail required; only use prefill when user left default
    }
    if (!value && field.key === 'full_name') value = trimStr(b.full_name);
    put(field.key, field.label, value, source);
    const requiredVisible = !!field.required
      && !(field.key === 'phone' && p.phone)
      && !(field.key === 'email' && p.email);
    if (requiredVisible && !value) {
      errors.push(`${field.number != null ? field.number + ' - ' : ''}${field.label}`);
    }
  }

  const minor = inscription.minor_authorization;
  if (minor) {
    for (const field of minor.fields || []) {
      const value = trimStr(b[field.key]);
      put(field.key, field.label, value, 'user');
      if (field.required && !value) {
        errors.push(field.label);
      }
    }
  }

  const contract = sections.find((s) => s.id === 'contract_conditions') || {};
  for (const field of contract.fields || []) {
    const value = trimStr(b[field.key]);
    const opt = (field.options || []).find((o) =>
      (typeof o === 'string' ? o : o.value) === value
    );
    const labelSnapshot = typeof opt === 'string' ? opt : (opt && opt.label) || field.label;
    put(field.key, field.label, value ? { value, option_label: labelSnapshot } : '', 'user');
    if (field.required && !value) errors.push(field.label);
  }
  if (contract.acceptance) {
    const accepted = b[contract.acceptance.key] === 'yes' || b[contract.acceptance.key] === 'on';
    put(contract.acceptance.key, contract.acceptance.label, accepted, 'user');
    if (contract.acceptance.required && !accepted) errors.push(contract.acceptance.label);
  }

  const privacy = sections.find((s) => s.id === 'personal_data_consent') || {};
  if (privacy.consent_prompt) {
    const values = asList(b[privacy.consent_prompt.key]);
    put(privacy.consent_prompt.key, privacy.consent_prompt.label, values, 'user');
    if (privacy.consent_prompt.required && values.length === 0) {
      errors.push(privacy.consent_prompt.label);
    }
  }
  for (const block of [privacy.minors_under_14, privacy.data_subject_from_14]) {
    if (!block) continue;
    for (const field of block.fields || []) {
      put(field.key, field.label, trimStr(b[field.key]), 'user');
    }
  }
  if (privacy.acceptance) {
    const accepted = b[privacy.acceptance.key] === 'yes' || b[privacy.acceptance.key] === 'on';
    put(privacy.acceptance.key, privacy.acceptance.label, accepted, 'user');
    if (privacy.acceptance.required && !accepted) errors.push(privacy.acceptance.label);
  }

  return {
    ok: errors.length === 0,
    errors,
    answers,
    respondent: {
      name: trimStr((answers.full_name && answers.full_name.value) || p.full_name) || null,
      email: trimStr((answers.email && answers.email.value) || p.email) || null,
      phone: trimStr((answers.phone && answers.phone.value) || p.phone) || null,
    },
  };
}

function buildFormSnapshot(cfg) {
  const c = cfg || loadWaiverFormConfig();
  return {
    form_version: c._meta && c._meta.form_version,
    status: c._meta && c._meta.status,
    needs_legal_copy_confirmation: !!(c._meta && c._meta.needs_legal_copy_confirmation),
    title: c.title,
    sections: c.sections,
    school: c.school,
  };
}

module.exports = {
  esc,
  normalizePrefill,
  hasPrefillPhone,
  hasPrefillEmail,
  pageShell,
  buildStatusPageHtml,
  buildInvalidLinkHtml,
  buildUnavailableLinkHtml,
  buildAlreadySubmittedHtml,
  buildSuccessHtml,
  buildPendingFormHtml,
  collectAndValidateAnswers,
  buildFormSnapshot,
  loadWaiverFormConfig,
  DEFAULT_STAGING_BASE_URL,
};
