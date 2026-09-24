"""Offline security tests. All network/provider calls are explicit fixtures."""
import importlib
import importlib.util
import unittest
import json
import sys
from datetime import datetime
from types import ModuleType
from unittest.mock import Mock, patch
import io
import socket
import ssl
from contextlib import contextmanager
import subprocess
import os
from pathlib import Path


class WorkerProtocolTests(unittest.TestCase):
    def test_serialized_output_cap_and_malformed_stdin(self):
        script = "from wolfhouse import guest_public_worker as w; w._execute=lambda *args: {'ok':True,'text':'x'*200000}; w._main()"
        child = subprocess.run([sys.executable, '-c', script],
                               input=b'{"operation":"read","value":"fixture"}',
                               capture_output=True, timeout=5)
        self.assertLessEqual(len(child.stdout), 131072)
        self.assertEqual(json.loads(child.stdout), {'ok': False, 'error': 'response_too_large'})
        for raw in (b'not JSON', b'{}', b'[]', b'x' * 4097):
            child = subprocess.run([sys.executable, '-m', 'wolfhouse.guest_public_worker'],
                                   input=raw, capture_output=True, timeout=5)
            self.assertEqual(json.loads(child.stdout), {'ok': False, 'error': 'invalid_input'})
            self.assertEqual(child.stderr, b'')

    def test_worker_protocol_suppresses_python_and_fd_debug_output(self):
        self.assertTrue(callable(getattr(worker, '_main', None)), 'stdin worker entrypoint required')
        script = '''
import os, sys
from wolfhouse import guest_public_worker as w
def noisy(operation, value):
    print('private Python debug')
    print('private stderr', file=sys.stderr)
    os.write(1, b'private fd debug')
    return {'ok': False, 'error': 'search_unavailable'}
w._execute = noisy
w._main()
'''
        child = subprocess.run([sys.executable, '-c', script],
                               input=b'{"operation":"search","value":"beach"}',
                               capture_output=True, timeout=5)
        self.assertEqual(child.returncode, 0)
        self.assertEqual(json.loads(child.stdout), {'ok': False, 'error': 'search_unavailable'})
        self.assertEqual(child.stderr, b'')


@contextmanager
def wire_response(body=b'Public text', status=200, headers=None, addresses=None):
    """Only HTTP parsing is real; DNS, TCP and TLS are offline fixtures."""
    headers = {'Content-Type': 'text/plain', **(headers or {})}
    wire = (f'HTTP/1.1 {status} Fixture\r\n' + ''.join(
        f'{k}: {v}\r\n' for k, v in headers.items()) + '\r\n').encode() + body
    sock = Mock()
    sock.makefile.return_value = io.BytesIO(wire)
    ctx = ssl.create_default_context()
    addresses = addresses if addresses is not None else [
        (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443))]
    with patch.object(socket, 'getaddrinfo', return_value=addresses) as dns, \
         patch.object(socket, 'socket', return_value=sock) as factory, \
         patch.object(ssl, 'create_default_context', return_value=ctx), \
         patch.object(ctx, 'wrap_socket', return_value=sock) as tls:
        yield sock, dns, factory, tls, ctx


class ReadTests(unittest.TestCase):
    def test_access_barriers_are_not_returned_or_bypassed(self):
        for body in (b'<h1>Verify you are human</h1>', b'<div>Subscribe to continue</div>',
                     b'<div>Sign in to continue</div>', b'<script src="/cdn-cgi/challenge-platform/x"></script>',
                     b'<script type="application/ld+json">{"isAccessibleForFree":false}</script>',
                     b'<div class="g-recaptcha">secret article</div>'):
            with self.subTest(body=body), patch.object(worker, '_https_get', side_effect=[
                (b'User-agent: *\nDisallow:\n', 'text/plain'), (body, 'text/html')
            ]) as get:
                self.assertEqual(worker._execute('read', 'https://example.com/guide'),
                                 {'ok': False, 'error': 'access_restricted'})
                self.assertEqual(get.call_count, 2, 'no retry / bypass')

    def test_robots_is_fail_closed_and_never_fetches_denied_content(self):
        for raw, media, code in [
            (b'User-agent: *\nDisallow: /\n', 'text/plain', 'robots_denied'),
            (b'User-agent: *\nAllow: /\nDisallow: /guide\n', 'text/plain', 'robots_denied'),
            (b'User-agent: *\nDisallow: /*guide$\n', 'text/plain', 'robots_denied'),
            (b'User-agent: LunaPublicLookup\nDisallow: /\n', 'text/plain', 'robots_denied'),
            (b'<html>not robots</html>', 'text/html', 'robots_unavailable'),
            (b'', 'text/plain', 'robots_unavailable'),
            (b'not a robots policy', 'text/plain', 'robots_unavailable'),
            (b'User-agent: *\nDisallow /', 'text/plain', 'robots_unavailable'),
        ]:
            with self.subTest(raw=raw), patch.object(worker, '_https_get', return_value=(raw, media)) as get:
                self.assertEqual(worker._execute('read', 'https://example.com/guide'),
                                 {'ok': False, 'error': code})
                get.assert_called_once_with('https://example.com/robots.txt')
        for error in (TimeoutError('private exception'), worker.PublicWebError('redirect_denied'),
                      worker.PublicWebError('http_error'), OSError('private DNS detail')):
            with self.subTest(error=type(error)), patch.object(worker, '_https_get', side_effect=error) as get:
                self.assertEqual(worker._execute('read', 'https://example.com/guide'),
                                 {'ok': False, 'error': 'robots_unavailable'})
                self.assertEqual(get.call_count, 1)

    def test_read_checks_robots_then_extracts_inert_bounded_text(self):
        html = b'''<html><head><style>SECRET css</style><script>SECRET js</script></head>
        <body><h1>Beach &amp; tide</h1><p>Public guide.</p><!--SECRET comment-->
        <iframe>SECRET frame</iframe><svg><text>SECRET svg</text></svg>
        <template>SECRET template</template><form>SECRET form</form>
        <p hidden>SECRET hidden</p><a href="javascript:SECRET()" onclick="SECRET()">Walk</a>
        <img src="https://elsewhere.example/tracker"></body></html>'''
        for body, media, expected in [(html, 'text/html', 'Beach & tide Public guide. Walk'),
                                      (b'x' * 12000, 'text/plain', 'x' * 10000)]:
            with self.subTest(media=media), patch.object(worker, '_https_get', side_effect=[
                (b'User-agent: *\nDisallow: /private\n', 'text/plain'), (body, media)
            ]) as get, patch.object(worker, '_search', side_effect=AssertionError('not search')):
                result = worker._execute('read', 'https://example.com/guide')
                self.assertTrue(result['ok'], result)
                self.assertEqual(result['text'], expected)
                self.assertEqual(result['url'], 'https://example.com/guide')
                self.assertIsNotNone(datetime.fromisoformat(result['fetched_at']).tzinfo)
                self.assertIn('not a license', result['access_note'])
                self.assertEqual([c.args[0] for c in get.call_args_list],
                                 ['https://example.com/robots.txt', 'https://example.com/guide'])


class TransportTests(unittest.TestCase):
    def test_connection_timeout_and_tls_failure_close_socket(self):
        for boundary, error in [('connect', TimeoutError('offline fixture')),
                                ('tls', ssl.SSLCertVerificationError('offline fixture'))]:
            with self.subTest(boundary=boundary), wire_response() as (sock, _, _, tls, _):
                if boundary == 'connect':
                    sock.connect.side_effect = error
                else:
                    tls.side_effect = error
                with self.assertRaises(type(error)):
                    worker._https_get('https://example.com/')
                sock.close.assert_called()
                sock.sendall.assert_not_called()

    def test_http_policy_rejects_redirects_errors_types_encoding_and_oversize(self):
        cases = [
            ({'status': status, 'headers': {'Location': 'https://127.0.0.1/'}}, 'redirect_denied')
            for status in (300, 301, 302, 303, 304, 305, 307, 308)
        ] + [({'status': status}, 'http_error') for status in (401, 402, 403, 404, 429, 500)] + [
            ({'headers': {'Content-Type': media}}, 'unsupported_content')
            for media in ('application/pdf', 'application/json', 'image/png', 'text/javascript', '')
        ] + [
            ({'headers': {'Content-Encoding': 'gzip'}}, 'unsupported_content'),
            ({'headers': {'Content-Length': str(256 * 1024 + 1)}}, 'response_too_large'),
            ({'body': b'x' * (256 * 1024 + 1)}, 'response_too_large'),
        ]
        for fixture, code in cases:
            with self.subTest(fixture={k: str(v)[:80] for k, v in fixture.items()}), wire_response(**fixture) as (sock, dns, _, _, _):
                with self.assertRaises(worker.PublicWebError) as error:
                    worker._https_get('https://example.com/')
                self.assertEqual(error.exception.code, code)
                self.assertEqual(dns.call_count, 1, 'no redirect lookup permitted')
                self.assertEqual(sock.connect.call_count, 1)
                sock.close.assert_called()

    def test_any_nonpublic_dns_answer_denies_before_socket_creation(self):
        self.assertTrue(hasattr(worker, 'PublicWebError'), 'typed transport errors required')
        for ip in ('127.0.0.1', '10.0.0.2', '169.254.169.254', '100.64.0.1',
                   '0.0.0.0', '192.0.2.1', '224.0.0.1', '240.0.0.1',
                   '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1',
                   '64:ff9b::7f00:1', '2002:7f00:1::', 'ff02::1'):
            addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443)),
                         (socket.AF_INET6 if ':' in ip else socket.AF_INET,
                          socket.SOCK_STREAM, 6, '', (ip, 443))]
            with self.subTest(ip=ip), wire_response(addresses=addresses) as (_, _, factory, _, _):
                with self.assertRaises(worker.PublicWebError) as error:
                    worker._https_get('https://example.com/')
                self.assertEqual(error.exception.code, 'blocked_destination')
                factory.assert_not_called()
        with wire_response(addresses=[]) as (_, _, factory, _, _):
            with self.assertRaises(worker.PublicWebError):
                worker._https_get('https://example.com/')
            factory.assert_not_called()
        with wire_response() as (_, dns, factory, _, _):
            with self.assertRaises(worker.PublicWebError):
                worker._https_get('https://127.0.0.1/')
            dns.assert_not_called()
            factory.assert_not_called()

    def test_tcp_uses_validated_ip_but_tls_and_host_use_original_hostname(self):
        self.assertTrue(callable(getattr(worker, '_https_get', None)), 'pinned transport required')
        with wire_response() as (sock, dns, factory, tls, ctx):
            self.assertEqual(worker._https_get('https://example.com/guide'),
                             (b'Public text', 'text/plain'))
        dns.assert_called_once_with('example.com', 443, type=socket.SOCK_STREAM)
        sock.connect.assert_called_once_with(('93.184.216.34', 443))
        tls.assert_called_once_with(sock, server_hostname='example.com')
        self.assertTrue(ctx.check_hostname)
        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)
        sent = b''.join(c.args[0] for c in sock.sendall.call_args_list)
        self.assertIn(b'GET /guide HTTP/1.1', sent)
        self.assertIn(b'Host: example.com', sent)
        self.assertNotIn(b'Authorization:', sent)
        self.assertNotIn(b'Cookie:', sent)
        sock.close.assert_called()

from wolfhouse import guest_public_worker as worker


class SearchTests(unittest.TestCase):
    def test_null_or_structured_metadata_does_not_discard_valid_sources(self):
        for value in (None, 17, {}, [], False):
            with self.subTest(value=value):
                fake = ModuleType('tools.web_tools')
                fake.web_search_tool = Mock(return_value=json.dumps({
                    'success': True, 'data': {'web': [
                        {'url': 'https://example.org/first', 'title': value, 'description': value},
                        {'url': 'https://example.org/second', 'title': 'Public guide', 'description': 'Evidence'},
                    ]}}))
                with patch.dict(sys.modules, {'tools.web_tools': fake}):
                    result = worker._execute('search', 'public museums in Santander')
                self.assertTrue(result['ok'], result)
                self.assertEqual(result['results'], [
                    {'url': 'https://example.org/first', 'title': '', 'description': ''},
                    {'url': 'https://example.org/second', 'title': 'Public guide', 'description': 'Evidence'},
                ])

    def test_invalid_inputs_and_upstream_failures_are_sanitized(self):
        fake = ModuleType('tools.web_tools')
        tool = Mock(side_effect=RuntimeError('upstream-secret'))
        fake.web_search_tool = tool
        with patch.dict(sys.modules, {'tools.web_tools': fake}):
            for operation, value in [('exec', 'ls'), ([], 'x'), ('search', ''),
                                     ('search', 'a' * 301), ('search', None),
                                     ('search', 'a\nb'), ('read', 'http://localhost')]:
                with self.subTest(operation=operation, value=value):
                    self.assertEqual(worker._execute(operation, value),
                                     {'ok': False, 'error': 'invalid_input'})
            tool.assert_not_called()
            for raw in [RuntimeError('upstream-secret'), 'upstream-secret', '{}',
                        '{"success":false,"error":"secret"}',
                        '{"success":true,"data":{"web":"secret"}}']:
                tool.side_effect = raw if isinstance(raw, Exception) else None
                tool.return_value = raw
                self.assertEqual(worker._execute('search', 'beaches'),
                                 {'ok': False, 'error': 'search_unavailable'})

    def test_search_returns_only_bounded_public_metadata(self):
        self.assertTrue(callable(getattr(worker, '_execute', None)), 'fixed dispatcher required')
        tool = Mock(return_value=json.dumps({'success': True, 'data': {'web': [
            {'url': 'https://example.com/guide', 'title': 'T' * 400,
             'description': 'D' * 2000, 'secret': 'not forwarded'},
            {'url': 'http://localhost/secret', 'title': 'bad'},
            *[{'url': 'https://example.com/' + str(i)} for i in range(6)],
        ]}}))
        fake = ModuleType('tools.web_tools')
        fake.web_search_tool = tool
        with patch.dict(sys.modules, {'tools.web_tools': fake}):
            result = worker._execute('search', 'beaches Somo')
        tool.assert_called_once_with('beaches Somo', limit=4)
        self.assertTrue(result['ok'])
        self.assertEqual(len(result['results']), 4)
        self.assertEqual(set(result['results'][0]), {'url', 'title', 'description'})
        self.assertEqual(len(result['results'][0]['title']), 300)
        self.assertEqual(len(result['results'][0]['description']), 1200)
        self.assertIsNotNone(datetime.fromisoformat(result['fetched_at']).tzinfo)
from unittest.mock import patch


class PublicURLTests(unittest.TestCase):
    def test_static_url_policy_without_dns(self):
        spec = importlib.util.find_spec('wolfhouse.guest_public_worker')
        self.assertIsNotNone(spec, 'public worker module must exist')
        worker = importlib.import_module('wolfhouse.guest_public_worker')
        with patch('socket.getaddrinfo', side_effect=AssertionError('no DNS in filter')):
            for url in ('https://example.com', 'https://www.example.com:443/beach%20guide'):
                with self.subTest(url=url):
                    self.assertTrue(worker.validate_public_url(url))
            for url in (None, {}, '', 'http://example.com', 'file:///etc/passwd',
                        'https://u:p@example.com/', 'https://example.com?q=x',
                        'https://example.com?', 'https://example.com#',
                        'https://example.com:444/', 'https://127.0.0.1/',
                        'https://[::1]/', 'https://8.8.8.8/', 'https://localhost/',
                        'https://foo.localhost/', 'https://foo.internal/', 'https://foo.local/',
                        'https://foo.lan/', 'https://foo.home/', 'https://intranet/',
                        'https://2130706433/', 'https://127.1/', 'https://0x7f000001/',
                        'https://example.com./', 'https://example.com\\@evil.com/',
                        ' https://example.com/', 'https://example.com/\nfoo',
                        'https://example.com/%0d%0aHost:evil', 'https://example.com:bad',
                        'https://example.com/' + 'a' * 2048):
                with self.subTest(url=url):
                    self.assertFalse(worker.validate_public_url(url))
