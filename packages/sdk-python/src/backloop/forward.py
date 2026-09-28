"""``on_record`` sinks: forward records to a collector, or keep them in memory."""

from __future__ import annotations

from typing import Callable, List, Optional

from . import _http
from .server import OnRecord, OnRecordResult
from .types import FeedbackRecord


class ForwardError(Exception):
    """The collector could not be reached, returned an error, or rejected the record."""

    def __init__(self, message: str, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.status = status


def forward_to(url: str, ingest_key: Optional[str] = None, timeout: float = 5.0) -> OnRecord:
    """
    An ``on_record`` sink that forwards records to a collector's
    ``POST /v1/records`` and passes any ``known_issue`` back to the agent.

    Retries once on network errors, 429 and 5xx; raises ``ForwardError`` on
    failure, which the handler turns into ``503 unavailable``.
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

    return sink


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
