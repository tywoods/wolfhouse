#!/usr/bin/env python3
import importlib.util
import json
import os
import pathlib
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

SCRIPT = pathlib.Path(__file__).with_name('verify-ghcr-anonymous-denial.py')
spec = importlib.util.spec_from_file_location('anonymous_denial', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
DIGEST = 'sha256:' + ('a' * 64)


class RegistryHandler(BaseHTTPRequestHandler):
    final_status = 401
    wrong_scope = False
    token_status = 200

    def log_message(self, *_args):
        return

    def do_GET(self):
        if self.path.startswith('/token?'):
            self.send_response(type(self).token_status)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            if type(self).token_status == 200:
                self.wfile.write(json.dumps({'token': 'anonymous-fixture-token'}).encode())
            else:
                self.wfile.write(b'{"errors":[{"code":"DENIED"}]}')
            return
        if self.path == f'/v2/owner/image/manifests/{DIGEST}':
            if self.headers.get('Authorization') == 'Bearer anonymous-fixture-token':
                self.send_response(type(self).final_status)
                if type(self).final_status in (401, 403):
                    self.send_header('Content-Type', 'application/json')
                self.end_headers()
                if type(self).final_status in (401, 403):
                    self.wfile.write(b'{"errors":[{"code":"DENIED"}]}')
                return
            scope = 'repository:owner/wrong:pull' if type(self).wrong_scope else 'repository:owner/image:pull'
            self.send_response(401)
            self.send_header(
                'WWW-Authenticate',
                f'Bearer realm="http://127.0.0.1:{self.server.server_port}/token",service="fixture",scope="{scope}"',
            )
            self.end_headers()
            return
        self.send_response(404)
        self.end_headers()


class RegistryFixture:
    def __init__(self, final_status=401, wrong_scope=False, token_status=200):
        handler = type('ConfiguredRegistryHandler', (RegistryHandler,), {
            'final_status': final_status,
            'wrong_scope': wrong_scope,
            'token_status': token_status,
        })
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return f'http://127.0.0.1:{self.server.server_port}'

    def __exit__(self, *_args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class AnonymousDenialTests(unittest.TestCase):
    def denial_challenge(self):
        return {'WWW-Authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:tywoods/image:pull"'}

    def test_bound_token_endpoint_denial_is_private_refusal(self):
        for status in (401, 403):
            with self.subTest(status=status), RegistryFixture(token_status=status) as base:
                result = module.verify_denial('registry.invalid/owner/image', DIGEST, base)
                self.assertEqual(result['token_status'], status)
                self.assertIsNone(result['final_status'])

    def test_missing_manifest_is_not_private_refusal(self):
        with mock.patch.object(module, 'request', return_value=(404, {}, b'')):
            with self.assertRaisesRegex(module.GateError, 'initial manifest status 404'):
                module.verify_denial('ghcr.io/tywoods/image', DIGEST)

    def test_malformed_token_response_fails_closed(self):
        challenge = {'WWW-Authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:tywoods/image:pull"'}
        responses = [(401, challenge, b''), (200, {'Content-Type': 'application/json'}, b'not-json')]
        with mock.patch.object(module, 'request', side_effect=responses):
            with self.assertRaisesRegex(module.GateError, 'token response'):
                module.verify_denial('ghcr.io/tywoods/image', DIGEST)

    def test_token_denial_requires_recognized_registry_error(self):
        bad = [
            ({'Content-Type': 'text/html'}, b'<html>policy block</html>'),
            ({'Content-Type': 'application/json'}, b'{not-json'),
            ({}, b''),
            ({'Content-Type': 'application/json'}, b'{"errors":[{"code":"UNKNOWN"}]}'),
        ]
        for headers, body in bad:
            with self.subTest(headers=headers, body=body), mock.patch.object(
                module, 'request', side_effect=[(401, self.denial_challenge(), b''), (403, headers, body)]
            ):
                with self.assertRaisesRegex(module.GateError, 'authorization denial'):
                    module.verify_denial('ghcr.io/tywoods/image', DIGEST)

    def test_final_manifest_denial_requires_recognized_registry_error(self):
        bad = [
            ({'Content-Type': 'text/html'}, b'<html>policy block</html>'),
            ({'Content-Type': 'application/json'}, b'{not-json'),
            ({}, b''),
            ({'Content-Type': 'application/json'}, b'{"errors":[{"code":"UNKNOWN"}]}'),
        ]
        token = (200, {'Content-Type': 'application/json'}, b'{"token":"synthetic-only"}')
        for headers, body in bad:
            with self.subTest(headers=headers, body=body), mock.patch.object(
                module, 'request', side_effect=[(401, self.denial_challenge(), b''), token, (403, headers, body)]
            ):
                with self.assertRaisesRegex(module.GateError, 'authorization denial'):
                    module.verify_denial('ghcr.io/tywoods/image', DIGEST)

    def test_network_ambiguity_fails_closed(self):
        with mock.patch.object(module, 'request', side_effect=module.GateError('registry request failed: timeout')):
            with self.assertRaisesRegex(module.GateError, 'request failed'):
                module.verify_denial('ghcr.io/tywoods/image', DIGEST)

    def test_foreign_token_realm_cannot_fake_denial(self):
        challenge = {'WWW-Authenticate': 'Bearer realm="https://evil.invalid/token",service="ghcr.io",scope="repository:tywoods/image:pull"'}
        with mock.patch.object(module, 'request', return_value=(401, challenge, b'')):
            with self.assertRaisesRegex(module.GateError, 'realm'):
                module.verify_denial('ghcr.io/tywoods/image', DIGEST)

    def test_wrong_token_service_cannot_fake_denial(self):
        challenge = {'WWW-Authenticate': 'Bearer realm="https://ghcr.io/token",service="evil.invalid",scope="repository:tywoods/image:pull"'}
        with mock.patch.object(module, 'request', return_value=(401, challenge, b'')):
            with self.assertRaisesRegex(module.GateError, 'service'):
                module.verify_denial('ghcr.io/tywoods/image', DIGEST)

    def test_request_does_not_follow_redirect_with_authorization(self):
        hits = []

        class Destination(BaseHTTPRequestHandler):
            def log_message(self, *_args): return
            def do_GET(self):
                hits.append(self.headers.get('Authorization'))
                self.send_response(200); self.end_headers()

        destination = ThreadingHTTPServer(('127.0.0.1', 0), Destination)

        class Redirect(BaseHTTPRequestHandler):
            def log_message(self, *_args): return
            def do_GET(self):
                self.send_response(302)
                self.send_header('Location', f'http://127.0.0.1:{destination.server_port}/capture')
                self.end_headers()

        redirect = ThreadingHTTPServer(('127.0.0.1', 0), Redirect)
        threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in (destination, redirect)]
        for thread in threads: thread.start()
        try:
            status, _, _ = module.request(f'http://127.0.0.1:{redirect.server_port}/start', {'Authorization': 'Bearer secret'})
        finally:
            for server in (destination, redirect): server.shutdown(); server.server_close()
            for thread in threads: thread.join(timeout=5)
        self.assertEqual(status, 302)
        self.assertEqual(hits, [])

    def test_private_manifest_denial_passes_complete_challenge_flow(self):
        with RegistryFixture(final_status=403) as base:
            result = module.verify_denial('registry.invalid/owner/image', DIGEST, base)
        self.assertEqual(result['initial_status'], 401)
        self.assertEqual(result['token_status'], 200)
        self.assertEqual(result['final_status'], 403)

    def test_public_manifest_after_anonymous_token_fails(self):
        with RegistryFixture(final_status=200) as base:
            with self.assertRaisesRegex(module.GateError, 'manifest success'):
                module.verify_denial('registry.invalid/owner/image', DIGEST, base)

    def test_wrong_repository_scope_fails_closed(self):
        with RegistryFixture(final_status=401, wrong_scope=True) as base:
            with self.assertRaisesRegex(module.GateError, 'scope'):
                module.verify_denial('registry.invalid/owner/image', DIGEST, base)

    def test_poisoned_helper_environment_is_never_consulted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            sentinel = root / 'helper-invoked'
            helper = root / 'docker-credential-pass'
            helper.write_text(f'#!/bin/sh\ntouch "{sentinel}"\nexit 99\n')
            helper.chmod(0o700)
            config = root / '.docker'
            config.mkdir()
            (config / 'config.json').write_text('{"credsStore":"pass"}\n')
            environment = {
                'PATH': f'{root}:{os.environ.get("PATH", "")}',
                'HOME': str(root),
                'DOCKER_CONFIG': str(config),
                'DOCKER_AUTH_CONFIG': '{"credsStore":"pass"}',
            }
            with mock.patch.dict(os.environ, environment, clear=False):
                with RegistryFixture(final_status=401) as base:
                    result = module.verify_denial('registry.invalid/owner/image', DIGEST, base)
            self.assertEqual(result['final_status'], 401)
            self.assertFalse(sentinel.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
