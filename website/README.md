# Luna Front Desk — marketing site

Static Astro site for [lunafrontdesk.com](https://lunafrontdesk.com) (preview: `preview.lunafrontdesk.com`). Interactive demo is fixture-driven and isolated from live guest/payment systems.

## Branch ancestry (PR #103)

| Slice | Role | Commit |
|---|---|---|
| **A** | Reproducibility / metadata (OG, Apple touch, locked QA browser, README) | Parent of Slice B: `f2a6462` |
| **B** | Lead truth / privacy / self-hosted fonts | Tip before Slice C: `6b1d128` |
| **C** | Static-site security / deployment hardening | Tip before Slice D: `24213a2` |
| **D** | Scripted interactive demo truth (this work) | Tip on `feat/luna-marketing-site` after Slice D |

Treat `24213a2` as the Slice C baseline when reviewing Slice D diffs (`24213a2..HEAD`).

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
npm test         # vitest (demo engine, lead schema, privacy, metadata assets)
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

There is **no** `PUBLIC_LEAD_*` enablement variable. Lead submission is compile-time disabled (`LEAD_SUBMISSION_ENABLED = false`) with zero network/storage path until an audited receiver is implemented in a future reviewed slice.

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
| `src/config/privacy.ts` | Controller identity placeholders, retention rule, launch-blocker marker |
| `security/headers.contract.json` | Platform-neutral security headers + CSP hash contract |
| `public/_headers` | Cloudflare Pages / Netlify static-host header config |
| `astro.config.mjs` | Astro `site` URL + Preact + sitemap integrations |
| `src/layouts/Layout.astro` | Title, robots, Open Graph, Twitter, favicon, apple-touch |
| `src/styles/fonts.css` | Self-hosted `@font-face` for Inter + Fraunces |
| `public/fonts/` | WOFF2 font files (SIL OFL) — no Google Fonts |
| `public/js/` | External site scripts (js-class, reveal) for CSP without our unsafe-inline |
| `public/og/luna-front-desk-og.png` | OG / Twitter image (1200×630) |
| `public/apple-touch-icon.png` | Apple touch icon (180×180) |
| `public/luna-front-desk-logo.png` | Brand logo source asset |

## Demo isolation

The public demo (`src/demo/*`, `DemoStudio`) is a **guided/scripted** state machine over seeded journeys:

- Scenario + reply chips only — no free-text composer or unsupported-input fallback
- Always-visible truth label: stays in this browser; no WhatsApp, live availability, booking, payment or staff write
- Ops panel is a **Simulated operations summary** — every step is a simulated demo outcome
- Truth ordering: no held/reserved/confirmed/scheduled/created claim before a matching simulated success op
- Terminal non-handoff copy ends at awaiting-payment with **no checkout link**
- No network / websocket / beacon / storage / navigation side effects in demo paths

Lead form submission is **compile-time disabled**: the UI states before submit that data will not be sent or saved; after submit it keeps entered values, avoids success/captured language, and offers an encoded mailto. Contact must be a strict email or conservative international phone. Do not fake delivery success. Privacy notice: `/privacy/`.

**Launch blocker:** registered legal controller identity and postal address are unset on purpose (do not invent). The privacy page marks them as a launch-blocking required value; collection stays disabled until they are supplied and an audited receiver exists.

## Deployment notes

- Output is **static** (`astro build` → `dist/`). Host on any static CDN / blob / Pages-style target.
- This PR/slice does **not** change backend, infra, or deploy pipelines — wire hosting separately.
- Preview builds should keep `PUBLIC_INDEXABLE` unset/false (`noindex`).
- Production builds must set `PUBLIC_SITE_URL` to the live origin and `PUBLIC_INDEXABLE=true` only when indexing is intentional.
- Confirm emitted metadata after build: `npm run verify:emitted` (checks `dist/og/luna-front-desk-og.png`, `dist/apple-touch-icon.png`, logo copy, and HTML refs).
- **Security headers (Slice C):** platform-neutral contract in `security/headers.contract.json`; concrete Cloudflare Pages / Netlify config in `public/_headers` (copied into `dist/` on build only). CSP uses `default-src 'self'`, no `unsafe-eval`, and **sha256 hashes** (not `unsafe-inline`) for remaining Astro island bootstrap inline script/style. Authorization is the reviewed `security/inline-blocks.inventory.json` (type, pages, SHA-256, expected count) — **not** dist. `npm run build` verifies dist against that inventory and copies the committed `_headers`; it never rewrites tracked inventory/contract/`_headers`. Print-only candidates: `npm run report:inline` (never in build). **HSTS** (`max-age=31536000; includeSubDomains`, no preload yet) must only be emitted over HTTPS — not on local `http://127.0.0.1` preview; preview hostnames may set HSTS for that host only.
- Font / stylesheet origin gate: `npm run scan:fonts` recursively checks every `src` CSS/Astro/HTML file. Post-build: `npm run verify:security` (+ `verify:adversarial-csp`).

## Scripts

| Command | Action |
|---|---|
| `npm ci` | Clean install from lockfile |
| `npm run dev` | Dev server |
| `npm run check` | Astro/TS check |
| `npm test` | Unit + component + metadata + security contract tests |
| `npm run test:lead-browser` | Playwright lead truth/privacy/same-origin font checks (`QA_URL`) |
| `npm run test:demo-browser` | Playwright scripted-demo isolation / mobile tabs / touch targets (`QA_URL`) |
| `npm run build` | Production static build + inventory verify + copy committed `_headers` to dist |
| `npm run verify:emitted` | Assert dist OG/Apple/logo + HTML refs (after build) |
| `npm run verify:security` | CSP/headers/inventory equivalence, local asset scan, dist origin/privacy gates |
| `npm run verify:adversarial-csp` | Injected unknown/moved/duplicate/missing/extra hash-header-directive must fail |
| `npm run verify:build-readonly` | Two builds → git-clean tracked CSP files + identical dist |
| `npm run report:inline` | Print-only inline candidates from dist (never writes; not part of build) |
| `npm run scan:fonts` | Source-only local stylesheet/@import/@font-face scanner |
| `npm run preview` | Preview `dist/` |
| `npm run qa:install-browser` | Install Playwright Chromium |
| `npm run qa` | Visual QA screenshots (`QA_URL`) |
