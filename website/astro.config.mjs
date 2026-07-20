// @ts-check
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import sitemap from '@astrojs/sitemap';

// Site URL drives canonical/OG/sitemap. Overridden per env via PUBLIC_SITE_URL
// (preview vs production) at build time.
const site = process.env.PUBLIC_SITE_URL || 'https://preview.lunafrontdesk.com';

// https://astro.build/config
export default defineConfig({
  site,
  integrations: [preact(), sitemap()],
});
