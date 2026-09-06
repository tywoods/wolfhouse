"""Reviewer probe consolidated as regression; internal observation, not admission."""
import contextvars, concurrent.futures, threading, sys


def check_concurrent_counts(fixture):
    previous_interval = sys.getswitchinterval()
    sys.setswitchinterval(0.000001)
    fixture.addCleanup(sys.setswitchinterval, previous_interval)
    iso, cap = fixture.iso, fixture.cap
    for trial in range(5):
        receipts, lock = [], threading.Lock()
        overlap = threading.Barrier(16)
        def edge(**kwargs):
            if kwargs.get("overlap"):
                overlap.wait(timeout=10)
            failed = kwargs.get("fail", False)
            with lock:
                receipts.append(not failed)
            if failed:
                raise ConnectionError("fixture SDK exception")
            return fixture.result
        fixture.client.responses.create = edge
        cap.responses_sdk_attempted = cap.responses_sdk_returned = 0
        token = iso.enter_isolated_turn(cap)
        try:
            iso._observe_openai_client(fixture.client)
            create = fixture.client.responses.create
            iso._observe_openai_client(fixture.client)
            assert create is fixture.client.responses.create
            for _ in range(100):
                assert create(model='fixture-model', stream=True) is fixture.result
            assert (cap.responses_sdk_attempted, cap.responses_sdk_returned, len(receipts)) == (100, 100, 100)
            print('SEQUENTIAL_CONTROL', trial, 100, flush=True)
            start = 2**53 - 81 if trial == 3 else 0
            cap.responses_sdk_attempted = cap.responses_sdk_returned = start
            receipts.clear()
            contexts = [contextvars.copy_context() for _ in range(16)]
            barrier = threading.Barrier(16)
            calls = 10 if trial >= 3 else 10000
            def worker():
                barrier.wait(timeout=10)
                for i in range(calls):
                    fail = trial >= 3 and i % 2 == 1
                    try:
                        assert create(model='fixture-model', stream=True, overlap=i == 0, fail=fail) is fixture.result
                        assert not fail
                    except ConnectionError:
                        assert fail
            with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
                futures = [pool.submit(ctx.run, worker) for ctx in contexts]
                for future in futures:
                    future.result(timeout=40)
            observed = (cap.responses_sdk_attempted, cap.responses_sdk_returned)
            assert all(type(n) is int for n in observed)
            assert len(receipts) == 16 * calls
            assert sum(receipts) == 16 * calls // (2 if trial >= 3 else 1)
            expected = (min(start + len(receipts), 2**53 - 1), min(start + sum(receipts), 2**53 - 1))
            print('NATURAL_CONCURRENT', trial, 'SDK_RECEIPTS', (len(receipts), sum(receipts)), 'ATTEMPTED_RETURNED', observed, flush=True)
            assert observed == expected, (observed, expected)
        finally:
            iso.exit_isolated_turn(token)
