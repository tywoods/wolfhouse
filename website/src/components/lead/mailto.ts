import type { LeadInput } from './leadSchema';

const CONTACT_EMAIL = 'hello@lunafrontdesk.com';

/** Build a fully encoded mailto: link from lead form values. */
export function buildMailtoLink(
  input: LeadInput,
  to: string = CONTACT_EMAIL,
): string {
  const body = [
    `Name: ${input.name}`,
    `Business: ${input.businessName}`,
    `Contact: ${input.contact}`,
    `Business type: ${input.businessType}`,
    `Monthly WhatsApp volume: ${input.volumeBucket || 'not specified'}`,
    input.freeText ? `\nContext:\n${input.freeText}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const subject = `Luna Front Desk — interest from ${input.businessName}`;
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
