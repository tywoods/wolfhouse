import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTROLLER_IDENTITY_LAUNCH_BLOCKER,
  isControllerIdentityComplete,
  privacy,
} from './privacy';

const ROOT = join(import.meta.dirname, '../..');

describe('controller identity launch blocker', () => {
  it('leaves legal name and postal address unset (do not invent)', () => {
    expect(privacy.controllerLegalName.trim()).toBe('');
    expect(privacy.controllerPostalAddress.trim()).toBe('');
    expect(isControllerIdentityComplete()).toBe(false);
  });

  it('states a specific voluntary email retention rule (24 months)', () => {
    expect(privacy.voluntaryEmailRetentionRule).toMatch(/24 months/i);
    expect(privacy.voluntaryEmailRetentionRule).toMatch(/hello@lunafrontdesk\.com/);
  });

  it('privacy page visibly marks the launch-blocking required value', () => {
    const page = readFileSync(join(ROOT, 'src/pages/privacy.astro'), 'utf8');
    expect(page).toContain('CONTROLLER_IDENTITY_LAUNCH_BLOCKER');
    expect(page).toContain('controller-identity-blocker');
    expect(page).toContain('data-controller-complete');
    expect(CONTROLLER_IDENTITY_LAUNCH_BLOCKER).toMatch(/LAUNCH-BLOCKING REQUIRED VALUE/i);
    expect(CONTROLLER_IDENTITY_LAUNCH_BLOCKER).toMatch(/legal controller identity/i);
    expect(CONTROLLER_IDENTITY_LAUNCH_BLOCKER).toMatch(/postal address/i);
  });

  it('rejects false controller-complete claims while identity is empty', () => {
    expect(isControllerIdentityComplete(privacy)).toBe(false);
    // Claiming complete with empty fields must fail.
    expect(
      isControllerIdentityComplete({
        controllerLegalName: '  ',
        controllerPostalAddress: '  ',
      }),
    ).toBe(false);
    // Only both real values count as complete.
    expect(
      isControllerIdentityComplete({
        controllerLegalName: 'Example Legal Entity SL',
        controllerPostalAddress: '1 Example Street, 00000 Example City',
      }),
    ).toBe(true);
  });

  it('does not claim controller identity is complete while identity is unset', () => {
    expect(isControllerIdentityComplete()).toBe(false);
    expect(privacy.controllerLegalName).toBe('');
    expect(privacy.controllerPostalAddress).toBe('');
    // A false claim would be asserting complete with empty fields:
    expect(
      isControllerIdentityComplete({
        controllerLegalName: privacy.controllerLegalName,
        controllerPostalAddress: privacy.controllerPostalAddress,
      }),
    ).toBe(false);
  });
});

describe('self-hosted fonts (no external font origins)', () => {
  it('ships Inter and Fraunces woff2 under public/fonts', () => {
    const fontsDir = join(ROOT, 'public/fonts');
    expect(existsSync(fontsDir)).toBe(true);
    const files = readdirSync(fontsDir);
    expect(files.some((f) => f.startsWith('inter-latin-400') && f.endsWith('.woff2'))).toBe(true);
    expect(files.some((f) => f.startsWith('fraunces-latin-400') && f.endsWith('.woff2'))).toBe(
      true,
    );
  });

  it('Layout and fonts.css never request Google Fonts origins', () => {
    const layout = readFileSync(join(ROOT, 'src/layouts/Layout.astro'), 'utf8');
    const fontsCss = readFileSync(join(ROOT, 'src/styles/fonts.css'), 'utf8');
    const globalCss = readFileSync(join(ROOT, 'src/styles/global.css'), 'utf8');
    for (const src of [layout, fontsCss, globalCss]) {
      expect(src).not.toMatch(/fonts\.googleapis\.com/);
      expect(src).not.toMatch(/fonts\.gstatic\.com/);
      expect(src).not.toMatch(/fonts\.google\.com/);
    }
    expect(layout).toContain("import '../styles/fonts.css'");
    expect(fontsCss).toMatch(/url\('\/fonts\//);
  });

  it('privacy text states fonts are self-hosted (not Google Fonts)', () => {
    const page = readFileSync(join(ROOT, 'src/pages/privacy.astro'), 'utf8');
    expect(page).toMatch(/self-hosted/i);
    expect(page).toMatch(/do not request Google Fonts/i);
    expect(page).not.toMatch(/Fonts may load from Google Fonts/);
  });
});
