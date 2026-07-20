/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import {
  validateLead,
  extractUtmParams,
  type LeadInput,
  type LeadErrors,
} from './leadSchema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SubmitState = 'idle' | 'submitting' | 'success' | 'demo' | 'error';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMailtoLink(input: LeadInput): string {
  const body = [
    `Name: ${input.name}`,
    `Business: ${input.businessName}`,
    `Contact: ${input.contact}`,
    `Business type: ${input.businessType}`,
    `Monthly WhatsApp volume: ${input.volumeBucket || 'not specified'}`,
    input.freeText ? `\nContext:\n${input.freeText}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return `mailto:hello@lunafrontdesk.com?subject=${encodeURIComponent('Luna Front Desk — interest from ' + input.businessName)}&body=${encodeURIComponent(body)}`;
}

function readUtmFromWindow(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  return extractUtmParams(window.location.search) as Record<string, string>;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface FieldProps {
  id: string;
  label: string;
  error?: string;
  required?: boolean;
  children: preact.ComponentChildren;
}

function Field({ id, label, error, required, children }: FieldProps) {
  return (
    <div class="lf-field">
      <label class="lf-label" for={id}>
        {label}
        {required && <span class="lf-required" aria-hidden="true"> *</span>}
      </label>
      {children}
      {error && (
        <p class="lf-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main island
// ---------------------------------------------------------------------------

export default function LeadForm() {
  const [values, setValues] = useState<LeadInput>({
    name: '',
    businessName: '',
    contact: '',
    businessType: '',
    volumeBucket: '',
    freeText: '',
  });
  const [errors, setErrors] = useState<LeadErrors>({});
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [serverError, setServerError] = useState<string>('');

  const set = (field: keyof LeadInput) => (e: Event) => {
    const val = (e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
    setValues((v) => ({ ...v, [field]: val }));
    // Clear error for field on change.
    if (errors[field as keyof LeadErrors]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  const ariaDesc = (id: string) =>
    errors[id as keyof LeadErrors] ? `${id}-error` : undefined;

  async function handleSubmit(e: Event) {
    e.preventDefault();

    const result = validateLead(values);
    if (!result.ok) {
      setErrors(result.errors);
      // Focus first error field for accessibility.
      const firstKey = Object.keys(result.errors)[0];
      if (firstKey) {
        const el = document.getElementById(firstKey);
        el?.focus();
      }
      return;
    }

    const endpoint = (import.meta as unknown as { env: Record<string, string | undefined> }).env
      .PUBLIC_LEAD_ENDPOINT;

    if (!endpoint) {
      // Honest demo state — no endpoint configured.
      setSubmitState('demo');
      return;
    }

    setSubmitState('submitting');
    setServerError('');

    try {
      const payload = {
        ...values,
        capturedAt: new Date().toISOString(),
        source: readUtmFromWindow(),
      };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        setSubmitState('success');
      } else {
        const text = await res.text().catch(() => '');
        setServerError(text || `Server returned ${res.status}.`);
        setSubmitState('error');
      }
    } catch (err) {
      setServerError('Network error — please check your connection and try again.');
      setSubmitState('error');
    }
  }

  // ---------------------------------------------------------------------------
  // Success states
  // ---------------------------------------------------------------------------

  if (submitState === 'success') {
    return (
      <div class="lf-outcome lf-outcome--success" role="status" aria-live="polite">
        <span class="lf-outcome__icon" aria-hidden="true">✓</span>
        <h3 class="lf-outcome__heading">You're on the list.</h3>
        <p>Thanks, {values.name.split(' ')[0]}. We'll be in touch with you at <strong>{values.contact}</strong> shortly.</p>
      </div>
    );
  }

  if (submitState === 'demo') {
    return (
      <div class="lf-outcome lf-outcome--demo" role="status" aria-live="polite">
        <span class="lf-outcome__icon" aria-hidden="true">◎</span>
        <h3 class="lf-outcome__heading">Thanks — we've noted your details.</h3>
        <p class="lf-outcome__note">
          <em>Demo preview:</em> submissions are delivered once the lead backend is connected.
        </p>
        <p class="lf-outcome__fallback">
          In the meantime, you can{' '}
          <a class="lf-outcome__mailto" href={buildMailtoLink(values)}>
            send your details directly via email
          </a>{' '}
          to hello@lunafrontdesk.com and we'll follow up.
        </p>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Form
  // ---------------------------------------------------------------------------

  const busy = submitState === 'submitting';

  return (
    <form
      class="lf-form"
      onSubmit={handleSubmit}
      noValidate
      aria-label="Express interest in Luna Front Desk"
    >
      <div class="lf-grid">
        <Field id="name" label="Your name" error={errors.name} required>
          <input
            id="name"
            class={`lf-input${errors.name ? ' lf-input--error' : ''}`}
            type="text"
            name="name"
            autocomplete="name"
            value={values.name}
            onInput={set('name')}
            aria-required="true"
            aria-describedby={ariaDesc('name')}
            disabled={busy}
          />
        </Field>

        <Field id="businessName" label="Business name" error={errors.businessName} required>
          <input
            id="businessName"
            class={`lf-input${errors.businessName ? ' lf-input--error' : ''}`}
            type="text"
            name="businessName"
            autocomplete="organization"
            value={values.businessName}
            onInput={set('businessName')}
            aria-required="true"
            aria-describedby={ariaDesc('businessName')}
            disabled={busy}
          />
        </Field>
      </div>

      <Field id="contact" label="Work email or WhatsApp number" error={errors.contact} required>
        <input
          id="contact"
          class={`lf-input${errors.contact ? ' lf-input--error' : ''}`}
          type="text"
          name="contact"
          autocomplete="email"
          placeholder="e.g. hello@mybusiness.com or +34 600 000 000"
          value={values.contact}
          onInput={set('contact')}
          aria-required="true"
          aria-describedby={ariaDesc('contact')}
          disabled={busy}
        />
      </Field>

      <div class="lf-grid">
        <Field id="businessType" label="Business type" error={errors.businessType} required>
          <select
            id="businessType"
            class={`lf-select${errors.businessType ? ' lf-input--error' : ''}`}
            name="businessType"
            value={values.businessType}
            onChange={set('businessType')}
            aria-required="true"
            aria-describedby={ariaDesc('businessType')}
            disabled={busy}
          >
            <option value="">Select a type…</option>
            <option value="hostel">Hostel / guest house</option>
            <option value="surf_school">Surf school</option>
            <option value="tours_activities">Tours / activities</option>
            <option value="rentals">Rentals</option>
            <option value="other">Other</option>
          </select>
        </Field>

        <Field id="volumeBucket" label="Approx. monthly WhatsApp enquiries">
          <select
            id="volumeBucket"
            class="lf-select"
            name="volumeBucket"
            value={values.volumeBucket}
            onChange={set('volumeBucket')}
            disabled={busy}
          >
            <option value="">Not sure / skip</option>
            <option value="under_20">Fewer than 20</option>
            <option value="20_50">20 – 50</option>
            <option value="50_150">50 – 150</option>
            <option value="150_plus">150+</option>
          </select>
        </Field>
      </div>

      <Field id="freeText" label="What takes most of your time? (optional)">
        <textarea
          id="freeText"
          class="lf-textarea"
          name="freeText"
          rows={3}
          placeholder="e.g. Answering the same availability questions, chasing deposits…"
          value={values.freeText}
          onInput={set('freeText')}
          disabled={busy}
        />
      </Field>

      {submitState === 'error' && (
        <p class="lf-server-error" role="alert">
          {serverError || 'Something went wrong — please try again.'}
        </p>
      )}

      <button class="btn btn--primary lf-submit" type="submit" disabled={busy}>
        {busy ? 'Sending…' : 'Show me Luna for my business'}
      </button>

      <p class="lf-privacy">
        We'll only use your details to follow up about Luna. No spam, no third-party sharing.
      </p>
    </form>
  );
}
