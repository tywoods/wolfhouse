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

function dockerContainerPresent(dockerFn, name) {
  const out = String(
    dockerFn(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']),
  );
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .includes(name);
}

function dockerVolumePresent(dockerFn, name) {
  const out = String(dockerFn(['volume', 'ls', '--format', '{{.Name}}']));
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .includes(name);
}

/**
 * Remove named Docker container + volume and verify both are absent.
 * Does not suppress rm / volume-rm failures when resources remain.
 * @returns {{ ok: true, containerRemoved: true, volumeRemoved: true }}
 */
function cleanupDockerResources(dockerFn, container, volume) {
  const errors = [];
  try {
    dockerFn(['rm', '-f', container]);
  } catch (e) {
    errors.push(e);
  }
  try {
    dockerFn(['volume', 'rm', '-f', volume]);
  } catch (e) {
    errors.push(e);
  }

  let containerGone = false;
  let volumeGone = false;
  try {
    containerGone = !dockerContainerPresent(dockerFn, container);
  } catch (e) {
    errors.push(e);
    containerGone = false;
  }
  try {
    volumeGone = !dockerVolumePresent(dockerFn, volume);
  } catch (e) {
    errors.push(e);
    volumeGone = false;
  }

  if (!containerGone || !volumeGone) {
    const detail = errors
      .map((e) => String(e && e.message ? e.message : e).slice(0, 200))
      .filter(Boolean)
      .join('; ');
    const err = new Error(
      `docker cleanup failed: containerPresent=${!containerGone} volumePresent=${!volumeGone}`
        + (detail ? ` (${detail})` : ''),
    );
    err.code = 'docker_cleanup_resources_still_present';
    err.containerRemoved = containerGone;
    err.volumeRemoved = volumeGone;
    throw err;
  }

  if (errors.length) {
    // Named resources are gone, but rm/volume-rm still failed — do not suppress.
    const first = errors[0];
    const err = first instanceof Error ? first : new Error(String(first));
    if (!err.code) err.code = 'docker_cleanup_rm_failed';
    err.containerRemoved = true;
    err.volumeRemoved = true;
    throw err;
  }

  return { ok: true, containerRemoved: true, volumeRemoved: true };
}

/**
 * @param {object} [options]
 * @param {() => boolean} [options.dockerAvailable]
 * @param {(args: string[]) => string} [options.docker]
 * @returns {Promise<{
 *   backend: 'docker' | 'pglite',
 *   admin: {host:string,port:number,user:string,password:string,database:string},
 *   cleanup: () => void | { ok: true, containerRemoved: true, volumeRemoved: true },
 *   container?: string,
 *   volume?: string,
 * }>}
 */
async function startDisposablePostgresHarness(options) {
  const opts = options || {};
  const isDockerAvailable = opts.dockerAvailable || dockerAvailable;
  const dockerFn = opts.docker || docker;

  const suffix = crypto.randomBytes(4).toString('hex');
  const USER = `wh_mig_u_${suffix}`;
  const PASSWORD = crypto.randomBytes(18).toString('base64url');

  if (isDockerAvailable()) {
    const CONTAINER = `wh-mig-${suffix}`;
    const VOLUME = `wh-mig-vol-${suffix}`;
    let started = false;
    try {
      dockerFn([
        'run', '-d', '--name', CONTAINER,
        '-e', `POSTGRES_USER=${USER}`,
        '-e', `POSTGRES_PASSWORD=${PASSWORD}`,
        '-e', 'POSTGRES_DB=postgres',
        '-p', '127.0.0.1::5432',
        '-v', `${VOLUME}:/var/lib/postgresql/data`,
        'postgres:15-alpine',
      ]);
      started = true;
      const portMap = String(dockerFn(['port', CONTAINER, '5432/tcp'])).trim();
      const portMatch = portMap.match(/:(\d+)\s*$/);
      if (!portMatch) {
        throw new Error(`docker port map unparseable: ${portMap.slice(0, 120)}`);
      }
      const port = Number(portMatch[1]);
      return {
        backend: 'docker',
        container: CONTAINER,
        volume: VOLUME,
        admin: { host: '127.0.0.1', port, user: USER, password: PASSWORD, database: 'postgres' },
        cleanup() {
          return cleanupDockerResources(dockerFn, CONTAINER, VOLUME);
        },
      };
    } catch (e) {
      if (started) {
        try {
          cleanupDockerResources(dockerFn, CONTAINER, VOLUME);
        } catch (_) {
          /* best-effort rollback; rethrow original setup error */
        }
      }
      throw e;
    }
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
  // Bind an ephemeral free port (suffix-derived ports collide under parallel/repeated proves).
  const net = require('net');
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const p = addr && typeof addr === 'object' ? addr.port : 0;
      probe.close((err) => (err ? reject(err) : resolve(p)));
    });
  });
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
  cleanupDockerResources,
};
