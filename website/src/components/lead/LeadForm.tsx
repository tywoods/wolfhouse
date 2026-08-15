/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import {
  validateLead,
  LEAD_MAX_LENGTH,
  type LeadInput,
  type LeadErrors,
} from './leadSchema';
import { isLeadSubmissionEnabled } from './leadApi';
import { buildMailtoLink } from './mailto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SubmitState = 'idle' | 'ready' | 'reached';

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

/**
 * Lead form island. Submission is compile-time disabled
 * ({@link isLeadSubmissionEnabled} is always false in this slice): validate
 * locally, retain values, offer mailto — never POST or store.
 */
export default function LeadForm() {
  // Compile-time constant path — no env/build-variable enablement.
  const submissionEnabled = isLeadSubmissionEnabled();

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

  const set = (field: keyof LeadInput) => (e: Event) => {
    const val = (e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
    setValues((v) => ({ ...v, [field]: val }));
    if (errors[field as keyof LeadErrors]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  const ariaDesc = (id: string) =>
    errors[id as keyof LeadErrors] ? `${id}-error` : undefined;

  function handleSubmit(e: Event) {
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

    // Zero network/storage path until an audited receiver lands.
    if (submissionEnabled) {
      // Unreachable while LEAD_SUBMISSION_ENABLED is false; kept as a
      // hard deny so accidental enablement cannot invent a POST path here.
      setSubmitState('ready');
      return;
    }

    // Validated, but nothing has reached us yet — only offer the email link.
    // The confirmation is withheld until the guest actually opens that email.
    setSubmitState('ready');
  }

  const mailtoHref = buildMailtoLink(values);
  const showEmailCta = submitState === 'ready' || submitState === 'reached';
  const showReachedNotice = submitState === 'reached';

  return (
    <form
      class="lf-form"
      onSubmit={handleSubmit}
      noValidate
      aria-label="Express interest in Luna Front Desk"
    >
      {!submissionEnabled && (
        <p class="lf-truth" role="note" data-testid="lead-disabled-truth">
          Submitting this form will not send or save your details — no lead
          backend is connected yet. After you submit, you can email us instead.
        </p>
      )}

      {showEmailCta && !showReachedNotice && (
        <div
          class="lf-local-outcome"
          role="status"
          aria-live="polite"
          data-testid="lead-local-outcome"
        >
          <p>
            Almost there — nothing has reached us yet. Open the email below to
            send Ty your details:
          </p>
          <p>
            <a
              class="lf-outcome__mailto"
              href={mailtoHref}
              data-testid="lead-mailto"
              onClick={() => setSubmitState('reached')}
            >
              Open an email with your details
            </a>{' '}
            to hello@lunafrontdesk.com.
          </p>
        </div>
      )}

      {showReachedNotice && (
        <div
          class="lf-local-outcome"
          role="status"
          aria-live="polite"
          data-testid="lead-reached-notice"
        >
          <p>
            Thanks — your email is on its way to Ty. He'll get back to you about
            whether Luna fits. Your answers are still in the form below.
          </p>
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
        />
      </Field>

      <div class="lf-actions">
        <button class="btn btn--primary lf-submit" type="submit">
          Show me Luna for my business
        </button>
        <a class="lf-privacy-link" href="/privacy/" data-testid="lead-privacy-link">
          Privacy
        </a>
      </div>

      <p class="lf-privacy">
        Your details stay in this browser until you choose to email us. See our{' '}
        <a href="/privacy/">privacy notice</a>
        {' '}for controller contact, retention, and your rights.
      </p>
    </form>
  );
}
