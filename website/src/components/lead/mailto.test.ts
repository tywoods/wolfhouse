import { describe, it, expect } from 'vitest';
import { buildMailtoLink } from './mailto';
import type { LeadInput } from './leadSchema';

const sample: LeadInput = {
  name: 'Maria García',
  businessName: 'Surf & Stay',
  contact: 'maria@example.com',
  businessType: 'hostel',
  volumeBucket: '20_50',
  freeText: 'Need help with deposits & packages',
};

describe('buildMailtoLink', () => {
  it('returns a fully encoded mailto URL', () => {
    const href = buildMailtoLink(sample);
    expect(href.startsWith('mailto:hello@lunafrontdesk.com?')).toBe(true);
    expect(href).toContain('subject=');
    expect(href).toContain('body=');
    // Special characters must be percent-encoded, not raw.
    expect(href).not.toContain('García');
    expect(href).toContain(encodeURIComponent('García'));
    expect(href).toContain(encodeURIComponent('deposits & packages'));
    expect(href).toContain(encodeURIComponent('Surf & Stay'));
  });
});
