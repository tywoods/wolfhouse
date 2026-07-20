# Luna Front Desk — marketing site

Static Astro site for [lunafrontdesk.com](https://lunafrontdesk.com) (preview: `preview.lunafrontdesk.com`). Interactive demo is fixture-driven and isolated from live guest/payment systems.

## Setup

Requires **Node.js ≥ 22.12**.

```sh
cd website
npm ci
npm run qa:install-browser   # Playwright Chromium for visual QA (once per machine)
```

`npm ci` installs the locked tree from `package-lock.json`. Do not use `npm install` for clean verification.

## Check

```sh
npm run check    # astro check (TypeScript + Astro diagnostics)
npm test         # vitest (demo engine, lead schema, metadata assets)
```

## Build

```sh
npm run build    # writes static output to ./dist
npm run preview  # serves ./dist locally
```

Build-time env (optional):

| Variable | Effect |
|---|---|
| `PUBLIC_SITE_URL` | Canonical / OG / sitemap base (default `https://preview.lunafrontdesk.com`) |
| `PUBLIC_INDEXABLE` | Set to `true` only for production so robots allow indexing |
| `PUBLIC_LEAD_ENDPOINT` | POST URL for lead capture; omit for honest demo/no-backend mode |

Example production-shaped build:

```sh
PUBLIC_SITE_URL=https://lunafrontdesk.com PUBLIC_INDEXABLE=true npm run build
```

## QA (browser screenshots)

Serve the build, then capture viewports + drive the demo:

```sh
npm run build
npx astro preview --host 127.0.0.1 --port 8099 &
QA_URL=http://127.0.0.1:8099/ npm run qa
```

- Screenshots land in `/tmp/luna-shots/`.
- `npm run qa` uses the **locked** `playwright@1.61.1` dependency from `package.json` / `package-lock.json`.
- Browser binary (once per machine / after Playwright upgrades):

```sh
# Prefer a writable cache. Some hosts ship a read-only PLAYWRIGHT_BROWSERS_PATH —
# override it so install can succeed:
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}" \
  npm run qa:install-browser
```

Use the same `PLAYWRIGHT_BROWSERS_PATH` when running `npm run qa` if you overrode it during install.

## Config

| File | Role |
|---|---|
| `src/config/site.ts` | Site name, tagline, description, `baseUrl`, `indexable`, `ogImage` |
| `astro.config.mjs` | Astro `site` URL + Preact + sitemap integrations |
| `src/layouts/Layout.astro` | Title, robots, Open Graph, Twitter, favicon, apple-touch |
| `public/og/luna-front-desk-og.png` | OG / Twitter image (1200×630) |
| `public/apple-touch-icon.png` | Apple touch icon (180×180) |
| `public/luna-front-desk-logo.png` | Brand logo source asset |

## Demo isolation

The public demo (`src/demo/*`, `DemoStudio`) is a pure, deterministic state machine over seeded journeys:

- No WhatsApp sends
- No Staff API / production DB calls
- No Stripe or booking writes
- No live availability or prices presented as real facts
- Journeys and ops events are fixtures only; label them as demo data in the UI

Lead form without `PUBLIC_LEAD_ENDPOINT` stays in an honest demo state (mailto fallback). Do not fake delivery success.

## Deployment notes

- Output is **static** (`astro build` → `dist/`). Host on any static CDN / blob / Pages-style target.
- This PR/slice does **not** change backend, infra, or deploy pipelines — wire hosting separately.
- Preview builds should keep `PUBLIC_INDEXABLE` unset/false (`noindex`).
- Production builds must set `PUBLIC_SITE_URL` to the live origin and `PUBLIC_INDEXABLE=true` only when indexing is intentional.
- Confirm emitted metadata after build: `npm run verify:emitted` (checks `dist/og/luna-front-desk-og.png`, `dist/apple-touch-icon.png`, logo copy, and HTML refs).

## Scripts

| Command | Action |
|---|---|
| `npm ci` | Clean install from lockfile |
| `npm run dev` | Dev server |
| `npm run check` | Astro/TS check |
| `npm test` | Unit + metadata tests |
| `npm run build` | Production static build |
| `npm run verify:emitted` | Assert dist OG/Apple/logo + HTML refs (after build) |
| `npm run preview` | Preview `dist/` |
| `npm run qa:install-browser` | Install Playwright Chromium |
| `npm run qa` | Visual QA screenshots (`QA_URL`) |
