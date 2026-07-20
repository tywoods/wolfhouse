import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../..');

const scanMod = await import('../../scripts/lib/local-asset-scan.mjs');
const cspMod = await import('../../scripts/lib/inline-csp.mjs');

describe('security headers contract', () => {
  it('commits a platform-neutral headers contract with required directives', () => {
    const path = join(ROOT, 'security/headers.contract.json');
    expect(existsSync(path)).toBe(true);
    const contract = JSON.parse(readFileSync(path, 'utf8')) as {
      headers: Record<
        string,
        {
          value?: string;
          directives?: Record<string, string[]>;
          forbiddenTokens?: string[];
          previewCaveat?: string;
        }
      >;
      hosting: { commonStaticConfig: string; notes: string[] };
      inlineHashes: { authorizedBy?: string };
    };
    expect(contract.hosting.commonStaticConfig).toBe('public/_headers');
    expect(contract.hosting.notes.some((n) => /HSTS/i.test(n))).toBe(true);
    expect(contract.hosting.notes.some((n) => /inline-blocks\.inventory/i.test(n))).toBe(true);
    expect(contract.inlineHashes.authorizedBy).toBe('security/inline-blocks.inventory.json');

    const csp = contract.headers['Content-Security-Policy'];
    expect(csp.directives?.['default-src']).toEqual(["'self'"]);
    expect(csp.directives?.['font-src']).toEqual(["'self'"]);
    expect(csp.directives?.['frame-src']).toEqual(["'none'"]);
    expect(csp.directives?.['object-src']).toEqual(["'none'"]);
    expect(csp.directives?.['base-uri']).toEqual(["'self'"]);
    expect(csp.directives?.['form-action']).toEqual(["'self'"]);
    expect(csp.directives?.['frame-ancestors']).toEqual(["'none'"]);
    expect(csp.directives?.['connect-src']).toEqual(["'self'"]);
    expect(csp.directives?.['img-src']?.[0]).toBe("'self'");
    expect(csp.directives?.['script-src']?.[0]).toBe("'self'");
    expect(csp.directives?.['style-src']?.[0]).toBe("'self'");
    expect(csp.forbiddenTokens?.some((t) => t.includes('unsafe-eval'))).toBe(true);

    expect(contract.headers['X-Content-Type-Options'].value).toBe('nosniff');
    expect(contract.headers['Referrer-Policy'].value).toBe('strict-origin-when-cross-origin');
    expect(contract.headers['Permissions-Policy'].value).toMatch(/camera=\(\)/);
    expect(contract.headers['Strict-Transport-Security'].value).toMatch(/max-age=31536000/);
    expect(contract.headers['Strict-Transport-Security'].previewCaveat).toMatch(/preview/i);
  });

  it('ships a concrete common static-host _headers file', () => {
    const headers = readFileSync(join(ROOT, 'public/_headers'), 'utf8');
    expect(headers).toMatch(/Content-Security-Policy:/);
    expect(headers).toMatch(/default-src 'self'/);
    expect(headers).toMatch(/X-Content-Type-Options:\s*nosniff/);
    expect(headers).toMatch(/Referrer-Policy:\s*strict-origin-when-cross-origin/);
    expect(headers).toMatch(/Permissions-Policy:/);
    expect(headers).toMatch(/Strict-Transport-Security:\s*max-age=31536000; includeSubDomains/);
    expect(headers).toMatch(/X-Frame-Options:\s*DENY/);
    expect(headers).not.toMatch(/unsafe-eval/);
    expect(headers).not.toMatch(/'unsafe-inline'/);
    expect(headers).toMatch(/HSTS caveat/i);
    expect(headers).toMatch(/never regenerates hashes from dist/i);
  });
});

describe('reviewed inline-block inventory (authorization source)', () => {
  it('commits exact type/page/sha256/expectedCount entries', () => {
    const path = join(ROOT, 'security/inline-blocks.inventory.json');
    expect(existsSync(path)).toBe(true);
    const inv = JSON.parse(readFileSync(path, 'utf8')) as {
      reviewed: boolean;
      blocks: Array<{
        id: string;
        type: string;
        pages: string[];
        sha256: string;
        expectedCount: number;
      }>;
    };
    expect(inv.reviewed).toBe(true);
    expect(inv.blocks.length).toBe(4);
    for (const b of inv.blocks) {
      expect(['script', 'style']).toContain(b.type);
      expect(b.pages.length).toBeGreaterThan(0);
      expect(b.sha256).toMatch(/^sha256-[A-Za-z0-9+/=]+$/);
      expect(b.expectedCount).toBe(1);
    }
    const ids = inv.blocks.map((b) => b.id).sort();
    expect(ids).toEqual([
      'astro-client-visible',
      'astro-island-display-contents',
      'astro-island-element',
      'privacy-scoped-css',
    ]);
  });

  it('keeps contract/_headers bidirectionally canonical with inventory', () => {
    const result = cspMod.verifyContractHeadersInventoryEquivalence(ROOT);
    expect(result.errors, result.errors.join('\n')).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('deterministic local asset / font origin source scanner', () => {
  it('recursively enumerates every src CSS/Astro/HTML file', () => {
    const files = scanMod.enumerateSourceFiles(ROOT);
    expect(files.some((f: string) => f.endsWith('styles/fonts.css'))).toBe(true);
    expect(files.some((f: string) => f.endsWith('layouts/Layout.astro'))).toBe(true);
    expect(files.some((f: string) => f.endsWith('pages/index.astro'))).toBe(true);
    expect(files.every((f: string) => f.startsWith('src/'))).toBe(true);
    expect(files).toEqual([...files].sort());
  });

  it('validates stylesheet links, @import, and @font-face URLs are local', () => {
    const { errors, files } = scanMod.scanLocalAssetOrigins(ROOT);
    expect(files.length).toBeGreaterThan(10);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('rejects protocol-relative, data, and remote font sources', () => {
    expect(scanMod.validateLocalUrl('//fonts.googleapis.com/css', 'stylesheet')).toMatch(/reject/i);
    expect(scanMod.validateLocalUrl('https://cdn.example/font.woff2', 'font')).toMatch(/reject/i);
    expect(scanMod.validateLocalUrl('data:font/woff2;base64,xx', 'font')).toMatch(/data:/i);
    expect(scanMod.validateLocalUrl('/fonts/inter-latin-400-normal.woff2', 'font')).toBeNull();
    expect(scanMod.validateLocalUrl('./tokens.css', 'import')).toBeNull();
  });
});

describe('lead + privacy invariants preserved (Slice C)', () => {
  it('keeps lead submission compile-time disabled', async () => {
    const { LEAD_SUBMISSION_ENABLED } = await import('../components/lead/leadApi');
    expect(LEAD_SUBMISSION_ENABLED).toBe(false);
  });

  it('keeps controller identity incomplete (launch blocker)', async () => {
    const { isControllerIdentityComplete, privacy } = await import('./privacy');
    expect(privacy.controllerLegalName).toBe('');
    expect(privacy.controllerPostalAddress).toBe('');
    expect(isControllerIdentityComplete()).toBe(false);
  });
});

describe('no dist-as-authorization writers', () => {
  it('build script seals without rewriting tracked CSP files', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.build).toContain('seal-dist-security');
    expect(pkg.scripts.build).not.toContain('sync-csp-hashes');
    expect(pkg.scripts.build).not.toContain('report:inline');
    const stub = readFileSync(join(ROOT, 'scripts/sync-csp-hashes.mjs'), 'utf8');
    expect(stub).not.toMatch(/writeFileSync/);
    const seal = readFileSync(join(ROOT, 'scripts/seal-dist-security.mjs'), 'utf8');
    expect(seal).toMatch(/copyCommittedHeadersToDist/);
    expect(seal).not.toMatch(/writeFileSync\([^)]*headers\.contract/);
    expect(seal).not.toMatch(/writeFileSync\([^)]*_headers/);
    expect(seal).not.toMatch(/writeFileSync\([^)]*inventory/);
  });
});
