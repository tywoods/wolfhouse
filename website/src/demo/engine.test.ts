import { describe, it, expect } from 'vitest';
import {
  initialState,
  startJourney,
  advance,
  matchJourneyByText,
  journeysFor,
  currentSuggestions,
} from './engine';
import type { DemoState } from './engine';

// ── initialState ─────────────────────────────────────────────────────────────

describe('initialState', () => {
  it('returns idle status with empty transcript and ops', () => {
    const state = initialState('hostel');
    expect(state.status).toBe('idle');
    expect(state.transcript).toHaveLength(0);
    expect(state.ops).toHaveLength(0);
    expect(state.turnIndex).toBe(0);
    expect(state.journeyId).toBeNull();
  });

  it('sets the businessType correctly', () => {
    expect(initialState('hostel').businessType).toBe('hostel');
    expect(initialState('surf_school').businessType).toBe('surf_school');
    expect(initialState('tours').businessType).toBe('tours');
    expect(initialState('rentals').businessType).toBe('rentals');
  });
});

// ── startJourney ──────────────────────────────────────────────────────────────

describe('startJourney', () => {
  it('reveals the first turn — guest and luna bubbles both appear', () => {
    const state = initialState('hostel');
    const started = startJourney(state, 'hostel-accommodation');
    expect(started.transcript.length).toBeGreaterThanOrEqual(2);
    const fromValues = started.transcript.map((b) => b.from);
    expect(fromValues).toContain('guest');
    expect(fromValues).toContain('luna');
  });

  it('emits ops from the first turn', () => {
    const state = initialState('hostel');
    const started = startJourney(state, 'hostel-accommodation');
    expect(started.ops.length).toBeGreaterThan(0);
  });

  it('sets status to playing (or complete for single-turn journeys)', () => {
    const state = initialState('hostel');
    const started = startJourney(state, 'hostel-accommodation');
    expect(['playing', 'complete']).toContain(started.status);
  });

  it('resets transcript and ops from a prior journey', () => {
    const state: DemoState = {
      businessType: 'hostel',
      journeyId: 'hostel-accommodation',
      turnIndex: 2,
      transcript: [{ from: 'guest', text: 'old message', id: 'old-g0' }],
      ops: [{ kind: 'inbox', title: 'Old event', detail: 'old detail' }],
      status: 'playing',
    };
    const restarted = startJourney(state, 'hostel-handoff');
    // transcript should only contain the first turn of the new journey
    const ids = restarted.transcript.map((b) => b.id);
    expect(ids.every((id) => id.startsWith('hostel-handoff'))).toBe(true);
  });

  it('sets turnIndex to 1 after the first turn is revealed', () => {
    const state = initialState('hostel');
    const started = startJourney(state, 'hostel-accommodation');
    expect(started.turnIndex).toBe(1);
  });
});

// ── advance ───────────────────────────────────────────────────────────────────

describe('advance', () => {
  it('increments turnIndex on each call', () => {
    let state = initialState('hostel');
    state = startJourney(state, 'hostel-accommodation');
    const indexAfterStart = state.turnIndex;
    state = advance(state);
    expect(state.turnIndex).toBe(indexAfterStart + 1);
  });

  it('sets status to complete on the last turn', () => {
    let state = initialState('hostel');
    state = startJourney(state, 'hostel-accommodation');
    // Advance until complete
    while (state.status !== 'complete') {
      state = advance(state);
    }
    expect(state.status).toBe('complete');
  });

  it('returns the same state when called after complete', () => {
    let state = initialState('hostel');
    state = startJourney(state, 'hostel-handoff');
    while (state.status !== 'complete') {
      state = advance(state);
    }
    const frozen = state;
    const afterComplete = advance(state);
    expect(afterComplete.status).toBe('complete');
    expect(afterComplete.transcript.length).toBe(frozen.transcript.length);
  });

  it('accumulates ops across turns', () => {
    let state = initialState('hostel');
    state = startJourney(state, 'hostel-accommodation');
    const opsAfterFirst = state.ops.length;
    state = advance(state);
    expect(state.ops.length).toBeGreaterThanOrEqual(opsAfterFirst);
  });

  it('is pure — does not mutate the original state', () => {
    const state = initialState('hostel');
    const started = startJourney(state, 'hostel-accommodation');
    const transcriptLengthBefore = started.transcript.length;
    advance(started);
    expect(started.transcript.length).toBe(transcriptLengthBefore);
  });
});

// ── matchJourneyByText ────────────────────────────────────────────────────────

describe('matchJourneyByText', () => {
  it('returns a hostel journey when the text mentions beds and dorm', () => {
    const result = matchJourneyByText('beds in a dorm for the weekend', 'hostel');
    expect(result).not.toBeNull();
    expect(result!.businessType).toBe('hostel');
  });

  it('returns a surf_school journey when text mentions lessons beginners', () => {
    const result = matchJourneyByText('beginner surf lessons for adults', 'surf_school');
    expect(result).not.toBeNull();
    expect(result!.businessType).toBe('surf_school');
  });

  it('returns a tours journey when text mentions day tour group', () => {
    const result = matchJourneyByText('day tour for our group of 5', 'tours');
    expect(result).not.toBeNull();
    expect(result!.businessType).toBe('tours');
  });

  it('returns a rentals journey when text mentions rent board', () => {
    const result = matchJourneyByText('rent a board for a few days', 'rentals');
    expect(result).not.toBeNull();
    expect(result!.businessType).toBe('rentals');
  });

  it('returns null for pure gibberish', () => {
    const result = matchJourneyByText('xqzwjfk blorptastic', 'hostel');
    expect(result).toBeNull();
  });

  it('returns null for an empty string', () => {
    const result = matchJourneyByText('', 'hostel');
    expect(result).toBeNull();
  });

  it('only returns journeys matching the given business type', () => {
    // A surf lesson query against the hostel type should not match surf_school journeys
    const result = matchJourneyByText('surf lesson group beginners', 'hostel');
    if (result !== null) {
      expect(result.businessType).toBe('hostel');
    }
  });
});

// ── journeysFor ───────────────────────────────────────────────────────────────

describe('journeysFor', () => {
  it('filters to only the requested business type', () => {
    const hostelJourneys = journeysFor('hostel');
    expect(hostelJourneys.every((j) => j.businessType === 'hostel')).toBe(true);
  });

  it('returns at least one journey for every business type', () => {
    for (const bt of ['hostel', 'surf_school', 'tours', 'rentals'] as const) {
      expect(journeysFor(bt).length).toBeGreaterThan(0);
    }
  });

  it('returns an empty array for a type with no journeys (edge case guard)', () => {
    // @ts-expect-error — deliberate invalid type for runtime guard test
    const result = journeysFor('nonexistent');
    expect(result).toEqual([]);
  });
});

// ── currentSuggestions ────────────────────────────────────────────────────────

describe('currentSuggestions', () => {
  it('returns empty array before any journey is started', () => {
    const state = initialState('hostel');
    expect(currentSuggestions(state)).toEqual([]);
  });

  it('returns suggestions from the last revealed turn when they exist', () => {
    let state = initialState('hostel');
    state = startJourney(state, 'hostel-accommodation');
    const suggestions = currentSuggestions(state);
    // hostel-accommodation turn 0 defines suggestions
    expect(Array.isArray(suggestions)).toBe(true);
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it('returns empty array for a turn that has no suggestions', () => {
    let state = initialState('hostel');
    // Advance hostel-accommodation to its final turn, which has no suggestions
    state = startJourney(state, 'hostel-accommodation');
    while (state.status !== 'complete') {
      state = advance(state);
    }
    // Final turn has no suggestions defined
    expect(currentSuggestions(state)).toEqual([]);
  });

  it('returns suggestions for rentals first turn', () => {
    let state = initialState('rentals');
    state = startJourney(state, 'rentals-gear');
    const suggestions = currentSuggestions(state);
    expect(Array.isArray(suggestions)).toBe(true);
    expect(suggestions.length).toBeGreaterThan(0);
  });
});
