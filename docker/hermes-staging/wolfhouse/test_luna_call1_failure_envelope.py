from __future__ import annotations
import ast, asyncio, contextvars, json, os, subprocess, sys, tempfile, threading, types, unittest
from pathlib import Path
from unittest.mock import patch
from wolfhouse import luna_call1_failure_envelope as env
from wolfhouse import luna_capture_identity_trace as trace

class Call1FailureEnvelopeTests(unittest.TestCase):
    def setUp(self):
        env.reset_for_tests(); self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        os.chmod(self.tmp.name,0o700)
        self.dir_patch=patch.object(env,"ARTIFACT_DIR",Path(self.tmp.name)); self.dir_patch.start()
        self.identity=trace.CaptureIdentityTrace(run_id="approved-7",attempt_id="attempt-2")
        self.token=trace.enter_trace(self.identity)
        self.call={"call_index":1,"response_id":"resp-4","response":{"tool_calls":[{"id":"call-5","function":{"name":env.TARGET_TOOL}}]},"executor":{"dispositions":[{"provider_call_id":"call-5","disposition":"completed"}]}}
        self.capture=types.SimpleNamespace(_lr32_server_validated_synthetic=True,metadata_capture=types.SimpleNamespace(calls=[self.call]))
        self.cp=patch.object(env,"_current_capture",return_value=self.capture); self.capture_mock=self.cp.start()
        self.good={env.ENABLE_ENV:"1",env.APPROVED_RUN_ENV:"approved-7",env.ARTIFACT_DIR_ENV:self.tmp.name,"HERMES_ROLE":"sunset-luna","LUNA_CLIENT_SLUG":"sunset","SUNSET_INGRESS_LOCATION_ID":"sunset-somo","LUNA_ALLOWED_LOCATION_IDS":"sunset-somo","LUNA_BOT_INTERNAL_TOKEN":"offline-test-token","WOLFHOUSE_STAFF_API_BASE_URL":"https://offline.invalid"}
    def tearDown(self):
        self.cp.stop(); self.dir_patch.stop(); trace.exit_trace(self.token); env.reset_for_tests()
    def enter(self): return env.adapter_entry(env.TARGET_TOOL,{"location_id":"sunset-somo"})
    def finish(self,h,value={"ok":True},producer="executor_return"):
        env.plugin_return(h,value)
        return env.append_result(call_id="call-5",api_request_id="req",response_id=None,value=value,dispatcher_disposition=None,producer=producer)

    def test_default_off_scope_and_true_call1_ordinal_rejection(self):
        self.assertIsNone(self.enter())
        for key,bad in [(env.APPROVED_RUN_ENV,"other"),("HERMES_ROLE","deckhand"),("LUNA_CLIENT_SLUG","other")]:
            with patch.dict(os.environ,{**self.good,key:bad},clear=True): self.assertIsNone(self.enter())
        with patch.dict(os.environ,self.good,clear=True):
            self.call["call_index"]=2; self.assertIsNone(self.enter()); self.call["call_index"]=1
            self.call["response"]["tool_calls"][0]["function"]["name"]="other"; self.assertIsNone(self.enter())
        self.assertEqual(list(Path(self.tmp.name).iterdir()),[])

    def test_exact_call_binding_repeat_rejected_and_nested_mismatch_not_consumed(self):
        with patch.dict(os.environ,self.good,clear=True):
            h=self.enter(); self.assertIsNotNone(h); self.assertIsNone(self.enter())
            self.assertIsNone(env.append_result(call_id="wrong",api_request_id=None,response_id=None,value="x",dispatcher_disposition=None))
            self.assertIs(env.current_handle(),h); path=self.finish(h)
        doc=json.loads(Path(path).read_text()); self.assertEqual(doc["ids"]["tool_call_id"],"call-5")
        self.assertEqual(doc["adapter_entry"]["call_ordinal"],1); self.assertEqual(doc["append"]["producer"],"executor_return")
        self.assertEqual(doc["dispatcher"]["disposition"],"completed")

    def test_trace_receipts_cover_adapter_append_and_publication_decisions(self):
        with patch.dict(os.environ, self.good, clear=True):
            handle = self.enter()
            self.assertIsNotNone(handle)
            self.assertIsNotNone(self.finish(handle))
        receipts = [row for row in self.identity.snapshot()
                    if row["event"].startswith("lr32_")]
        self.assertEqual([row["event"] for row in receipts], [
            "lr32_adapter_outcome", "lr32_append_outcome", "lr32_publication_outcome",
        ])
        adapter, append, publication = receipts
        self.assertEqual((adapter["status"], adapter["reason"]), ("accepted", "handle_created"))
        self.assertTrue(adapter["metadata_call1"])
        self.assertTrue(adapter["pending_created"])
        self.assertEqual(adapter["call_id"], "call-5")
        self.assertEqual((append["status"], append["reason"]), ("consumed", "exact_match"))
        self.assertEqual(append["call_id"], "call-5")
        self.assertEqual(append["expected_call_id"], "call-5")
        self.assertEqual(append["exact_match_count"], 1)
        self.assertTrue(append["same_request_capture"])
        self.assertTrue(append["handle_match"])
        self.assertEqual((publication["status"], publication["reason"]),
                         ("completed", "published"))
        self.assertTrue(publication["capture_complete"])
        self.assertIsNone(publication["capture_failure"])

    def test_trace_receipts_cover_rejected_admission_no_match_and_publication_failure(self):
        with patch.dict(os.environ, {**self.good, "HERMES_ROLE": "deckhand"}, clear=True):
            self.assertIsNone(self.enter())
        rejected = self.identity.snapshot()[-1]
        self.assertEqual((rejected["event"], rejected["status"], rejected["reason"]),
                         ("lr32_adapter_outcome", "rejected", "scope_mismatch"))
        self.assertFalse(rejected["pending_created"])

        with patch.dict(os.environ, self.good, clear=True):
            handle = self.enter()
            self.assertIsNone(env.append_result(
                call_id="wrong", api_request_id=None, response_id=None, value="x",
                dispatcher_disposition=None,
            ))
            with patch.object(env, "_atomic_write", side_effect=OSError("injected")):
                self.assertIsNone(self.finish(handle))
        no_match, consumed, failed = self.identity.snapshot()[-3:]
        self.assertEqual((no_match["event"], no_match["status"], no_match["reason"]),
                         ("lr32_append_outcome", "rejected", "no_exact_match"))
        self.assertEqual(no_match["exact_match_count"], 0)
        self.assertEqual((consumed["status"], consumed["reason"]),
                         ("consumed", "exact_match"))
        self.assertEqual((failed["event"], failed["status"], failed["reason"]),
                         ("lr32_publication_outcome", "failed", "publication_failed"))
        self.assertEqual(failed["stage"], "publication")
        self.assertFalse(failed["capture_complete"])
        self.assertEqual(failed["capture_failure"], "persistence_failed")

    def test_receipts_keep_unreached_predicates_unknown_and_close_internal_error(self):
        with patch.dict(os.environ, self.good, clear=True), patch.object(
            env, "_current_capture", return_value=None
        ):
            self.assertIsNone(self.enter())
        missing = self.identity.snapshot()[-1]
        self.assertEqual((missing["status"], missing["reason"]), ("rejected", "capture_missing"))
        self.assertTrue(missing["identity_present"])
        self.assertFalse(missing["capture_present"])
        for field in ("approved_present", "run_ids_match", "server_marker", "scope_match", "metadata_call1"):
            self.assertIsNone(missing[field], field)

        with patch.dict(os.environ, self.good, clear=True), patch.object(
            env, "CallCapture", side_effect=RuntimeError("must-not-be-recorded")
        ):
            self.assertIsNone(self.enter())
        internal = self.identity.snapshot()[-1]
        self.assertEqual((internal["status"], internal["reason"]), ("rejected", "internal_error"))
        self.assertNotIn("must-not-be-recorded", json.dumps(internal))

    def test_receipt_emitters_are_never_called_under_handle_lock(self):
        source = Path(env.__file__).read_text()
        tree = ast.parse(source)
        violations = []
        for node in ast.walk(tree):
            if not isinstance(node, (ast.With, ast.AsyncWith)):
                continue
            owns_handle_lock = any(
                isinstance(item.context_expr, ast.Name) and item.context_expr.id == "_LOCK"
                for item in node.items
            )
            if not owns_handle_lock:
                continue
            for nested in ast.walk(node):
                if not isinstance(nested, ast.Call):
                    continue
                name = nested.func.id if isinstance(nested.func, ast.Name) else None
                if name in {"_adapter_receipt", "trace_emit"}:
                    violations.append((nested.lineno, name))
        self.assertEqual(violations, [])

    def test_every_moved_rejection_branch_keeps_its_locked_decision(self):
        class DecisionLock:
            def __init__(self, on_enter):
                self._lock = threading.RLock()
                self._on_enter = on_enter
                self.entries = 0
            def __enter__(self):
                self._lock.acquire()
                self.entries += 1
                self._on_enter(self.entries)
                return self
            def __exit__(self, *_args):
                self._lock.release()

        with patch.dict(os.environ, self.good, clear=True):
            setattr(self.capture, env._CAPTURE_PENDING_ATTR, [])
            self.assertIsNone(self.enter())
            self.assertEqual(self.identity.snapshot()[-1]["reason"], "pending_invalid")

            for reason, replacement in (
                ("pending_invalid", lambda handle: []),
                ("duplicate_handle", lambda handle: (handle,)),
            ):
                env.reset_for_tests()
                self.identity._records.clear()
                original_capture = env.CallCapture
                created = []
                def mutate_second(entry):
                    if entry == 2:
                        setattr(self.capture, env._CAPTURE_PENDING_ATTR, replacement(created[0]))
                decision_lock = DecisionLock(mutate_second)
                def create_handle(*args, **kwargs):
                    handle = original_capture(*args, **kwargs)
                    created.append(handle)
                    return handle
                with patch.object(env, "_LOCK", decision_lock), \
                     patch.object(env, "CallCapture", side_effect=create_handle):
                    self.assertIsNone(self.enter())
                receipt = self.identity.snapshot()[-1]
                self.assertEqual((receipt["status"], receipt["reason"]), ("rejected", reason))
                self.assertFalse(receipt["pending_created"])

            env.reset_for_tests()
            self.identity._records.clear()
            handle = self.enter()
            self.assertIsNotNone(handle)
            invalidate_lock = DecisionLock(
                lambda entry: setattr(self.capture, env._CAPTURE_PENDING_ATTR, ())
            )
            with patch.object(env, "_LOCK", invalidate_lock):
                self.assertIsNone(env.append_result(
                    call_id="call-5", api_request_id=None, response_id=None,
                    value="x", dispatcher_disposition=None,
                ))
            receipt = self.identity.snapshot()[-1]
            self.assertEqual(
                (receipt["event"], receipt["status"], receipt["reason"]),
                ("lr32_append_outcome", "rejected", "handle_not_current"),
            )
            self.assertEqual(receipt["exact_match_count"], 0)
            self.assertFalse(receipt["consumed"])

    def test_duplicate_receipt_does_not_hold_handle_lock_across_requests(self):
        capture_a = self.capture
        capture_b = types.SimpleNamespace(
            _lr32_server_validated_synthetic=True,
            metadata_capture=types.SimpleNamespace(calls=[self.call]),
        )
        existing = env.CallCapture(
            "approved-7", "attempt-a", "call-5",
            {"tool": env.TARGET_TOOL, "call_ordinal": 1, "arg_shape": {}},
        )
        setattr(capture_a, env._CAPTURE_PENDING_ATTR, (existing,))
        local = threading.local()
        emitter_entered = threading.Event()
        release_emitter = threading.Event()
        b_started = threading.Event()
        b_done = threading.Event()
        errors = []
        results = {}
        original_receipt = env._adapter_receipt

        def current_capture():
            return capture_a if getattr(local, "name", None) == "a" else capture_b

        def paused_receipt(identity, capture, **kwargs):
            if getattr(local, "name", None) == "a" and kwargs.get("reason") == "duplicate_handle":
                emitter_entered.set()
                if not release_emitter.wait(2):
                    raise AssertionError("A receipt release was not signalled")
            return original_receipt(identity, capture, **kwargs)

        def run(name, done=None):
            identity = trace.CaptureIdentityTrace(run_id="approved-7", attempt_id=f"attempt-{name}")
            token = trace.enter_trace(identity)
            local.name = name
            try:
                if name == "b":
                    b_started.set()
                results[name] = env.adapter_entry(env.TARGET_TOOL, {"location_id": "sunset-somo"})
            except BaseException as exc:
                errors.append(exc)
            finally:
                if done is not None:
                    done.set()
                trace.exit_trace(token)

        with patch.dict(os.environ, self.good, clear=True), \
             patch.object(env, "_current_capture", side_effect=current_capture), \
             patch.object(env, "_adapter_receipt", side_effect=paused_receipt):
            thread_a = threading.Thread(target=run, args=("a",), daemon=True)
            thread_b = threading.Thread(target=run, args=("b", b_done), daemon=True)
            thread_a.start()
            try:
                self.assertTrue(emitter_entered.wait(2), "A never reached duplicate receipt")
                thread_b.start()
                self.assertTrue(b_started.wait(2), "B never started")
                self.assertTrue(
                    b_done.wait(1),
                    "B handle critical section blocked behind A receipt I/O",
                )
            finally:
                release_emitter.set()
                thread_a.join(2)
                if thread_b.ident is not None:
                    thread_b.join(2)
            self.assertFalse(thread_a.is_alive())
            self.assertFalse(thread_b.is_alive())
        self.assertEqual(errors, [])
        self.assertIsNone(results["a"])
        self.assertIsInstance(results["b"], env.CallCapture)

    def test_receipts_redaction_projection_checksum_atomic_and_aggregate_budget(self):
        with patch.dict(os.environ,self.good,clear=True):
            h=self.enter(); tid=env.transport_attempt(h)
            env.transport_result(h,transport_id=tid,http_status=200,body=b'{"ok":true}',staff_receipt=True)
            path=self.finish(h,{"token":"secret","blob":"x"*50000})
        raw=Path(path).read_bytes(); doc=json.loads(raw); digest=doc.pop("checksum_sha256")
        self.assertEqual(digest,env.checksum(doc)); self.assertLessEqual(len(raw),env.MAX_ENVELOPE_BYTES)
        self.assertLessEqual(len(doc["append"]["result"].encode()),env.MAX_APPEND_BYTES)
        self.assertNotIn("secret",raw.decode()); self.assertFalse(doc["capture_complete"])
        self.assertIsNone(doc["transport"]["staff_receipt_observed"])
        self.assertEqual(doc["transport"]["staff_receipt_dependency"],"producer_unavailable")
        self.assertEqual(len(list(Path(self.tmp.name).glob("*.json"))),1)
        with patch.dict(os.environ,self.good,clear=True):
            env.reset_for_tests(); self.assertIsNone(self.finish(self.enter()))
        self.assertLessEqual(sum(p.stat().st_size for p in Path(self.tmp.name).glob("*.json")),env.MAX_ENVELOPE_BYTES)

    def test_atomic_final_publication_is_no_replace_across_processes(self):
        script = """
import sys
from pathlib import Path
from wolfhouse.luna_call1_failure_envelope import _atomic_write
try:
    _atomic_write(Path(sys.argv[1]), "one-run.json", sys.argv[2].encode())
    print("published")
except FileExistsError:
    print("exists")
"""
        root = str(Path(__file__).resolve().parents[1])
        environment = {**os.environ, "PYTHONPATH": root}
        processes = [subprocess.Popen(
            [sys.executable, "-c", script, self.tmp.name, payload],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=environment,
        ) for payload in ("first", "second")]
        results = [process.communicate(timeout=10) for process in processes]
        self.assertEqual([process.returncode for process in processes], [0, 0], results)
        self.assertEqual(sorted(stdout.strip() for stdout, _stderr in results), ["exists", "published"])
        self.assertIn((Path(self.tmp.name) / "one-run.json").read_text(), {"first", "second"})

    def test_transport_error_malformed_exception_and_plugin_transform(self):
        cases=[(dict(http_status=503,body=b'{}'),"http_error"),(dict(http_status=200,body=b'bad'),"malformed_body"),(dict(exception=TimeoutError()),"transport_exception")]
        for i,(kw,want) in enumerate(cases):
            for old in Path(self.tmp.name).glob("*.json"): old.unlink()
            self.call["response"]["tool_calls"][0]["id"]=f"c{i}"; env.reset_for_tests()
            with patch.dict(os.environ,self.good,clear=True):
                h=self.enter(); h.expected_call_id=f"c{i}"; tid=env.transport_attempt(h); env.transport_result(h,transport_id=tid,**kw)
                env.plugin_return(h,None,exception=ValueError()); p=env.append_result(call_id=f"c{i}",api_request_id=None,response_id=None,value="bad",dispatcher_disposition="failed",producer="caught_exception")
            d=json.loads(Path(p).read_text()); self.assertEqual(d["transport"]["outcome"],want); self.assertEqual(d["plugin_return"]["classification"],"transform_exception:ValueError")

    def test_ordinary_plugin_worker_context_publishes_transport_error_envelope(self):
        """The real plugin runs in a copied worker Context; append runs in its parent."""
        from plugins import wolfhouse_staff_api as plugin
        from wolfhouse.luna_group_lesson_live_eval import BoundedMetadataCapture

        metadata = BoundedMetadataCapture(
            model="gpt-5.6-sol", revisions={"wolfhouse": None, "hermes": None},
            api_mode="codex_responses", streaming=True,
        )
        metadata.observe_request(
            attempted=True, sent=True, prompts=[], tools=[], tool_choice="auto",
            api_mode="codex_responses", endpoint=None, streaming=True,
        )
        metadata.observe_response(
            status="completed", finish_reason="completed", provider_shape="openai_responses",
            completion_category="tool_calls", output_item_types=["function_call"],
            tool_calls=[{"id": "sealed-call1", "name": env.TARGET_TOOL, "arg_validation": "valid"}],
        )
        self.capture.metadata_capture = metadata
        # No network: urllib is the external transport seam. The real plugin,
        # adapter, transport observers, append owner, validation and sink remain.
        with patch.dict(os.environ, self.good, clear=True), \
             patch("urllib.request.urlopen", side_effect=TimeoutError("offline-control")):
            worker = contextvars.copy_context()
            result = worker.run(plugin.get_sunset_lesson_catalog, {"location_id": "sunset-somo"})
            self.assertIn('"success": false', result.lower())
            handle = env.current_handle()
            self.assertIsNotNone(handle)
            self.assertEqual(handle.expected_call_id, "sealed-call1")
            self.assertEqual(handle.transport["outcome"], "transport_exception")
            path = env.append_result(
                call_id="sealed-call1", api_request_id="sealed-request",
                response_id=None, value=result, dispatcher_disposition="failed",
                producer="executor_return",
            )
        self.assertIsNotNone(path)
        document = json.loads(Path(path).read_text())
        self.assertEqual(document["ids"]["tool_call_id"], "sealed-call1")
        self.assertEqual(document["transport"]["outcome"], "transport_exception")
        self.assertEqual(document["dispatcher"]["disposition"], "failed")
        checksum = document.pop("checksum_sha256")
        self.assertEqual(checksum, env.checksum(document))

    def test_active_capture_cannot_observe_or_finalize_another_capture_handle(self):
        with patch.dict(os.environ, self.good, clear=True):
            handle = self.enter()
            self.assertIsNotNone(handle)
            other = types.SimpleNamespace(
                _lr32_server_validated_synthetic=True,
                metadata_capture=types.SimpleNamespace(calls=[self.call]),
            )
            self.capture_mock.return_value = other
            self.assertIsNone(env.current_handle())
            self.assertIsNone(self.finish(handle))
            self.capture_mock.return_value = self.capture
            self.assertIs(env.current_handle(), handle)
            self.assertIsNotNone(self.finish(handle))

    def test_async_and_thread_contexts_do_not_cross_call_ids(self):
        results=[]
        def worker(i):
            ident=trace.CaptureIdentityTrace(run_id=f"run-{i}",attempt_id=str(i)); tok=trace.enter_trace(ident)
            call={"call_index":1,"response":{"tool_calls":[{"id":f"id-{i}","function":{"name":env.TARGET_TOOL}}]},"executor":{"dispositions":[]}}
            cap=types.SimpleNamespace(_lr32_server_validated_synthetic=True,metadata_capture=types.SimpleNamespace(calls=[call]))
            values={**self.good,env.APPROVED_RUN_ENV:f"run-{i}"}
            try:
                with patch.object(env,"_current_capture",return_value=cap),patch.dict(os.environ,values,clear=True):
                    h=self.enter(); results.append((i,h.expected_call_id))
            finally: trace.exit_trace(tok)
        # Environment mutation is serialized; context isolation itself is exercised in threads.
        for i in range(4): threading.Thread(target=worker,args=(i,)).start()
        while threading.active_count()>1: pass
        self.assertEqual(sorted(results),[(i,f"id-{i}") for i in range(4)])
        async def nested():
            with patch.dict(os.environ,self.good,clear=True):
                env.reset_for_tests(); h=self.enter(); return await asyncio.create_task(asyncio.sleep(0,result=h.expected_call_id))
        self.assertEqual(asyncio.run(nested()),"call-5")

    def test_every_hook_failure_is_fail_open_and_sink_is_hardened(self):
        from plugins import wolfhouse_staff_api as plugin
        expected=plugin._get_sunset_lesson_catalog_impl
        with patch.dict(os.environ,self.good,clear=True):
            for hook in ("adapter_entry","transport_attempt","transport_result","plugin_return"):
                with patch.object(env,hook,side_effect=RuntimeError("injected")):
                    # Adapter/observer failures preserve the underlying transform result/exception contract.
                    with patch.object(plugin,"_get_sunset_lesson_catalog_impl",return_value="same"):
                        self.assertEqual(plugin.get_sunset_lesson_catalog({}),"same")
        self.assertIsNotNone(expected)
        env.reset_for_tests()
        self.call["response"]["tool_calls"][0]["id"]="call-5"
        with patch.dict(os.environ,{**self.good,env.ARTIFACT_DIR_ENV:"/arbitrary"},clear=True):
            h=self.enter(); self.assertIsNone(self.finish(h)); self.assertEqual(h.capture_failure,"persistence_failed")

if __name__=="__main__": unittest.main()
