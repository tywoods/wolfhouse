#!/usr/bin/env node
'use strict';

/**
 * verify-luna-tenant-defaults
 * Prove unsafe client_slug defaults are gone from active Hermes tool paths.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PLUGIN = path.join(ROOT, 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py');
const PAUSE = path.join(ROOT, 'docker/hermes-staging/wolfhouse/pause_gate.py');
const MIRROR = path.join(ROOT, 'docker/hermes-staging/wolfhouse_whatsapp_mirror.py');
const COMPOSE_SU = path.join(ROOT, 'docker/hermes-sunset/docker-compose.vm.yml');

let pass = 0;
let fail = 0;
function assert(label, ok, detail) {
  if (ok) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); fail += 1; }
}

console.log('\nverify-luna-tenant-defaults\n');
const plugin = fs.readFileSync(PLUGIN, 'utf8');
assert('has _trusted_client_slug', /def _trusted_client_slug/.test(plugin));
assert('no payload.setdefault wolfhouse-somo', !/setdefault\("client_slug",\s*"wolfhouse-somo"\)/.test(plugin));
assert('_post_bot fails closed without LUNA_CLIENT_SLUG', /LUNA_CLIENT_SLUG is required/.test(plugin));
assert('rejects unknown tenant', /Unknown Luna tenant slug/.test(plugin));
assert('sardinero denied when not bound', /Sardinero is not enabled/.test(plugin));

const pause = fs.readFileSync(PAUSE, 'utf8');
assert('pause_gate does not default wolfhouse-somo', !/return "wolfhouse-somo"/.test(pause));
assert('pause_gate fail-closed missing slug', /pause_gate_missing_client_slug/.test(pause));

const mirror = fs.readFileSync(MIRROR, 'utf8');
assert('mirror does not invent DEFAULT_CLIENT_SLUG wolfhouse', !/DEFAULT_CLIENT_SLUG\s*=\s*"wolfhouse-somo"/.test(mirror));
assert('mirror skips when slug missing', /missing_luna_client_slug/.test(mirror));

const su = fs.readFileSync(COMPOSE_SU, 'utf8');
assert('sunset compose allows only sunset-somo location', /LUNA_ALLOWED_LOCATION_IDS:\s*sunset-somo\b/.test(su));
assert('sunset compose does not list sunset-sardinero allow', !/sunset-sardinero/.test(su.split('SUNSET_INGRESS')[0]));

// Runtime unit via python — exercise real _post_bot (mock HTTP, not the helper).
const py = `
import json, os, sys, io
from unittest.mock import patch
sys.path.insert(0, "docker/hermes-staging/plugins")
import wolfhouse_staff_api as mod

captured = []

class FakeResp:
    def __init__(self, body):
        self._body = body.encode("utf-8")
    def read(self):
        return self._body
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False

def fake_urlopen(req, timeout=30):
    body = req.data.decode("utf-8") if isinstance(req.data, (bytes, bytearray)) else str(req.data or "")
    payload = json.loads(body) if body else {}
    captured.append(payload)
    return FakeResp(json.dumps({"success": True, "needs_human": True, "conversation_paused": True}))

os.environ["LUNA_BOT_INTERNAL_TOKEN"] = "tok"
os.environ["WOLFHOUSE_STAFF_API_BASE_URL"] = "https://example.test"
os.environ["WOLFHOUSE_WHATSAPP_GUEST_PHONE"] = "+34999111000"

# Sunset: model wolfhouse-somo must become sunset
captured.clear()
os.environ["LUNA_CLIENT_SLUG"] = "sunset"
os.environ["SUNSET_INGRESS_LOCATION_ID"] = "sunset-somo"
os.environ["LUNA_ALLOWED_LOCATION_IDS"] = "sunset-somo"
with patch("urllib.request.urlopen", fake_urlopen):
    out = json.loads(mod.flag_needs_human({"client_slug":"wolfhouse-somo","phone":"+34000000000","reason":"human_requested"}))
print(json.dumps({"sunset_slug": captured[-1].get("client_slug"), "ok": captured[-1].get("client_slug")=="sunset" and out.get("needs_human") is True}))

# Wolfhouse: model sunset rewritten
captured.clear()
os.environ["LUNA_CLIENT_SLUG"] = "wolfhouse-somo"
for k in ("SUNSET_INGRESS_LOCATION_ID","LUNA_ALLOWED_LOCATION_IDS"):
    os.environ.pop(k, None)
with patch("urllib.request.urlopen", fake_urlopen):
    out = json.loads(mod.flag_needs_human({"client_slug":"sunset","reason":"human_requested"}))
print(json.dumps({"wh_slug": captured[-1].get("client_slug"), "ok": captured[-1].get("client_slug")=="wolfhouse-somo"}))

# Missing slug fails closed (trusted helper + write path)
os.environ.pop("LUNA_CLIENT_SLUG", None)
captured.clear()
denied_missing = mod._post_bot("/conversation/needs-human", {"reason":"x","client_slug":"wolfhouse-somo"})
print(json.dumps({
  "missing_slug": mod._trusted_client_slug() == "" and denied_missing.get("staff_api_status")=="tenant_scope_denied" and len(captured)==0,
  "ok": mod._trusted_client_slug() == "" and denied_missing.get("success") is False and len(captured)==0,
}))

# Unknown tenant
os.environ["LUNA_CLIENT_SLUG"]="other"
denied = mod._post_bot("/conversation/needs-human", {"reason":"x"})
print(json.dumps({"unknown_denied": denied.get("staff_api_status")=="tenant_scope_denied", "ok": denied.get("success") is False}))

# Sardinero rejected on Somo runtime
os.environ["LUNA_CLIENT_SLUG"]="sunset"
os.environ["SUNSET_INGRESS_LOCATION_ID"]="sunset-somo"
os.environ["LUNA_ALLOWED_LOCATION_IDS"]="sunset-somo"
denied2 = mod._post_bot("/conversation/needs-human", {"location_id":"sunset-sardinero","reason":"x"})
print(json.dumps({
  "sardi_denied": denied2.get("success") is False and "Sardinero" in str(denied2.get("error") or ""),
  "ok": denied2.get("success") is False,
}))
`;
try {
  const out = execFileSync('python3', ['-c', py], { cwd: ROOT, encoding: 'utf8' });
  for (const line of out.trim().split('\n')) {
    const j = JSON.parse(line);
    const key = Object.keys(j).find((k) => k !== 'ok');
    assert(`runtime:${key}`, j.ok === true, line);
  }
} catch (e) {
  assert('runtime tenant checks', false, String(e.stdout || e.message).slice(0, 400));
}

console.log(`\nverify-luna-tenant-defaults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
