/** @jsxImportSource preact */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { BusinessType, OpsEvent } from '../../demo/types';
import { businesses, businessOrder } from '../../demo/journeys';
import { getJourney, journeysFor, matchJourneyByText } from '../../demo/engine';
import './DemoStudio.css';

interface Bubble {
  from: 'guest' | 'luna';
  text: string;
  id: string;
}
type Phase = 'idle' | 'playing' | 'guestTyping' | 'lunaTyping' | 'complete';

const OPS_META: Record<OpsEvent['kind'], { icon: string; tone: string }> = {
  availability: { icon: '◷', tone: 'sea' },
  package: { icon: '❏', tone: 'sea' },
  detail: { icon: '✎', tone: 'ink' },
  quote: { icon: '€', tone: 'sun' },
  draft: { icon: '✓', tone: 'sea' },
  inbox: { icon: '✉', tone: 'ink' },
  handoff: { icon: '☎', tone: 'sun' },
};

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(m.matches);
    const on = () => setReduced(m.matches);
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

export default function DemoStudio() {
  const [businessType, setBusinessType] = useState<BusinessType>('hostel');
  const [journeyId, setJourneyId] = useState<string | null>(null);
  const [turnIndex, setTurnIndex] = useState(0);
  const [transcript, setTranscript] = useState<Bubble[]>([]);
  const [ops, setOps] = useState<OpsEvent[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [input, setInput] = useState('');
  const reduced = usePrefersReducedMotion();

  const threadRef = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  const clearTimers = () => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current = [];
  };
  useEffect(() => () => clearTimers(), []);

  const wait = (ms: number) =>
    new Promise<void>((res) => {
      const t = window.setTimeout(res, reduced ? 0 : ms);
      timers.current.push(t);
    });

  const business = businesses[businessType];
  const journeyList = useMemo(() => journeysFor(businessType), [businessType]);
  const activeJourney = journeyId ? getJourney(journeyId) : null;

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [transcript, phase]);

  const reset = useCallback(() => {
    clearTimers();
    setJourneyId(null);
    setTurnIndex(0);
    setTranscript([]);
    setOps([]);
    setPhase('idle');
    setInput('');
  }, []);

  const switchBusiness = (bt: BusinessType) => {
    if (bt === businessType) return;
    clearTimers();
    setBusinessType(bt);
    setJourneyId(null);
    setTurnIndex(0);
    setTranscript([]);
    setOps([]);
    setPhase('idle');
  };

  // Play one turn: guest bubble → Luna typing → Luna reply + staged ops.
  const playTurn = useCallback(
    async (jId: string, idx: number, guestOverride?: string) => {
      const journey = getJourney(jId);
      if (!journey || idx >= journey.turns.length) return;
      const turn = journey.turns[idx];

      setPhase('guestTyping');
      await wait(360);
      setTranscript((t) => [
        ...t,
        { from: 'guest', text: guestOverride?.trim() || turn.guest, id: `${jId}-g${idx}` },
      ]);

      setPhase('lunaTyping');
      const thinking = Math.min(1500, 500 + turn.luna.length * 12);
      await wait(thinking);

      setTranscript((t) => [...t, { from: 'luna', text: turn.luna, id: `${jId}-l${idx}` }]);

      // Stage the operational events in one after another for a "work happening" feel.
      if (turn.ops?.length) {
        for (let k = 0; k < turn.ops.length; k++) {
          await wait(300);
          setOps((o) => [...o, turn.ops![k]]);
        }
      }

      const nextIdx = idx + 1;
      setTurnIndex(nextIdx);
      setPhase(nextIdx >= journey.turns.length ? 'complete' : 'playing');
    },
    [reduced],
  );

  const startJourney = (jId: string) => {
    clearTimers();
    setJourneyId(jId);
    setTurnIndex(0);
    setTranscript([]);
    setOps([]);
    void playTurn(jId, 0);
  };

  const sendNext = (guestText?: string) => {
    if (!activeJourney || phase === 'guestTyping' || phase === 'lunaTyping') return;
    if (turnIndex >= activeJourney.turns.length) return;
    void playTurn(activeJourney.id, turnIndex, guestText);
    setInput('');
  };

  const onSubmit = (e: Event) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    if (!activeJourney) {
      // Free-text opener → match to a journey, else fall back to first journey.
      const matched = matchJourneyByText(text, businessType) ?? journeyList[0];
      if (matched) {
        clearTimers();
        setJourneyId(matched.id);
        setTurnIndex(0);
        setTranscript([]);
        setOps([]);
        void playTurn(matched.id, 0, text);
        setInput('');
      }
      return;
    }
    sendNext(text);
  };

  const busy = phase === 'guestTyping' || phase === 'lunaTyping';
  const suggestions =
    activeJourney && turnIndex > 0 && turnIndex < activeJourney.turns.length && !busy
      ? activeJourney.turns[turnIndex - 1].suggestions ?? []
      : [];

  return (
    <div class="studio" aria-label="Interactive Luna demo">
      {/* Business-type switcher */}
      <div class="studio__biz" role="tablist" aria-label="Choose a business type">
        {businessOrder.map((bt) => (
          <button
            key={bt}
            role="tab"
            aria-selected={bt === businessType}
            class={`studio__biz-tab${bt === businessType ? ' is-active' : ''}`}
            onClick={() => switchBusiness(bt)}
          >
            {businesses[bt].label}
          </button>
        ))}
      </div>

      <div class="studio__grid">
        {/* LEFT — guest WhatsApp */}
        <section class="phone" aria-label="Guest WhatsApp conversation">
          <header class="phone__bar">
            <span class="phone__avatar" aria-hidden="true">L</span>
            <div class="phone__id">
              <strong>Luna</strong>
              <span>{business.demoName}</span>
            </div>
            <span class="phone__wa" aria-hidden="true">WhatsApp</span>
          </header>

          <div class="phone__thread" ref={threadRef} role="log" aria-live="polite">
            {transcript.length === 0 && phase === 'idle' && (
              <p class="phone__hint">Pick a scenario below, or type a guest message to start.</p>
            )}
            {transcript.map((b) => (
              <div key={b.id} class={`bubble bubble--${b.from}`}>
                {b.text.split('\n').map((line, i) => (
                  <span key={i} class="bubble__line">{line}</span>
                ))}
              </div>
            ))}
            {phase === 'lunaTyping' && (
              <div class="bubble bubble--luna bubble--typing" aria-label="Luna is typing">
                <span></span><span></span><span></span>
              </div>
            )}
          </div>

          {suggestions.length > 0 && (
            <div class="phone__chips">
              {suggestions.map((s) => (
                <button key={s} class="chip chip--reply" onClick={() => sendNext(s)}>{s}</button>
              ))}
            </div>
          )}

          <form class="phone__compose" onSubmit={onSubmit}>
            <label class="sr-only" for="demo-input">Type a guest message</label>
            <input
              id="demo-input"
              class="phone__input"
              value={input}
              placeholder={activeJourney ? 'Reply as the guest…' : 'e.g. Do you have space this weekend?'}
              onInput={(e) => setInput((e.target as HTMLInputElement).value)}
              disabled={phase === 'complete'}
            />
            <button class="phone__send" type="submit" aria-label="Send" disabled={busy || phase === 'complete'}>➤</button>
          </form>
        </section>

        {/* RIGHT — business operations */}
        <section class="ops" aria-label="What Luna did for the business">
          <header class="ops__head">
            <span class="eyebrow eyebrow--moon">Behind the scenes</span>
            <h3 class="ops__title">Your staff view</h3>
            <p class="ops__sub">Plain-language of what Luna checked and prepared — no guessing, from your real business rules.</p>
          </header>

          <ol class="ops__list">
            {ops.length === 0 && <li class="ops__empty">Operational steps will appear here as the conversation moves.</li>}
            {ops.map((e, i) => {
              const meta = OPS_META[e.kind];
              return (
                <li key={i} class={`ops__item ops__item--${meta.tone}`}>
                  <span class="ops__icon" aria-hidden="true">{meta.icon}</span>
                  <div>
                    <strong>{e.title}</strong>
                    <span>{e.detail}</span>
                  </div>
                </li>
              );
            })}
          </ol>

          {phase === 'complete' && activeJourney && (
            <div class="ops__payoff">
              <p>{activeJourney.payoff}</p>
              <a class="btn btn--on-night" href="#lead">Show me Luna for my business</a>
            </div>
          )}
        </section>
      </div>

      {/* Scenario picker / controls */}
      <div class="studio__foot">
        <div class="studio__journeys" role="group" aria-label="Demo scenarios">
          {journeyList.map((j) => (
            <button
              key={j.id}
              class={`chip chip--journey${journeyId === j.id ? ' is-active' : ''}`}
              onClick={() => startJourney(j.id)}
            >
              {j.title}
            </button>
          ))}
        </div>
        <div class="studio__actions">
          <span class="studio__flag">Demo data</span>
          {(transcript.length > 0 || journeyId) && (
            <button class="btn btn--ghost-night studio__reset" onClick={reset}>↺ Reset</button>
          )}
        </div>
      </div>
    </div>
  );
}
