'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

(async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE clients (id uuid PRIMARY KEY, slug text NOT NULL UNIQUE);
      CREATE TABLE bookings (
        id uuid PRIMARY KEY,
        client_id uuid NOT NULL REFERENCES clients(id),
        booking_code text NOT NULL,
        CONSTRAINT bookings_id_client_uq_115 UNIQUE (id, client_id)
      );
      CREATE TABLE conversations (
        id uuid PRIMARY KEY,
        client_id uuid NOT NULL REFERENCES clients(id),
        current_hold_booking_id uuid REFERENCES bookings(id),
        CONSTRAINT conversations_client_id_id_uq UNIQUE (client_id, id)
      );
      INSERT INTO clients (id, slug) VALUES
        ('00000000-0000-4000-8000-000000000001', 'tenant-a'),
        ('00000000-0000-4000-8000-000000000002', 'tenant-b');
      INSERT INTO bookings (id, client_id, booking_code) VALUES
        ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'A-1'),
        ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'B-1');
      INSERT INTO conversations (id, client_id, current_hold_booking_id) VALUES
        ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001'),
        ('20000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001');
    `);
    const migration = fs.readFileSync(path.join(__dirname,
      '../database/migrations/133_booking_conversation_links.sql'), 'utf8');
    await db.exec(migration);

    const links = (await db.query(
      'SELECT client_id::text, conversation_id::text, booking_id::text FROM booking_conversation_links',
    )).rows;
    assert.equal(links.length, 1, 'cross-tenant legacy pointer must not be backfilled');
    assert.equal(links[0].conversation_id, '20000000-0000-4000-8000-000000000001');

    await assert.rejects(
      db.query(`INSERT INTO booking_conversation_links (client_id, conversation_id, booking_id)
                VALUES ($1, $2, $3)`, [
        '00000000-0000-4000-8000-000000000002',
        '20000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000001',
      ]),
      /tenant mismatch|foreign key/i,
      'schema must reject a conversation tenant paired with another tenant booking',
    );

    await assert.rejects(
      db.query('UPDATE bookings SET client_id = $1 WHERE id = $2', [
        '00000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000001',
      ]),
      /foreign key/i,
      'booking tenant reassignment must not orphan its conversation ownership link',
    );
    const preserved = (await db.query(
      'SELECT client_id::text FROM booking_conversation_links WHERE booking_id = $1',
      ['10000000-0000-4000-8000-000000000001'],
    )).rows[0];
    assert.equal(preserved.client_id, '00000000-0000-4000-8000-000000000001',
      'rejected tenant reassignment must preserve the valid ownership link');
    console.log('booking conversation link migration tenant invariant: PASS');
  } finally {
    await db.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
