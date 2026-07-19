'use strict';

/**
 * Disposable PostgreSQL harness for migration proof scripts.
 * Prefers Docker postgres:15-alpine; falls back to PGlite socket when Docker is unavailable.
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');

function dockerAvailable() {
  try {
    execFileSync('docker', ['info'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    return true;
  } catch (_) {
    return false;
  }
}

function docker(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/**
 * @returns {Promise<{
 *   backend: 'docker' | 'pglite',
 *   admin: {host:string,port:number,user:string,password:string,database:string},
 *   cleanup: () => void,
 * }>}
 */
async function startDisposablePostgresHarness() {
  const suffix = crypto.randomBytes(4).toString('hex');
  const USER = `wh_mig_u_${suffix}`;
  const PASSWORD = crypto.randomBytes(18).toString('base64url');

  if (dockerAvailable()) {
    const CONTAINER = `wh-mig-${suffix}`;
    const VOLUME = `wh-mig-vol-${suffix}`;
    docker([
      'run', '-d', '--name', CONTAINER,
      '-e', `POSTGRES_USER=${USER}`,
      '-e', `POSTGRES_PASSWORD=${PASSWORD}`,
      '-e', 'POSTGRES_DB=postgres',
      '-p', '127.0.0.1::5432',
      '-v', `${VOLUME}:/var/lib/postgresql/data`,
      'postgres:15-alpine',
    ]);
    const portMap = String(docker(['port', CONTAINER, '5432/tcp'])).trim();
    const port = Number(portMap.match(/:(\d+)\s*$/)[1]);
    return {
      backend: 'docker',
      admin: { host: '127.0.0.1', port, user: USER, password: PASSWORD, database: 'postgres' },
      cleanup() {
        try { docker(['rm', '-f', CONTAINER]); } catch (_) { /* ignore */ }
        try { docker(['volume', 'rm', '-f', VOLUME]); } catch (_) { /* ignore */ }
      },
    };
  }

  let PGlite;
  let PGLiteSocketServer;
  let pgcrypto;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
    ({ PGLiteSocketServer } = require('@electric-sql/pglite-socket'));
    ({ pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto'));
  } catch (e) {
    throw new Error(
      'Docker unavailable and @electric-sql/pglite packages missing — install devDependencies or start Docker',
    );
  }

  const db = new PGlite({ extensions: { pgcrypto } });
  await db.waitReady;
  const port = 15000 + (suffix.charCodeAt(0) % 1000);
  const server = new PGLiteSocketServer({
    db,
    host: '127.0.0.1',
    port,
    maxConnections: 20,
  });
  await server.start();
  return {
    backend: 'pglite',
    admin: { host: '127.0.0.1', port, user: 'postgres', password: '', database: 'postgres' },
    cleanup() {
      try { server.stop(); } catch (_) { /* ignore */ }
      try { db.close(); } catch (_) { /* ignore */ }
    },
  };
}

module.exports = {
  startDisposablePostgresHarness,
  dockerAvailable,
};
