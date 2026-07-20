/**
 * Same-origin `/api/leads` contract for marketing lead capture.
 *
 * This static site does **not** implement a receiver. Posting is disabled by
 * default. Production enablement stays blocked pending an audited backend.
 */

import type { LeadInput } from './leadSchema';
import type { UtmParams } from './leadSchema';

/** Only allowed path — never an arbitrary absolute URL. */
export const LEAD_API_PATH = '/api/leads' as const;

/** Generic user-facing error — never include status text or response bodies. */
export const LEAD_GENERIC_ERROR =
  'Something went wrong. Please try again, or email us instead.';

export interface LeadPayload {
  name: string;
  businessName: string;
  contact: string;
  businessType: string;
  volumeBucket: string;
  freeText: string;
  capturedAt: string;
  source: UtmParams;
}

export interface LeadApiSuccess {
  ok: true;
}

export interface LeadApiFailure {
  ok: false;
  /** Always the generic message; never a raw body. */
  error: typeof LEAD_GENERIC_ERROR;
}

export type LeadApiResult = LeadApiSuccess | LeadApiFailure;

/**
 * Whether the client may POST to same-origin `/api/leads`.
 * Default: false. Production builds (`PUBLIC_INDEXABLE=true`) always refuse,
 * even if `PUBLIC_LEAD_API_ENABLED=true`, until a backend audit lands.
 */
export function isLeadApiEnabled(
  env: Record<string, string | undefined> = (
    import.meta as unknown as { env: Record<string, string | undefined> }
  ).env,
): boolean {
  const flag = env.PUBLIC_LEAD_API_ENABLED === 'true';
  const productionBuild = env.PUBLIC_INDEXABLE === 'true';
  if (productionBuild) return false;
  return flag;
}

export function buildLeadPayload(
  input: LeadInput,
  source: UtmParams,
  now: () => Date = () => new Date(),
): LeadPayload {
  return {
    name: input.name.trim(),
    businessName: input.businessName.trim(),
    contact: input.contact.trim(),
    businessType: input.businessType,
    volumeBucket: input.volumeBucket || '',
    freeText: (input.freeText || '').trim(),
    capturedAt: now().toISOString(),
    source,
  };
}

/**
 * POST to same-origin `/api/leads` only. Swallows response bodies and always
 * surfaces {@link LEAD_GENERIC_ERROR} on failure.
 */
export async function postLead(
  payload: LeadPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<LeadApiResult> {
  try {
    const res = await fetchImpl(LEAD_API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    // Consume body so the connection can close, but never surface it.
    await res.text().catch(() => '');
    if (res.ok) return { ok: true };
    return { ok: false, error: LEAD_GENERIC_ERROR };
  } catch {
    return { ok: false, error: LEAD_GENERIC_ERROR };
  }
}
