import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  LEAD_API_PATH,
  LEAD_SUBMISSION_ENABLED,
  isLeadSubmissionEnabled,
} from './leadApi';

const ROOT = join(import.meta.dirname, '../../..');
const LEAD_DIR = join(ROOT, 'src/components/lead');

function readLeadSources(): string {
  const files = readdirSync(LEAD_DIR).filter(
    (f) => /\.(ts|tsx)$/.test(f) && !f.includes('.test.'),
  );
  return files.map((f) => readFileSync(join(LEAD_DIR, f), 'utf8')).join('\n');
}

describe('lead submission compile-time disablement', () => {
  it('keeps LEAD_SUBMISSION_ENABLED false (rejects accidental enablement)', () => {
    expect(LEAD_SUBMISSION_ENABLED).toBe(false);
    expect(isLeadSubmissionEnabled()).toBe(false);
  });

  it('documents the future path without shipping a receiver', () => {
    expect(LEAD_API_PATH).toBe('/api/leads');
    expect(existsSync(join(ROOT, 'src/pages/api'))).toBe(false);
  });

  it('contains no POST helper, fetch lead calls, or build-variable enablement', () => {
    const src = readLeadSources();
    expect(src).not.toMatch(/\bpostLead\b/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/PUBLIC_LEAD_API_ENABLED/);
    expect(src).not.toMatch(/PUBLIC_LEAD_ENDPOINT/);
    expect(src).not.toMatch(/method:\s*['"]POST['"]/);
    expect(src).not.toMatch(/buildLeadPayload/);
  });
});
