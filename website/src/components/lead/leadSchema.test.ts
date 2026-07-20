import { describe, it, expect } from 'vitest';
import {
  validateLead,
  isStrictEmail,
  isConservativePhone,
  isValidContact,
  extractUtmParams,
  LEAD_MAX_LENGTH,
  type LeadInput,
} from './leadSchema';

const validInput: LeadInput = {
  name: 'Maria Garcia',
  businessName: 'Surf & Stay Hostel',
  contact: 'maria@surfstay.com',
  businessType: 'hostel',
  volumeBucket: '50_150',
  freeText: 'Mostly handle availability questions on WhatsApp.',
};

describe('validateLead', () => {
  it('passes for a fully valid input', () => {
    const result = validateLead(validInput);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual({});
  });

  it('passes when contact is a WhatsApp/phone number', () => {
    const result = validateLead({ ...validInput, contact: '+34 663 123 456' });
    expect(result.ok).toBe(true);
  });

  it('passes when volumeBucket and freeText are empty (both optional)', () => {
    const result = validateLead({ ...validInput, volumeBucket: '', freeText: '' });
    expect(result.ok).toBe(true);
  });

  it('fails when name is missing', () => {
    const result = validateLead({ ...validInput, name: '' });
    expect(result.ok).toBe(false);
    expect(result.errors.name).toBeTruthy();
  });

  it('fails when name is only whitespace', () => {
    const result = validateLead({ ...validInput, name: '   ' });
    expect(result.ok).toBe(false);
    expect(result.errors.name).toBeTruthy();
  });

  it('fails when businessName is missing', () => {
    const result = validateLead({ ...validInput, businessName: '' });
    expect(result.ok).toBe(false);
    expect(result.errors.businessName).toBeTruthy();
  });

  it('fails when contact is empty', () => {
    const result = validateLead({ ...validInput, contact: '' });
    expect(result.ok).toBe(false);
    expect(result.errors.contact).toBeTruthy();
  });

  it('fails when businessType is empty', () => {
    const result = validateLead({ ...validInput, businessType: '' });
    expect(result.ok).toBe(false);
    expect(result.errors.businessType).toBeTruthy();
  });

  it('fails when freeText exceeds maxlength', () => {
    const result = validateLead({
      ...validInput,
      freeText: 'x'.repeat(LEAD_MAX_LENGTH.freeText + 1),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.freeText).toBeTruthy();
  });

  it('fails when name exceeds maxlength', () => {
    const result = validateLead({
      ...validInput,
      name: 'n'.repeat(LEAD_MAX_LENGTH.name + 1),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.name).toMatch(/100/);
  });

  it('fails when contact exceeds maxlength', () => {
    const result = validateLead({
      ...validInput,
      contact: 'c'.repeat(LEAD_MAX_LENGTH.contact + 1),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.contact).toMatch(/254/);
  });

  it('rejects malformed email-like strings (no phone fallback)', () => {
    for (const bad of ['user@domain', 'a@b', 'not@valid', '@example.com', 'user@']) {
      const result = validateLead({ ...validInput, contact: bad });
      expect(result.ok, bad).toBe(false);
      expect(result.errors.contact, bad).toMatch(/email/i);
    }
  });

  it('rejects arbitrary text that is neither email nor phone', () => {
    for (const bad of ['call me later', 'whatsapp', 'N/A', '123', '++34', 'hello world']) {
      const result = validateLead({ ...validInput, contact: bad });
      expect(result.ok, bad).toBe(false);
      expect(result.errors.contact, bad).toBeTruthy();
    }
  });
});

describe('isStrictEmail', () => {
  it('accepts a well-formed email', () => {
    expect(isStrictEmail('hello@example.com')).toBe(true);
  });

  it('accepts email with subdomain', () => {
    expect(isStrictEmail('user@mail.example.co.uk')).toBe(true);
  });

  it('rejects a string with no @', () => {
    expect(isStrictEmail('+34 663 123 456')).toBe(false);
  });

  it('rejects an incomplete email (missing TLD)', () => {
    expect(isStrictEmail('user@domain')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isStrictEmail('')).toBe(false);
  });

  it('rejects a string with spaces in the local part', () => {
    expect(isStrictEmail('hello world@example.com')).toBe(false);
  });
});

describe('isConservativePhone', () => {
  it('accepts valid international examples (space/hyphen separators only)', () => {
    expect(isConservativePhone('+34 663 123 456')).toBe(true);
    expect(isConservativePhone('+1-415-555-2671')).toBe(true);
    expect(isConservativePhone('34663123456')).toBe(true);
    expect(isConservativePhone('+34663123456')).toBe(true);
    expect(isConservativePhone('415-555-2671')).toBe(true);
    // 7-digit lower bound
    expect(isConservativePhone('1234567')).toBe(true);
    // 15-digit upper bound (E.164 max)
    expect(isConservativePhone('+123456789012345')).toBe(true);
  });

  it('rejects parentheses (repeated, open, close, unmatched groups)', () => {
    expect(isConservativePhone('(415) 555-2671')).toBe(false);
    expect(isConservativePhone('((415)) 555-2671')).toBe(false);
    expect(isConservativePhone('(415 555-2671')).toBe(false);
    expect(isConservativePhone('415) 555-2671')).toBe(false);
    expect(isConservativePhone('415 (555) 2671')).toBe(false);
    expect(isConservativePhone('+34 (663) 123 456')).toBe(false);
  });

  it('rejects periods and repeated dots', () => {
    expect(isConservativePhone('415.555.2671')).toBe(false);
    expect(isConservativePhone('415..555.2671')).toBe(false);
    expect(isConservativePhone('+34.663.123.456')).toBe(false);
  });

  it('rejects repeated spaces/hyphens and trailing separators', () => {
    expect(isConservativePhone('+34  663 123 456')).toBe(false);
    expect(isConservativePhone('+34--663-123-456')).toBe(false);
    expect(isConservativePhone('+34663123456-')).toBe(false);
    expect(isConservativePhone('+34 663 123 456-')).toBe(false);
    expect(isConservativePhone('-34663123456')).toBe(false);
    expect(isConservativePhone('34- 663123456')).toBe(false);
  });

  it('rejects letters, too-short/too-long digit runs, and bare text', () => {
    expect(isConservativePhone('123456')).toBe(false); // 6 digits
    expect(isConservativePhone('+1234567890123456')).toBe(false); // 16 digits
    expect(isConservativePhone('call me')).toBe(false);
    expect(isConservativePhone('+34abc663')).toBe(false);
    expect(isConservativePhone('+')).toBe(false);
    expect(isConservativePhone('++34663123456')).toBe(false);
  });
});

describe('isValidContact', () => {
  it('accepts strict email or conservative phone only', () => {
    expect(isValidContact('maria@surfstay.com')).toBe(true);
    expect(isValidContact('+34 600 000 000')).toBe(true);
    expect(isValidContact('user@domain')).toBe(false);
    expect(isValidContact('please email me')).toBe(false);
  });
});

describe('extractUtmParams', () => {
  it('keeps only allowlisted utm_* and ref keys', () => {
    const result = extractUtmParams('?utm_source=google&utm_medium=cpc&evil_key=drop&ref=homepage');
    expect(result.utm_source).toBe('google');
    expect(result.utm_medium).toBe('cpc');
    expect(result.ref).toBe('homepage');
    expect((result as Record<string, unknown>)['evil_key']).toBeUndefined();
  });

  it('returns an empty object when no utm params present', () => {
    const result = extractUtmParams('?page=1&other=val');
    expect(result).toEqual({});
  });

  it('truncates values longer than 128 characters', () => {
    const longValue = 'a'.repeat(200);
    const result = extractUtmParams(`?utm_campaign=${longValue}`);
    expect(result.utm_campaign).toHaveLength(128);
  });

  it('accepts URLSearchParams directly', () => {
    const params = new URLSearchParams('utm_source=twitter&utm_content=banner');
    const result = extractUtmParams(params);
    expect(result.utm_source).toBe('twitter');
    expect(result.utm_content).toBe('banner');
  });

  it('does not include keys with null values', () => {
    const result = extractUtmParams('?utm_source=fb');
    expect('utm_medium' in result).toBe(false);
  });
});
