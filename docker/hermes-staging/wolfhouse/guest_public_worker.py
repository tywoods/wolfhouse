"""Conservative public-web worker; no browser, proxy, extraction service or cache."""
import ipaddress
import json
import os
import sys
from datetime import datetime, timezone
import re
import http.client
import socket
import ssl
from urllib.parse import unquote, urlsplit
from html.parser import HTMLParser
from urllib.robotparser import RobotFileParser


class _Text(HTMLParser):
    OMIT = {'head', 'script', 'style', 'noscript', 'iframe', 'svg', 'math',
            'template', 'object', 'embed', 'form'}
    VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
            'link', 'meta', 'param', 'source', 'track', 'wbr'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hidden = []
        self.text = []

    def handle_starttag(self, tag, attrs):
        if tag in self.VOID:
            return
        if self.hidden or tag in self.OMIT or 'hidden' in dict(attrs):
            self.hidden.append(tag)

    def handle_endtag(self, tag):
        if self.hidden and tag == self.hidden[-1]:
            self.hidden.pop()

    def handle_data(self, data):
        if not self.hidden:
            self.text.append(data)


def _check_robots(url):
    """Fail closed. Conservatively honor Disallow from ALL groups, including globs.

    This intentionally denies some RFC-allowed requests (e.g. Allow exceptions),
    rather than relying on robotparser's first-match/no-wildcard limitations.
    """
    parts = urlsplit(url)
    try:
        body, media = _https_get('https://' + parts.netloc + '/robots.txt')
        if media != 'text/plain':
            raise ValueError('not robots text')
        lines = body.decode('utf-8-sig').splitlines()
        directives = []
        agent_seen = False
        for line in lines:
            line = line.split('#', 1)[0].strip()
            if not line:
                continue
            key, separator, value = line.partition(':')
            key, value = key.strip().lower(), value.strip()
            if not separator or key not in {'user-agent', 'allow', 'disallow', 'sitemap', 'crawl-delay', 'request-rate'}:
                raise ValueError('unsupported robots policy')
            if key == 'user-agent':
                if not value:
                    raise ValueError('empty agent')
                agent_seen = True
            if key in ('allow', 'disallow'):
                if not agent_seen or (value and not value.startswith('/')):
                    raise ValueError('malformed rule')
                directives.append((key, unquote(value)))
        if not agent_seen or not directives:
            raise ValueError('missing policy')
    except Exception:
        raise PublicWebError('robots_unavailable') from None
    path = unquote(parts.path or '/')
    for key, value in directives:
        if key == 'disallow' and value:
            end = '$' if value.endswith('$') else ''
            value = value[:-1] if end else value
            pattern = '^' + '.*'.join(re.escape(x) for x in value.split('*')) + end
            if re.search(pattern, path):
                raise PublicWebError('robots_denied')
    robots = RobotFileParser()
    robots.parse(lines)
    if not robots.can_fetch('LunaPublicLookup', url):
        raise PublicWebError('robots_denied')


def _read(url):
    _check_robots(url)
    body, media = _https_get(url)
    text = body.decode('utf-8', errors='replace')
    # Heuristics only; never execute JS, authenticate, pay, retry, or bypass a gate.
    if re.search(r'verify (?:that )?you are human|subscribe to (?:continue|read)|'
                 r'(?:sign|log) in to (?:continue|read)|captcha|challenge-platform|'
                 r'isAccessibleForFree[\"\s:]*false|paywall', text, re.I):
        raise PublicWebError('access_restricted')
    if media == 'text/html':
        parser = _Text()
        parser.feed(text)
        parser.close()
        text = ' '.join(parser.text)
    return {'ok': True, 'url': url, 'text': ' '.join(text.split())[:10000],
            'fetched_at': datetime.now(timezone.utc).isoformat(),
            'access_note': 'Public access and robots permission are not a license; source terms still apply.'}


class PublicWebError(Exception):
    """Internal reason code, never an upstream exception message."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _public_address(value):
    address = ipaddress.ip_address(value)
    if not address.is_global or address.is_multicast or address.is_reserved:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        # Avoid IPv4 embedding/translation mechanisms, even on older Python tables.
        if address.ipv4_mapped or address.sixtofour or address.teredo:
            return False
        if address in ipaddress.ip_network('64:ff9b::/96'):
            return False
    return True


def _https_get(url):
    if not validate_public_url(url):
        raise PublicWebError('invalid_input')
    parts = urlsplit(url)
    host = parts.hostname
    addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    if not addresses or any(
        family not in (socket.AF_INET, socket.AF_INET6) or not _public_address(address[0])
        for family, _, _, _, address in addresses
    ):
        raise PublicWebError('blocked_destination')
    family, kind, proto, _, address = addresses[0]
    raw = socket.socket(family, kind, proto)
    connection = http.client.HTTPConnection(host, 443, timeout=5)
    try:
        raw.settimeout(5)
        raw.connect(address)
        connection.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host)
        connection.request('GET', parts.path or '/', headers={
            'User-Agent': 'LunaPublicLookup/1.0', 'Accept-Encoding': 'identity',
            'Accept': 'text/html, text/plain', 'Connection': 'close',
        })
        response = connection.getresponse()
        if 300 <= response.status < 400:
            raise PublicWebError('redirect_denied')
        if not 200 <= response.status < 300:
            raise PublicWebError('http_error')
        media = response.getheader('Content-Type', '').split(';', 1)[0].strip().lower()
        if media not in ('text/html', 'text/plain') or response.getheader('Content-Encoding', 'identity').lower() != 'identity':
            raise PublicWebError('unsupported_content')
        length = response.getheader('Content-Length')
        if length is not None and int(length) > 256 * 1024:
            raise PublicWebError('response_too_large')
        body = response.read(256 * 1024 + 1)
        if len(body) > 256 * 1024:
            raise PublicWebError('response_too_large')
        return body, media
    finally:
        connection.close()
        raw.close()


def validate_public_url(value):
    """Static boolean filter only. The transport separately checks EVERY DNS address."""
    if not isinstance(value, str) or not 1 <= len(value) <= 2048:
        return False
    if any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value):
        return False
    if any(c in value for c in '\\?#') or not value.isascii():
        return False
    if re.search(r'%0[0-9a-f]|%1[0-9a-f]|%7f|%5c', value, re.I):
        return False
    try:
        parts = urlsplit(value)
        host = parts.hostname or ''
        if parts.scheme != 'https' or parts.username is not None or parts.password is not None:
            return False
        if parts.port not in (None, 443) or not host or host.endswith('.'):
            return False
        if parts.netloc.lower() not in (host, host + ':443'):
            return False
        labels = host.split('.')
        if len(labels) < 2 or len(host) > 253 or not labels[-1].isalpha():
            return False
        if any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', x) for x in labels):
            return False
        if any(x in {'localhost', 'internal', 'local', 'lan', 'home', 'intranet'} for x in labels):
            return False
        try:
            ipaddress.ip_address(host)
        except ValueError:
            return True
        return False
    except ValueError:
        return False


def _valid_input(operation, value):
    if operation == 'read':
        return validate_public_url(value)
    return (operation == 'search' and isinstance(value, str)
            and 1 <= len(value) <= 300 and bool(value.strip())
            and all(c.isprintable() for c in value))


def _execute(operation, value):
    if not _valid_input(operation, value):
        return {'ok': False, 'error': 'invalid_input'}
    try:
        return _search(value) if operation == 'search' else _read(value)
    except PublicWebError as error:
        return {'ok': False, 'error': error.code}
    except TimeoutError:
        return {'ok': False, 'error': 'timeout'}
    except Exception:
        return {'ok': False, 'error': 'search_unavailable' if operation == 'search' else 'read_unavailable'}


def _search(value):
    from tools.web_tools import web_search_tool
    data = json.loads(web_search_tool(value, limit=4))
    if data.get('success') is not True or not isinstance(data.get('data', {}).get('web'), list):
        raise ValueError('invalid search response')
    results = []
    for item in data['data']['web']:
        if isinstance(item, dict) and validate_public_url(item.get('url')):
            results.append({
                'url': item['url'], 'title': item.get('title', '')[:300],
                'description': item.get('description', '')[:1200],
            })
        if len(results) == 4:
            break
    return {'ok': True, 'results': results,
            'fetched_at': datetime.now(timezone.utc).isoformat()}


def _main():
    # Only the private protocol descriptor can reach the parent. FD redirection
    # also suppresses C extensions/os.write and debug output during lazy imports.
    with os.fdopen(os.dup(1), 'wb') as protocol, open(os.devnull, 'wb') as sink:
        os.dup2(sink.fileno(), 1)
        os.dup2(sink.fileno(), 2)
        try:
            raw = sys.stdin.buffer.read(4097)
            if len(raw) > 4096:
                raise ValueError('oversize input')
            request = json.loads(raw)
            result = _execute(request['operation'], request['value'])
        except Exception:
            result = {'ok': False, 'error': 'invalid_input'}
        encoded = json.dumps(result, ensure_ascii=True).encode()
        if len(encoded) > 131072:
            encoded = b'{"ok":false,"error":"response_too_large"}'
        protocol.write(encoded)


if __name__ == '__main__':
    _main()
