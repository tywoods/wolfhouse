"""Thread-safe bounded replay cache for sunset-email-luna.

Claiming a request_id is serialized. The same id yields exactly one invoke.
Eviction is oldest-first and never clears the whole set.
"""

from __future__ import annotations

import threading
from collections import OrderedDict


class ReplayCache:
    def __init__(self, max_size: int = 2048) -> None:
        if not isinstance(max_size, int) or max_size < 1:
            raise ValueError("max_size")
        self._max_size = max_size
        self._lock = threading.Lock()
        self._seen: OrderedDict[str, None] = OrderedDict()
        self._inflight: set[str] = set()
        self._invoke_started: set[str] = set()

    def claim(self, request_id: str) -> bool:
        """Return True if this caller may invoke. False means replay."""
        if not isinstance(request_id, str) or not request_id:
            return False
        with self._lock:
            if request_id in self._seen or request_id in self._inflight:
                return False
            self._inflight.add(request_id)
            return True

    def mark_invoke_started(self, request_id: str) -> None:
        with self._lock:
            if request_id in self._inflight:
                self._invoke_started.add(request_id)

    def finish(self, request_id: str) -> None:
        with self._lock:
            self._inflight.discard(request_id)
            self._invoke_started.discard(request_id)
            if request_id in self._seen:
                self._seen.move_to_end(request_id)
                return
            self._seen[request_id] = None
            while len(self._seen) > self._max_size:
                self._seen.popitem(last=False)

    def __contains__(self, request_id: object) -> bool:
        if not isinstance(request_id, str):
            return False
        with self._lock:
            return request_id in self._seen or request_id in self._inflight

    def inflight_count(self) -> int:
        with self._lock:
            return len(self._inflight)

    def seen_count(self) -> int:
        with self._lock:
            return len(self._seen)
