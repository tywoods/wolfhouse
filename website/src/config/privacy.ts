/**
 * Privacy / controller metadata for the marketing site.
 *
 * Legal controller identity and postal address are intentionally unset until
 * real registered details are supplied. Collection stays disabled while these
 * remain incomplete — they are a launch-blocking required value.
 */

/** Visible marker used in the privacy page and asserted by tests. */
export const CONTROLLER_IDENTITY_LAUNCH_BLOCKER =
  'LAUNCH-BLOCKING REQUIRED VALUE — legal controller identity and postal address not yet set' as const;

export const privacy = {
  /**
   * Registered legal name of the controller. Empty until a real value is
   * provided — do not invent one.
   */
  controllerLegalName: '' as string,
  /**
   * Postal address of the controller. Empty until a real value is provided —
   * do not invent one.
   */
  controllerPostalAddress: '' as string,
  /**
   * Voluntary email contact retention: delete or permanently anonymise enquiry
   * threads no later than 24 months after the last reply in that thread.
   */
  voluntaryEmailRetentionRule:
    'Voluntary email contact you send to hello@lunafrontdesk.com is retained only to handle that enquiry and related follow-up, and is deleted or permanently anonymised no later than 24 months after the last reply in that thread.',
} as const;

export function isControllerIdentityComplete(
  cfg: {
    controllerLegalName: string;
    controllerPostalAddress: string;
  } = privacy,
): boolean {
  return (
    cfg.controllerLegalName.trim().length > 0 &&
    cfg.controllerPostalAddress.trim().length > 0
  );
}
