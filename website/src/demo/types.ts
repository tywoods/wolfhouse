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
export type OpsKind =
  | 'availability' // checked real availability
  | 'package' // selected a package / service / tier
  | 'detail' // collected a missing booking detail
  | 'quote' // prepared a quote
  | 'draft' // created a demo booking draft
  | 'inbox' // conversation surfaced to staff inbox
  | 'handoff'; // flagged for a human

export interface OpsEvent {
  kind: OpsKind;
  title: string; // "Availability checked"
  detail: string; // "3 beds free in a mixed dorm, 5–8 Jul"
}

// One conversational turn: the guest message and Luna's reply, plus whatever
// operational work that turn produced.
export interface Turn {
  guest: string; // guest WhatsApp message
  luna: string; // Luna's reply (pre-captured, human-reviewed)
  ops?: OpsEvent[]; // business-side events produced by this turn
  // Optional quick-reply chips offered to the visitor to send the next guest
  // message. If omitted, the visitor can still type freely.
  suggestions?: string[];
}

export interface Journey {
  id: string;
  businessType: BusinessType;
  // "Accommodation enquiry" | "Surf lesson enquiry" | "Human handoff"
  kind: 'accommodation' | 'service' | 'handoff';
  title: string;
  summary: string;
  // The first guest message is offered as the opener chip; the visitor can also
  // type their own and the engine will map it to this journey's first turn.
  turns: Turn[];
  // Closing payoff line shown when the journey completes.
  payoff: string;
}
