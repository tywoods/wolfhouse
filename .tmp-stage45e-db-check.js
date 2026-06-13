'use strict';

const { withPgClient } = require('./scripts/lib/pg-connect');

(async () => {
  await withPgClient(async (pg) => {
    const rooms = await pg.query(`
      SELECT room_code, fill_priority, gender_strategy, often_used_by_operator
      FROM rooms r
      JOIN clients c ON c.id = r.client_id
      WHERE c.slug = 'wolfhouse-somo'
      ORDER BY fill_priority, room_code
    `);
    const beds = await pg.query(`
      SELECT count(*)::int AS n
      FROM beds b
      JOIN rooms r ON r.id = b.room_id
      JOIN clients c ON c.id = r.client_id
      WHERE c.slug = 'wolfhouse-somo'
    `);
    console.log(JSON.stringify({
      room_count: rooms.rows.length,
      bed_count: beds.rows[0].n,
      operator_rooms: rooms.rows.filter((r) => r.often_used_by_operator).map((r) => r.room_code),
      r3: rooms.rows.find((r) => r.room_code === 'R3'),
      r5: rooms.rows.find((r) => r.room_code === 'R5'),
      r6: rooms.rows.find((r) => r.room_code === 'R6'),
    }, null, 2));
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
