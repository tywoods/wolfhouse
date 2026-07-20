// Deterministic, side-effect-free demo model.
//
// SAFETY: nothing here touches the network, a database, WhatsApp, or Stripe.
// Every "fact" a visitor sees is seeded content in journeys.ts. The engine only
// advances through pre-authored steps. This is the public-safe replacement for
// the live open-demo pipeline (which requires DB/WhatsApp/Stripe and is gated to
// non-production only).

export type BusinessType = 'hostel' | 'surf_school' | 'tours' | 'rentals';

export interface BusinessProfile {
  id: BusinessType;
  label: string; // "Surf school"
  demoName: string; // seeded business name shown in the ops panel
  blurb: string; // one line describing the vertical's pain
}

// A single operational event shown on the staff/business side, in plain
// owner-friendly language. Never expose prompts, tool names, SQL, or internals.
// Every event is a simulated demo outcome — never a real write.
export type OpsKind =
  | 'availability' // simulated availability check
  | 'package' // simulated package / service / tier selection
  | 'detail' // simulated detail collection
  | 'quote' // simulated quote
  | 'draft' // simulated staff-ready booking draft
  | 'inbox' // simulated inbox surface
  | 'handoff'; // simulated handoff flag

export interface OpsEvent {
  kind: OpsKind;
  title: string; // must read as a simulated demo outcome
  detail: string;
}

// One conversational turn: the guest message and Luna's reply, plus whatever
// operational work that turn produced.
export interface Turn {
  guest: string; // guest WhatsApp message
  luna: string; // Luna's reply (pre-captured, human-reviewed)
  ops?: OpsEvent[]; // business-side events produced by this turn
  // Scripted quick-reply chips offered to advance. Demo is chip-guided only —
  // there is no free-text composer or unsupported-input fallback.
  suggestions?: string[];
}

export interface Journey {
  id: string;
  businessType: BusinessType;
  // "Accommodation enquiry" | "Surf lesson enquiry" | "Human handoff"
  kind: 'accommodation' | 'service' | 'handoff';
  title: string;
  summary: string;
  // Scenario chips start a journey; reply chips advance it. No free-text path.
  turns: Turn[];
  // Closing payoff line shown when the journey completes.
  payoff: string;
}
