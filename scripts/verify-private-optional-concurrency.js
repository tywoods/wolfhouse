'use strict';
/**
 * Independent stock PostgreSQL sessions, existing offline booking fixture only.
 * Reuses package-extracted PostgreSQL binaries; never accepts a connection URL,
 * PGHOST, DATABASE_URL, remote host, system daemon or existing database.
 * PRIVATE_OPTIONAL_PG_ROOT may select another package-extracted binary root.
 * A new private cluster/socket is owned by this run and always stopped in finally.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const originalConnect = net.Socket.prototype.connect;
// This import installs the existing no-network/no-send tripwires. Below we allow
// ONLY this process's newly-created Unix socket, never TCP or another DB socket.
const { payload, seed, build, create, snapshot, roomBlocks, DEFAULT_OUT } = require('./verify-room-selling-booking');
const { executeWolfhouseBookingCreate } = require('./lib/luna-front-desk-accommodation-booking-create-service');
const { Client } = require('pg');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run(out = DEFAULT_OUT) {
  fs.mkdirSync(out, { recursive: true });
  const root = process.env.PRIVATE_OPTIONAL_PG_ROOT || path.resolve(out, '../../../review-1414-r18/pg-runtime/root');
  const bin = path.join(root, 'usr/lib/postgresql/17/bin');
  const env = { ...process.env, LD_LIBRARY_PATH: path.join(root, 'usr/lib/x86_64-linux-gnu') };
  // Avoid all implicit libpq targets; node-pg receives every connection property.
  for (const name of Object.keys(env)) if (/^PG|DATABASE_URL/.test(name)) delete env[name];
  const data = fs.mkdtempSync(path.join(out, 'stock-pg-'));
  const socket = fs.mkdtempSync(path.join(os.tmpdir(), 'private-opt-pg-'));
  fs.chmodSync(socket, 0o700);
  const socketFile = path.join(socket, '.s.PGSQL.5432');
  const report = { passed: false, engine: 'stock PostgreSQL, independent backend sessions',
    binary: path.join(bin, 'postgres'), data, socket, cases: [], network_denials: 0 };
  const active = new Set();
  let server;
  let stopped = false;
  net.Socket.prototype.connect = function (...args) {
    const target = args[0];
    if (target === socketFile || (target && typeof target === 'object' && target.path === socketFile)) return originalConnect.apply(this, args);
    report.network_denials++;
    throw new Error('Concurrency fixture allows only its own disposable Unix socket');
  };
  async function connect(database = 'postgres', label = 'admin') {
    const client = new Client({ host: socket, port: 5432, database, user: 'private_opt_fixture', password: '', ssl: false,
      application_name: `private-opt-${label}`, connectionTimeoutMillis: 1500, statement_timeout: 15000, query_timeout: 20000 });
    await client.connect(); active.add(client);
    client.exec = sql => client.query(sql);
    return client;
  }
  async function close(client) { active.delete(client); await client.end(); }
  try {
    const version = spawnSync(path.join(bin, 'postgres'), ['--version'], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(version.status, 0, `existing PostgreSQL binaries unavailable: ${version.error || version.stderr}`);
    report.version = version.stdout.trim();
    const init = spawnSync(path.join(bin, 'initdb'), ['-D', data, '-U', 'private_opt_fixture', '-A', 'trust', '--no-locale', '-E', 'UTF8'], { env, encoding: 'utf8', timeout: 30000 });
    fs.writeFileSync(path.join(out, 'stock-pg-init.log'), init.stdout + init.stderr);
    assert.equal(init.status, 0, `initdb failed: ${init.error || init.stderr}`);
    const log = fs.openSync(path.join(out, 'stock-pg-server.log'), 'a');
    server = spawn(path.join(bin, 'postgres'), ['-D', data, '-k', socket, '-p', '5432', '-c', 'listen_addresses=', '-c', 'max_connections=16'], { env, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    const exited = new Promise(resolve => { server.once('exit', (code, signal) => { stopped = true; resolve({ code, signal }); }); });
    let admin;
    const readyUntil = Date.now() + 10000;
    while (!admin && Date.now() < readyUntil && !stopped) {
      try { if (fs.existsSync(socketFile)) admin = await connect(); } catch (_) { /* bounded readiness probe */ }
      if (!admin) await pause(40);
    }
    assert.ok(admin, 'disposable PostgreSQL readiness failed');
    report.server = (await admin.query('SELECT version(), inet_server_addr() AS address, current_database() AS database')).rows[0];
    assert.equal(report.server.address, null, 'Unix socket connection only');
    for (const type of ['private', 'double']) for (const first of ['private', 'shared']) {
      const name = `${type}-${first}-first`;
      const evidence = { name, passed: false, lock_observations: [] };
      report.cases.push(evidence);
      const dbName = `private_opt_${type}_${first}`;
      const sessions = [];
      let blocker;
      let promises = [];
      try {
        await admin.query(`CREATE DATABASE ${dbName}`);
        const observer = await connect(dbName, `${name}-observer`); sessions.push(observer);
        await seed(observer);
        blocker = await connect(dbName, `${name}-blocker`); sessions.push(blocker);
        const privateClient = await connect(dbName, `${name}-private`); sessions.push(privateClient);
        const sharedClient = await connect(dbName, `${name}-shared`); sessions.push(sharedClient);
        const pids = {};
        for (const [role, client] of Object.entries({ observer, blocker, private: privateClient, shared: sharedClient })) {
          pids[role] = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        }
        evidence.pids = pids;
        assert.equal(new Set(Object.values(pids)).size, 4, 'four genuinely independent backend sessions');
        const privateBody = payload(type, 1, `${name}-private`);
        const sharedBody = { ...payload('shared', 1, `${name}-shared`), selected_bed_codes: ['R1-B1'],
          guest_name: 'Unrelated shared', guests: [{ name: 'Unrelated shared' }] };
        const privateBuilt = await build(privateClient, privateBody);
        const sharedBuilt = await build(sharedClient, sharedBody);
        assert.equal(privateBuilt.ok, true, JSON.stringify(privateBuilt));
        assert.equal(sharedBuilt.ok, true, JSON.stringify(sharedBuilt));
        await blocker.query('BEGIN');
        await blocker.query("SELECT id FROM rooms WHERE room_code='R1' FOR UPDATE");
        const starts = {
          private: () => executeWolfhouseBookingCreate(privateClient, privateBuilt.command, { stripeConfig: { stripeLinksEnabled: false } }),
          shared: () => executeWolfhouseBookingCreate(sharedClient, sharedBuilt.command, { stripeConfig: { stripeLinksEnabled: false } }),
        };
        async function waitBlocked(role) {
          const until = Date.now() + 6000;
          while (Date.now() < until) {
            const row = (await observer.query(`SELECT pid, application_name, wait_event_type, query,
              pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1`, [pids[role]])).rows[0];
            if (row && row.wait_event_type === 'Lock' && row.blockers.length) {
              // PostgreSQL may queue the second row locker behind the first
              // waiter's tuple lock, not directly behind the transaction holder.
              const edges = (await observer.query(`SELECT pid, pg_blocking_pids(pid) AS blockers
                FROM pg_stat_activity WHERE pid=ANY($1::int[])`, [Object.values(pids)])).rows;
              const reachesBlocker = (pid, seen = new Set()) => {
                if (pid === pids.blocker) return true;
                if (seen.has(pid)) return false;
                seen.add(pid);
                return (edges.find(e => e.pid === pid)?.blockers || []).some(next => reachesBlocker(next, seen));
              };
              if (reachesBlocker(pids[role])) {
                assert.match(row.query, /SELECT r\.id, r\.selling_mode/);
                evidence.lock_observations.push({ role, ...row, blocking_graph: edges }); return;
              }
            }
            await pause(20);
          }
          throw new Error(`${role} did not demonstrably wait behind the exact room-lock blocker`);
        }
        // Queue each real production operation while the observer proves overlap.
        // Query errors become explicit failures, never unhandled rejections.
        const launch = role => starts[role]().catch(error => ({ ok: false, thrown: error.message }));
        const firstPromise = launch(first); promises.push(firstPromise);
        await waitBlocked(first);
        const second = first === 'private' ? 'shared' : 'private';
        const secondPromise = launch(second); promises.push(secondPromise);
        await waitBlocked(second);
        await blocker.query('COMMIT');
        const results = await Promise.all(promises);
        evidence.results = { [first]: results[0], [second]: results[1] };
        assert.equal(results.filter(r => r.ok).length, 1, 'exactly one incompatible reservation may commit');
        assert.equal(evidence.results[first].ok, true, 'first queued transaction wins');
        const loser = evidence.results[second];
        assert.equal(loser.thrown, undefined, 'loser must be a genuine inventory refusal, not timeout/deadlock');
        assert.match(JSON.stringify(loser.body), /overlap_conflict|private_room_room_not_empty|availability_changed/);
        const parents = (await observer.query("SELECT * FROM bookings WHERE status::text <> 'blocked'")).rows;
        assert.equal(parents.length, 1);
        const companions = (await observer.query("SELECT * FROM bookings WHERE metadata->>'block_type'='private_room_companion'")).rows;
        assert.equal(companions.length, first === 'private' ? 1 : 0);
        assert.equal((await observer.query('SELECT * FROM booking_guests')).rows.length, 1, 'loser leaves no partial guest');
        const coverage = await roomBlocks(observer, privateBody.check_in, privateBody.check_out);
        const allBeds = (await observer.query("SELECT bd.bed_code FROM beds bd JOIN rooms r ON r.id=bd.room_id WHERE r.room_code='R1' ORDER BY bd.bed_code")).rows.map(r => r.bed_code);
        assert.deepEqual(coverage.map(r => r.bed_code).sort(), first === 'private' ? allBeds : ['R1-B1']);
        const beforeRetry = await snapshot(observer);
        const retry = await create(first === 'private' ? privateClient : sharedClient, first === 'private' ? privateBody : sharedBody);
        assert.equal(retry.ok, true, JSON.stringify(retry));
        assert.equal(retry.body.booking_id, parents[0].id);
        assert.deepEqual(await snapshot(observer), beforeRetry, 'retry adds no parent, block, payment or link');
        evidence.readback = { parents, companions, coverage, retry };
        evidence.passed = true;
        console.log(`PASS ${name}: independent sessions, observed contention, one commit, atomic loser, idempotent retry`);
      } catch (error) {
        evidence.error = error.stack;
        console.error(`FAIL ${name}: ${error.message}`);
      } finally {
        if (blocker) await blocker.query('ROLLBACK').catch(() => {});
        await Promise.allSettled(promises);
        for (const client of sessions) await close(client);
        // Leave only the disposable on-disk receipt; no leaked fixture databases.
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
        evidence.database_removed = !(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbName])).rows.length;
        assert.equal(evidence.database_removed, true);
      }
    }
    await close(admin);
    report.passed = report.cases.every(c => c.passed && c.database_removed);
    // Graceful stop only our child (never pg_ctl or a system service).
    server.kill('SIGTERM');
    report.shutdown = await exited;
    assert.equal(report.shutdown.code, 0, 'owned disposable PostgreSQL shuts down cleanly');
  } catch (error) {
    report.error = error.stack;
    report.passed = false;
    console.error(error.message);
  } finally {
    for (const client of active) await client.end().catch(() => {});
    if (server && !stopped) {
      server.kill('SIGTERM');
      const until = Date.now() + 6000;
      while (!stopped && Date.now() < until) await pause(20);
      if (!stopped) { server.kill('SIGKILL'); report.passed = false; }
    }
    report.server_stopped = !server || stopped;
    report.socket_removed = !fs.existsSync(socketFile);
    if (!report.server_stopped || !report.socket_removed || report.network_denials) report.passed = false;
    if (report.socket_removed) fs.rmdirSync(socket);
    fs.writeFileSync(path.join(out, 'concurrency.json'), JSON.stringify(report, null, 2));
  }
  return report;
}
if (require.main === module) run(path.resolve(process.argv[2] || DEFAULT_OUT)).then(r => { if (!r.passed) process.exitCode = 1; }).catch(e => { console.error(e); process.exitCode = 1; });
