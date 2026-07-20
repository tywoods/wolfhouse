import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../..');
const SRC = join(ROOT, 'src');

function walk(dir: string, acc: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dist') continue;
      walk(p, acc);
    } else if (/\.(tsx?|astro|css|mjs|js)$/.test(ent.name)) {
      acc.push(p);
    }
  }
  return acc;
}

describe('Slice D scripted-demo source invariants', () => {
  it('DemoStudio has no free-text composer or unsupported-input fallback', () => {
    const studio = readFileSync(join(SRC, 'components/demo/DemoStudio.tsx'), 'utf8');
    expect(studio).not.toMatch(/<input\b/);
    expect(studio).not.toMatch(/textarea/i);
    expect(studio).not.toMatch(/matchJourneyByText/);
    expect(studio).not.toMatch(/Type a guest message|type your own|free-text|placeholder=/i);
    expect(studio).toMatch(/Continue with next scripted guest message/);
    expect(studio).toMatch(/Simulated operations summary/);
    expect(studio).toMatch(/Interactive scripted demo — stays in this browser/);
    expect(studio).toMatch(/role="tab"/);
    expect(studio).toMatch(/ArrowLeft|ArrowRight|Home|End/);
  });

  it('engine has no free-text matching API', () => {
    const engine = readFileSync(join(SRC, 'demo/engine.ts'), 'utf8');
    expect(engine).not.toMatch(/matchJourneyByText/);
    expect(engine).not.toMatch(/free-text intent/i);
    expect(engine).toMatch(/nextScriptedGuest/);
  });

  it('nav/CTAs say Interactive demo, not Live demo', () => {
    const files = [
      'components/Header.astro',
      'components/Footer.astro',
      'components/Hero.astro',
      'components/sections/FinalCta.astro',
      'components/sections/Onboarding.astro',
    ];
    for (const f of files) {
      const text = readFileSync(join(SRC, f), 'utf8');
      expect(text, f).not.toMatch(/Live demo/i);
      if (f.includes('Header') || f.includes('Footer') || f.includes('Hero')) {
        expect(text, f).toMatch(/Interactive demo/i);
      }
    }
  });

  it('demo CSS enforces >=44px touch targets and reduced-motion stability', () => {
    const css = readFileSync(join(SRC, 'components/demo/DemoStudio.css'), 'utf8');
    expect(css).toMatch(/--touch:\s*44px/);
    expect(css).toMatch(/studio__biz-tab[\s\S]*min-height:\s*var\(--touch\)/);
    expect(css).toMatch(/chip--reply[\s\S]*min-height:\s*var\(--touch\)/);
    expect(css).toMatch(/chip--journey[\s\S]*min-height:\s*var\(--touch\)/);
    expect(css).toMatch(/phone__send[\s\S]*min-height:\s*var\(--touch\)/);
    expect(css).toMatch(/studio__reset[\s\S]*min-height:\s*var\(--touch\)/);
    expect(css).toMatch(/studio__panel-tab[\s\S]*min-height:\s*var\(--touch\)/);
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(css).toMatch(/overflow-x:\s*clip/);
  });

  it('demo sources never open network, storage, websocket, beacon, or navigation APIs', () => {
    const demoFiles = walk(join(SRC, 'demo')).concat(
      walk(join(SRC, 'components/demo')),
    );
    const banned =
      /\b(fetch|XMLHttpRequest|WebSocket|navigator\.sendBeacon|localStorage|sessionStorage|indexedDB|location\.assign|location\.replace|window\.open)\b/;
    for (const f of demoFiles) {
      if (f.endsWith('.test.ts') || f.endsWith('.test.tsx')) continue;
      const text = readFileSync(f, 'utf8');
      expect(banned.test(text), `${f} uses banned side-effect API`).toBe(false);
    }
  });

  it('security/lead/controller blocker invariants remain unchanged', async () => {
    const { LEAD_SUBMISSION_ENABLED } = await import('../components/lead/leadApi');
    expect(LEAD_SUBMISSION_ENABLED).toBe(false);
    const { isControllerIdentityComplete, privacy } = await import('../config/privacy');
    expect(privacy.controllerLegalName).toBe('');
    expect(privacy.controllerPostalAddress).toBe('');
    expect(isControllerIdentityComplete()).toBe(false);
  });
});
