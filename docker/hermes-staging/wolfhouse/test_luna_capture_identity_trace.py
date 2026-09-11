from __future__ import annotations

import asyncio
import fcntl
import json
import multiprocessing
import os
import stat
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from wolfhouse import luna_capture_identity_trace as trace
from wolfhouse import luna_personality_isolation as iso
from wolfhouse.luna_group_lesson_live_eval import BoundedMetadataCapture


def _process_emit(result, attempt):
    identity = trace.CaptureIdentityTrace(path=trace.TRACE_PATH, run_id="workers", attempt_id=attempt)
    identity.emit("attach", reason="worker")
    result.put((str(trace.trace_path()), identity.snapshot()))
    trace.reset_trace_sink_for_tests()


def _reset_and_unlink_test_sinks():
    """Test-only cleanup; production trace code never removes evidence."""
    trace.reset_trace_sink_for_tests()
    for path in trace.trace_paths():
        try:
            path.unlink()
        except (FileNotFoundError, OSError):
            pass


class CaptureIdentityTraceTests(unittest.TestCase):
    def setUp(self):
        _reset_and_unlink_test_sinks()

    def tearDown(self):
        _reset_and_unlink_test_sinks()

    def test_records_exclude_runtime_names(self):
        identity = trace.CaptureIdentityTrace(run_id="r", attempt_id="a")
        identity.emit("attach")
        self.assertNotIn("thread_name", identity.snapshot()[0])
        self.assertNotIn("task_name", identity.snapshot()[0])

    def test_path_sink_rejects_non_fixed_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            for target in (Path(tmp) / "trace", Path("/tmp/other-trace.jsonl")):
                identity = trace.CaptureIdentityTrace(path=target, run_id="r", attempt_id="a")
                identity.emit("attach")
                self.assertEqual(identity.snapshot()[0]["event"], "sink_failure")

    def test_fixed_path_rejects_final_symlink_fifo_and_directory_without_blocking(self):
        with tempfile.TemporaryDirectory() as tmp:
            regular = Path(tmp) / "regular"
            regular.write_text("existing")
            for kind in ("symlink", "fifo", "directory"):
                _reset_and_unlink_test_sinks()
                path = trace.trace_path()
                if kind == "symlink":
                    path.symlink_to(regular)
                elif kind == "fifo":
                    os.mkfifo(path)
                else:
                    path.mkdir()
                identity = trace.CaptureIdentityTrace(path=trace.TRACE_PATH, run_id="r", attempt_id="a")
                worker = threading.Thread(target=identity.emit, args=("attach",))
                worker.start(); worker.join(1)
                self.assertFalse(worker.is_alive(), kind)
                self.assertEqual(identity.snapshot()[0]["event"], "sink_failure")
                if kind == "directory":
                    path.rmdir()
                else:
                    path.unlink()
            self.assertEqual(regular.read_text(), "existing")

    def test_fixed_path_rejects_hard_link_without_changing_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "unrelated"
            target.write_text("unchanged")
            target.chmod(0o640)
            os.link(target, trace.trace_path())
            identity = trace.CaptureIdentityTrace(
                path=trace.TRACE_PATH, run_id="r", attempt_id="a",
            )
            identity.emit("attach")
            self.assertEqual(identity.snapshot()[0]["event"], "sink_failure")
            self.assertEqual(target.read_text(), "unchanged")
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o640)
            trace.trace_path().unlink()

    def test_fixed_path_rejects_preexisting_regular_without_changing_it(self):
        trace.trace_path().write_text("unchanged")
        trace.trace_path().chmod(0o640)
        identity = trace.CaptureIdentityTrace(path=trace.TRACE_PATH, run_id="r", attempt_id="a")
        identity.emit("attach")
        self.assertEqual(identity.snapshot()[0]["event"], "sink_failure")
        self.assertEqual(trace.trace_path().read_text(), "unchanged")
        self.assertEqual(stat.S_IMODE(trace.trace_path().stat().st_mode), 0o640)
        trace.trace_path().unlink()

    def test_creation_is_exclusive_and_descriptor_is_shared_without_leak(self):
        before = len(os.listdir("/proc/self/fd"))
        real_open = os.open
        flags_seen = []

        def observe_open(path, flags, mode=0o777):
            flags_seen.append(flags)
            return real_open(path, flags, mode)

        with patch.object(trace.os, "open", side_effect=observe_open):
            first = trace.CaptureIdentityTrace(path=trace.TRACE_PATH, run_id="r", attempt_id="1")
            shared_fd = trace._SINK_FD
            second = trace.CaptureIdentityTrace(path=trace.TRACE_PATH, run_id="r", attempt_id="2")
        self.assertEqual(len(flags_seen), 1)
        required = (os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND |
                    os.O_NONBLOCK | os.O_CLOEXEC | os.O_NOFOLLOW)
        self.assertEqual(flags_seen[0] & required, required)
        self.assertIs(trace._SINK_FD, shared_fd)
        first.emit("attach")
        second.emit("attach")
        self.assertEqual([json.loads(line)["attempt_id"]
                          for line in trace.trace_path().read_text().splitlines()], ["1", "2"])
        self.assertEqual(len(os.listdir("/proc/self/fd")), before + 1)
        _reset_and_unlink_test_sinks()
        self.assertEqual(len(os.listdir("/proc/self/fd")), before)

    def test_post_creation_hardlink_aliases_only_trace_owned_inode(self):
        with tempfile.TemporaryDirectory() as tmp:
            unrelated = Path(tmp) / "unrelated"
            alias = Path(tmp) / "trace-alias"
            unrelated.write_text("safe")
            identity = trace.CaptureIdentityTrace(path=trace.TRACE_PATH, run_id="r", attempt_id="a")
            os.link(trace.trace_path(), alias)
            trace.trace_path().unlink()
            os.link(unrelated, trace.trace_path())
            identity.emit("attach")
            self.assertEqual(unrelated.read_text(), "safe")
            self.assertEqual(trace.trace_path().read_text(), "safe")
            self.assertEqual(json.loads(alias.read_text())["event"], "attach")
            trace.trace_path().unlink()

    def test_path_sink_completes_short_writes_and_forces_private_mode(self):
        path = trace.trace_path()
        real_write = os.write

        def short_write(fd, data):
            return real_write(fd, data[:7])

        identity = trace.CaptureIdentityTrace(path=trace.TRACE_PATH, run_id="r", attempt_id="a")
        with patch.object(trace.os, "write", side_effect=short_write):
            identity.emit("attach")
        self.assertEqual(json.loads(path.read_text()), identity.snapshot()[0])
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_path_sink_refuses_event_past_fixed_file_bound(self):
        path = trace.trace_path()
        identity = trace.CaptureIdentityTrace(path=trace.TRACE_PATH, run_id="r", attempt_id="a")
        os.ftruncate(trace._SINK_FD, trace.TRACE_FILE_MAX_BYTES)
        identity.emit("attach")
        self.assertEqual(path.stat().st_size, trace.TRACE_FILE_MAX_BYTES)
        self.assertEqual(identity.snapshot()[0]["event"], "sink_failure")
        self.assertEqual(identity.snapshot()[0]["status"], "truncated")

    def test_two_independent_instances_cannot_race_past_file_bound(self):
        probes = [trace.CaptureIdentityTrace(run_id="r", attempt_id=str(i)) for i in range(2)]
        for probe in probes:
            probe.emit("attach")
        sizes = [len((json.dumps(probe.snapshot()[0], ensure_ascii=True,
                                 separators=(",", ":")) + "\n").encode()) for probe in probes]
        bound = max(sizes) + 17
        identities = [trace.CaptureIdentityTrace(path=trace.TRACE_PATH, run_id="r", attempt_id=str(i))
                      for i in range(2)]
        os.ftruncate(trace._SINK_FD, bound - max(sizes))
        barrier = threading.Barrier(3)

        def emit_one(identity):
            barrier.wait()
            identity.emit("attach")

        with patch.object(trace, "TRACE_FILE_MAX_BYTES", bound):
            workers = [threading.Thread(target=emit_one, args=(identity,)) for identity in identities]
            for worker in workers:
                worker.start()
            barrier.wait()
            for worker in workers:
                worker.join(1)
        self.assertLessEqual(trace.trace_path().stat().st_size, bound)
        self.assertEqual(sum(any(r["event"] == "attach" for r in i.snapshot()) for i in identities), 1)

    def test_partial_write_failure_rolls_back_to_prior_valid_jsonl(self):
        prior = b'{"prior":true}\n'
        identity = trace.CaptureIdentityTrace(path=trace.TRACE_PATH, run_id="r", attempt_id="a")
        os.write(trace._SINK_FD, prior)
        real_write = os.write
        calls = 0

        def partial_then_fail(fd, data):
            nonlocal calls
            calls += 1
            if calls == 1:
                return real_write(fd, data[:5])
            raise OSError("injected")

        with patch.object(trace.os, "write", side_effect=partial_then_fail):
            identity.emit("attach")
        self.assertEqual(trace.trace_path().read_bytes(), prior)
        self.assertEqual(identity.snapshot()[0]["event"], "sink_failure")
        self.assertEqual(json.loads(trace.trace_path().read_text()), {"prior": True})

    def test_exclusive_lock_contention_drops_without_blocking(self):
        identity = trace.CaptureIdentityTrace(path=trace.TRACE_PATH, run_id="r", attempt_id="a")
        fd = os.open(trace.trace_path(), os.O_WRONLY | os.O_APPEND)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            worker = threading.Thread(target=identity.emit, args=("attach",))
            worker.start(); worker.join(1)
            self.assertFalse(worker.is_alive())
            self.assertEqual(identity.snapshot()[0]["event"], "sink_failure")
            self.assertEqual(trace.trace_path().read_bytes(), b"")
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def test_default_off_and_closed_enablement(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(trace.trace_from_environment(run_id="run", attempt_id="1"))
        with patch.dict(os.environ, {trace.TRACE_PATH_ENV: "relative.jsonl"}, clear=True):
            self.assertIsNone(trace.trace_from_environment(run_id="run", attempt_id="1"))
        with patch.dict(os.environ, {trace.TRACE_PATH_ENV: "/tmp/arbitrary.jsonl"}, clear=True):
            self.assertIsNone(trace.trace_from_environment(run_id="run", attempt_id="1"))
        with patch.dict(os.environ, {trace.TRACE_PATH_ENV: str(trace.TRACE_PATH)}, clear=True):
            self.assertIsNotNone(trace.trace_from_environment(run_id="run", attempt_id="1"))

    def test_allowlisted_bounded_append_only_jsonl(self):
        with patch.object(trace, "TRACE_FILE_MAX_BYTES", 4096):
            path = trace.trace_path()
            capture = object()
            identity = trace.CaptureIdentityTrace(path=trace.TRACE_PATH, run_id="r", attempt_id="a", limit=3)
            identity.emit("attach", capture=capture, call_id="c", prompt="SECRET", guest="PERSON")
            identity.emit("enqueue", capture=capture, status="queued", args={"SECRET": True})
            identity.emit("handler_entry", capture=capture, reason="consumer")
            identity.emit("finalize", capture=capture, status="ignored-at-bound")
            records = identity.snapshot()
            self.assertEqual(len(records), 3)
            self.assertEqual([r["event"] for r in records], ["attach", "enqueue", "handler_entry"])
            self.assertTrue(all(r["capture_present"] and r["capture_id"] == id(capture) for r in records))
            serialized = path.read_text().splitlines()
            self.assertEqual([json.loads(line) for line in serialized], records)
            forbidden = {"prompt", "guest", "args", "results", "credentials", "dumps"}
            keys = set().union(*(record.keys() for record in records))
            self.assertFalse(forbidden.intersection(keys))

    def test_missing_capture_and_sink_failure_are_detectable_without_raising(self):
        identity = trace.CaptureIdentityTrace(path=Path("/tmp/not-the-fixed-path"), run_id="r", attempt_id="a")
        identity.emit("handler_entry", capture=None, reason="consumer")
        records = identity.snapshot()
        self.assertEqual(records[0]["event"], "sink_failure")
        self.assertEqual(records[0]["capture_present"], False)
        self.assertEqual(records[0]["reason"], "write_failed")

    def test_concurrent_turns_keep_distinct_capture_identity(self):
        traces = [trace.CaptureIdentityTrace(run_id="same", attempt_id=str(i)) for i in range(2)]
        captures = [object(), object()]
        threads = [threading.Thread(target=t.emit, args=("handler_entry",),
                                    kwargs={"capture": c, "reason": "worker"})
                   for t, c in zip(traces, captures)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertNotEqual(traces[0].snapshot()[0]["capture_id"], traces[1].snapshot()[0]["capture_id"])
        self.assertNotEqual(traces[0].snapshot()[0]["attempt_id"], traces[1].snapshot()[0]["attempt_id"])

    def test_task_and_thread_identity_survive_scheduling(self):
        identity = trace.CaptureIdentityTrace(run_id="r", attempt_id="a")
        capture = object()

        async def run():
            identity.emit("enqueue", capture=capture, reason="asyncio")
            await asyncio.create_task(_entry())

        async def _entry():
            identity.emit("handler_entry", capture=capture, reason="consumer")

        asyncio.run(run())
        records = identity.snapshot()
        self.assertEqual(records[0]["capture_id"], records[1]["capture_id"])
        self.assertIsNotNone(records[0]["task_id"])
        self.assertIsNotNone(records[1]["task_id"])
        self.assertEqual(records[0]["thread_id"], records[1]["thread_id"])

    def test_request_local_trace_owner_does_not_leak_between_concurrent_turns(self):
        identities = [trace.CaptureIdentityTrace(run_id="r", attempt_id=str(i)) for i in range(2)]

        async def turn(identity):
            token = trace.enter_trace(identity)
            try:
                await asyncio.sleep(0)
                self.assertIs(trace.current_trace(), identity)
                trace.emit(trace.current_trace(), "handler", reason="gateway_handler")
            finally:
                trace.exit_trace(token)
            self.assertIsNone(trace.current_trace())

        async def run():
            await asyncio.gather(*(turn(identity) for identity in identities))

        asyncio.run(run())
        self.assertEqual([[record["attempt_id"] for record in identity.snapshot()]
                          for identity in identities], [["0"], ["1"]])

    def test_worker_start_is_linux_process_start_not_import_clock(self):
        expected = Path("/proc/self/stat").read_text(encoding="ascii").rsplit(")", 1)[1].split()[19]
        identity = trace.CaptureIdentityTrace(run_id="r", attempt_id="a")
        identity.emit("attach")
        self.assertEqual(identity.snapshot()[0]["worker_start"], expected)

    @unittest.skipUnless(hasattr(os, "fork"), "requires Linux fork")
    def test_fork_after_init_closes_inherited_fd_and_child_reset_cannot_unlink_parent(self):
        identity = trace.CaptureIdentityTrace(path=trace.TRACE_PATH, run_id="r", attempt_id="parent")
        identity.emit("attach")
        parent_path = trace.trace_path()
        parent_bytes = parent_path.read_bytes()
        read_fd, write_fd = os.pipe()
        child = os.fork()
        if child == 0:
            try:
                os.close(read_fd)
                trace.reset_trace_sink_for_tests()
                identity.emit("handler_entry", reason="worker")
                row = json.loads(trace.trace_path().read_text())
                os.write(write_fd, json.dumps({"path": str(trace.trace_path()), "row": row}).encode())
            finally:
                os._exit(0)
        os.close(write_fd)
        payload = os.read(read_fd, 65536)
        os.close(read_fd)
        waited, status = os.waitpid(child, 0)
        self.assertEqual((waited, status), (child, 0))
        observed = json.loads(payload)
        child_path = Path(observed["path"])
        self.assertNotEqual(child_path, parent_path)
        self.assertEqual(parent_path.read_bytes(), parent_bytes)
        self.assertEqual(observed["row"]["worker_pid"], child)
        expected_start = child_path.name.split(".")[-2]
        self.assertEqual(observed["row"]["worker_start"], expected_start)
        self.assertEqual(observed["row"]["attempt_id"], "parent")

    @unittest.skipUnless(hasattr(os, "fork"), "requires Linux fork")
    def test_fork_before_init_creates_distinct_complete_worker_files(self):
        read_fd, write_fd = os.pipe()
        child = os.fork()
        if child == 0:
            try:
                os.close(read_fd)
                identity = trace.CaptureIdentityTrace(path=trace.TRACE_PATH, run_id="r", attempt_id="child")
                identity.emit("attach")
                os.write(write_fd, str(trace.trace_path()).encode())
            finally:
                os._exit(0)
        os.close(write_fd)
        parent = trace.CaptureIdentityTrace(path=trace.TRACE_PATH, run_id="r", attempt_id="parent")
        parent.emit("attach")
        child_path = Path(os.read(read_fd, 4096).decode())
        os.close(read_fd)
        _waited, status = os.waitpid(child, 0)
        self.assertEqual(status, 0)
        self.assertNotEqual(child_path, trace.trace_path())
        for path, pid, attempt in ((trace.trace_path(), os.getpid(), "parent"),
                                   (child_path, child, "child")):
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            self.assertEqual(len(rows), 1)
            self.assertEqual((rows[0]["worker_pid"], rows[0]["attempt_id"]), (pid, attempt))

    def test_spawned_and_forked_workers_each_preserve_complete_evidence(self):
        results = []
        if "fork" in multiprocessing.get_all_start_methods():
            context = multiprocessing.get_context("fork")
            result = context.Queue()
            worker = context.Process(target=_process_emit, args=(result, "fork"))
            worker.start()
            path, snapshot = result.get(timeout=10)
            worker.join(10)
            self.assertEqual(worker.exitcode, 0)
            results.append((Path(path), snapshot, worker.pid, "fork"))
        script = (
            "import json,os; from wolfhouse import luna_capture_identity_trace as t; "
            "i=t.CaptureIdentityTrace(path=t.TRACE_PATH,run_id='workers',attempt_id='spawn'); "
            "i.emit('attach',reason='worker'); "
            "print(json.dumps([str(t.trace_path()),i.snapshot(),os.getpid()]))"
        )
        completed = subprocess.run([sys.executable, "-c", script], check=True,
                                   text=True, capture_output=True)
        path, snapshot, pid = json.loads(completed.stdout)
        results.append((Path(path), snapshot, pid, "spawn"))
        self.assertEqual(len({path for path, *_rest in results}), len(results))
        for path, snapshot, pid, method in results:
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            self.assertEqual(rows, snapshot)
            self.assertEqual(len(rows), 1)
            self.assertEqual((rows[0]["worker_pid"], rows[0]["attempt_id"]), (pid, method))
            self.assertIn(path, trace.trace_paths())

    def test_production_dispatcher_observes_missing_capture_and_executes_original(self):
        calls = []
        mod = types.SimpleNamespace(
            handle_function_call=lambda name, args: calls.append((name, args)) or "real-result",
        )
        identity = trace.CaptureIdentityTrace(run_id="r", attempt_id="missing-cap")
        trace_token = trace.enter_trace(identity)
        try:
            self.assertTrue(iso._wrap_tool_dispatcher(mod))
            self.assertEqual(mod.handle_function_call("ordinary", {"x": 1}), "real-result")
        finally:
            trace.exit_trace(trace_token)
            iso.reset_isolation_runtime_for_tests()
        self.assertEqual(calls, [("ordinary", {"x": 1})])
        record = identity.snapshot()[0]
        self.assertEqual(record["event"], "dispatcher")
        self.assertFalse(record["capture_present"])
        self.assertIsNone(trace.current_trace())

    def test_concurrent_installed_executor_and_dispatcher_keep_trace_capture_pairing(self):
        mod = types.SimpleNamespace(handle_function_call=lambda name, args: name)
        identities = [trace.CaptureIdentityTrace(run_id="r", attempt_id=str(i)) for i in range(2)]
        captures = [iso.IsolatedTurnCapture("case", "sunny") for _ in range(2)]
        for capture in captures:
            capture.read_only_tool_allowlist = frozenset({"get_sunset_lesson_catalog"})
        try:
            self.assertTrue(iso._wrap_tool_dispatcher(mod))
            self.assertTrue(iso._wrap_executor_context_propagation())
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = []
                for index, (identity, capture) in enumerate(zip(identities, captures)):
                    trace_token = trace.enter_trace(identity)
                    cap_token = iso.enter_isolated_turn(capture)
                    try:
                        futures.append(pool.submit(
                            mod.handle_function_call, "get_sunset_lesson_catalog",
                            {"location_id": "sunset-somo"},
                        ))
                    finally:
                        iso.exit_isolated_turn(cap_token)
                        trace.exit_trace(trace_token)
                self.assertEqual([future.result() for future in futures],
                                 ["get_sunset_lesson_catalog"] * 2)
        finally:
            iso.reset_isolation_runtime_for_tests()
        for identity, capture in zip(identities, captures):
            dispatcher = [item for item in identity.snapshot()
                          if item["event"] == "dispatcher"]
            self.assertEqual(len(dispatcher), 1)
            self.assertEqual(dispatcher[0]["capture_id"], id(capture))
        self.assertIsNone(trace.current_trace())
        self.assertIsNone(iso.current_isolated_turn())

    def test_lost_trace_context_is_finalize_missing_without_synthetic_boundaries(self):
        identity = trace.CaptureIdentityTrace(run_id="r", attempt_id="lost")
        capture = iso.IsolatedTurnCapture("case", "sunny")
        token = trace.enter_trace(identity)
        trace.exit_trace(token)
        trace.finalize(identity, capture=capture)
        records = identity.snapshot()
        self.assertEqual([record["event"] for record in records], ["finalize"])
        self.assertEqual(records[0]["status"], "missing")
        self.assertEqual(records[0]["reason"], "trace_context_missing")

    def test_enabled_trace_preserves_real_dispatcher_results_dispositions_and_denials(self):
        calls = []

        def original(name, args):
            calls.append((name, args))
            return json.dumps({"success": True, "source": "real-wrapper"})

        mod = types.SimpleNamespace(handle_function_call=original)
        metadata = BoundedMetadataCapture("gpt-5.6-sol", {})
        metadata.observe_request(attempted=True, sent=True, prompts=[], tools=[], tool_choice="auto")
        metadata.observe_response(
            status="ok", finish_reason="tool_calls",
            tool_calls=[{"id": "call-1", "function": {"name": "get_sunset_lesson_catalog"},
                         "arg_validation": "valid"}],
            provider_shape="openai_responses", completion_category="tool_calls",
        )
        capture = iso.IsolatedTurnCapture("case", "sunny")
        capture.metadata_capture = metadata
        capture.read_only_tool_allowlist = frozenset({"get_sunset_lesson_catalog"})
        identity = trace.CaptureIdentityTrace(run_id="r", attempt_id="enabled")
        capture.identity_trace = identity
        trace_token = trace.enter_trace(identity)
        cap_token = iso.enter_isolated_turn(capture)
        try:
            self.assertTrue(iso._wrap_tool_dispatcher(mod))
            allowed = mod.handle_function_call(
                "get_sunset_lesson_catalog", {"location_id": "sunset-somo"},
            )
            denied_send = mod.handle_function_call("send_message", {"text": "not-recorded"})
            denied_write = mod.handle_function_call("terminal", {"cmd": "not-recorded"})
            finalized = metadata.finalize(model_reached=True)
        finally:
            iso.exit_isolated_turn(cap_token)
            trace.exit_trace(trace_token)
            iso.reset_isolation_runtime_for_tests()

        self.assertEqual(json.loads(allowed), {"success": True, "source": "real-wrapper"})
        self.assertIn(iso.ISOLATION_DENY_MESSAGE, denied_send)
        self.assertIn(iso.ISOLATION_DENY_MESSAGE, denied_write)
        self.assertEqual(calls, [("get_sunset_lesson_catalog", {"location_id": "sunset-somo"})])
        dispositions = finalized["calls"][0]["executor"]["dispositions"]
        self.assertEqual([item["disposition"] for item in dispositions],
                         ["accepted", "dispatched", "completed", "rejected", "rejected"])
        self.assertEqual(capture.sends_completed, 0)
        self.assertEqual(capture.journal_writes_completed, 0)
        self.assertEqual(capture.tools_denied, ["send_message", "terminal"])
        self.assertTrue(any(record["event"] == "record_disposition_post_write"
                            for record in identity.snapshot()))
        disposition_records = [record for record in identity.snapshot()
                               if record["event"].startswith("record_disposition_")]
        self.assertTrue(disposition_records)
        self.assertEqual({record["call_id"] for record in disposition_records},
                         {f"{metadata.run_id}:1"})
        serialization = [record for record in identity.snapshot()
                         if record["event"] == "serialization_finalize"]
        self.assertEqual(len(serialization), 1)
        self.assertEqual(serialization[0]["capture_id"], id(capture))
        self.assertEqual(serialization[0]["disposition_count"], 5)
        self.assertEqual(serialization[0]["reason"], "metadata_capture_finalize")

    def test_controlled_codex_parser_to_dispatcher_chain_pairs_concurrent_turns(self):
        """Maximum local chain; gateway.stream_consumer exists only in the Hermes image."""
        dispatcher = types.SimpleNamespace(handle_function_call=lambda name, args: name)

        class Stream(list):
            def close(self):
                return None

        def consume(events, **_kwargs):
            for _event in events:
                pass
            return {"id": "response-id", "status": "completed", "output": [],
                    "terminal_event_type": "response.completed"}

        parser = types.SimpleNamespace(_consume_codex_event_stream=consume)
        identities = [trace.CaptureIdentityTrace(run_id="r", attempt_id=str(i)) for i in range(2)]
        captures = [iso.IsolatedTurnCapture("case", "sunny") for _ in range(2)]
        for capture, identity in zip(captures, identities):
            capture.identity_trace = identity
            capture.metadata_capture = BoundedMetadataCapture("gpt-5.6-sol", {})
            capture.read_only_tool_allowlist = frozenset({"get_sunset_lesson_catalog"})

        def turn(capture, identity):
            trace_token = trace.enter_trace(identity)
            cap_token = iso.enter_isolated_turn(capture)
            try:
                observed = iso._ObservedResponsesStream(Stream([{
                    "type": "response.completed",
                    "response": {"id": "response-id", "status": "completed", "output": []},
                }]), capture)
                parser._consume_codex_event_stream(observed, model="gpt-5.6-sol")
                observed.close()
                dispatcher.handle_function_call("get_sunset_lesson_catalog", {})
                capture.metadata_capture.finalize(model_reached=True)
                trace.finalize(identity, capture=capture)
            finally:
                iso.exit_isolated_turn(cap_token)
                trace.exit_trace(trace_token)

        try:
            self.assertTrue(iso._wrap_tool_dispatcher(dispatcher))
            iso._wrap_codex_parser(parser)
            workers = [threading.Thread(target=turn, args=pair)
                       for pair in zip(captures, identities)]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(2)
                self.assertFalse(worker.is_alive())
        finally:
            iso.reset_isolation_runtime_for_tests()
        expected = {"provider_response_consumed", "loop", "dispatcher",
                    "record_disposition_entry", "record_disposition_post_write",
                    "serialization_finalize", "finalize"}
        for capture, identity in zip(captures, identities):
            records = identity.snapshot()
            self.assertTrue(expected.issubset({record["event"] for record in records}))
            self.assertEqual({record["capture_id"] for record in records}, {id(capture)})
            self.assertEqual({record["attempt_id"] for record in records}, {identity.attempt_id})

    def test_default_off_finalize_ignores_malformed_disposition_container(self):
        class BrokenLength:
            def __len__(self):
                raise RuntimeError("diagnostic count failed")

        metadata = BoundedMetadataCapture("gpt-5.6-sol", {})
        metadata.observe_response(
            status="ok", finish_reason="stop", tool_calls=[],
            provider_shape="openai_responses", completion_category="terminal",
        )
        metadata.calls[0]["executor"]["dispositions"] = BrokenLength()
        finalized = metadata.finalize(model_reached=True)
        self.assertIsNone(finalized["calls"][0]["executor"]["dispositions"])

    def test_failed_finalize_construction_never_emits_completed(self):
        class BrokenMapping:
            def keys(self):
                raise RuntimeError("construction failed")

            def __getitem__(self, _key):
                raise AssertionError("unreachable")

        metadata = BoundedMetadataCapture("gpt-5.6-sol", {})
        metadata.revisions = BrokenMapping()  # type: ignore[assignment]
        identity = trace.CaptureIdentityTrace(run_id="r", attempt_id="a")
        token = trace.enter_trace(identity)
        try:
            with self.assertRaises(RuntimeError):
                metadata.finalize(model_reached=False)
        finally:
            trace.exit_trace(token)
        self.assertFalse(any(item["event"] == "serialization_finalize"
                             for item in identity.snapshot()))


if __name__ == "__main__":
    unittest.main()
