"""Standalone source-only terminal owner. Not installed or gateway-integrated."""
import json
import math
import os
from pathlib import Path
import sqlite3


class JournalDenied(RuntimeError):
    """No authority granted."""


def _finite_number(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


class TerminalOperationJournal:
    def __init__(self, path, identity, *, cancellation_verifier, effect_verifier, bootstrap=False):
        self.db = None
        self.halted = False
        try:
            self._initialize(path, identity, cancellation_verifier=cancellation_verifier, effect_verifier=effect_verifier, bootstrap=bootstrap)
        except (OSError, sqlite3.Error, TypeError, ValueError, JournalDenied) as exc:
            self.close()
            raise JournalDenied('missing, corrupt, drifted or inaccessible custody') from exc

    def _initialize(self, path, identity, *, cancellation_verifier, effect_verifier, bootstrap=False):
        if set(identity) != {'tenant', 'endpoint', 'request', 'operation', 'lane', 'source', 'config'} or any(type(v) is not str or not v for v in identity.values()):
            raise JournalDenied('invalid identity')
        if not callable(cancellation_verifier) or not callable(effect_verifier):
            raise JournalDenied('trusted verifiers required')
        self.path = Path(path).absolute()
        if self.path.resolve() != self.path:
            raise JournalDenied('symlink custody path')
        parent = self.path.parent.lstat()
        if parent.st_uid != os.geteuid() or parent.st_mode & 0o022:
            raise JournalDenied('unsafe parent custody')
        self.identity = json.dumps(identity, sort_keys=True, separators=(',', ':'))
        self.cancellation_verifier = cancellation_verifier
        self.effect_verifier = effect_verifier
        self.db = None
        if bootstrap:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(fd)
        stat = self.path.lstat()
        parent = self.path.parent.stat()
        if self.path.is_symlink() or not self.path.is_file() or stat.st_nlink != 1 or stat.st_uid != os.geteuid() or stat.st_mode & 0o077:
            raise JournalDenied('unsafe journal custody')
        self.custody = (stat.st_dev, stat.st_ino, parent.st_dev, parent.st_ino)
        self.db = sqlite3.connect(self.path.as_uri() + '?mode=rw', uri=True, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA synchronous=FULL')
        if bootstrap:
            self.db.execute('BEGIN IMMEDIATE')
            self.db.execute('CREATE TABLE owner (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL, reservation TEXT, evidence TEXT, cancellation TEXT, cleanup_done INTEGER NOT NULL)')
            self.db.execute('INSERT INTO owner VALUES (1, ?, 0, "READY", NULL, NULL, NULL, 0)', (self.identity,))
            self.db.execute('COMMIT')
            fd = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        self.snapshot()

    def snapshot(self):
        try:
            return self._snapshot()
        except (OSError, sqlite3.Error, TypeError, ValueError, JournalDenied) as exc:
            self.halted = True
            raise JournalDenied('storage/custody uncertainty') from exc

    def _snapshot(self):
        if self.halted or self.db is None:
            raise JournalDenied('owner halted; external custody recovery required')
        stat = self.path.lstat()
        parent = self.path.parent.stat()
        if self.path.resolve() != self.path or parent.st_uid != os.geteuid() or parent.st_mode & 0o022 or self.path.is_symlink() or stat.st_nlink != 1 or stat.st_uid != os.geteuid() or stat.st_mode & 0o077 or (stat.st_dev, stat.st_ino, parent.st_dev, parent.st_ino) != self.custody:
            raise JournalDenied('custody changed')
        schema = self.db.execute('SELECT name, sql FROM sqlite_master ORDER BY name').fetchall()
        expected = 'CREATE TABLE owner (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL, reservation TEXT, evidence TEXT, cancellation TEXT, cleanup_done INTEGER NOT NULL)'
        if [(r[0], r[1]) for r in schema] != [('owner', expected)]:
            raise JournalDenied('schema drift')
        if self.db.execute('PRAGMA user_version').fetchone()[0] != 0 or self.db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise JournalDenied('schema or integrity drift')
        rows = self.db.execute('SELECT * FROM owner').fetchall()
        if len(rows) != 1:
            raise JournalDenied('missing established owner')
        row = dict(rows[0])
        if row['id'] != 1 or row['identity'] != self.identity or type(row['generation']) is not int or row['generation'] < 0 or row['status'] not in ('READY', 'ACTIVE', 'COMMITTED', 'CANCEL_POISONED', 'UNCERTAIN_DENY'):
            raise JournalDenied('identity or state drift')
        if row['reservation'] is not None and (type(row['reservation']) is not str or not row['reservation']):
            raise JournalDenied('reservation drift')
        if row['status'] == 'COMMITTED' and (row['evidence'] is None or row['reservation'] is None):
            raise JournalDenied('committed evidence missing')
        if row['status'] == 'READY' and (row['generation'] != 0 or row['reservation'] is not None or row['evidence'] is not None):
            raise JournalDenied('ready state drift')
        if row['status'] != 'READY' and row['generation'] < 1:
            raise JournalDenied('fence drift')
        if row['status'] in ('CANCEL_POISONED', 'UNCERTAIN_DENY') and row['generation'] < 1 + (row['reservation'] is not None):
            raise JournalDenied('terminal fence drift')
        if row['evidence'] is not None:
            if row['reservation'] is None or row['status'] not in ('COMMITTED', 'CANCEL_POISONED'):
                raise JournalDenied('evidence state drift')
            json.loads(row['evidence'], parse_constant=lambda value: (_ for _ in ()).throw(ValueError('nonfinite evidence')))
        if type(row['cleanup_done']) is not int or row['cleanup_done'] not in (0, 1):
            raise JournalDenied('cleanup drift')
        if row['status'] == 'CANCEL_POISONED':
            claim = json.loads(row['cancellation'])
            if type(claim) is not dict or set(claim) != {'principal', 'nonce', 'expires'} or any(type(claim[k]) is not str or not claim[k] for k in ('principal', 'nonce')) or not _finite_number(claim['expires']):
                raise JournalDenied('retained cancellation drift')
        elif row['cancellation'] is not None or row['cleanup_done'] != 0:
            raise JournalDenied('cancellation state drift')
        return row

    def _transaction(self, action):
        if self.halted or self.db is None:
            raise JournalDenied('owner halted; external custody recovery required')
        try:
            self.db.execute('BEGIN IMMEDIATE')
            row = self.snapshot()
            result = action(row)
            self.snapshot()
            self.db.execute('COMMIT')
            return result
        except (sqlite3.Error, OSError) as exc:
            self.halted = True
            # Best effort durable uncertainty, never overwrite confirmed terminal
            # evidence. If storage remains broken, caller MUST halt every owner
            # and retain external custody; local flags are not host enforcement.
            try:
                if self.db.in_transaction:
                    self.db.execute('ROLLBACK')
                self.db.execute('BEGIN IMMEDIATE')
                self._custody_for_recovery()
                self.db.execute('UPDATE owner SET status="UNCERTAIN_DENY", generation=generation+1 WHERE id=1 AND identity=? AND status IN ("READY", "ACTIVE")', (self.identity,))
                self.db.execute('COMMIT')
            except Exception:
                try:
                    if self.db.in_transaction:
                        self.db.execute('ROLLBACK')
                except Exception:
                    pass
            raise JournalDenied('storage/commit uncertainty; halt all custody; no acknowledgment') from exc
        except Exception:
            if self.db.in_transaction:
                self.db.execute('ROLLBACK')
            raise

    def _custody_for_recovery(self):
        halted = self.halted
        self.halted = False
        try:
            self._snapshot()
        finally:
            self.halted = halted

    def admit(self):
        def action(row):
            if row['status'] != 'READY':
                raise JournalDenied('terminal or occupied custody')
            generation = row['generation'] + 1
            self.db.execute('UPDATE owner SET status="ACTIVE", generation=? WHERE id=1', (generation,))
            return generation
        return self._transaction(action)

    def check(self, generation):
        def action(row):
            if type(generation) is not int or generation != row['generation'] or row['status'] != 'ACTIVE':
                raise JournalDenied('stale or denied owner')
            return row['status']
        return self._transaction(action)

    def cancel(self, generation, credential, *, now, cleanup):
        """Verifier must authenticate, authorize and bind this identity and expiry.

        The returned closed claim is trusted ONLY because the injected verifier
        is trusted. Matching claim strings are not authentication. Cleanup runs
        after durable refusal; no success acknowledgment on cleanup uncertainty.
        """
        if not _finite_number(now):
            raise JournalDenied('invalid clock')
        def action(row):
            try:
                claim = self.cancellation_verifier(json.loads(self.identity), credential, now)
            except Exception as exc:
                raise JournalDenied('verifier failure') from exc
            if type(claim) is not dict or set(claim) != {'principal', 'nonce', 'expires'} or any(type(claim[k]) is not str or not claim[k] for k in ('principal', 'nonce')) or not _finite_number(claim['expires']) or not claim['expires'] > now:
                raise JournalDenied('unauthorized or expired')
            if type(generation) is not int or generation != row['generation'] or row['status'] not in ('READY', 'ACTIVE', 'COMMITTED'):
                raise JournalDenied('stale or replayed cancellation')
            encoded = json.dumps(claim, sort_keys=True, separators=(',', ':'), allow_nan=False)
            self.db.execute('UPDATE owner SET status="CANCEL_POISONED", generation=generation+1, cancellation=?, cleanup_done=0 WHERE id=1', (encoded,))
            return ('CANCEL_POISONED', generation + 1)
        result = self._transaction(action)
        try:
            cleanup()
            def finalize(row):
                if row['status'] != result[0] or row['generation'] != result[1]:
                    raise JournalDenied('final custody drift')
                self.db.execute('UPDATE owner SET cleanup_done=1 WHERE id=1')
            self._transaction(finalize)
        except Exception as exc:
            raise JournalDenied('cleanup/final custody uncertainty; no acknowledgment') from exc
        return result

    def _active(self, row, generation):
        if type(generation) is not int or generation != row['generation'] or row['status'] != 'ACTIVE':
            raise JournalDenied('stale or denied owner')

    def reserve_effect(self, generation, effect):
        """Durable linearization only; cannot unsend external in-flight I/O.

        One effect per operation. Never blindly retry an unresolved reservation.
        This owner performs no I/O and grants no independent transport bypass.
        """
        def action(row):
            self._active(row, generation)
            if type(effect) is not str or not effect or row['reservation'] is not None:
                raise JournalDenied('invalid or previously reserved effect')
            self.db.execute('UPDATE owner SET reservation=? WHERE id=1', (effect,))
            return (effect, generation)
        return self._transaction(action)

    def commit_effect(self, generation, effect, evidence):
        def action(row):
            self._active(row, generation)
            if row['reservation'] != effect or row['reservation'] is None or row['evidence'] is not None:
                raise JournalDenied('unreserved or immutable outcome')
            try:
                verified = self.effect_verifier(json.loads(self.identity), evidence)
                encoded = json.dumps(evidence, sort_keys=True, allow_nan=False)
            except Exception as exc:
                raise JournalDenied('effect evidence verifier failure') from exc
            if verified is not True:
                raise JournalDenied('trusted business effect evidence required')
            self.db.execute('UPDATE owner SET status="COMMITTED", evidence=? WHERE id=1', (encoded,))
        return self._transaction(action)

    def mark_uncertain(self, generation):
        def action(row):
            self._active(row, generation)
            self.db.execute('UPDATE owner SET status="UNCERTAIN_DENY", generation=generation+1 WHERE id=1')
        return self._transaction(action)

    def startup_check(self):
        """Read-before-scheduling; never reconstruct ACTIVE as fresh authority."""
        def action(row):
            if row['status'] != 'READY':
                raise JournalDenied('startup denied: occupied or terminal custody')
            return 'READY'
        return self._transaction(action)

    def release(self, generation):
        def action(row):
            if row['status'] == 'CANCEL_POISONED' and row['cleanup_done'] != 1:
                raise JournalDenied('cleanup not confirmed')
            if type(generation) is not int or generation != row['generation'] or row['status'] not in ('COMMITTED', 'CANCEL_POISONED'):
                raise JournalDenied('unresolved or stale custody cannot release')
            return (row['status'], generation)
        return self._transaction(action)

    def close(self):
        if self.db is not None:
            self.db.close()
            self.db = None
