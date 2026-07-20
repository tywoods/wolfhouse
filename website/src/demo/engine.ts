// Pure, deterministic demo state machine. No framework imports, no I/O — so it
// is trivially unit-testable and can never produce a side effect.

import type { BusinessType, Journey, OpsEvent, Turn } from './types';
import { journeys } from './journeys';

export interface Bubble {
  from: 'guest' | 'luna';
  text: string;
  // stable key for rendering
  id: string;
}

export interface DemoState {
  businessType: BusinessType;
  journeyId: string | null;
  turnIndex: number; // number of turns already revealed
  transcript: Bubble[];
  ops: OpsEvent[];
  status: 'idle' | 'playing' | 'complete';
}

export function journeysFor(bt: BusinessType): Journey[] {
  return journeys.filter((j) => j.businessType === bt);
}

export function getJourney(id: string): Journey | undefined {
  return journeys.find((j) => j.id === id);
}

export function initialState(bt: BusinessType): DemoState {
  return { businessType: bt, journeyId: null, turnIndex: 0, transcript: [], ops: [], status: 'idle' };
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set(
  'a an the to for of in on at is it do i we you my our can could would like want need got have has'.split(' '),
);

function tokens(s: string): Set<string> {
  return new Set(
    normalize(s)
      .split(' ')
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

// Controlled free-text intent matching: map a visitor's typed opener to the best
// journey within the selected business type by keyword overlap. Returns null when
// nothing clears a small confidence floor (caller then shows guided chips).
export function matchJourneyByText(text: string, bt: BusinessType): Journey | null {
  const t = tokens(text);
  if (t.size === 0) return null;
  let best: Journey | null = null;
  let bestScore = 0;
  for (const j of journeysFor(bt)) {
    const hay = tokens(`${j.title} ${j.summary} ${j.turns[0]?.guest ?? ''} ${j.kind}`);
    let score = 0;
    for (const w of t) if (hay.has(w)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = j;
    }
  }
  return bestScore >= 1 ? best : null;
}

// Reveal the next turn of the active journey. Pure: returns a new state.
export function advance(state: DemoState): DemoState {
  const journey = state.journeyId ? getJourney(state.journeyId) : null;
  if (!journey) return state;
  if (state.turnIndex >= journey.turns.length) return { ...state, status: 'complete' };

  const turn: Turn = journey.turns[state.turnIndex];
  const n = state.turnIndex;
  const transcript: Bubble[] = [
    ...state.transcript,
    { from: 'guest', text: turn.guest, id: `${journey.id}-g${n}` },
    { from: 'luna', text: turn.luna, id: `${journey.id}-l${n}` },
  ];
  const ops = turn.ops ? [...state.ops, ...turn.ops] : state.ops;
  const turnIndex = n + 1;
  return {
    ...state,
    transcript,
    ops,
    turnIndex,
    status: turnIndex >= journey.turns.length ? 'complete' : 'playing',
  };
}

export function startJourney(state: DemoState, journeyId: string): DemoState {
  return advance({
    ...state,
    journeyId,
    turnIndex: 0,
    transcript: [],
    ops: [],
    status: 'playing',
  });
}

export function setBusinessType(bt: BusinessType): DemoState {
  return initialState(bt);
}

// The next guest suggestions to show, if any (from the last revealed turn).
export function currentSuggestions(state: DemoState): string[] {
  const journey = state.journeyId ? getJourney(state.journeyId) : null;
  if (!journey || state.turnIndex === 0) return [];
  const last = journey.turns[state.turnIndex - 1];
  return last?.suggestions ?? [];
}
