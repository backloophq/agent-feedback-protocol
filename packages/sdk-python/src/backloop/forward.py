"""``on_record`` sinks: forward records to a collector, or keep them in memory."""

from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as _Timeout
from typing import Callable, List, Optional

from . import _http
from .server import OnRecord, OnRecordResult
from .types import FeedbackRecord


logger = logging.getLogger("backloop")

# Forwards that outlive their request. Few threads: they wait on the network, and a
# collector that is down must not take the service's threads with it.
_BACKGROUND_THREADS = 4
_BACKGROUND_LIMIT = 200


class ForwardError(Exception):
    """The collector could not be reached, returned an error, or rejected the record."""

    def __init__(self, message: str, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.status = status


def forward_to(
    url: str,
    ingest_key: Optional[str] = None,
    timeout: float = 5.0,
    wait: Optional[float] = None,
    on_error: Optional[Callable[[Exception, FeedbackRecord], None]] = None,
) -> OnRecord:
    """
    An ``on_record`` sink that forwards records to a collector's
    ``POST /v1/records`` and passes any ``known_issue`` back to the agent.

    Retries once on network errors, 429 and 5xx; raises ``ForwardError`` on
    failure, which the handler turns into ``503 unavailable``.

    ``wait``: how long the agent's request waits for the collector's answer, in
    seconds. None: until it answers (or fails). Set: at most that long, then
    forwarding goes on in a background thread, so a slow collector never holds
    a worker. An answer that came in time still carries the known issue back.
    ``on_error`` is told about a forward that failed after the request was
    answered (default: logged).
    """
    endpoint = url.rstrip("/") + "/v1/records"
    headers = {"content-type": "application/json"}
    if ingest_key:
        headers["authorization"] = f"Bearer {ingest_key}"

    def sink(record: FeedbackRecord) -> OnRecordResult:
        body = _http.dumps({"records": [record]})
        last_error = ForwardError(f"Could not forward to {endpoint}")
        for _attempt in range(2):
            try:
                status, _, raw = _http.request(endpoint, "POST", body, headers, timeout)
            except Exception as e:
                last_error = ForwardError(f"Could not reach {endpoint}: {getattr(e, 'reason', e)}")
                continue
            if 200 <= status < 300:
                return _result(raw)
            last_error = ForwardError(f"Collector returned HTTP {status}", status)
            if status < 500 and status != 429:
                break
        raise last_error

    if wait is None:
        return sink

    pool = ThreadPoolExecutor(max_workers=_BACKGROUND_THREADS, thread_name_prefix="backloop-forward")
    pending = threading.BoundedSemaphore(_BACKGROUND_LIMIT)

    def late(error: Exception, record: FeedbackRecord) -> None:
        if on_error:
            on_error(error, record)
        else:
            logger.error("[backloop] feedback record %s not forwarded: %s", record.get("id"), error)

    def background(record: FeedbackRecord) -> OnRecordResult:
        # More waiting than a collector that is down can take: this one is dropped, and said so.
        if not pending.acquire(blocking=False):
            late(ForwardError(f"Too many records waiting for {endpoint}"), record)
            return None
        answered = threading.Event()
        lock = threading.Lock()

        def work() -> OnRecordResult:
            try:
                return sink(record)
            except Exception as e:
                with lock:
                    if not answered.is_set():
                        raise
                late(e, record)
                return None
            finally:
                pending.release()

        future = pool.submit(work)
        try:
            return future.result(timeout=wait)
        except _Timeout:
            with lock:
                answered.set()
            # It failed between the timeout and the lock: nobody was told yet.
            if future.done() and future.exception() is not None:
                late(future.exception(), record)  # type: ignore[arg-type]
            return None

    return background


def _result(raw: bytes) -> OnRecordResult:
    data = _http.parse_json(raw)
    if not isinstance(data, dict):
        raise ForwardError("Collector returned an invalid response")
    results = data.get("results")
    result = results[0] if isinstance(results, list) and results and isinstance(results[0], dict) else {}
    if result.get("status") == "rejected":
        error = result.get("error")
        message = error.get("message") if isinstance(error, dict) else None
        raise ForwardError(f"Collector rejected record: {message or 'unknown error'}")
    known_issue = result.get("known_issue")
    return {"known_issue": known_issue} if known_issue else None


def fan_out(*sinks: Callable[[FeedbackRecord], OnRecordResult]) -> OnRecord:
    """Run several sinks for each record; the first ``known_issue`` wins."""

    def sink(record: FeedbackRecord) -> OnRecordResult:
        results = [s(record) for s in sinks]
        return next((r for r in results if r and r.get("known_issue")), None)

    return sink


class MemorySink:
    """Keeps records in ``records``. Useful for tests and prototypes."""

    def __init__(self) -> None:
        self.records: List[FeedbackRecord] = []

    def __call__(self, record: FeedbackRecord) -> None:
        self.records.append(record)


def memory_sink() -> MemorySink:
    """An ``on_record`` sink that keeps records in memory (``sink.records``)."""
    return MemorySink()
