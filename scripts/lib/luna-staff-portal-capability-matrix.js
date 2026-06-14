'use strict';

/**
 * Maps Luna guest intents to staff-portal surfaces (booking drawer tabs).
 * Used by nightly tests and docs — single source for "what Luna must create vs staff UI".
 *
 * Staff portal tabs: Overview · Services · Transfers · Payments
 */

const STAFF_PORTAL_CAPABILITIES = Object.freeze([
  {
    id: 'booking_hold',
    staff_surface: 'Overview · calendar hold',
    luna_creates: 'bed hold when availability passes',
    guest_visible: 'quote with dates/guests',
    schedulable: false,
    test_scenarios: ['package_booking', 'short_stay_accommodation', 'greeting_booking_start'],
  },
  {
    id: 'package_malibu',
    staff_surface: 'Overview · package summary',
    luna_creates: 'package_interest=malibu on booking',
    includes: ['shared_room', 'shirt', 'airport_shuttle_santander'],
    guest_visible: 'Malibu line in package explainer',
    test_scenarios: ['package_booking', 'transfer_side_question'],
  },
  {
    id: 'package_uluwatu',
    staff_surface: 'Overview · package + Services (included gear)',
    luna_creates: 'package_interest=uluwatu',
    includes: ['surfboard_6_days', 'wetsuit_6_days'],
    guest_visible: 'Uluwatu explainer; gear not double-billed',
    test_scenarios: ['package_booking', 'package_surf_addons'],
  },
  {
    id: 'package_waimea',
    staff_surface: 'Overview · package + Services (gear + lessons)',
    luna_creates: 'package_interest=waimea',
    includes: ['surfboard_6_days', 'wetsuit_6_days', 'surf_lesson_each_day_6_days'],
    test_scenarios: ['package_booking', 'lesson_addon'],
  },
  {
    id: 'service_wetsuit',
    staff_surface: 'Services tab · booking_service_records',
    luna_creates: 'service_interest wetsuit → staff-visible record (short stay / Malibu)',
    schedulable: true,
    staff_action: 'PATCH service_date per stay night',
    test_scenarios: ['short_stay_surf_addons', 'lesson_addon'],
  },
  {
    id: 'service_surfboard',
    staff_surface: 'Services tab',
    luna_creates: 'surfboard / soft_top_rental record',
    schedulable: true,
    variants: ['soft board', 'hard board'],
    test_scenarios: ['short_stay_surf_addons'],
  },
  {
    id: 'service_surf_lesson',
    staff_surface: 'Services tab',
    luna_creates: 'surf_lesson record',
    schedulable: true,
    test_scenarios: ['lesson_addon'],
  },
  {
    id: 'service_yoga',
    staff_surface: 'Services tab · pending manual',
    luna_creates: 'yoga_request → needs_staff_confirmation',
    schedulable: true,
    test_scenarios: ['yoga_request'],
  },
  {
    id: 'service_meals',
    staff_surface: 'Services tab · pending manual',
    luna_creates: 'meals_request → staff schedules dates',
    schedulable: true,
    test_scenarios: ['dinner_meals_request'],
  },
  {
    id: 'transfer_santander',
    staff_surface: 'Transfers tab · booking_transfers',
    luna_creates: 'transfer_info with airport_code SDR (included in package)',
    schedulable: true,
    test_scenarios: ['transfer_side_question', 'flight_times_update'],
  },
  {
    id: 'transfer_bilbao',
    staff_surface: 'Transfers tab · extra charge',
    luna_creates: 'transfer_info BIO + staff prices supplement',
    guest_visible: 'Bilbao extra explained when 4+ on package',
    test_scenarios: ['bilbao_transfer_extra'],
  },
  {
    id: 'payment_deposit',
    staff_surface: 'Payments tab · Stripe checkout',
    luna_creates: 'payment draft + checkout URL',
    guest_visible: 'deposit or full link',
    test_scenarios: ['package_booking', 'cash_payment_side_question'],
  },
  {
    id: 'payment_confirmation',
    staff_surface: 'Payments + Overview',
    luna_creates: 'payment truth → confirmation WhatsApp',
    guest_visible: 'gate code after paid deposit (when auto-send on)',
    test_scenarios: ['cami-realism flows with deposit'],
  },
  {
    id: 'post_booking_services',
    staff_surface: 'Services tab after booked',
    luna_creates: 'add_service_request lane → new service rows',
    schedulable: true,
    test_scenarios: ['post_booking_add_service'],
  },
  {
    id: 'surf_report',
    staff_surface: 'read-only · surf API',
    luna_creates: 'general_question surf_report intent',
    does_not_reset_intake: true,
    test_scenarios: ['surf_report_side_question'],
  },
]);

const HAMMER_SCENARIO_TO_CAPABILITY = Object.freeze({
  greeting_new_guest: ['booking_hold'],
  greeting_booking_start: ['booking_hold'],
  package_booking: ['package_malibu', 'package_uluwatu', 'package_waimea', 'payment_deposit'],
  package_surf_addons: ['package_uluwatu', 'service_wetsuit', 'service_surfboard'],
  short_stay_surf_addons: ['service_wetsuit', 'service_surfboard'],
  lesson_addon: ['service_surf_lesson'],
  yoga_request: ['service_yoga'],
  dinner_meals_request: ['service_meals'],
  transfer_side_question: ['transfer_santander'],
  bilbao_transfer_extra: ['transfer_bilbao'],
  flight_times_update: ['transfer_santander'],
  surf_report_side_question: ['surf_report'],
  post_booking_add_service: ['post_booking_services'],
  cash_payment_side_question: ['payment_deposit'],
});

function capabilitiesForScenario(scenarioType) {
  const ids = HAMMER_SCENARIO_TO_CAPABILITY[scenarioType] || [];
  return STAFF_PORTAL_CAPABILITIES.filter((c) => ids.includes(c.id));
}

function allTestScenarioTypes() {
  const set = new Set();
  for (const c of STAFF_PORTAL_CAPABILITIES) {
    for (const s of c.test_scenarios || []) set.add(s);
  }
  return [...set].sort();
}

module.exports = {
  STAFF_PORTAL_CAPABILITIES,
  HAMMER_SCENARIO_TO_CAPABILITY,
  capabilitiesForScenario,
  allTestScenarioTypes,
};
