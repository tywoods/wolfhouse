#!/usr/bin/env python3
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

MODULE_PATH = pathlib.Path(__file__).with_name('pull-ghcr-digest-helper-free.py')
SPEC = importlib.util.spec_from_file_location('helper_free_pull', MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError('could not load helper-free pull module')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def digest(data: bytes) -> str:
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def json_bytes(value: dict) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


class HelperFreePullTests(unittest.TestCase):
    def repeated_descriptor_fixture(self, mode: str):
        manifest_type = 'application/vnd.oci.image.manifest.v1+json'
        index_type = 'application/vnd.oci.image.index.v1+json'
        config_type = 'application/vnd.oci.image.config.v1+json'
        layer_type = 'application/vnd.oci.image.layer.v1.tar'
        layer = b'\0' * 1024
        config = json_bytes({'architecture': 'amd64', 'os': 'linux'})
        layer_descriptor = {'digest': digest(layer), 'size': len(layer), 'mediaType': layer_type}
        layers = [layer_descriptor]
        if mode == 'blob_wrong_size':
            layers.append({**layer_descriptor, 'size': len(layer) + 1})
        child = json_bytes({
            'schemaVersion': 2,
            'mediaType': manifest_type,
            'config': {'digest': digest(config), 'size': len(config), 'mediaType': config_type},
            'layers': layers,
        })
        child_descriptor = {'digest': digest(child), 'size': len(child), 'mediaType': manifest_type}
        children = [child_descriptor, dict(child_descriptor)]
        if mode == 'manifest_wrong_size':
            children[1]['size'] += 1
        elif mode == 'manifest_wrong_type':
            children[1]['mediaType'] = index_type
        root = json_bytes({'schemaVersion': 2, 'manifests': children})
        objects = {
            digest(root): (index_type, root),
            digest(child): (manifest_type, child),
            digest(config): ('application/octet-stream', config),
            digest(layer): ('application/octet-stream', layer),
        }
        return digest(root), objects

    def run_repeated_descriptor_fixture(self, mode: str):
        root_digest, objects = self.repeated_descriptor_fixture(mode)
        requested = []

        def fake_http_get(url, headers=None):
            object_digest = url.rsplit('/', 1)[-1]
            requested.append(object_digest)
            content_type, body = objects[object_digest]
            return 200, {'Content-Type': content_type}, body

        with mock.patch.object(MODULE, 'acquire_token', return_value='fixture-token'), mock.patch.object(
            MODULE, 'http_get', side_effect=fake_http_get
        ):
            result = MODULE.pull_exact('ghcr.io/tywoods/fresh-private-name', root_digest, 'owner', 'fixture-password')
        return result, requested

    def fixture(self, corrupt_layer: bool = False, omit_index_media_type: bool = False):
        config = b'{"architecture":"amd64","os":"linux"}'
        layer = b'complete-layer-bytes'
        config_digest = digest(config)
        layer_digest = digest(layer)
        child = json_bytes({
            'schemaVersion': 2,
            'mediaType': 'application/vnd.oci.image.manifest.v1+json',
            'config': {'mediaType': 'application/vnd.oci.image.config.v1+json', 'digest': config_digest, 'size': len(config)},
            'layers': [{'mediaType': 'application/vnd.oci.image.layer.v1.tar+gzip', 'digest': layer_digest, 'size': len(layer)}],
        })
        child_digest = digest(child)
        root_document = {
            'schemaVersion': 2,
            'mediaType': 'application/vnd.oci.image.index.v1+json',
            'manifests': [{'mediaType': 'application/vnd.oci.image.manifest.v1+json', 'digest': child_digest, 'size': len(child)}],
        }
        if omit_index_media_type:
            del root_document['mediaType']
        root = json_bytes(root_document)
        root_digest = digest(root)
        objects = {
            ('manifests', root_digest): root,
            ('manifests', child_digest): child,
            ('blobs', config_digest): config,
            ('blobs', layer_digest): b'corrupt' if corrupt_layer else layer,
        }
        return root_digest, objects, {root_digest, child_digest}, {config_digest, layer_digest}

    def run_pull(self, corrupt_layer: bool = False, omit_index_media_type: bool = False):
        root_digest, objects, expected_manifests, expected_blobs = self.fixture(corrupt_layer, omit_index_media_type)
        requested = []
        temp_paths = []
        real_temporary_directory = tempfile.TemporaryDirectory

        def fake_http_get(url, headers=None):
            kind = 'manifests' if '/manifests/' in url else 'blobs'
            object_digest = url.rsplit('/', 1)[-1]
            requested.append((kind, object_digest))
            body = objects[(kind, object_digest)]
            if kind == 'manifests':
                content_type = json.loads(body).get('mediaType') or 'application/vnd.oci.image.index.v1+json'
            else:
                content_type = 'application/octet-stream'
            return 200, {'Content-Type': content_type}, body

        def recording_temporary_directory(*args, **kwargs):
            directory = real_temporary_directory(*args, **kwargs)
            temp_paths.append(pathlib.Path(directory.name))
            return directory

        with mock.patch.object(MODULE, 'acquire_token', return_value='fixture-token'), \
             mock.patch.object(MODULE, 'http_get', side_effect=fake_http_get), \
             mock.patch.object(MODULE.tempfile, 'TemporaryDirectory', side_effect=recording_temporary_directory):
            if corrupt_layer:
                with self.assertRaisesRegex(MODULE.PullError, 'do not match descriptor digest'):
                    MODULE.pull_exact('ghcr.io/tywoods/fresh-private-name', root_digest, 'owner', 'fixture-password')
                result = None
            else:
                result = MODULE.pull_exact('ghcr.io/tywoods/fresh-private-name', root_digest, 'owner', 'fixture-password')

        self.assertEqual(set(requested), {('manifests', value) for value in expected_manifests} | {('blobs', value) for value in expected_blobs})
        self.assertTrue(temp_paths)
        self.assertTrue(all(not path.exists() for path in temp_paths))
        return result, expected_manifests, expected_blobs

    def test_pull_fetches_every_manifest_config_and_layer_then_cleans_up(self):
        result, manifests, blobs = self.run_pull()
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result['manifests'], len(manifests))
        self.assertEqual(result['blobs'], len(blobs))
        self.assertGreater(result['bytes'], 0)

    def test_index_without_json_media_type_uses_response_type_and_recurses(self):
        result, manifests, blobs = self.run_pull(omit_index_media_type=True)
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result['manifests'], len(manifests))
        self.assertEqual(result['blobs'], len(blobs))

    def test_consistent_repeated_descriptors_are_deduplicated(self):
        result, requested = self.run_repeated_descriptor_fixture('valid')
        self.assertEqual(result['manifests'], 2)
        self.assertEqual(result['blobs'], 2)
        self.assertEqual(len(requested), 4)

    def test_repeated_manifest_with_contradictory_size_fails(self):
        with self.assertRaisesRegex(MODULE.PullError, 'repeated manifest descriptor'):
            self.run_repeated_descriptor_fixture('manifest_wrong_size')

    def test_repeated_manifest_with_contradictory_type_fails(self):
        with self.assertRaisesRegex(MODULE.PullError, 'repeated manifest descriptor'):
            self.run_repeated_descriptor_fixture('manifest_wrong_type')

    def test_repeated_blob_with_contradictory_size_fails(self):
        with self.assertRaisesRegex(MODULE.PullError, 'repeated blob descriptor'):
            self.run_repeated_descriptor_fixture('blob_wrong_size')

    def test_corrupt_layer_prevents_finished_pull_result_and_still_cleans_up(self):
        result, _, _ = self.run_pull(corrupt_layer=True)
        self.assertIsNone(result)

    def test_conflicting_response_and_json_media_types_fail_closed(self):
        root_digest, objects, _, _ = self.fixture()

        def fake_http_get(url, headers=None):
            kind = 'manifests' if '/manifests/' in url else 'blobs'
            body = objects[(kind, url.rsplit('/', 1)[-1])]
            return 200, {'Content-Type': 'application/vnd.oci.image.manifest.v1+json'}, body

        with mock.patch.object(MODULE, 'acquire_token', return_value='fixture-token'), mock.patch.object(MODULE, 'http_get', side_effect=fake_http_get):
            with self.assertRaisesRegex(MODULE.PullError, 'conflicting'):
                MODULE.pull_exact('ghcr.io/tywoods/fresh-private-name', root_digest, 'owner', 'fixture-password')

    def test_malformed_manifest_structure_does_not_report_finished_pull(self):
        root = json_bytes({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json'})
        root_digest = digest(root)
        with mock.patch.object(MODULE, 'acquire_token', return_value='fixture-token'), mock.patch.object(
            MODULE, 'http_get', return_value=(200, {'Content-Type': 'application/vnd.oci.image.manifest.v1+json'}, root)
        ):
            with self.assertRaisesRegex(MODULE.PullError, 'malformed'):
                MODULE.pull_exact('ghcr.io/tywoods/fresh-private-name', root_digest, 'owner', 'fixture-password')

    def test_foreign_auth_realm_is_rejected(self):
        headers = {'WWW-Authenticate': 'Bearer realm="https://evil.invalid/token",service="ghcr.io",scope="repository:tywoods/fresh-private-name:pull"'}
        with mock.patch.object(MODULE, 'http_get', return_value=(401, headers, b'')):
            with self.assertRaisesRegex(MODULE.PullError, 'realm'):
                MODULE.acquire_token('ghcr.io', 'tywoods/fresh-private-name', 'sha256:' + 'a' * 64, 'owner', 'secret')

    def test_no_tty_refuses_password_instead_of_getpass_fallback(self):
        with mock.patch.object(MODULE.sys.stdin, 'isatty', return_value=False), mock.patch.object(MODULE.getpass, 'getpass') as prompt:
            with self.assertRaisesRegex(MODULE.PullError, 'no-echo'):
                MODULE.read_password_no_echo()
        prompt.assert_not_called()

    def test_getpass_warning_refuses_fallback_input(self):
        with mock.patch.object(MODULE.sys.stdin, 'isatty', return_value=True), mock.patch.object(
            MODULE.getpass, 'getpass', side_effect=MODULE.getpass.GetPassWarning('fallback')
        ):
            with self.assertRaisesRegex(MODULE.PullError, 'no-echo'):
                MODULE.read_password_no_echo()

    def test_sigterm_is_configured_to_raise_for_cleanup(self):
        with self.assertRaisesRegex(MODULE.PullError, 'signal'):
            MODULE.raise_on_termination(MODULE.signal.SIGTERM, None)

    def test_sigterm_during_blob_fetch_removes_temporary_directory(self):
        root_digest, objects, _, _ = self.fixture()
        temp_paths = []
        real_temporary_directory = tempfile.TemporaryDirectory

        def fake_http_get(url, headers=None):
            if '/blobs/' in url:
                MODULE.raise_on_termination(MODULE.signal.SIGTERM, None)
            body = objects[('manifests', url.rsplit('/', 1)[-1])]
            return 200, {'Content-Type': json.loads(body)['mediaType']}, body

        def recording_temporary_directory(*args, **kwargs):
            directory = real_temporary_directory(*args, **kwargs)
            temp_paths.append(pathlib.Path(directory.name))
            return directory

        with mock.patch.object(MODULE, 'acquire_token', return_value='fixture-token'), \
             mock.patch.object(MODULE, 'http_get', side_effect=fake_http_get), \
             mock.patch.object(MODULE.tempfile, 'TemporaryDirectory', side_effect=recording_temporary_directory):
            with self.assertRaisesRegex(MODULE.PullError, 'signal'):
                MODULE.pull_exact('ghcr.io/tywoods/fresh-private-name', root_digest, 'owner', 'fixture-password')
        self.assertTrue(temp_paths)
        self.assertTrue(all(not path.exists() for path in temp_paths))

    def test_authenticated_http_client_does_not_follow_redirect(self):
        hits = []

        class Destination(BaseHTTPRequestHandler):
            def log_message(self, format, *args): return
            def do_GET(self):
                hits.append(self.headers.get('Authorization'))
                self.send_response(200); self.end_headers()

        destination = ThreadingHTTPServer(('127.0.0.1', 0), Destination)

        class Redirect(BaseHTTPRequestHandler):
            def log_message(self, format, *args): return
            def do_GET(self):
                self.send_response(302)
                self.send_header('Location', f'http://127.0.0.1:{destination.server_port}/capture')
                self.end_headers()

        redirect = ThreadingHTTPServer(('127.0.0.1', 0), Redirect)
        threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in (destination, redirect)]
        for thread in threads: thread.start()
        try:
            status, _, _ = MODULE.http_get(f'http://127.0.0.1:{redirect.server_port}/start', {'Authorization': 'Basic secret'})
        finally:
            for server in (destination, redirect): server.shutdown(); server.server_close()
            for thread in threads: thread.join(timeout=5)
        self.assertEqual(status, 302)
        self.assertEqual(hits, [])

    def test_blob_redirect_is_https_only_and_strips_authorization(self):
        with mock.patch.object(MODULE, 'http_get', side_effect=[
            (307, {'Location': 'https://signed-storage.invalid/object?sig=fixture'}, b''),
            (200, {'Content-Type': 'application/octet-stream'}, b'blob'),
        ]) as requests:
            status, _, body = MODULE.blob_get_with_safe_redirects(
                'https://ghcr.io/v2/tywoods/image/blobs/sha256:' + 'a' * 64,
                {'Authorization': 'Bearer synthetic', 'Accept': 'application/octet-stream'},
            )
        self.assertEqual((status, body), (200, b'blob'))
        self.assertEqual(requests.call_args_list[1].args[0], 'https://signed-storage.invalid/object?sig=fixture')
        self.assertNotIn('Authorization', requests.call_args_list[1].args[1])

    def test_blob_redirect_rejects_https_downgrade(self):
        with mock.patch.object(MODULE, 'http_get', return_value=(302, {'Location': 'http://signed-storage.invalid/object'}, b'')):
            with self.assertRaisesRegex(MODULE.PullError, 'unsafe blob redirect'):
                MODULE.blob_get_with_safe_redirects(
                    'https://ghcr.io/v2/tywoods/image/blobs/sha256:' + 'a' * 64,
                    {'Authorization': 'Bearer synthetic'},
                )

    def test_client_has_no_external_process_or_credential_helper_path(self):
        source = MODULE_PATH.read_text()
        forbidden = ('subprocess', 'os.system', 'os.popen', 'docker-credential', 'DOCKER_CONFIG')
        self.assertEqual([word for word in forbidden if word in source], [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
