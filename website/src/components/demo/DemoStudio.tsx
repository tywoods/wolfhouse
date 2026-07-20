/** @jsxImportSource preact */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { BusinessType, OpsEvent } from '../../demo/types';
import { businesses, businessOrder } from '../../demo/journeys';
import { getJourney, journeysFor, nextScriptedGuest } from '../../demo/engine';
import './DemoStudio.css';

interface Bubble {
  from: 'guest' | 'luna';
  text: string;
  id: string;
}
type Phase = 'idle' | 'playing' | 'guestTyping' | 'lunaTyping' | 'complete';
type MobilePanel = 'chat' | 'ops';

const DEMO_TRUTH =
  'Interactive scripted demo — stays in this browser; no WhatsApp, live availability, booking, payment or staff write';

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

function useRovingTablist(selectedIndex: number, count: number, onSelect: (i: number) => void) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (count === 0) return;
    let next = selectedIndex;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      next = (selectedIndex + 1) % count;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      next = (selectedIndex - 1 + count) % count;
    } else if (e.key === 'Home') {
      e.preventDefault();
      next = 0;
    } else if (e.key === 'End') {
      e.preventDefault();
      next = count - 1;
    } else {
      return;
    }
    onSelect(next);
    refs.current[next]?.focus();
  };
  return { refs, onKeyDown };
}

export default function DemoStudio() {
  const [businessType, setBusinessType] = useState<BusinessType>('hostel');
  const [journeyId, setJourneyId] = useState<string | null>(null);
  const [turnIndex, setTurnIndex] = useState(0);
  const [transcript, setTranscript] = useState<Bubble[]>([]);
  const [ops, setOps] = useState<OpsEvent[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('chat');
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
    setMobilePanel('chat');
  }, []);

  const switchBusiness = useCallback((bt: BusinessType) => {
    setBusinessType((current) => {
      if (bt === current) return current;
      clearTimers();
      setJourneyId(null);
      setTurnIndex(0);
      setTranscript([]);
      setOps([]);
      setPhase('idle');
      setMobilePanel('chat');
      return bt;
    });
  }, []);

  const bizIndex = businessOrder.indexOf(businessType);
  const bizRoving = useRovingTablist(bizIndex, businessOrder.length, (i) => {
    switchBusiness(businessOrder[i]);
  });
  const panelIndex = mobilePanel === 'chat' ? 0 : 1;
  const panelRoving = useRovingTablist(panelIndex, 2, (i) => setMobilePanel(i === 0 ? 'chat' : 'ops'));

  // Stage simulated ops first, then Luna reply — truth ordering in the UI.
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

      if (turn.ops?.length) {
        for (let k = 0; k < turn.ops.length; k++) {
          await wait(reduced ? 0 : 220);
          setOps((o) => [...o, turn.ops![k]]);
        }
      }

      setTranscript((t) => [...t, { from: 'luna', text: turn.luna, id: `${jId}-l${idx}` }]);

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
    setMobilePanel('chat');
    void playTurn(jId, 0);
  };

  const sendNext = (guestText?: string) => {
    if (!activeJourney || phase === 'guestTyping' || phase === 'lunaTyping') return;
    if (turnIndex >= activeJourney.turns.length) return;
    void playTurn(activeJourney.id, turnIndex, guestText);
  };

  const continueScripted = () => {
    const next = nextScriptedGuest({
      businessType,
      journeyId,
      turnIndex,
      transcript: [],
      ops: [],
      status: phase === 'complete' ? 'complete' : journeyId ? 'playing' : 'idle',
    });
    if (next) sendNext(next);
  };

  const busy = phase === 'guestTyping' || phase === 'lunaTyping';
  const suggestions =
    activeJourney && turnIndex > 0 && turnIndex < activeJourney.turns.length && !busy
      ? activeJourney.turns[turnIndex - 1].suggestions ?? []
      : [];
  const canContinue =
    Boolean(activeJourney) && !busy && phase !== 'complete' && turnIndex < (activeJourney?.turns.length ?? 0);

  return (
    <div class="studio" aria-label="Interactive scripted Luna demo" data-testid="demo-studio">
      <p class="studio__truth" data-testid="demo-truth-label" role="note">
        {DEMO_TRUTH}
      </p>

      <div
        class="studio__biz"
        role="tablist"
        aria-label="Choose a business type"
        onKeyDown={bizRoving.onKeyDown}
      >
        {businessOrder.map((bt, i) => (
          <button
            key={bt}
            ref={(el) => {
              bizRoving.refs.current[i] = el;
            }}
            role="tab"
            id={`biz-tab-${bt}`}
            aria-selected={bt === businessType}
            tabIndex={bt === businessType ? 0 : -1}
            class={`studio__biz-tab${bt === businessType ? ' is-active' : ''}`}
            onClick={() => switchBusiness(bt)}
          >
            {businesses[bt].label}
          </button>
        ))}
      </div>

      <div
        class="studio__panels"
        role="tablist"
        aria-label="Demo panels"
        data-testid="demo-panel-tabs"
        onKeyDown={panelRoving.onKeyDown}
      >
        <button
          ref={(el) => {
            panelRoving.refs.current[0] = el;
          }}
          role="tab"
          id="demo-tab-chat"
          aria-controls="demo-panel-chat"
          aria-selected={mobilePanel === 'chat'}
          tabIndex={mobilePanel === 'chat' ? 0 : -1}
          class={`studio__panel-tab${mobilePanel === 'chat' ? ' is-active' : ''}`}
          onClick={() => setMobilePanel('chat')}
          data-testid="demo-tab-chat"
        >
          Chat
        </button>
        <button
          ref={(el) => {
            panelRoving.refs.current[1] = el;
          }}
          role="tab"
          id="demo-tab-ops"
          aria-controls="demo-panel-ops"
          aria-selected={mobilePanel === 'ops'}
          tabIndex={mobilePanel === 'ops' ? 0 : -1}
          class={`studio__panel-tab${mobilePanel === 'ops' ? ' is-active' : ''}`}
          onClick={() => setMobilePanel('ops')}
          data-testid="demo-tab-ops"
        >
          Operations
        </button>
      </div>

      <div class="studio__grid">
        <section
          id="demo-panel-chat"
          role="tabpanel"
          aria-labelledby="demo-tab-chat"
          class={`phone${mobilePanel === 'chat' ? ' is-panel-active' : ''}`}
          aria-label="Guest WhatsApp conversation (scripted demo)"
          data-testid="demo-chat-panel"
          hidden={false}
        >
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
              <p class="phone__hint">Pick a scenario below to start the scripted demo.</p>
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
            <div class="phone__chips" role="group" aria-label="Scripted reply choices">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  class="chip chip--reply"
                  onClick={() => sendNext(s)}
                  disabled={busy}
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          <div class="phone__compose">
            <button
              class="phone__send"
              type="button"
              aria-label="Continue with next scripted guest message"
              data-testid="demo-continue"
              disabled={!canContinue}
              onClick={continueScripted}
            >
              Continue
            </button>
          </div>
        </section>

        <section
          id="demo-panel-ops"
          role="tabpanel"
          aria-labelledby="demo-tab-ops"
          class={`ops${mobilePanel === 'ops' ? ' is-panel-active' : ''}`}
          aria-label="Simulated operations summary"
          data-testid="demo-ops-panel"
        >
          <header class="ops__head">
            <span class="eyebrow eyebrow--moon">Behind the scenes</span>
            <h3 class="ops__title">Simulated operations summary</h3>
            <p class="ops__sub">
              Each step is a simulated demo outcome from seeded fixtures — not a live write to availability, bookings, payments, or staff systems.
            </p>
          </header>

          <ol class="ops__list" data-testid="demo-ops-list">
            {ops.length === 0 && (
              <li class="ops__empty">Simulated operational steps will appear here as the scripted conversation moves.</li>
            )}
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

      <div class="studio__foot">
        <div class="studio__journeys" role="group" aria-label="Demo scenarios">
          {journeyList.map((j) => (
            <button
              key={j.id}
              type="button"
              class={`chip chip--journey${journeyId === j.id ? ' is-active' : ''}`}
              onClick={() => startJourney(j.id)}
              data-testid={`demo-scenario-${j.id}`}
            >
              {j.title}
            </button>
          ))}
        </div>
        <div class="studio__actions">
          <span class="studio__flag" data-testid="demo-truth-flag">{DEMO_TRUTH}</span>
          {(transcript.length > 0 || journeyId) && (
            <button
              type="button"
              class="btn btn--ghost-night studio__reset"
              onClick={reset}
              data-testid="demo-reset"
            >
              ↺ Reset
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
