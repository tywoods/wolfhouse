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
