"""Public reader HTTP fixtures; DNS/TCP/TLS mocked, no live requests."""
import gzip
import io
import socket
import ssl
from contextlib import contextmanager
from unittest.mock import Mock, patch
import unittest
from wolfhouse import guest_public_worker as worker
from wolfhouse.test_guest_public_worker import wire_response


@contextmanager
def sequence(responses):
    """Real HTTP parser with a fresh offline socket for every request."""
    sockets = []
    for status, headers, body in responses:
        headers = {'Content-Type': 'text/plain', 'Content-Length': str(len(body)), **headers}
        raw = (f'HTTP/1.1 {status} Fixture\r\n' + ''.join(
            f'{k}: {v}\r\n' for k, v in headers.items()) + '\r\n').encode() + body
        sock = Mock()
        sock.makefile.return_value = io.BytesIO(raw)
        sockets.append(sock)
    ctx = Mock()
    ctx.wrap_socket.side_effect = lambda raw, **kw: raw
    with patch.object(socket, 'getaddrinfo', return_value=[
            (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34',443))]) as dns, \
         patch.object(socket, 'socket', side_effect=sockets), \
         patch.object(ssl, 'create_default_context', return_value=ctx):
        yield sockets, dns


class ReaderPolishTests(unittest.TestCase):
    def test_redirect_checks_target_robots_before_read_and_returns_final_url(self):
        for allowed in (True, False):
            policy = b'User-agent: *\nDisallow:\n' if allowed else b'User-agent: *\nDisallow: /guide\n'
            replies = [(200, {}, b'User-agent: *\nDisallow:\n'),
                       (302, {'Location': 'https://other.example/guide'}, b''),
                       (200, {}, policy)]
            if allowed:
                replies.append((200, {'Content-Encoding': 'gzip'}, gzip.compress(b'Beach guide')))
            with self.subTest(allowed=allowed), sequence(replies) as (socks, dns):
                result = worker._execute('read', 'https://example.com/old')
                if allowed:
                    self.assertTrue(result['ok'], result)
                    self.assertEqual(result['url'], 'https://other.example/guide')
                    self.assertEqual(result['text'], 'Beach guide')
                else:
                    self.assertEqual(result, {'ok': False, 'error': 'robots_denied'})
                self.assertEqual(dns.call_count, len(replies))
                requests = [b''.join(c.args[0] for c in sock.sendall.call_args_list) for sock in socks]
                self.assertIn(b'GET /robots.txt ', requests[2])
                self.assertIn(b'Host: other.example', requests[2])

    def test_redirected_robots_policy_still_applies_to_original_content_path(self):
        with sequence([(302, {'Location': 'https://policy.example/rules'}, b''),
                       (200, {}, b'User-agent: *\nDisallow: /guide\n')]) as (_, dns):
            result = worker._execute('read', 'https://example.com/guide')
        self.assertEqual(result, {'ok': False, 'error': 'robots_denied'})
        self.assertEqual(dns.call_count, 2)

    def test_full_read_redirect_exhaustion_keeps_policy_checks(self):
        responses = []
        for n in range(4):
            responses.extend([(404, {}, b''), (302, {'Location': '/page' + str(n + 1)}, b'')])
        with sequence(responses) as (_, dns):
            result = worker._execute('read', 'https://example.com/page0')
        self.assertEqual(result, {'ok': False, 'error': 'redirect_denied'})
        self.assertEqual(dns.call_count, 8)

    def test_multiple_gzip_members_share_decoded_limit(self):
        body = gzip.compress(b'x' * 200000) + gzip.compress(b'y' * 100000)
        with sequence([(200, {'Content-Encoding': 'gzip'}, body)]):
            with self.assertRaises(worker.PublicWebError) as caught:
                worker._https_get('https://example.com/guide')
        self.assertEqual(caught.exception.code, 'response_too_large')

    def test_relative_redirects_are_bounded_and_revalidate_every_hop(self):
        with sequence([(301, {'Location': '/guide'}, b''), (200, {}, b'Guide')]) as (_, dns):
            self.assertEqual(worker._https_get('https://example.com/old'), (b'Guide', 'text/plain'))
            self.assertEqual(dns.call_count, 2)
        with sequence([(302, {'Location': '/loop'}, b'')] * 4) as (_, dns):
            with self.assertRaises(worker.PublicWebError) as caught:
                worker._https_get('https://example.com/loop')
            self.assertEqual(caught.exception.code, 'redirect_denied')
            self.assertEqual(dns.call_count, 4)
        for target in ('http://example.com/guide', 'https://127.0.0.1/', 'https://example.com/?token=private'):
            with self.subTest(target=target), sequence([(302, {'Location': target}, b'')]) as (_, dns):
                with self.assertRaises(worker.PublicWebError) as caught:
                    worker._https_get('https://example.com/old')
                self.assertEqual(caught.exception.code, 'redirect_denied')
                self.assertEqual(dns.call_count, 1)

    def test_redirect_to_private_dns_is_blocked_without_second_socket(self):
        with sequence([(302, {'Location': 'https://other.example/guide'}, b'')]) as (socks, dns):
            dns.side_effect = [[(socket.AF_INET,socket.SOCK_STREAM,6,'',('93.184.216.34',443))],
                               [(socket.AF_INET,socket.SOCK_STREAM,6,'',('127.0.0.1',443))]]
            with self.assertRaises(worker.PublicWebError) as caught:
                worker._https_get('https://example.com/old')
            self.assertEqual(caught.exception.code, 'blocked_destination')
            self.assertEqual(dns.call_count, 2)

    def test_missing_robots_allows_page_but_unavailable_policy_does_not(self):
        from unittest.mock import patch
        for status in (404, 410):
            with self.subTest(status=status), wire_response(status=status):
                try:
                    worker._check_robots('https://example.com/guide')
                except worker.PublicWebError as error:
                    self.fail(f'No robots policy (HTTP {status}) should allow public access: {error}')
        for status in (401, 403, 429, 500):
            with self.subTest(status=status), wire_response(status=status):
                with self.assertRaises(worker.PublicWebError) as caught:
                    worker._check_robots('https://example.com/guide')
                self.assertEqual(caught.exception.code, 'robots_unavailable')

    def test_gzip_decodes_public_text_with_bounded_expansion(self):
        with wire_response(body=gzip.compress(b'Beach guide'), headers={'Content-Encoding':'gzip'}):
            self.assertEqual(worker._https_get('https://example.com/guide'), (b'Beach guide','text/plain'))
        with wire_response(body=gzip.compress(b'x' * (256*1024+1)), headers={'Content-Encoding':'gzip'}):
            with self.assertRaises(worker.PublicWebError) as caught:
                worker._https_get('https://example.com/guide')
            self.assertEqual(caught.exception.code, 'response_too_large')
        for body in (b'not gzip', gzip.compress(b'Beach guide')[:-5]):
            with wire_response(body=body, headers={'Content-Encoding':'gzip'}):
                with self.assertRaises(worker.PublicWebError) as caught:
                    worker._https_get('https://example.com/guide')
                self.assertEqual(caught.exception.code, 'unsupported_content')


if __name__ == '__main__':
    unittest.main()
