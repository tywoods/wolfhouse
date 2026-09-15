from __future__ import annotations
import asyncio, json, os, subprocess, sys, tempfile, threading, types, unittest
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
        self.cp=patch.object(env,"_current_capture",return_value=self.capture); self.cp.start()
        self.good={env.ENABLE_ENV:"1",env.APPROVED_RUN_ENV:"approved-7",env.ARTIFACT_DIR_ENV:self.tmp.name,"HERMES_ROLE":"sunset-luna","LUNA_CLIENT_SLUG":"sunset","SUNSET_INGRESS_LOCATION_ID":"sunset-somo"}
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
