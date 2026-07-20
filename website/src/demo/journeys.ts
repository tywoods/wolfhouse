import type { BusinessProfile, BusinessType, Journey } from './types';

// Seeded demo businesses (clearly fictional demo data). Grounded in the two real
// working verticals — a surf hostel and a surf school — plus two adjacent
// verticals the same engine serves.
export const businesses: Record<BusinessType, BusinessProfile> = {
  hostel: {
    id: 'hostel',
    label: 'Hostel / guest house',
    demoName: 'Marea Surf Hostel · Somo',
    blurb: 'Beds, dorms and packages booked over WhatsApp between check-ins.',
  },
  surf_school: {
    id: 'surf_school',
    label: 'Surf school',
    demoName: 'Sunset Surf · Somo',
    blurb: 'Lessons and rentals booked while instructors are in the water.',
  },
  tours: {
    id: 'tours',
    label: 'Tours / activities',
    demoName: 'Cabo Verde Day Tours',
    blurb: 'Availability and group questions arriving at all hours.',
  },
  rentals: {
    id: 'rentals',
    label: 'Rentals',
    demoName: 'Bahía Board & Bike Rental',
    blurb: 'Gear, dates and deposits handled without the back-and-forth.',
  },
};

export const businessOrder: BusinessType[] = ['hostel', 'surf_school', 'tours', 'rentals'];

// NOTE: Luna replies here are pre-captured, human-reviewed copy that follows the
// guest-behaviour spec (one clear question per message, warm tone, no internal
// jargon, facts from the seeded business). They are illustrative demo content.
export const journeys: Journey[] = [
  {
    id: 'hostel-accommodation',
    businessType: 'hostel',
    kind: 'accommodation',
    title: 'A stay enquiry, start to finish',
    summary: 'Guest asks about a few nights next month in plain language.',
    payoff: 'A real conversation for the guest — a structured, ready-to-confirm booking for you.',
    turns: [
      {
        guest: 'Hey! Do you have space for 2 people next weekend?',
        luna:
          "Hi! 🌊 Yes — we've got room next weekend. Are you thinking Friday to Sunday (2 nights), or different dates?",
        ops: [
          { kind: 'inbox', title: 'New conversation', detail: 'WhatsApp enquiry surfaced in the staff inbox' },
          { kind: 'availability', title: 'Availability checked', detail: 'Fri–Sun · 2 guests · space in a mixed dorm and 1 private twin' },
        ],
        suggestions: ['Friday to Sunday works', 'Actually, can we do 3 nights?'],
      },
      {
        guest: 'Friday to Sunday works. What are the options?',
        luna:
          "Two ways to stay:\n\n• Mixed dorm bed — €26/night per person\n• Private twin room — €78/night\n\nBoth include breakfast and board storage. Would you like the dorm beds or the private twin?",
        ops: [
          { kind: 'package', title: 'Options prepared', detail: '2× dorm bed or 1× private twin, breakfast included' },
        ],
        suggestions: ['The private twin, please', 'Two dorm beds'],
      },
      {
        guest: 'The private twin, please.',
        luna:
          "Lovely choice. That's 2 nights in the private twin — €156 total, breakfast included. Can I get the name for the booking?",
        ops: [
          { kind: 'quote', title: 'Quote prepared', detail: 'Private twin · 2 nights · €156 total (breakfast incl.)' },
        ],
        suggestions: ['It’s Marco Ferrari'],
      },
      {
        guest: "It's Marco Ferrari.",
        luna:
          "Thanks Marco! I've set aside the private twin for Fri–Sun and put together your booking. I'll send a secure payment link to confirm — one moment while the team gives it a quick look. 🙌",
        ops: [
          { kind: 'detail', title: 'Detail collected', detail: 'Lead guest: Marco Ferrari' },
          { kind: 'draft', title: 'Booking draft created', detail: 'Marco Ferrari · Private twin · Fri–Sun · €156 · awaiting payment' },
        ],
      },
    ],
  },
  {
    id: 'surf-school-lesson',
    businessType: 'surf_school',
    kind: 'service',
    title: 'A surf lesson enquiry',
    summary: 'Guest asks about beginner lessons for the family this week.',
    payoff: 'The guest gets clear options; your schedule gets a structured lesson request.',
    turns: [
      {
        guest: 'Hi, do you do surf lessons for beginners? We are 2 adults and a 10 year old',
        luna:
          "Hi! Yes — beginners are our favourite. 🏄 We run group lessons at 10:00 and 12:30, and your 10-year-old is very welcome. Which day were you thinking?",
        ops: [
          { kind: 'inbox', title: 'New conversation', detail: 'Lesson enquiry · 2 adults + 1 child (10)' },
          { kind: 'availability', title: 'Availability checked', detail: 'Group lessons 10:00 & 12:30 have space this week' },
        ],
        suggestions: ['Thursday if possible', 'What does it cost?'],
      },
      {
        guest: 'Thursday if possible. What does it include?',
        luna:
          "Thursday it is. A group lesson is 2 hours with a certified instructor, and includes the board and wetsuit — €40 per person, €30 for under-12s. Shall I pencil in the three of you for 10:00 or 12:30?",
        ops: [
          { kind: 'package', title: 'Service explained', detail: '2-hr group lesson · board + wetsuit included' },
          { kind: 'quote', title: 'Quote prepared', detail: '2 × €40 + 1 × €30 (child) = €110' },
        ],
        suggestions: ['10:00 please', '12:30 is better'],
      },
      {
        guest: '10:00 please',
        luna:
          "Perfect — three spots held for Thursday at 10:00. Could I get a name and a good number so the instructor can reach you on the day?",
        ops: [
          { kind: 'detail', title: 'Slot selected', detail: 'Thu 10:00 · 3 spots held (2 adult, 1 child)' },
        ],
        suggestions: ['Sophie, and this number is fine'],
      },
      {
        guest: 'Sophie, and this number is fine 🙂',
        luna:
          "Thanks Sophie! You're down for Thursday 10:00 — I'll send a payment link to lock it in and pop it into the schedule for the team. See you in the water! 🌞",
        ops: [
          { kind: 'detail', title: 'Detail collected', detail: 'Contact: Sophie · WhatsApp number on file' },
          { kind: 'draft', title: 'Lesson request created', detail: 'Sophie · Thu 10:00 · 3 spots · €110 · in the schedule' },
        ],
      },
    ],
  },
  {
    id: 'hostel-handoff',
    businessType: 'hostel',
    kind: 'handoff',
    title: 'When a human is needed',
    summary: 'Guest raises something only a person should handle.',
    payoff: 'Luna knows her limits — and hands your team a clear, ready-to-action summary.',
    turns: [
      {
        guest:
          "Hi, we stayed last week and I think we were double-charged on our card. Can someone check?",
        luna:
          "I'm sorry about that — a billing issue is something our team should look at directly, so I'm bringing a person in now. Could you share the name the booking was under so they can pull it up straight away?",
        ops: [
          { kind: 'inbox', title: 'New conversation', detail: 'Returning guest · payment concern' },
          { kind: 'handoff', title: 'Handed to the team', detail: 'Reason: billing dispute — needs a human · marked urgent' },
        ],
        suggestions: ['It was under Delgado'],
      },
      {
        guest: 'It was under Delgado.',
        luna:
          "Thank you — I've passed everything to the team with the name Delgado and flagged it as a possible double charge. Someone will be with you shortly. 🙏",
        ops: [
          { kind: 'detail', title: 'Context attached', detail: 'Booking name: Delgado · added to the handoff note' },
        ],
      },
    ],
  },

  // ── Surf school extra: equipment rental enquiry ──────────────────────────
  {
    id: 'surf-school-rental',
    businessType: 'surf_school',
    kind: 'service',
    title: 'Board & wetsuit rental',
    summary: 'Guest wants to rent gear for a few days without booking a lesson.',
    payoff: 'Gear is reserved and the guest knows exactly what to bring — no phone tag.',
    turns: [
      {
        guest: 'Hi! Can I rent a board and wetsuit for a couple of days without taking a lesson?',
        luna:
          "Hi! Absolutely — rental only is no problem. 🏄 We have shortboards, funboards and longboards; wetsuits in all sizes. How many days were you thinking, and roughly what dates?",
        ops: [
          { kind: 'inbox', title: 'New conversation', detail: 'Gear rental enquiry · no lesson required' },
          { kind: 'availability', title: 'Availability checked', detail: 'Rental boards & wetsuits available this week' },
        ],
        suggestions: ['2 days, starting tomorrow', 'This Saturday and Sunday'],
      },
      {
        guest: 'This Saturday and Sunday.',
        luna:
          "Great timing — Saturday and Sunday are clear. Board + wetsuit for 2 days is €45. Do you know roughly what size board suits you, or would you like the team to help pick one on the day?",
        ops: [
          { kind: 'package', title: 'Rental option selected', detail: 'Board + wetsuit · 2 days (Sat–Sun) · €45' },
          { kind: 'quote', title: 'Quote prepared', detail: 'Board + wetsuit × 2 days = €45' },
        ],
        suggestions: ['I usually ride a longboard', 'Happy to choose on the day'],
      },
      {
        guest: 'I usually ride a longboard.',
        luna:
          "Perfect — I'll hold a longboard and wetsuit for you for Saturday and Sunday. Could I get your name so we can tag the kit?",
        ops: [
          { kind: 'detail', title: 'Preference noted', detail: 'Board type: longboard' },
        ],
        suggestions: ['Yep, it\'s Tomás'],
      },
      {
        guest: "Yep, it's Tomás.",
        luna:
          "Done, Tomás! Longboard + wetsuit reserved for Saturday–Sunday. Pop in from 9:00 to pick up and the team will have it ready for you. See you at the beach! 🌊",
        ops: [
          { kind: 'detail', title: 'Detail collected', detail: 'Guest name: Tomás' },
          { kind: 'draft', title: 'Rental reservation created', detail: 'Tomás · longboard + wetsuit · Sat–Sun · €45' },
        ],
      },
    ],
  },

  // ── Surf school: handoff — medical / allergy concern ────────────────────────
  {
    id: 'surf-school-handoff',
    businessType: 'surf_school',
    kind: 'handoff',
    title: 'Medical or special-needs enquiry',
    summary: 'Guest raises a health or allergy concern that needs an instructor to respond.',
    payoff: 'Sensitive queries go to a qualified person — with context already attached.',
    turns: [
      {
        guest: "Hi, my son has epilepsy — is he still able to take a beginner lesson? I want to make sure it's safe.",
        luna:
          "Thank you for letting us know — that's really important and we take it seriously. This is something one of our instructors should speak to you about directly so they can give you the right advice. I'm flagging it for them now. What's the best way for them to reach you?",
        ops: [
          { kind: 'inbox', title: 'New conversation', detail: 'Parent enquiry · medical — epilepsy · safety check needed' },
          { kind: 'handoff', title: 'Handed to the team', detail: 'Reason: medical question — certified instructor review required' },
        ],
        suggestions: ['This WhatsApp is best', 'A call is easier'],
      },
      {
        guest: 'This WhatsApp is best.',
        luna:
          "Got it — an instructor will message you here within a few hours to talk it through properly. We really appreciate you reaching out first. 🙏",
        ops: [
          { kind: 'detail', title: 'Contact preference noted', detail: 'WhatsApp · instructor will follow up directly' },
        ],
      },
    ],
  },

  // ── Tours: day-tour enquiry ───────────────────────────────────────────────
  {
    id: 'tours-day-tour',
    businessType: 'tours',
    kind: 'service',
    title: 'Day tour for a group',
    summary: 'Guest asks about availability for a group day tour and a specific date.',
    payoff: 'Group size, date and contact confirmed in a single chat — no spreadsheet needed.',
    turns: [
      {
        guest: 'Hi! Do you run day tours to the volcanic crater? We are a group of 6.',
        luna:
          "Hi! 🌋 Yes — the Crater Ridge day tour is our most popular. It runs Tuesday, Thursday and Saturday, guided in English and Spanish, with lunch included. Which date were you thinking?",
        ops: [
          { kind: 'inbox', title: 'New conversation', detail: 'Group enquiry · 6 guests · Crater Ridge tour' },
          { kind: 'availability', title: 'Availability checked', detail: 'Crater Ridge tour runs Tue / Thu / Sat — next 3 dates available' },
        ],
        suggestions: ['This Saturday', 'Next Thursday'],
      },
      {
        guest: 'This Saturday — is there space for all 6 of us?',
        luna:
          "Yes, Saturday has room for your whole group! 🎉 The tour is €55 per person, so €330 for six — that covers transport, guide and a set lunch at a local restaurant. Shall I hold 6 spots for you?",
        ops: [
          { kind: 'availability', title: 'Group availability confirmed', detail: 'Saturday · 6 spots free on Crater Ridge tour' },
          { kind: 'quote', title: 'Quote prepared', detail: '6 × €55 = €330 (transport + guide + lunch incl.)' },
        ],
        suggestions: ['Yes please, hold 6 spots', 'What time does it start?'],
      },
      {
        guest: 'Yes please! What time does it start?',
        luna:
          "The tour leaves the meeting point at 08:30 and returns around 17:30. I'll hold those 6 spots now. Could I get the lead name for the booking?",
        ops: [
          { kind: 'detail', title: 'Tour details shared', detail: 'Departure 08:30 · return ~17:30 · meeting point details sent on confirmation' },
          { kind: 'package', title: 'Tour confirmed', detail: 'Crater Ridge · Saturday · 6 guests' },
        ],
        suggestions: ['It\'s under Nguyen'],
      },
      {
        guest: "It's under Nguyen.",
        luna:
          "Wonderful — 6 spots reserved for the Nguyen group, Saturday Crater Ridge tour. I'll send a payment link to confirm the booking. You'll get meeting-point details once that's through. Have an amazing day! 🌄",
        ops: [
          { kind: 'detail', title: 'Detail collected', detail: 'Lead guest: Nguyen' },
          { kind: 'draft', title: 'Booking draft created', detail: 'Nguyen × 6 · Saturday · Crater Ridge · €330 · awaiting payment' },
        ],
      },
    ],
  },

  // ── Tours: handoff — large/special-needs group ────────────────────────────
  {
    id: 'tours-handoff',
    businessType: 'tours',
    kind: 'handoff',
    title: 'Large or special-access group',
    summary: 'A request involving mobility needs or a very large group that requires personal attention.',
    payoff: 'Complex requests reach the right person with full context — no detail dropped.',
    turns: [
      {
        guest: "Hi, we have a group of 18 and two members use wheelchairs. Can you accommodate us?",
        luna:
          "Thanks for reaching out, and for giving us that heads-up about accessibility — it means a lot. A group of 18 with specific access needs is something our team needs to plan carefully, so I'm going to bring one of our guides in directly. Could I get the best number or email to reach you?",
        ops: [
          { kind: 'inbox', title: 'New conversation', detail: 'Large group · 18 guests · 2 wheelchair users' },
          { kind: 'handoff', title: 'Handed to the team', detail: 'Reason: accessibility + large group — specialist guide required' },
        ],
        suggestions: ['This number is best', 'Email is easier — give me a sec'],
      },
      {
        guest: 'This number is best.',
        luna:
          "Perfect — I've passed your number to the team along with the group size and accessibility details. A guide will be in touch within a few hours to talk through options and make sure everything works for everyone. 🙏",
        ops: [
          { kind: 'detail', title: 'Contact preference noted', detail: 'WhatsApp number · guide will follow up directly' },
        ],
      },
    ],
  },

  // ── Rentals: gear rental enquiry ─────────────────────────────────────────
  {
    id: 'rentals-gear',
    businessType: 'rentals',
    kind: 'service',
    title: 'Board & bike rental enquiry',
    summary: 'Guest asks to rent a board and a bike for a multi-day stay.',
    payoff: 'Dates, kit and deposit confirmed without a single phone call.',
    turns: [
      {
        guest: "Hello! I'd like to rent a surfboard and a bike for 3 days. Do you have availability?",
        luna:
          "Hi! Yes — we have boards and bikes free across most of this week. 🚲🏄 Which three days were you planning, so I can check the full availability?",
        ops: [
          { kind: 'inbox', title: 'New conversation', detail: 'Rental enquiry · surfboard + bike · 3 days' },
          { kind: 'availability', title: 'Availability checked', detail: 'Boards and bikes available — exact dates needed to confirm' },
        ],
        suggestions: ['Tuesday, Wednesday and Thursday', 'Friday to Sunday'],
      },
      {
        guest: 'Tuesday, Wednesday and Thursday.',
        luna:
          "All clear for Tuesday–Thursday. Here's what that looks like:\n\n• Surfboard (your choice of size) — €15/day → €45\n• City bike — €10/day → €30\n• Total — €75 for 3 days\n\nA €20 refundable deposit is held against the gear, returned when everything comes back undamaged. Does that work for you?",
        ops: [
          { kind: 'availability', title: 'Dates confirmed', detail: 'Tue–Thu · surfboard + city bike both free' },
          { kind: 'package', title: 'Rental package prepared', detail: 'Surfboard €45 + bike €30 = €75 · €20 refundable deposit' },
          { kind: 'quote', title: 'Quote prepared', detail: '3-day bundle · surfboard + bike · €75 total + €20 deposit' },
        ],
        suggestions: ['Sounds good, let\'s do it', 'What size boards do you have?'],
      },
      {
        guest: "What size boards do you have?",
        luna:
          "We stock 7'0\" funboards, 8'0\" mini-mals and 9'0\" longboards — all with fins included. Which size suits you best?",
        ops: [
          { kind: 'detail', title: 'Board options shared', detail: '7\'0" funboard · 8\'0" mini-mal · 9\'0" longboard' },
        ],
        suggestions: ['The 8\'0" mini-mal please', 'The 9\'0" longboard'],
      },
      {
        guest: "The 8'0\" mini-mal please.",
        luna:
          "Perfect choice. Could I get a name for the reservation so we can tag the board and bike for you?",
        ops: [
          { kind: 'detail', title: 'Board selected', detail: '8\'0" mini-mal confirmed' },
        ],
        suggestions: ['It\'s Lena Schmidt'],
      },
      {
        guest: "It's Lena Schmidt.",
        luna:
          "All set, Lena! I've reserved the 8'0\" mini-mal and a city bike for Tuesday–Thursday. The team will confirm by sending a payment link for €75 plus the €20 deposit. See you Tuesday! 🤙",
        ops: [
          { kind: 'detail', title: 'Detail collected', detail: 'Guest: Lena Schmidt' },
          { kind: 'draft', title: 'Rental draft created', detail: 'Lena Schmidt · 8\'0" board + bike · Tue–Thu · €75 + €20 deposit' },
        ],
      },
    ],
  },

  // ── Rentals: handoff — damage / refund claim ──────────────────────────────
  {
    id: 'rentals-handoff',
    businessType: 'rentals',
    kind: 'handoff',
    title: 'Damage or refund dispute',
    summary: 'Returning renter disputes a damage charge or asks for a deposit refund.',
    payoff: 'Sensitive money matters go straight to the owner — with the full rental context attached.',
    turns: [
      {
        guest: "Hi, I returned the bike yesterday and you've kept my deposit. I didn't damage anything — can someone check?",
        luna:
          "I'm sorry for the confusion — deposit questions are something our team needs to look at directly so they can review the check-in and check-out notes. I'm flagging this for them now. Could you share the name the rental was under?",
        ops: [
          { kind: 'inbox', title: 'New conversation', detail: 'Returning renter · deposit refund dispute' },
          { kind: 'handoff', title: 'Handed to the team', detail: 'Reason: deposit dispute — owner review required · marked urgent' },
        ],
        suggestions: ['It was under Eriksen'],
      },
      {
        guest: 'It was under Eriksen.',
        luna:
          "Thank you — I've passed this to the team with the name Eriksen and flagged it as a deposit query. Someone will come back to you shortly to sort it out. 🙏",
        ops: [
          { kind: 'detail', title: 'Context attached', detail: 'Rental name: Eriksen · deposit dispute added to handoff note' },
        ],
      },
    ],
  },
];
