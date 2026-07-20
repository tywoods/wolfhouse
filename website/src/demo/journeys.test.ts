import { describe, it, expect } from 'vitest';
import { journeys, businesses, businessOrder } from './journeys';
import type { OpsKind, BusinessType } from './types';

const VALID_OPS_KINDS: OpsKind[] = [
  'availability',
  'package',
  'detail',
  'quote',
  'draft',
  'inbox',
  'handoff',
];

const ALL_BUSINESS_TYPES: BusinessType[] = ['hostel', 'surf_school', 'tours', 'rentals'];

const SLA_CLAIM = /\b(within a few hours|shortly|in \d+\s*(minutes?|hours?|days?)|asap|immediately)\b/i;
const CHECKOUT_URL = /https?:\/\/|checkout\.stripe|buy\.stripe|payment[\s_-]?link|\/pay\b/i;

function claimWords(text: string): string[] {
  const out: string[] = [];
  const re = /\b(held|reserved|confirmed|scheduled|created)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1].toLowerCase());
  return out;
}

function isSimulatedSuccessFor(opText: string, claim: string): boolean {
  if (!/simulated/i.test(opText)) return false;
  // Map claim → acceptable simulated success markers in the op.
  const patterns: Record<string, RegExp> = {
    held: /\b(held|hold|reserved|created|draft)\b/i,
    reserved: /\b(reserved|reservation|created|draft)\b/i,
    confirmed: /\b(confirmed|created|draft)\b/i,
    scheduled: /\b(scheduled|schedule|created|draft)\b/i,
    created: /\b(created|draft)\b/i,
  };
  return patterns[claim]?.test(opText) ?? false;
}

// ── Journey structural integrity ──────────────────────────────────────────────

describe('journeys structure', () => {
  it('every journey has at least one turn', () => {
    for (const j of journeys) {
      expect(j.turns.length, `Journey "${j.id}" must have >=1 turn`).toBeGreaterThan(0);
    }
  });

  it('every turn has a non-empty guest message', () => {
    for (const j of journeys) {
      for (const [i, turn] of j.turns.entries()) {
        expect(
          turn.guest.trim().length,
          `Journey "${j.id}" turn ${i} has empty guest message`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('every turn has a non-empty luna reply', () => {
    for (const j of journeys) {
      for (const [i, turn] of j.turns.entries()) {
        expect(
          turn.luna.trim().length,
          `Journey "${j.id}" turn ${i} has empty luna reply`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('every ops event uses a valid OpsKind', () => {
    for (const j of journeys) {
      for (const [i, turn] of j.turns.entries()) {
        for (const op of turn.ops ?? []) {
          expect(
            VALID_OPS_KINDS,
            `Journey "${j.id}" turn ${i} has unknown ops kind "${op.kind}"`,
          ).toContain(op.kind);
        }
      }
    }
  });

  it('every journey has a non-empty title, summary and payoff', () => {
    for (const j of journeys) {
      expect(j.title.trim().length, `Journey "${j.id}" missing title`).toBeGreaterThan(0);
      expect(j.summary.trim().length, `Journey "${j.id}" missing summary`).toBeGreaterThan(0);
      expect(j.payoff.trim().length, `Journey "${j.id}" missing payoff`).toBeGreaterThan(0);
    }
  });

  it('every journey id is unique', () => {
    const ids = journeys.map((j) => j.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('every journey businessType is one of the four known types', () => {
    for (const j of journeys) {
      expect(
        ALL_BUSINESS_TYPES,
        `Journey "${j.id}" has unknown businessType "${j.businessType}"`,
      ).toContain(j.businessType);
    }
  });

  it('ops events have non-empty title and detail', () => {
    for (const j of journeys) {
      for (const [i, turn] of j.turns.entries()) {
        for (const op of turn.ops ?? []) {
          expect(op.title.trim().length, `Journey "${j.id}" turn ${i} op has empty title`).toBeGreaterThan(0);
          expect(op.detail.trim().length, `Journey "${j.id}" turn ${i} op has empty detail`).toBeGreaterThan(0);
        }
      }
    }
  });
});

// ── Slice D truth ordering + simulated ops ────────────────────────────────────

describe('Slice D demo truth ordering', () => {
  it('every ops title is explicitly simulated', () => {
    for (const j of journeys) {
      for (const [i, turn] of j.turns.entries()) {
        for (const op of turn.ops ?? []) {
          expect(
            /simulated/i.test(op.title),
            `${j.id} turn ${i} op "${op.title}" must be simulated`,
          ).toBe(true);
        }
      }
    }
  });

  it('success claim phrases are ordered behind matching simulated ops', () => {
    for (const j of journeys) {
      const priorOps: string[] = [];
      for (const [i, turn] of j.turns.entries()) {
        // Ops for this turn become available before guest/luna claims (UI + fixture order).
        for (const op of turn.ops ?? []) {
          priorOps.push(`${op.title} ${op.detail}`);
        }
        const claimTexts = [turn.guest, turn.luna, ...(turn.suggestions ?? []), j.payoff];
        // Payoff only checked on final turn
        const texts =
          i === j.turns.length - 1
            ? claimTexts
            : [turn.guest, turn.luna, ...(turn.suggestions ?? [])];
        for (const text of texts) {
          for (const claim of claimWords(text)) {
            // Claims that appear only inside an already-qualified simulated op string
            // on this turn are covered by priorOps including this turn's ops.
            const covered = priorOps.some((opText) => isSimulatedSuccessFor(opText, claim));
            expect(
              covered,
              `${j.id} turn ${i}: claim "${claim}" in "${text.slice(0, 80)}" lacks prior simulated success`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it('handoff copy has no SLA promises', () => {
    for (const j of journeys.filter((x) => x.kind === 'handoff')) {
      for (const turn of j.turns) {
        const blob = `${turn.guest}\n${turn.luna}\n${(turn.ops ?? []).map((o) => `${o.title} ${o.detail}`).join('\n')}`;
        expect(SLA_CLAIM.test(blob), `${j.id} still has SLA language`).toBe(false);
      }
    }
  });

  it('fixtures contain no checkout URL or payment-link control', () => {
    for (const j of journeys) {
      const blob = JSON.stringify(j);
      expect(CHECKOUT_URL.test(blob), `${j.id} has checkout/payment URL`).toBe(false);
      expect(/\bpay now\b/i.test(blob), `${j.id} has pay-now control copy`).toBe(false);
    }
  });

  it('flagship hostel journey is enquiry → staff-ready booking draft with awaiting-payment', () => {
    const flagship = journeys.find((j) => j.id === 'hostel-accommodation');
    expect(flagship).toBeTruthy();
    expect(flagship!.title).toMatch(/enquiry.*staff-ready booking draft/i);
    const last = flagship!.turns[flagship!.turns.length - 1];
    expect(last.luna).toMatch(/awaiting payment/i);
    expect(last.luna).toMatch(/no checkout link/i);
    expect(last.ops?.some((o) => o.kind === 'draft' && /awaiting payment/i.test(o.detail))).toBe(true);
  });

  it('non-handoff journeys end awaiting-payment without checkout', () => {
    for (const j of journeys.filter((x) => x.kind !== 'handoff')) {
      const last = j.turns[j.turns.length - 1];
      const draft = last.ops?.find((o) => o.kind === 'draft');
      expect(draft, `${j.id} missing terminal draft op`).toBeTruthy();
      expect(/awaiting payment/i.test(`${last.luna}\n${draft!.detail}`), `${j.id} missing awaiting-payment`).toBe(
        true,
      );
      expect(/checkout/i.test(last.luna) ? /no checkout/i.test(last.luna) : true).toBe(true);
    }
  });
});

// ── Coverage by business type ─────────────────────────────────────────────────

describe('journey coverage by business type', () => {
  it('every business type has at least one journey', () => {
    for (const bt of ALL_BUSINESS_TYPES) {
      const count = journeys.filter((j) => j.businessType === bt).length;
      expect(count, `Business type "${bt}" has no journeys`).toBeGreaterThan(0);
    }
  });

  it('every business type has at least one accommodation or service journey', () => {
    for (const bt of ALL_BUSINESS_TYPES) {
      const count = journeys.filter(
        (j) => j.businessType === bt && (j.kind === 'accommodation' || j.kind === 'service'),
      ).length;
      expect(
        count,
        `Business type "${bt}" has no accommodation/service journey`,
      ).toBeGreaterThan(0);
    }
  });

  it('every business type has at least one handoff journey', () => {
    for (const bt of ALL_BUSINESS_TYPES) {
      const count = journeys.filter(
        (j) => j.businessType === bt && j.kind === 'handoff',
      ).length;
      expect(count, `Business type "${bt}" has no handoff journey`).toBeGreaterThan(0);
    }
  });

  it('tours has at least one service journey', () => {
    const toursService = journeys.filter(
      (j) => j.businessType === 'tours' && j.kind === 'service',
    );
    expect(toursService.length).toBeGreaterThan(0);
  });

  it('rentals has at least one service journey', () => {
    const rentalsService = journeys.filter(
      (j) => j.businessType === 'rentals' && j.kind === 'service',
    );
    expect(rentalsService.length).toBeGreaterThan(0);
  });
});

// ── businessOrder ─────────────────────────────────────────────────────────────

describe('businessOrder', () => {
  it('covers all four business types', () => {
    expect(businessOrder.length).toBe(4);
    for (const bt of ALL_BUSINESS_TYPES) {
      expect(businessOrder, `businessOrder is missing "${bt}"`).toContain(bt);
    }
  });

  it('contains no duplicates', () => {
    const unique = new Set(businessOrder);
    expect(unique.size).toBe(businessOrder.length);
  });
});

// ── businesses ────────────────────────────────────────────────────────────────

describe('businesses', () => {
  it('has an entry for every business type', () => {
    for (const bt of ALL_BUSINESS_TYPES) {
      expect(businesses[bt], `businesses is missing entry for "${bt}"`).toBeDefined();
    }
  });

  it('every business profile has a non-empty demoName, label and blurb', () => {
    for (const bt of ALL_BUSINESS_TYPES) {
      const b = businesses[bt];
      expect(b.demoName.trim().length, `businesses["${bt}"].demoName is empty`).toBeGreaterThan(0);
      expect(b.label.trim().length, `businesses["${bt}"].label is empty`).toBeGreaterThan(0);
      expect(b.blurb.trim().length, `businesses["${bt}"].blurb is empty`).toBeGreaterThan(0);
    }
  });
});
