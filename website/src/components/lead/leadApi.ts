/**
 * Marketing lead-capture contract (compile-time disabled).
 *
 * No receiver is implemented on this static site. There is intentionally
 * **no** build-time/env enablement flag and **no** POST / storage path in this
 * slice. An audited same-origin receiver may be added only in a future
 * reviewed slice.
 */

/** Documented future path — never called from this slice. */
export const LEAD_API_PATH = '/api/leads' as const;

/**
 * Compile-time kill switch. Must remain `false` until an audited receiver
 * lands. Changing this to `true` without a receiver is forbidden; tests assert
 * the constant stays false and that no POST helper exists.
 */
export const LEAD_SUBMISSION_ENABLED = false as const;

/** True only when a future audited receiver may be wired. Always false here. */
export function isLeadSubmissionEnabled(): boolean {
  return LEAD_SUBMISSION_ENABLED;
}
