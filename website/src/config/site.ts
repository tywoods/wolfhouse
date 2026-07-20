// Central site metadata. baseUrl is overridden per-environment at build time
// via PUBLIC_SITE_URL (preview vs production) so canonical/OG links are correct.
export const site = {
  name: 'Luna Front Desk',
  tagline: 'The AI WhatsApp front desk for hospitality',
  // Falls back to the intended preview subdomain; real value injected at build.
  baseUrl: (import.meta.env.PUBLIC_SITE_URL as string | undefined) ?? 'https://preview.lunafrontdesk.com',
  description:
    'Luna answers your guests on WhatsApp, checks real availability, explains your packages, and turns enquiries into organised bookings — while your team keeps working.',
  // Set true only on the real production build so robots allow indexing.
  indexable: (import.meta.env.PUBLIC_INDEXABLE as string | undefined) === 'true',
  contactEmail: 'hello@lunafrontdesk.com',
  ogImage: '/og/luna-front-desk-og.png',
} as const;
