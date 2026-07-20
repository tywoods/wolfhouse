// Pure, deterministic demo state machine. No framework imports, no I/O — so it
// is trivially unit-testable and can never produce a side effect.
// Scripted only: journeys advance via scenario/reply chips. No free-text matching.

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

/** Scripted next guest line for Continue — never free-text. */
export function nextScriptedGuest(state: DemoState): string | null {
  const journey = state.journeyId ? getJourney(state.journeyId) : null;
  if (!journey || state.turnIndex >= journey.turns.length) return null;
  return journey.turns[state.turnIndex]?.guest ?? null;
}
