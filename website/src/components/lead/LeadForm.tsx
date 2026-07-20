/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import {
  validateLead,
  extractUtmParams,
  LEAD_MAX_LENGTH,
  type LeadInput,
  type LeadErrors,
} from './leadSchema';
import {
  isLeadApiEnabled,
  buildLeadPayload,
  postLead,
  LEAD_GENERIC_ERROR,
} from './leadApi';
import { buildMailtoLink } from './mailto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SubmitState = 'idle' | 'submitting' | 'local' | 'delivered' | 'error';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readUtmFromWindow(): ReturnType<typeof extractUtmParams> {
  if (typeof window === 'undefined') return {};
  return extractUtmParams(window.location.search);
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

export interface LeadFormProps {
  /** Override for tests; defaults to {@link isLeadApiEnabled}. */
  apiEnabled?: boolean;
  /** Override for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export default function LeadForm(props: LeadFormProps = {}) {
  const apiEnabled = props.apiEnabled ?? isLeadApiEnabled();
  const fetchImpl = props.fetchImpl ?? fetch;

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
      const firstKey = Object.keys(result.errors)[0];
      if (firstKey) {
        document.getElementById(firstKey)?.focus();
      }
      return;
    }

    if (!apiEnabled) {
      // No audited backend — do not POST. Keep values; offer mailto.
      setServerError('');
      setSubmitState('local');
      return;
    }

    setSubmitState('submitting');
    setServerError('');

    const payload = buildLeadPayload(values, readUtmFromWindow());
    const outcome = await postLead(payload, fetchImpl);

    if (outcome.ok) {
      setSubmitState('delivered');
    } else {
      setServerError(LEAD_GENERIC_ERROR);
      setSubmitState('error');
    }
  }

  const busy = submitState === 'submitting';
  const mailtoHref = buildMailtoLink(values);
  const showLocalNotice = submitState === 'local';
  const showDelivered = submitState === 'delivered';

  return (
    <form
      class="lf-form"
      onSubmit={handleSubmit}
      noValidate
      aria-label="Express interest in Luna Front Desk"
    >
      {!apiEnabled && (
        <p class="lf-truth" role="note" data-testid="lead-disabled-truth">
          Submitting this form will not send or save your details — no lead
          backend is connected yet. After you submit, you can email us instead.
        </p>
      )}

      {showLocalNotice && (
        <div
          class="lf-local-outcome"
          role="status"
          aria-live="polite"
          data-testid="lead-local-outcome"
        >
          <p>
            Nothing was sent or saved. Your answers are still in the form below.
            To reach us, use the email link:
          </p>
          <p>
            <a
              class="lf-outcome__mailto"
              href={mailtoHref}
              data-testid="lead-mailto"
            >
              Open an email with your details
            </a>{' '}
            to hello@lunafrontdesk.com.
          </p>
        </div>
      )}

      {showDelivered && (
        <div
          class="lf-local-outcome"
          role="status"
          aria-live="polite"
          data-testid="lead-delivered"
        >
          <p>Thanks — we received your message and will follow up.</p>
        </div>
      )}

      <div class="lf-grid">
        <Field id="name" label="Your name" error={errors.name} required>
          <input
            id="name"
            class={`lf-input${errors.name ? ' lf-input--error' : ''}`}
            type="text"
            name="name"
            autocomplete="name"
            maxlength={LEAD_MAX_LENGTH.name}
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
            maxlength={LEAD_MAX_LENGTH.businessName}
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
          maxlength={LEAD_MAX_LENGTH.contact}
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

      <Field id="freeText" label="What takes most of your time? (optional)" error={errors.freeText}>
        <textarea
          id="freeText"
          class="lf-textarea"
          name="freeText"
          rows={3}
          placeholder="e.g. Answering the same availability questions, chasing deposits…"
          maxlength={LEAD_MAX_LENGTH.freeText}
          value={values.freeText}
          onInput={set('freeText')}
          aria-describedby={ariaDesc('freeText')}
          disabled={busy}
        />
      </Field>

      {submitState === 'error' && (
        <p class="lf-server-error" role="alert" data-testid="lead-generic-error">
          {serverError || LEAD_GENERIC_ERROR}
        </p>
      )}

      <div class="lf-actions">
        <button class="btn btn--primary lf-submit" type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Show me Luna for my business'}
        </button>
        <a class="lf-privacy-link" href="/privacy/" data-testid="lead-privacy-link">
          Privacy
        </a>
      </div>

      <p class="lf-privacy">
        {!apiEnabled
          ? 'Your details stay in this browser until you choose to email us. See our '
          : 'We only use your details to follow up about Luna. See our '}
        <a href="/privacy/">privacy notice</a>
        {' '}for controller contact, retention, and your rights.
      </p>
    </form>
  );
}
