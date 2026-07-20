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
];
