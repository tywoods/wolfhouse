import { describe, it, expect, vi } from 'vitest';
import {
  LEAD_API_PATH,
  LEAD_GENERIC_ERROR,
  isLeadApiEnabled,
  buildLeadPayload,
  postLead,
} from './leadApi';
import type { LeadInput } from './leadSchema';

const sample: LeadInput = {
  name: 'Maria Garcia',
  businessName: 'Surf & Stay Hostel',
  contact: 'maria@surfstay.com',
  businessType: 'hostel',
  volumeBucket: '50_150',
  freeText: 'Availability questions',
};

describe('isLeadApiEnabled', () => {
  it('is disabled by default', () => {
    expect(isLeadApiEnabled({})).toBe(false);
    expect(isLeadApiEnabled({ PUBLIC_LEAD_API_ENABLED: 'false' })).toBe(false);
  });

  it('enables only when flag is true and not a production indexable build', () => {
    expect(isLeadApiEnabled({ PUBLIC_LEAD_API_ENABLED: 'true' })).toBe(true);
  });

  it('blocks production enablement even when the flag is set', () => {
    expect(
      isLeadApiEnabled({
        PUBLIC_LEAD_API_ENABLED: 'true',
        PUBLIC_INDEXABLE: 'true',
      }),
    ).toBe(false);
  });
});

describe('buildLeadPayload', () => {
  it('builds a trimmed payload with allowlisted source only', () => {
    const payload = buildLeadPayload(
      { ...sample, name: '  Maria  ' },
      { utm_source: 'google' },
      () => new Date('2026-07-20T12:00:00.000Z'),
    );
    expect(payload.name).toBe('Maria');
    expect(payload.source).toEqual({ utm_source: 'google' });
    expect(payload.capturedAt).toBe('2026-07-20T12:00:00.000Z');
  });
});

describe('postLead', () => {
  it('POSTs only to the same-origin LEAD_API_PATH', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"secret":"nope"}', { status: 200 }));
    const result = await postLead(buildLeadPayload(sample, {}), fetchImpl);
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const firstCall = fetchImpl.mock.calls[0] as unknown as [string, RequestInit?];
    expect(firstCall[0]).toBe(LEAD_API_PATH);
    expect(firstCall[0]).toBe('/api/leads');
    expect(firstCall[1]?.method).toBe('POST');
  });

  it('returns a generic error and never surfaces response bodies', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('INTERNAL TRACEBACK: /var/secrets', { status: 500 }),
    );
    const result = await postLead(buildLeadPayload(sample, {}), fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(LEAD_GENERIC_ERROR);
      expect(result.error).not.toContain('TRACEBACK');
      expect(result.error).not.toContain('secrets');
    }
  });

  it('returns a generic error on network failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    const result = await postLead(buildLeadPayload(sample, {}), fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(LEAD_GENERIC_ERROR);
      expect(result.error).not.toContain('offline');
    }
  });
});
