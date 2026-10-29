'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('bootstrap grants crowsnest owner CREATE on the connected target database', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crowsnest-role-bootstrap-'));
  const bin = path.join(tmp, 'bin');
  const capture = path.join(tmp, 'captured.sql');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'psql'), '#!/bin/sh\ncat > "$BOOTSTRAP_SQL_CAPTURE"\n', { mode: 0o755 });

  try {
    execFileSync('sh', [path.join(__dirname, 'bootstrap-crowsnest-comms-roles.sh')], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CROWSNEST_ADMIN_DSN: 'postgresql://example.invalid/example',
        BOOTSTRAP_SQL_CAPTURE: capture,
      },
      stdio: 'pipe',
    });
    const sql = fs.readFileSync(capture, 'utf8');
    assert.match(sql, /current_database\(\)/i);
    assert.match(sql, /GRANT CREATE ON DATABASE %I TO crowsnest_comms_owner/i);
    assert.doesNotMatch(sql, /wolfhouse_prod/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
