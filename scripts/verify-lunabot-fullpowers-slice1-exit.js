#!/usr/bin/env node
'use strict';

/**
 * Slice 1 exit gate (fail closed).
 *
 * The former implementation spawned independent fixtures whose tenant,
 * conversation, booking, message and event identities were unrelated. Passing
 * those fixtures cannot prove one coherent synthetic session, so this command
 * must not report green until the composable seam below exists.
 *
 * Required production seam (no test persistence): export a dependency-injected
 * `createStaffApiHandlers({ withPgClient, readBody, sendJSON, appendAuditLog,
 * transports })` from staff-query-api.js (or move the existing route assembly
 * to a library and import it there). It must expose the existing booking-create,
 * contact-update, transfer-save, owner_lab list/thread, supervisor lease/reply,
 * event list/detail, transcript and receipt handlers. Every handler must receive
 * the same `withPgClient`, allowing this tracer to supply ONE PGlite instance.
 * Today booking/contact handlers are file-local functions in the executable API;
 * tests extract them from source text or use separate harnesses, which cannot be
 * composed authentically into one database/session without duplicating routing
 * logic. The booking service itself is already exported and needs no new owner.
 *
 * Once that production assembly seam is exported, this file should create one
 * database, one identity tuple, invoke those handlers in sequence, and assert
 * durable readback plus zero calls on injected provider/email/event transports.
 */
throw new Error(
  'SLICE1_EXIT_NOT_PROVEN: independent fixtures were removed from the exit gate; ' +
  'export the dependency-injected Staff handler assembly described in this file ' +
  'before claiming one coherent synthetic-session vertical proof. Run ' +
  'verify-lunabot-fullpowers-slice1-aggregate.js for the non-exit regression aggregate.'
);
