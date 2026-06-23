#!/usr/bin/env python3
"""Extract admin JS block from staging /staff/ui for local merge."""
from pathlib import Path
import urllib.request
import json
import ssl

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / '_work' / 'admin-ui-block.js'

ctx = ssl.create_default_context()

def req(method, url, body=None, cookie=''):
    r = urllib.request.Request(url, data=body, method=method)
    r.add_header('Content-Type', 'application/json')
    r.add_header('Accept', 'application/json')
    if cookie:
        r.add_header('Cookie', cookie)
    with urllib.request.urlopen(r, context=ctx) as resp:
        return resp.read().decode('utf-8'), resp.headers.get('Set-Cookie') or ''

login_body = json.dumps({
    'client': 'sunset',
    'email': 'tywoods@gmail.com',
    'password': 'SunsetStaging2026!',
}).encode('utf-8')
_, set_cookie = req('POST', 'https://sunset-staging.lunafrontdesk.com/staff/auth/login', login_body)
cookies = '; '.join(part.split(';')[0] for part in set_cookie.split(',') if part.strip())
html, _ = req('GET', 'https://sunset-staging.lunafrontdesk.com/staff/ui', cookie=cookies)

start = html.find('var adminConfigCache = null;')
end = html.find('\nvar customersCache = []', start)
if start < 0 or end < 0:
    raise SystemExit(f'admin block not found start={start} end={end}')

block = html[start:end]
OUT.write_text(block, encoding='utf-8')
print('OK wrote', OUT, 'bytes', len(block))
