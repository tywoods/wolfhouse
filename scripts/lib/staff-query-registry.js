/**
 * Stage 6.1 — Staff query registry.
 *
 * Maps stable intent keys to the Stage 5 query helper functions.
 * This is the ONLY place that wires natural-language intents to SQL helpers.
 *
 * Design rules:
 *   - No arbitrary SQL. All SQL lives in the helper modules imported below.
 *   - Every entry is readOnly: true. Write helpers are NOT in this registry.
 *   - Every entry is clientSlugged: true — $1 is always the client slug.
 *   - Intents are organised as <category>.<intent> for stable namespacing.
 *   - requiredParams lists $2+ positional params the runner must supply.
 *   - optionalParams lists params with defaults that the runner may supply.
 *   - migrationRequired notes which migration must be applied before runtime use.
 *     This is informational only — the registry itself never connects to a DB.
 *
 * Categories (35 total intents):
 *   holds     — active/expired holds and payment-pending bookings (4)
 *   payments  — payment status and confirmation (7)
 *   rooming   — bed/room assignment state (6)
 *   addons    — service add-ons: lessons, yoga, rentals, meals, transfers (9)
 *   handoffs  — staff handoff queue (9)
 *
 * Stage 6.1 is static-only. No DB, no HTTP, no n8n, no runtime.
 * Stage 6.2 (CLI runner) wires the registry to a live PG connection.
 *
 * @module staff-query-registry
 */

'use strict';

const holdQueries    = require('./staff-booking-hold-queries');
const paymentQueries = require('./staff-payment-queries');
const roomingQueries = require('./staff-rooming-queries');
const addonQueries   = require('./staff-addon-queries');
const handoffQueries = require('./staff-handoff-queries');
const askLunaLessons   = require('./staff-ask-luna-lessons');
const askLunaGear      = require('./staff-ask-luna-gear');
const askLunaMealsYoga = require('./staff-ask-luna-meals-yoga');
const askLunaPendingManual = require('./staff-ask-luna-pending-manual-services');
const askLunaArrivalsCheckouts = require('./staff-ask-luna-arrivals-checkouts');
const askLunaCleaning = require('./staff-ask-luna-cleaning');
const askLunaBookingLookup = require('./staff-ask-luna-booking-lookup');
const askLunaOccupancy = require('./staff-ask-luna-occupancy');
const askLunaFreeBeds = require('./staff-ask-luna-free-beds');

// ─────────────────────────────────────────────────────────────────────────────
// Param descriptor shape (for documentation + CLI validation)
// { name: string, description: string, example: string }
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The canonical registry of staff question intents.
 * Each entry is a frozen object describing one queryable intent.
 *
 * Fields:
 *   key              — stable dot-namespaced intent key
 *   category         — top-level grouping
 *   description      — human-readable staff question
 *   helperModule     — relative path to the query helper module (from scripts/)
 *   helperFn         — exported function name in that module
 *   helperRef        — direct function reference (resolved at registry build time)
 *   requiredParams   — array of { name, description, example } for $2+ positional params
 *   optionalParams   — array of { name, description, example, default }
 *   clientSlugged    — true: $1 is always the client slug (bound by runner)
 *   readOnly         — true: SELECT only, no mutations
 *   migrationRequired — null | 'migration_007' | 'migration_008'
 *   missingHelper    — true if the helper function could not be resolved at load time
 */
const REGISTRY = [

  // ── Holds ─────────────────────────────────────────────────────────────────

  {
    key:             'holds.active',
    category:        'holds',
    description:     'Which bookings currently have an active hold?',
    helperModule:    'lib/staff-booking-hold-queries',
    helperFn:        'getActiveHoldsQuery',
    helperRef:       holdQueries.getActiveHoldsQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: null,
  },
  {
    key:             'holds.expired',
    category:        'holds',
    description:     'Which holds have expired or been stuck without a booking?',
    helperModule:    'lib/staff-booking-hold-queries',
    helperFn:        'getExpiredHoldsQuery',
    helperRef:       holdQueries.getExpiredHoldsQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: null,
  },
  {
    key:             'holds.payment_pending',
    category:        'holds',
    description:     'Which bookings are in payment_pending status (awaiting payment)?',
    helperModule:    'lib/staff-booking-hold-queries',
    helperFn:        'getPaymentPendingQuery',
    helperRef:       holdQueries.getPaymentPendingQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: null,
  },
  {
    key:             'holds.no_payment',
    category:        'holds',
    description:     'Which payment_pending bookings have no payment record at all?',
    helperModule:    'lib/staff-booking-hold-queries',
    helperFn:        'getNoPaymentRecordQuery',
    helperRef:       holdQueries.getNoPaymentRecordQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: null,
  },

  // ── Payments ──────────────────────────────────────────────────────────────

  {
    key:             'payments.waiting',
    category:        'payments',
    description:     'Who is waiting for payment / has a payment link pending?',
    helperModule:    'lib/staff-payment-queries',
    helperFn:        'getWaitingPaymentQuery',
    helperRef:       paymentQueries.getWaitingPaymentQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: null,
  },
  {
    key:             'payments.deposit',
    category:        'payments',
    description:     'Who paid deposit but not the full balance yet?',
    helperModule:    'lib/staff-payment-queries',
    helperFn:        'getDepositPaidQuery',
    helperRef:       paymentQueries.getDepositPaidQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: null,
  },
  {
    key:             'payments.fully_paid',
    category:        'payments',
    description:     'Who paid in full?',
    helperModule:    'lib/staff-payment-queries',
    helperFn:        'getFullyPaidQuery',
    helperRef:       paymentQueries.getFullyPaidQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: null,
  },
  {
    key:             'payments.balance_due',
    category:        'payments',
    description:     'Who still owes a remaining balance?',
    helperModule:    'lib/staff-payment-queries',
    helperFn:        'getBalanceDueQuery',
    helperRef:       paymentQueries.getBalanceDueQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: null,
  },
  {
    key:             'payments.no_record',
    category:        'payments',
    description:     'Who has no payment record (payment_pending with no payments row)?',
    helperModule:    'lib/staff-payment-queries',
    helperFn:        'getNoPaymentRecordQuery',
    helperRef:       paymentQueries.getNoPaymentRecordQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: null,
  },
  {
    key:             'payments.confirmation_needed',
    category:        'payments',
    description:     'Who is paid/deposit_paid but has not yet received a confirmation?',
    helperModule:    'lib/staff-payment-queries',
    helperFn:        'getConfirmationNeededQuery',
    helperRef:       paymentQueries.getConfirmationNeededQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: null,
  },
  {
    key:             'payments.payment_claimed',
    category:        'payments',
    description:     'Who claimed they paid but has no verified Stripe/payment record?',
    helperModule:    'lib/staff-payment-queries',
    helperFn:        'getPaymentClaimedNoRecordQuery',
    helperRef:       paymentQueries.getPaymentClaimedNoRecordQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_008',
  },

  // ── Rooming ───────────────────────────────────────────────────────────────

  {
    key:             'rooming.roster',
    category:        'rooming',
    description:     'Who is assigned to which room/bed? (full rooming roster)',
    helperModule:    'lib/staff-rooming-queries',
    helperFn:        'getRoomingRosterQuery',
    helperRef:       roomingQueries.getRoomingRosterQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: null,
  },
  {
    key:             'rooming.unassigned',
    category:        'rooming',
    description:     'Which bookings have no bed assigned yet?',
    helperModule:    'lib/staff-rooming-queries',
    helperFn:        'getUnassignedBookingsQuery',
    helperRef:       roomingQueries.getUnassignedBookingsQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: null,
  },
  {
    key:             'rooming.review',
    category:        'rooming',
    description:     'Which bookings need a rooming review (flagged by bot or staff)?',
    helperModule:    'lib/staff-rooming-queries',
    helperFn:        'getRoomingReviewQuery',
    helperRef:       roomingQueries.getRoomingReviewQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: null,
  },
  {
    key:             'rooming.preferences',
    category:        'rooming',
    description:     'Which guests requested specific room preferences (private, couple, sea view, etc.)?',
    helperModule:    'lib/staff-rooming-queries',
    helperFn:        'getRoomingPreferencesQuery',
    helperRef:       roomingQueries.getRoomingPreferencesQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: null,
  },
  {
    key:             'rooming.occupied_beds',
    category:        'rooming',
    description:     'Which beds are occupied between two dates?',
    helperModule:    'lib/staff-rooming-queries',
    helperFn:        'getOccupiedBedsQuery',
    helperRef:       roomingQueries.getOccupiedBedsQuery,
    requiredParams:  [
      { name: 'start_date', description: 'Range start (ISO date)', example: '2026-07-01' },
      { name: 'end_date',   description: 'Range end (ISO date)',   example: '2026-07-08' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: null,
  },
  {
    key:             'rooming.arrivals',
    category:        'rooming',
    description:     'Which arrivals are approaching and still need a bed assignment?',
    helperModule:    'lib/staff-rooming-queries',
    helperFn:        'getArrivalsNeedingAssignmentQuery',
    helperRef:       roomingQueries.getArrivalsNeedingAssignmentQuery,
    requiredParams:  [],
    optionalParams:  [
      { name: 'date', description: 'Cutoff check-in date — show arrivals on or before this date (ISO date)', example: '2026-07-07', default: 'TODAY' },
    ],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: null,
  },

  // ── Add-ons ───────────────────────────────────────────────────────────────

  {
    key:             'addons.unpaid',
    category:        'addons',
    description:     'Which add-on orders are not yet paid?',
    helperModule:    'lib/staff-addon-queries',
    helperFn:        'getUnpaidAddOnsQuery',
    helperRef:       addonQueries.getUnpaidAddOnsQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_007',
  },
  {
    key:             'addons.lessons',
    category:        'addons',
    description:     'Who requested surf lessons on a specific date?',
    helperModule:    'lib/staff-addon-queries',
    helperFn:        'getLessonsByDateQuery',
    helperRef:       addonQueries.getLessonsByDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Lesson date (ISO date)', example: '2026-07-04' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_007',
  },
  {
    key:             'addons.yoga',
    category:        'addons',
    description:     'Who has yoga on a specific date?',
    helperModule:    'lib/staff-addon-queries',
    helperFn:        'getYogaByDateQuery',
    helperRef:       addonQueries.getYogaByDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Yoga class date (ISO date)', example: '2026-07-04' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_007',
  },
  {
    key:             'addons.rentals',
    category:        'addons',
    description:     'Who has an active board/wetsuit rental on a specific date?',
    helperModule:    'lib/staff-addon-queries',
    helperFn:        'getActiveRentalsByDateQuery',
    helperRef:       addonQueries.getActiveRentalsByDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Date to check active rentals (ISO date)', example: '2026-07-04' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_007',
  },
  {
    key:             'addons.by_booking',
    category:        'addons',
    description:     'What add-ons does a specific booking have?',
    helperModule:    'lib/staff-addon-queries',
    helperFn:        'getAddonsByBookingQuery',
    helperRef:       addonQueries.getAddonsByBookingQuery,
    requiredParams:  [
      { name: 'booking_code', description: 'Wolfhouse booking code', example: 'WH-12345' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_007',
  },
  {
    key:             'addons.staff_required',
    category:        'addons',
    description:     'Which add-ons require staff scheduling or action?',
    helperModule:    'lib/staff-addon-queries',
    helperFn:        'getStaffRequiredAddOnsQuery',
    helperRef:       addonQueries.getStaffRequiredAddOnsQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_007',
  },
  {
    key:             'addons.meals',
    category:        'addons',
    description:     'Who has dinner/meals on a specific date?',
    helperModule:    'lib/staff-addon-queries',
    helperFn:        'getMealsByDateQuery',
    helperRef:       addonQueries.getMealsByDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Meal/dinner date (ISO date)', example: '2026-07-04' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_007',
  },
  {
    key:             'addons.transfers',
    category:        'addons',
    description:     'Who has an airport transfer on a specific date?',
    helperModule:    'lib/staff-addon-queries',
    helperFn:        'getTransfersByDateQuery',
    helperRef:       addonQueries.getTransfersByDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Transfer date (ISO date)', example: '2026-07-04' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_007',
  },
  {
    key:             'addons.action_required',
    category:        'addons',
    description:     'Which add-on requests of any type still need staff action?',
    helperModule:    'lib/staff-addon-queries',
    helperFn:        'getStaffActionRequiredAddOnsQuery',
    helperRef:       addonQueries.getStaffActionRequiredAddOnsQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_007',
  },

  // ── Services (Ask Luna — booking_service_records) ─────────────────────────

  {
    key:             'services.lessons_today',
    category:        'services',
    description:     'Who has surf lessons booked today?',
    helperModule:    'lib/staff-ask-luna-lessons',
    helperFn:        'getAskLunaLessonsOnDateQuery',
    helperRef:       askLunaLessons.getAskLunaLessonsOnDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Lesson date (ISO date, use today)', example: '2026-06-04' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_010',
  },
  {
    key:             'services.lessons_tomorrow',
    category:        'services',
    description:     'Who has surf lessons booked tomorrow?',
    helperModule:    'lib/staff-ask-luna-lessons',
    helperFn:        'getAskLunaLessonsOnDateQuery',
    helperRef:       askLunaLessons.getAskLunaLessonsOnDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Lesson date (ISO date, use tomorrow)', example: '2026-06-05' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_010',
  },
  {
    key:             'services.gear_today',
    category:        'services',
    description:     'What surf gear (boards/wetsuits) is needed today?',
    helperModule:    'lib/staff-ask-luna-gear',
    helperFn:        'getAskLunaGearOnDateQuery',
    helperRef:       askLunaGear.getAskLunaGearOnDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Gear date (ISO date, use today)', example: '2026-06-04' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_010',
  },
  {
    key:             'services.gear_tomorrow',
    category:        'services',
    description:     'What surf gear (boards/wetsuits) is needed tomorrow?',
    helperModule:    'lib/staff-ask-luna-gear',
    helperFn:        'getAskLunaGearOnDateQuery',
    helperRef:       askLunaGear.getAskLunaGearOnDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Gear date (ISO date, use tomorrow)', example: '2026-06-05' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_010',
  },
  {
    key:             'services.meals_today',
    category:        'services',
    description:     'Who has meals booked today?',
    helperModule:    'lib/staff-ask-luna-meals-yoga',
    helperFn:        'getAskLunaMealsOnDateQuery',
    helperRef:       askLunaMealsYoga.getAskLunaMealsOnDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Meal date (ISO date, use today)', example: '2026-06-04' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_010',
  },
  {
    key:             'services.meals_tomorrow',
    category:        'services',
    description:     'Who has meals booked tomorrow?',
    helperModule:    'lib/staff-ask-luna-meals-yoga',
    helperFn:        'getAskLunaMealsOnDateQuery',
    helperRef:       askLunaMealsYoga.getAskLunaMealsOnDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Meal date (ISO date, use tomorrow)', example: '2026-06-05' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_010',
  },
  {
    key:             'services.yoga_today',
    category:        'services',
    description:     'Who has yoga booked today?',
    helperModule:    'lib/staff-ask-luna-meals-yoga',
    helperFn:        'getAskLunaYogaOnDateQuery',
    helperRef:       askLunaMealsYoga.getAskLunaYogaOnDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Yoga date (ISO date, use today)', example: '2026-06-04' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_010',
  },
  {
    key:             'services.yoga_tomorrow',
    category:        'services',
    description:     'Who has yoga booked tomorrow?',
    helperModule:    'lib/staff-ask-luna-meals-yoga',
    helperFn:        'getAskLunaYogaOnDateQuery',
    helperRef:       askLunaMealsYoga.getAskLunaYogaOnDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Yoga date (ISO date, use tomorrow)', example: '2026-06-05' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_010',
  },
  {
    key:             'services.meals_on_date',
    category:        'services',
    description:     'Who has meals on a specific date (weekday within 5 days)?',
    helperModule:    'lib/staff-ask-luna-meals-yoga',
    helperFn:        'getAskLunaMealsOnDateQuery',
    helperRef:       askLunaMealsYoga.getAskLunaMealsOnDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Meal date (ISO)', example: '2026-06-06' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_010',
  },
  {
    key:             'services.yoga_on_date',
    category:        'services',
    description:     'Who has yoga on a specific date (weekday within 5 days)?',
    helperModule:    'lib/staff-ask-luna-meals-yoga',
    helperFn:        'getAskLunaYogaOnDateQuery',
    helperRef:       askLunaMealsYoga.getAskLunaYogaOnDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Yoga date (ISO)', example: '2026-06-06' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_010',
  },
  {
    key:             'services.pending_manual',
    category:        'services',
    description:     'Guest-requested yoga/meals awaiting staff scheduling (no service date yet)',
    helperModule:    'lib/staff-ask-luna-pending-manual-services',
    helperFn:        'getPendingManualServicesQuery',
    helperRef:       askLunaPendingManual.getPendingManualServicesQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_010',
  },
  {
    key:             'services.pending_yoga',
    category:        'services',
    description:     'Pending guest yoga requests needing staff scheduling',
    helperModule:    'lib/staff-ask-luna-pending-manual-services',
    helperFn:        'getPendingManualYogaQuery',
    helperRef:       askLunaPendingManual.getPendingManualYogaQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_010',
  },
  {
    key:             'services.pending_meals',
    category:        'services',
    description:     'Pending guest meals/dinner requests needing staff follow-up',
    helperModule:    'lib/staff-ask-luna-pending-manual-services',
    helperFn:        'getPendingManualMealsQuery',
    helperRef:       askLunaPendingManual.getPendingManualMealsQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_010',
  },

  // ── Bookings — arrivals / checkouts (Ask Luna Phase 11e) ───────────────────

  {
    key:             'bookings.arrivals_today',
    category:        'bookings',
    description:     'Who is checking in / arriving today?',
    helperModule:    'lib/staff-ask-luna-arrivals-checkouts',
    helperFn:        'getAskLunaArrivalsOnDateQuery',
    helperRef:       askLunaArrivalsCheckouts.getAskLunaArrivalsOnDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Arrival date (ISO date, use today)', example: '2026-06-04' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_001',
  },
  {
    key:             'bookings.arrivals_tomorrow',
    category:        'bookings',
    description:     'Who is checking in / arriving tomorrow?',
    helperModule:    'lib/staff-ask-luna-arrivals-checkouts',
    helperFn:        'getAskLunaArrivalsOnDateQuery',
    helperRef:       askLunaArrivalsCheckouts.getAskLunaArrivalsOnDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Arrival date (ISO date, use tomorrow)', example: '2026-06-05' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_001',
  },
  {
    key:             'bookings.arrivals_on_date',
    category:        'bookings',
    description:     'Who is arriving on a specific date (weekday within 5 days)?',
    helperModule:    'lib/staff-ask-luna-arrivals-checkouts',
    helperFn:        'getAskLunaArrivalsOnDateQuery',
    helperRef:       askLunaArrivalsCheckouts.getAskLunaArrivalsOnDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Arrival date (ISO)', example: '2026-06-06' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_001',
  },
  {
    key:             'bookings.checkouts_today',
    category:        'bookings',
    description:     'Who is checking out / leaving today?',
    helperModule:    'lib/staff-ask-luna-arrivals-checkouts',
    helperFn:        'getAskLunaCheckoutsOnDateQuery',
    helperRef:       askLunaArrivalsCheckouts.getAskLunaCheckoutsOnDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Checkout date (ISO date, use today)', example: '2026-06-04' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_001',
  },
  {
    key:             'bookings.checkouts_tomorrow',
    category:        'bookings',
    description:     'Who is checking out / leaving tomorrow?',
    helperModule:    'lib/staff-ask-luna-arrivals-checkouts',
    helperFn:        'getAskLunaCheckoutsOnDateQuery',
    helperRef:       askLunaArrivalsCheckouts.getAskLunaCheckoutsOnDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Checkout date (ISO date, use tomorrow)', example: '2026-06-05' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_001',
  },
  {
    key:             'bookings.checkouts_on_date',
    category:        'bookings',
    description:     'Who is checking out on a specific date (weekday within 5 days)?',
    helperModule:    'lib/staff-ask-luna-arrivals-checkouts',
    helperFn:        'getAskLunaCheckoutsOnDateQuery',
    helperRef:       askLunaArrivalsCheckouts.getAskLunaCheckoutsOnDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Checkout date (ISO)', example: '2026-06-06' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_001',
  },

  // ── Occupancy (Phase 11k) ───────────────────────────────────────────────────

  {
    key:             'bookings.occupancy_tonight',
    category:        'bookings',
    description:     'Who is staying / in-house tonight (nights-based occupancy)?',
    helperModule:    'lib/staff-ask-luna-occupancy',
    helperFn:        'getAskLunaOccupancyOnNightQuery',
    helperRef:       askLunaOccupancy.getAskLunaOccupancyOnNightQuery,
    requiredParams:  [
      { name: 'date', description: 'Occupancy night (ISO date, use today)', example: '2026-06-04' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_001',
  },
  {
    key:             'bookings.occupancy_tomorrow_night',
    category:        'bookings',
    description:     'Who is staying / in-house tomorrow night?',
    helperModule:    'lib/staff-ask-luna-occupancy',
    helperFn:        'getAskLunaOccupancyOnNightQuery',
    helperRef:       askLunaOccupancy.getAskLunaOccupancyOnNightQuery,
    requiredParams:  [
      { name: 'date', description: 'Occupancy night (ISO date, use tomorrow)', example: '2026-06-05' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_001',
  },

  // ── Inventory snapshot (Phase 11l) ──────────────────────────────────────────

  {
    key:             'inventory.free_beds_tonight',
    category:        'inventory',
    description:     'Which sellable beds are free tonight (staff snapshot only)?',
    helperModule:    'lib/staff-ask-luna-free-beds',
    helperFn:        'getAskLunaFreeBedsOnNightQuery',
    helperRef:       askLunaFreeBeds.getAskLunaFreeBedsOnNightQuery,
    requiredParams:  [
      { name: 'date', description: 'Night date (ISO date, use today)', example: '2026-06-04' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_001',
  },
  {
    key:             'inventory.free_beds_tomorrow_night',
    category:        'inventory',
    description:     'Which sellable beds are free tomorrow night (staff snapshot only)?',
    helperModule:    'lib/staff-ask-luna-free-beds',
    helperFn:        'getAskLunaFreeBedsOnNightQuery',
    helperRef:       askLunaFreeBeds.getAskLunaFreeBedsOnNightQuery,
    requiredParams:  [
      { name: 'date', description: 'Night date (ISO date, use tomorrow)', example: '2026-06-05' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_001',
  },

  // ── Booking lookup (Phase 11g) ──────────────────────────────────────────────

  {
    key:             'bookings.lookup',
    category:        'bookings',
    description:     'Look up a booking by guest name, booking code, or room/bed',
    helperModule:    'lib/staff-ask-luna-booking-lookup',
    helperFn:        'buildAskLunaBookingLookupQuery',
    helperRef:       askLunaBookingLookup.buildAskLunaBookingLookupQuery,
    requiredParams:  [
      { name: 'lookupMode', description: 'booking_code | guest_name | room | bed', example: 'guest_name' },
      { name: 'searchValue', description: 'Search term (name, code, or room)', example: 'Jimmy' },
    ],
    optionalParams:  [
      { name: 'lookupFocus', description: 'general | arrival | checkout | room | bed', example: 'general' },
    ],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_001',
  },

  // ── Housekeeping (Phase 11f) ────────────────────────────────────────────────

  {
    key:             'housekeeping.cleaning_today',
    category:        'housekeeping',
    description:     'Which rooms/beds need cleaning after today\'s checkouts?',
    helperModule:    'lib/staff-ask-luna-cleaning',
    helperFn:        'getAskLunaCleaningOnDateQuery',
    helperRef:       askLunaCleaning.getAskLunaCleaningOnDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Checkout date (ISO date, use today)', example: '2026-06-04' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_001',
  },
  {
    key:             'housekeeping.cleaning_tomorrow',
    category:        'housekeeping',
    description:     'Which rooms/beds need cleaning after tomorrow\'s checkouts?',
    helperModule:    'lib/staff-ask-luna-cleaning',
    helperFn:        'getAskLunaCleaningOnDateQuery',
    helperRef:       askLunaCleaning.getAskLunaCleaningOnDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Checkout date (ISO date, use tomorrow)', example: '2026-06-05' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_001',
  },
  {
    key:             'housekeeping.cleaning_on_date',
    category:        'housekeeping',
    description:     'Which rooms/beds need cleaning after checkouts on a given date?',
    helperModule:    'lib/staff-ask-luna-cleaning',
    helperFn:        'getAskLunaCleaningOnDateQuery',
    helperRef:       askLunaCleaning.getAskLunaCleaningOnDateQuery,
    requiredParams:  [
      { name: 'date', description: 'Checkout date (ISO)', example: '2026-06-06' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_001',
  },

  // ── Handoffs ──────────────────────────────────────────────────────────────

  {
    key:             'handoffs.open',
    category:        'handoffs',
    description:     'Which conversations need a human staff reply?',
    helperModule:    'lib/staff-handoff-queries',
    helperFn:        'getOpenHandoffsQuery',
    helperRef:       handoffQueries.getOpenHandoffsQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_008',
  },
  {
    key:             'handoffs.urgent',
    category:        'handoffs',
    description:     'Which handoffs are urgent or high priority?',
    helperModule:    'lib/staff-handoff-queries',
    helperFn:        'getHighPriorityHandoffsQuery',
    helperRef:       handoffQueries.getHighPriorityHandoffsQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_008',
  },
  {
    key:             'handoffs.by_reason',
    category:        'handoffs',
    description:     'Show open handoffs filtered to a specific reason code.',
    helperModule:    'lib/staff-handoff-queries',
    helperFn:        'getHandoffsByReasonQuery',
    helperRef:       handoffQueries.getHandoffsByReasonQuery,
    requiredParams:  [
      { name: 'reason_code', description: 'Handoff reason code', example: 'cancellation_request' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_008',
  },
  {
    key:             'handoffs.payment_claimed',
    category:        'handoffs',
    description:     'Which payment-claimed handoffs need staff review?',
    helperModule:    'lib/staff-handoff-queries',
    helperFn:        'getPaymentClaimedHandoffsQuery',
    helperRef:       handoffQueries.getPaymentClaimedHandoffsQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_008',
  },
  {
    key:             'handoffs.cancel_refund',
    category:        'handoffs',
    description:     'Which cancellation or refund handoffs are open?',
    helperModule:    'lib/staff-handoff-queries',
    helperFn:        'getCancellationRefundHandoffsQuery',
    helperRef:       handoffQueries.getCancellationRefundHandoffsQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_008',
  },
  {
    key:             'handoffs.by_staff',
    category:        'handoffs',
    description:     'Show handoffs currently assigned to a staff member.',
    helperModule:    'lib/staff-handoff-queries',
    helperFn:        'getHandoffsByStaffQuery',
    helperRef:       handoffQueries.getHandoffsByStaffQuery,
    requiredParams:  [
      { name: 'staff_name', description: 'Assigned staff member name or identifier', example: 'alice' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_008',
  },
  {
    key:             'handoffs.stale',
    category:        'handoffs',
    description:     'Which handoffs have had no response for longer than N hours?',
    helperModule:    'lib/staff-handoff-queries',
    helperFn:        'getStaleHandoffsQuery',
    helperRef:       handoffQueries.getStaleHandoffsQuery,
    requiredParams:  [],
    optionalParams:  [
      { name: 'hours', description: 'Hours threshold for stale handoffs', example: '24', default: '24' },
    ],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_008',
  },
  {
    key:             'handoffs.by_booking',
    category:        'handoffs',
    description:     'Show all handoffs linked to a specific booking.',
    helperModule:    'lib/staff-handoff-queries',
    helperFn:        'getBookingHandoffsQuery',
    helperRef:       handoffQueries.getBookingHandoffsQuery,
    requiredParams:  [
      { name: 'booking_code', description: 'Wolfhouse booking code', example: 'WH-12345' },
    ],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_008',
  },
  {
    key:             'handoffs.needs_human_no_handoff',
    category:        'handoffs',
    description:     'Conversations marked needs_human but missing an open handoff row (reconciliation gap).',
    helperModule:    'lib/staff-handoff-queries',
    helperFn:        'getNeedsHumanWithoutOpenHandoffQuery',
    helperRef:       handoffQueries.getNeedsHumanWithoutOpenHandoffQuery,
    requiredParams:  [],
    optionalParams:  [],
    clientSlugged:   true,
    readOnly:        true,
    migrationRequired: 'migration_008',
  },

].map(Object.freeze);

// ─────────────────────────────────────────────────────────────────────────────
// Lookup helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Map from intent key to registry entry. */
const REGISTRY_BY_KEY = new Map(REGISTRY.map((e) => [e.key, e]));

/** All valid intent keys. */
const INTENT_KEYS = REGISTRY.map((e) => e.key);

/** All valid categories. */
const CATEGORIES = [...new Set(REGISTRY.map((e) => e.category))];

/**
 * Look up a registry entry by exact intent key.
 * Returns undefined if the key is not registered.
 *
 * @param {string} key e.g. 'handoffs.open'
 * @returns {object|undefined}
 */
function getEntry(key) {
  return REGISTRY_BY_KEY.get(key);
}

/**
 * Return all entries for a category.
 *
 * @param {string} category e.g. 'payments'
 * @returns {object[]}
 */
function getEntriesByCategory(category) {
  return REGISTRY.filter((e) => e.category === category);
}

/**
 * The 31 planned intents from Stage 6 planning docs.
 * Used by the verifier to assert completeness.
 */
const PLANNED_INTENTS = [
  // holds (4 — added to the planned list for completeness)
  'holds.active',
  'holds.expired',
  'holds.payment_pending',
  'holds.no_payment',
  // payments (7)
  'payments.waiting',
  'payments.deposit',
  'payments.fully_paid',
  'payments.balance_due',
  'payments.no_record',
  'payments.confirmation_needed',
  'payments.payment_claimed',
  // rooming (6)
  'rooming.roster',
  'rooming.unassigned',
  'rooming.review',
  'rooming.preferences',
  'rooming.occupied_beds',
  'rooming.arrivals',
  // addons (9)
  'addons.unpaid',
  'addons.lessons',
  'addons.yoga',
  'addons.rentals',
  'addons.by_booking',
  'addons.staff_required',
  'addons.meals',
  'addons.transfers',
  'addons.action_required',
  // handoffs (9)
  'handoffs.open',
  'handoffs.urgent',
  'handoffs.by_reason',
  'handoffs.payment_claimed',
  'handoffs.cancel_refund',
  'handoffs.by_staff',
  'handoffs.stale',
  'handoffs.by_booking',
  'handoffs.needs_human_no_handoff',
];

module.exports = {
  REGISTRY,
  REGISTRY_BY_KEY,
  INTENT_KEYS,
  CATEGORIES,
  PLANNED_INTENTS,
  getEntry,
  getEntriesByCategory,
};
