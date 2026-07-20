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
}

export interface ValidationResult {
  ok: boolean;
  errors: LeadErrors;
}

/** Returns true if the string looks like an email address. */
export function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());
}

export function validateLead(input: LeadInput): ValidationResult {
  const errors: LeadErrors = {};

  if (!input.name.trim()) {
    errors.name = 'Your name is required.';
  }

  if (!input.businessName.trim()) {
    errors.businessName = 'Business name is required.';
  }

  const contact = input.contact.trim();
  if (!contact) {
    errors.contact = 'Please enter a work email or WhatsApp number.';
  } else if (looksLikeEmail(contact)) {
    // Looks like an email — validate the format more strictly.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contact)) {
      errors.contact = 'That email address doesn\'t look right.';
    }
  }
  // Otherwise treat as a phone/WhatsApp — no further format enforcement.

  if (!input.businessType) {
    errors.businessType = 'Please select a business type.';
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
