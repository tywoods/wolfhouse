import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { site } from '../config/site';

const ROOT = join(import.meta.dirname, '../..');
const PUBLIC = join(ROOT, 'public');

/** Minimal PNG IHDR width/height reader (big-endian at byte 16). */
function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('site metadata config', () => {
  it('points ogImage at the local OG asset path', () => {
    expect(site.ogImage).toBe('/og/luna-front-desk-og.png');
  });

  it('keeps a non-empty description and name', () => {
    expect(site.name).toBe('Luna Front Desk');
    expect(site.description.length).toBeGreaterThan(40);
  });
});

describe('source metadata assets (public/)', () => {
  it('keeps the supplied brand logo', () => {
    const logo = join(PUBLIC, 'luna-front-desk-logo.png');
    expect(existsSync(logo)).toBe(true);
    expect(statSync(logo).size).toBeGreaterThan(100_000);
    const { width, height } = pngSize(readFileSync(logo));
    expect(width).toBe(707);
    expect(height).toBe(353);
  });

  it('ships a real 1200×630 OG PNG', () => {
    const og = join(PUBLIC, 'og/luna-front-desk-og.png');
    expect(existsSync(og)).toBe(true);
    const { width, height } = pngSize(readFileSync(og));
    expect(width).toBe(1200);
    expect(height).toBe(630);
  });

  it('ships a real 180×180 Apple touch PNG', () => {
    const icon = join(PUBLIC, 'apple-touch-icon.png');
    expect(existsSync(icon)).toBe(true);
    const { width, height } = pngSize(readFileSync(icon));
    expect(width).toBe(180);
    expect(height).toBe(180);
  });
});

describe('layout metadata wiring', () => {
  it('Layout.astro references local OG and Apple touch paths', () => {
    const layout = readFileSync(join(ROOT, 'src/layouts/Layout.astro'), 'utf8');
    expect(layout).toContain('property="og:image"');
    expect(layout).toContain('rel="apple-touch-icon"');
    expect(layout).toContain('href="/apple-touch-icon.png"');
    expect(layout).toContain('ogImageUrl');
  });
});

describe('QA browser dependency lock', () => {
  it('pins playwright in package.json for reproducible qa/shot.mjs', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    expect(pkg.devDependencies?.playwright).toBe('1.61.1');
    expect(pkg.scripts?.qa).toBe('node qa/shot.mjs');
    expect(pkg.scripts?.['qa:install-browser']).toBe('playwright install chromium');
    expect(pkg.scripts?.['verify:emitted']).toBe('node scripts/verify-emitted-metadata.mjs');
    const shot = readFileSync(join(ROOT, 'qa/shot.mjs'), 'utf8');
    expect(shot).toContain("from 'playwright'");
    expect(existsSync(join(ROOT, 'scripts/verify-emitted-metadata.mjs'))).toBe(true);
  });
});
