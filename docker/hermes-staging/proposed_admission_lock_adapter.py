"""PROPOSED injected synthetic adapter only; not wired admission or host I/O."""
from collections import namedtuple

Authority = namedtuple('Authority', 'identity')


def valid_identity(identity):
    return (type(identity) is tuple and len(identity) == 3
            and all(type(value) is str and value for value in identity))


class Adapter:
    def __init__(self, owner):
        self.owner = owner

    def admit(self, request=None):
        owner = self.owner
        identity = getattr(owner, 'execution_identity', None)
        if not valid_identity(request) or not valid_identity(identity) or request != identity:
            return None
        if owner.poisoned is not False:
            return None
        try:
            descriptor = owner.open_existing()
        except Exception:
            owner.poisoned = True
            return None
        locked = False
        transaction = None
        committed = False
        try:
            metadata = owner.custody(descriptor)
            if descriptor is not owner.lock_identity or not self._custody_valid(metadata):
                return None
            if owner.lock_exclusive_nonblocking(descriptor) is not True:
                return None
            locked = True
            metadata = owner.custody(descriptor)
            if descriptor is not owner.lock_identity or not self._custody_valid(metadata):
                return None
            transaction = owner.begin()
            record = transaction.read()
            if transaction.validate(record) is not True:
                owner.poisoned = True
                return None
            transaction.burn()
            transaction.commit()
            if owner.poisoned is not False:
                return None
            committed = True
            permission = transaction.authority()
            if (type(permission) is not Authority or not valid_identity(permission.identity)
                    or permission.identity != identity
                    or owner.execution_identity != identity):
                owner.poisoned = True
                return None
        except Exception:
            owner.poisoned = True
            return None
        finally:
            cleanup_failed = False
            if transaction is not None and not committed:
                try:
                    transaction.abort()
                except Exception:
                    cleanup_failed = True
            if locked:
                try:
                    owner.unlock(descriptor)
                except Exception:
                    cleanup_failed = True
            try:
                owner.close(descriptor)
            except Exception:
                cleanup_failed = True
            if (cleanup_failed or not valid_identity(getattr(owner, 'execution_identity', None))
                    or owner.execution_identity != identity):
                owner.poisoned = True
        if owner.poisoned:
            return None
        return permission

    @staticmethod
    def _custody_valid(metadata):
        # Closed synthetic trusted pins, never taken from candidate evidence.
        paths = ('/', '/var', '/var/lib', '/var/lib/pass4-authority',
                 '/var/lib/pass4-authority/admission.lock')
        fields = {'path', 'dev', 'inode', 'mode', 'uid', 'gid', 'type', 'symlink'}
        if type(metadata) is not dict or set(metadata) != {'ancestors', 'descriptor'}:
            return False
        ancestors = metadata['ancestors']
        if type(ancestors) is not list or len(ancestors) != 4:
            return False
        for index, node in enumerate(ancestors + [metadata['descriptor']]):
            file = index == 4
            required = fields | ({'nlink', 'size'} if file else set())
            if type(node) is not dict or set(node) != required:
                return False
            expected = dict(path=paths[index], dev=1, inode=index + 1,
                            mode=0o600 if file else (0o700 if index == 3 else 0o755), uid=0, gid=0,
                            type='regular' if file else 'directory', symlink=False)
            if file:
                expected.update(nlink=1, size=0)
            if any(type(node[key]) is not type(value) or node[key] != value
                   for key, value in expected.items()):
                return False
        return True
