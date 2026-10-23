'use strict';

const crypto = require('crypto');

function createScopedNotesStore() {
  const notes = new Map();
  const operations = new Map();

  return Object.freeze({
    async read({ tenantId, sessionId }) {
      const scope = `${tenantId}:${sessionId}`;
      return Array.from(notes.values()).filter((note) => note.scope === scope);
    },
    async write({ tenantId, sessionId, text, context = null, bookingReference = null, operationKey }) {
      if (tenantId !== 'wolfhouse-somo') throw new Error('tenant is not admitted');
      if (!sessionId || !operationKey || !String(text || '').trim()) throw new Error('sessionId, operationKey and text are required');
      const scope = `${tenantId}:${sessionId}`;
      const replayKey = `${scope}:${operationKey}`;
      if (operations.has(replayKey)) return operations.get(replayKey);
      const note = Object.freeze({
        id: `luna-v3-note-${crypto.createHash('sha256').update(replayKey).digest('hex').slice(0, 16)}`,
        scope,
        text: String(text).trim(),
        context,
        booking_reference: bookingReference,
        version: 1,
      });
      notes.set(note.id, note);
      operations.set(replayKey, note);
      return note;
    },
    replaceSharedNotes() {
      throw new Error('shared General Notes are read-only for Luna v3');
    },
  });
}

module.exports = { createScopedNotesStore };
