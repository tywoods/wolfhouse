#!/usr/bin/env python3
"""Helper-free, read-only exact-digest OCI pull with automatic cleanup."""

from __future__ import annotations

import argparse
import base64
import contextlib
import getpass
import hashlib
import json
import pathlib
import re
import signal
import ssl
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import warnings

INDEX_TYPES = {
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
}
MANIFEST_TYPES = {
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
}
SUPPORTED_MANIFEST_TYPES = INDEX_TYPES | MANIFEST_TYPES
ACCEPT = ", ".join(sorted(SUPPORTED_MANIFEST_TYPES))
USER_AGENT = "wolfhouse-ghcr-readonly-pull/2"
GHCR_REALM = "https://ghcr.io/token"
GHCR_SERVICE = "ghcr.io"


class PullError(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_get(url: str, headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], bytes]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})}, method="GET")
    try:
        opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=ssl.create_default_context()),
            NoRedirect(),
        )
        with opener.open(request, timeout=60) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers.items()), error.read()
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise PullError(f"registry request failed: {type(error).__name__}") from error


def blob_get_with_safe_redirects(url: str, headers: dict[str, str], max_redirects: int = 3) -> tuple[int, dict[str, str], bytes]:
    current_url = url
    current_headers = dict(headers)
    for redirect_count in range(max_redirects + 1):
        status, response_headers, body = http_get(current_url, current_headers)
        if status not in {301, 302, 303, 307, 308}:
            return status, response_headers, body
        if redirect_count == max_redirects:
            raise PullError("too many blob redirects")
        location = find_header(response_headers, "location")
        if not location:
            raise PullError("blob redirect missing Location")
        destination = urllib.parse.urljoin(current_url, location)
        parsed = urllib.parse.urlsplit(destination)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            raise PullError("unsafe blob redirect destination")
        current_url = destination
        current_headers = {key: value for key, value in current_headers.items() if key.lower() != "authorization"}
    raise PullError("unreachable blob redirect state")


def find_header(headers: dict[str, str], name: str) -> str | None:
    return next((value for key, value in headers.items() if key.lower() == name.lower()), None)


def response_media_type(headers: dict[str, str]) -> str:
    value = find_header(headers, "content-type")
    return value.split(";", 1)[0].strip().lower() if value else ""


def challenge_fields(value: str | None) -> dict[str, str]:
    if not value or not value.lower().startswith("bearer "):
        raise PullError("Bearer challenge missing")
    fields = dict(re.findall(r'(\w+)="([^"]*)"', value[7:]))
    if not all(fields.get(key) for key in ("realm", "service", "scope")):
        raise PullError("Bearer challenge is incomplete")
    return fields


def verify_digest(data: bytes, digest: str) -> None:
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise PullError("descriptor is not an exact sha256 digest")
    actual = "sha256:" + hashlib.sha256(data).hexdigest()
    if actual != digest:
        raise PullError("downloaded bytes do not match descriptor digest")


def validate_descriptor(value: object, *, manifest: bool) -> tuple[str, int, str]:
    if not isinstance(value, dict):
        raise PullError("malformed OCI descriptor")
    digest = value.get("digest")
    size = value.get("size")
    media_type = value.get("mediaType")
    if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise PullError("malformed OCI descriptor digest")
    if not isinstance(size, int) or isinstance(size, bool) or size < 0:
        raise PullError("malformed OCI descriptor size")
    if not isinstance(media_type, str) or not media_type:
        raise PullError("malformed OCI descriptor mediaType")
    if manifest and media_type not in SUPPORTED_MANIFEST_TYPES:
        raise PullError("unsupported referenced manifest mediaType")
    return digest, size, media_type


def acquire_token(registry: str, repository: str, digest: str, username: str, password: str) -> str:
    if registry != "ghcr.io":
        raise PullError("only ghcr.io is accepted")
    manifest_url = f"https://{registry}/v2/{repository}/manifests/{digest}"
    status, headers, _ = http_get(manifest_url, {"Accept": ACCEPT})
    if status != 401:
        raise PullError(f"expected authenticated package challenge, got HTTP {status}")
    fields = challenge_fields(find_header(headers, "www-authenticate"))
    expected_scope = f"repository:{repository}:pull"
    if fields["realm"] != GHCR_REALM:
        raise PullError("unexpected GHCR token realm")
    if fields["service"] != GHCR_SERVICE:
        raise PullError("unexpected GHCR token service")
    if fields["scope"] != expected_scope:
        raise PullError("unexpected GHCR repository scope")
    encoded = base64.b64encode(f"{username}:{password}".encode()).decode()
    token_url = GHCR_REALM + "?" + urllib.parse.urlencode({"service": GHCR_SERVICE, "scope": expected_scope})
    token_status, _, body = http_get(token_url, {"Accept": "application/json", "Authorization": f"Basic {encoded}"})
    encoded = ""
    if token_status != 200:
        raise PullError(f"token endpoint returned HTTP {token_status}")
    try:
        payload = json.loads(body)
        token = payload.get("token") or payload.get("access_token")
    except (json.JSONDecodeError, UnicodeDecodeError, AttributeError) as error:
        raise PullError("token endpoint returned invalid JSON") from error
    if not isinstance(token, str) or not token:
        raise PullError("token endpoint returned no token")
    return token


def read_password_no_echo() -> str:
    if not sys.stdin.isatty():
        raise PullError("no-echo password input is unavailable")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            password = getpass.getpass("GHCR read:packages token: ")
    except (getpass.GetPassWarning, EOFError, KeyboardInterrupt) as error:
        raise PullError("no-echo password input is unavailable") from error
    if not password:
        raise PullError("empty token refused")
    return password


def raise_on_termination(signum, _frame) -> None:
    raise PullError(f"interrupted by signal {signum}; temporary files removed")


@contextlib.contextmanager
def cleanup_signal_handlers():
    handled = [signal.SIGINT, signal.SIGTERM]
    for name in ("SIGHUP", "SIGQUIT"):
        candidate = getattr(signal, name, None)
        if candidate is not None:
            handled.append(candidate)
    previous = {item: signal.getsignal(item) for item in handled}
    try:
        for item in handled:
            signal.signal(item, raise_on_termination)
        yield
    finally:
        for item, handler in previous.items():
            signal.signal(item, handler)


def pull_exact(image: str, digest: str, username: str, password: str) -> dict[str, int]:
    normalized = image.removeprefix("https://").rstrip("/")
    registry, slash, repository = normalized.partition("/")
    if not slash or registry != "ghcr.io":
        raise PullError("only ghcr.io/repository images are accepted")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise PullError("digest must be an exact lowercase sha256")

    token = acquire_token(registry, repository, digest, username, password)
    authorization = {"Authorization": f"Bearer {token}"}
    seen_manifests: dict[str, tuple[int, str]] = {}
    seen_blobs: dict[str, int] = {}
    total_bytes = 0

    with cleanup_signal_handlers(), tempfile.TemporaryDirectory(prefix="ghcr-readonly-pull-") as directory:
        root = pathlib.Path(directory)

        def fetch_blob(descriptor: object) -> None:
            nonlocal total_bytes
            blob_digest, expected_size, _ = validate_descriptor(descriptor, manifest=False)
            if blob_digest in seen_blobs:
                if seen_blobs[blob_digest] != expected_size:
                    raise PullError("conflicting repeated blob descriptor size")
                return
            status, _, data = blob_get_with_safe_redirects(f"https://{registry}/v2/{repository}/blobs/{blob_digest}", authorization)
            if status != 200:
                raise PullError(f"blob request returned HTTP {status}")
            verify_digest(data, blob_digest)
            if len(data) != expected_size:
                raise PullError("downloaded blob size does not match descriptor")
            (root / blob_digest.replace(":", "_")).write_bytes(data)
            seen_blobs[blob_digest] = len(data)
            total_bytes += len(data)

        def fetch_manifest(manifest_digest: str, expected_size: int | None = None, expected_type: str | None = None) -> None:
            nonlocal total_bytes
            if manifest_digest in seen_manifests:
                verified_size, verified_type = seen_manifests[manifest_digest]
                if expected_size is not None and expected_size != verified_size:
                    raise PullError("conflicting repeated manifest descriptor size")
                if expected_type is not None and expected_type != verified_type:
                    raise PullError("conflicting repeated manifest descriptor mediaType")
                return
            status, headers, data = http_get(
                f"https://{registry}/v2/{repository}/manifests/{manifest_digest}",
                {**authorization, "Accept": ACCEPT},
            )
            if status != 200:
                raise PullError(f"manifest request returned HTTP {status}")
            verify_digest(data, manifest_digest)
            if expected_size is not None and len(data) != expected_size:
                raise PullError("downloaded manifest size does not match descriptor")
            response_type = response_media_type(headers)
            if response_type not in SUPPORTED_MANIFEST_TYPES:
                raise PullError("unsupported or missing manifest response mediaType")
            if expected_type is not None and response_type != expected_type:
                raise PullError("conflicting descriptor and response mediaTypes")
            try:
                document = json.loads(data)
            except (json.JSONDecodeError, UnicodeDecodeError) as error:
                raise PullError("malformed manifest JSON") from error
            if not isinstance(document, dict) or document.get("schemaVersion") != 2:
                raise PullError("malformed manifest structure")
            declared_type = document.get("mediaType")
            if declared_type is not None:
                if declared_type not in SUPPORTED_MANIFEST_TYPES or declared_type != response_type:
                    raise PullError("conflicting JSON and response mediaTypes")
            seen_manifests[manifest_digest] = (len(data), response_type)
            total_bytes += len(data)

            if response_type in INDEX_TYPES:
                children = document.get("manifests")
                if not isinstance(children, list) or not children or "config" in document or "layers" in document:
                    raise PullError("malformed OCI index structure")
                for child in children:
                    child_digest, child_size, child_type = validate_descriptor(child, manifest=True)
                    fetch_manifest(child_digest, child_size, child_type)
                return

            if "manifests" in document:
                raise PullError("malformed OCI image manifest structure")
            config = document.get("config")
            layers = document.get("layers")
            if not isinstance(config, dict) or not isinstance(layers, list):
                raise PullError("malformed OCI image manifest structure")
            fetch_blob(config)
            for layer in layers:
                fetch_blob(layer)

        fetch_manifest(digest)

    token = ""
    return {"manifests": len(seen_manifests), "blobs": len(seen_blobs), "bytes": total_bytes}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("digest")
    parser.add_argument("--username", required=True)
    args = parser.parse_args()
    password = ""
    try:
        password = read_password_no_echo()
        result = pull_exact(args.image, args.digest, args.username, password)
    except PullError as error:
        print(f"FAIL {error}", file=sys.stderr)
        return 1
    finally:
        password = ""
    print(json.dumps({**result, "result": "exact digest verified; temporary bytes removed"}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
