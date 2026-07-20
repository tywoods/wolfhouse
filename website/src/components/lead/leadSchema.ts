/**
 * leadSchema.ts — pure, side-effect-free validation for the Luna lead form.
 * No DOM access; fully unit-testable with vitest.
 */

export const BUSINESS_TYPES = [
  'hostel',
  'surf_school',
  'tours_activities',
  'rentals',
  'other',
] as const;

export const VOLUME_BUCKETS = [
  'under_20',
  '20_50',
  '50_150',
  '150_plus',
] as const;

/** Field max lengths enforced in validation and on inputs. */
export const LEAD_MAX_LENGTH = {
  name: 100,
  businessName: 150,
  contact: 254,
  freeText: 1000,
} as const;

export type BusinessType = (typeof BUSINESS_TYPES)[number];
export type VolumeBucket = (typeof VOLUME_BUCKETS)[number];

export interface LeadInput {
  name: string;
  businessName: string;
  contact: string;
  businessType: BusinessType | '';
  volumeBucket: VolumeBucket | '';
  freeText?: string;
}

export interface LeadErrors {
  name?: string;
  businessName?: string;
  contact?: string;
  businessType?: string;
  freeText?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: LeadErrors;
}

/**
 * Strict email grammar (single @, dot-separated domain labels, TLD ≥ 2 chars).
 * Rejects spaces and trailing/leading dots in labels.
 */
const STRICT_EMAIL =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/**
 * Conservative international phone:
 * - optional leading +
 * - 7–15 digits total
 * - digits separated only by at most one ASCII space or hyphen (no repeats,
 *   no trailing separator)
 * - no parentheses, periods, letters, or other punctuation
 */
const CONSERVATIVE_PHONE = /^\+?\d(?:[ -]?\d){6,14}$/;

/** Returns true if the string is a strict email address. */
export function isStrictEmail(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > LEAD_MAX_LENGTH.contact) return false;
  if (t.includes('..') || t.startsWith('.') || t.includes('@.') || t.endsWith('.')) {
    return false;
  }
  return STRICT_EMAIL.test(t);
}

/** Returns true if the string matches conservative international phone grammar. */
export function isConservativePhone(s: string): boolean {
  const t = s.trim();
  if (!CONSERVATIVE_PHONE.test(t)) return false;
  const digits = t.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

/** True when contact is either a strict email or a conservative phone. */
export function isValidContact(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  // Prefer email when '@' is present — never fall through to phone for
  // malformed email-like strings (e.g. user@domain with no TLD).
  if (t.includes('@')) return isStrictEmail(t);
  return isConservativePhone(t);
}

export function validateLead(input: LeadInput): ValidationResult {
  const errors: LeadErrors = {};

  if (!input.name.trim()) {
    errors.name = 'Your name is required.';
  } else if (input.name.length > LEAD_MAX_LENGTH.name) {
    errors.name = `Please keep this under ${LEAD_MAX_LENGTH.name} characters.`;
  }

  if (!input.businessName.trim()) {
    errors.businessName = 'Business name is required.';
  } else if (input.businessName.length > LEAD_MAX_LENGTH.businessName) {
    errors.businessName = `Please keep this under ${LEAD_MAX_LENGTH.businessName} characters.`;
  }

  const contact = input.contact.trim();
  if (!contact) {
    errors.contact = 'Please enter a work email or WhatsApp number.';
  } else if (input.contact.length > LEAD_MAX_LENGTH.contact) {
    errors.contact = `Please keep this under ${LEAD_MAX_LENGTH.contact} characters.`;
  } else if (!isValidContact(contact)) {
    if (contact.includes('@')) {
      errors.contact = 'That email address doesn\'t look right.';
    } else {
      errors.contact =
        'Enter a work email, or an international phone/WhatsApp number (e.g. +34 600 000 000).';
    }
  }

  if (!input.businessType) {
    errors.businessType = 'Please select a business type.';
  }

  const freeText = input.freeText ?? '';
  if (freeText.length > LEAD_MAX_LENGTH.freeText) {
    errors.freeText = `Please keep this under ${LEAD_MAX_LENGTH.freeText} characters.`;
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

/** Allowlisted UTM/source query-param keys. */
const ALLOWED_UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref'] as const;
export type UtmKey = (typeof ALLOWED_UTM_KEYS)[number];
export type UtmParams = Partial<Record<UtmKey, string>>;

const UTM_MAX_LENGTH = 128;

/**
 * Extracts only the allowlisted UTM/ref keys from a query string (or URLSearchParams).
 * Truncates values to UTM_MAX_LENGTH. Does not pass arbitrary keys.
 */
export function extractUtmParams(search: string | URLSearchParams): UtmParams {
  const params =
    typeof search === 'string' ? new URLSearchParams(search) : search;
  const result: UtmParams = {};
  for (const key of ALLOWED_UTM_KEYS) {
    const val = params.get(key);
    if (val !== null) {
      result[key] = val.slice(0, UTM_MAX_LENGTH);
    }
  }
  return result;
}
