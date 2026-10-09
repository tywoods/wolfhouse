#!/usr/bin/env python3
"""Verify that an exact OCI manifest is denied after anonymous bearer exchange."""

from __future__ import annotations

import argparse
import json
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

ACCEPT = ", ".join((
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
))
USER_AGENT = "wolfhouse-ghcr-privacy-gate/1"


class GateError(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(url: str, headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], bytes]:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, **(headers or {})},
        method="GET",
    )
    try:
        opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=ssl.create_default_context()),
            NoRedirect(),
        )
        with opener.open(req, timeout=30) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers.items()), error.read()
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise GateError(f"registry request failed: {type(error).__name__}") from error


def header(headers: dict[str, str], name: str) -> str | None:
    wanted = name.lower()
    return next((value for key, value in headers.items() if key.lower() == wanted), None)


def parse_bearer_challenge(value: str | None) -> dict[str, str]:
    if not value or not value.lower().startswith("bearer "):
        raise GateError("unexpected registry challenge: Bearer challenge missing")
    fields = dict(re.findall(r'(\w+)="([^"]*)"', value[7:]))
    if not fields.get("realm") or not fields.get("service") or not fields.get("scope"):
        raise GateError("unexpected registry challenge: realm/service/scope missing")
    return fields


def normalize_image(image: str) -> tuple[str, str]:
    image = image.removeprefix("https://").removeprefix("http://").rstrip("/")
    registry, slash, repository = image.partition("/")
    if not slash or not repository:
        raise GateError("image must include registry and repository")
    return registry, repository


def require_registry_authorization_denial(headers: dict[str, str], body: bytes, endpoint: str) -> list[str]:
    content_type = (header(headers, "content-type") or "").split(";", 1)[0].strip().lower()
    if content_type != "application/json":
        raise GateError(f"{endpoint} authorization denial is not Registry v2 JSON")
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise GateError(f"{endpoint} authorization denial is malformed") from error
    errors = payload.get("errors") if isinstance(payload, dict) else None
    if not isinstance(errors, list) or not errors:
        raise GateError(f"{endpoint} authorization denial has no registry errors")
    recognized = {"DENIED", "UNAUTHORIZED"}
    codes: list[str] = []
    for entry in errors:
        code = entry.get("code") if isinstance(entry, dict) else None
        if not isinstance(code, str) or code not in recognized:
            raise GateError(f"{endpoint} authorization denial has an unrelated registry error")
        codes.append(code)
    return codes


def verify_denial(image: str, digest: str, registry_base: str | None = None) -> dict[str, object]:
    registry, repository = normalize_image(image)
    if not registry_base and registry != "ghcr.io":
        raise GateError("production privacy gate accepts only ghcr.io")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise GateError("digest must be an exact lowercase sha256")

    base = (registry_base or f"https://{registry}").rstrip("/")
    manifest_url = f"{base}/v2/{repository}/manifests/{digest}"

    initial_status, initial_headers, _ = request(manifest_url, {"Accept": ACCEPT})
    if initial_status == 200:
        raise GateError("unexpected anonymous manifest success before challenge")
    if initial_status != 401:
        raise GateError(f"unexpected initial manifest status {initial_status}")

    challenge = parse_bearer_challenge(header(initial_headers, "www-authenticate"))
    expected_scope = f"repository:{repository}:pull"
    if challenge["scope"] != expected_scope:
        raise GateError("unexpected registry challenge scope")

    realm = challenge["realm"]
    if registry_base:
        expected_realm = base + "/token"
        expected_service = "fixture"
    else:
        expected_realm = "https://ghcr.io/token"
        expected_service = "ghcr.io"
    if realm != expected_realm:
        raise GateError("unexpected registry challenge realm")
    if challenge["service"] != expected_service:
        raise GateError("unexpected registry challenge service")

    token_url = realm + "?" + urllib.parse.urlencode({
        "service": challenge["service"],
        "scope": challenge["scope"],
    })
    token_status, token_headers, token_body = request(token_url, {"Accept": "application/json"})
    if token_status in {401, 403}:
        denial_codes = require_registry_authorization_denial(token_headers, token_body, "token endpoint")
        return {
            "image": image,
            "digest": digest,
            "initial_status": initial_status,
            "token_status": token_status,
            "final_status": None,
            "denial_codes": denial_codes,
            "result": "anonymous token issuance denied",
        }
    if token_status != 200:
        raise GateError(f"unexpected anonymous token status {token_status}")
    try:
        payload = json.loads(token_body)
        token = payload.get("token") or payload.get("access_token")
    except (json.JSONDecodeError, UnicodeDecodeError, AttributeError) as error:
        raise GateError("unexpected anonymous token response") from error
    if not isinstance(token, str) or not token:
        raise GateError("unexpected anonymous token response: token missing")

    final_status, final_headers, final_body = request(manifest_url, {
        "Accept": ACCEPT,
        "Authorization": f"Bearer {token}",
    })
    token = ""
    if final_status == 200:
        raise GateError("unexpected anonymous exact-digest manifest success")
    if final_status not in {401, 403}:
        raise GateError(f"unexpected final manifest status {final_status}")
    denial_codes = require_registry_authorization_denial(final_headers, final_body, "final manifest")

    return {
        "image": image,
        "digest": digest,
        "initial_status": initial_status,
        "token_status": token_status,
        "final_status": final_status,
        "denial_codes": denial_codes,
        "result": "anonymous authorization denied",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("digest")
    parser.add_argument("--registry-base", help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        result = verify_denial(args.image, args.digest, args.registry_base)
    except GateError as error:
        print(f"FAIL {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
