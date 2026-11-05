"""Session events: the shared queue, previews and limits behind ``instrument_server`` and ``record_requests``.

Events go to ``POST <url>/v1/sessions/events`` as ``{"events": [...]}``, in the
same JSON shapes as the TypeScript SDK's ``sessions.ts``.
"""

from __future__ import annotations

import atexit
import json
import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Mapping, Optional, Union

from . import _http
from .redact import redact as _redact
from .redact import redact_string

logger = logging.getLogger("backloop")

FRUSTRATION_LEVELS = ("low", "medium", "high")

#: Same values as ``SESSION_EVENT_LIMITS`` in ``@backloop/sdk``.
SESSION_EVENT_LIMITS = {"preview": 4000, "error": 1000, "telemetry": 1000, "batch": 500}

SessionEvent = Dict[str, Any]
OnEvents = Callable[[List[SessionEvent]], Any]
RedactOption = Union[bool, Mapping[str, Any]]


def clip(value: str, limit: int) -> str:
    return value if len(value) <= limit else value[: limit - 1] + "…"


def iso_now(ms: Optional[float] = None) -> str:
    """ISO 8601 in UTC with milliseconds, like ``Date.prototype.toISOString``."""
    dt = datetime.fromtimestamp((time.time() * 1000 if ms is None else ms) / 1000, timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _jsonable(value: Any) -> Any:
    dump = getattr(value, "model_dump", None)  # pydantic models
    if callable(dump):
        try:
            return dump(mode="json")
        except Exception:
            pass
    if isinstance(value, (set, frozenset)):
        return list(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


class Scrubber:
    """Redaction and size-capped previews, from the ``redact`` and ``preview_chars`` options."""

    def __init__(self, redact: RedactOption = True, preview_chars: int = 2000) -> None:
        self.enabled = redact is not False
        options = dict(redact) if isinstance(redact, Mapping) else {}
        self.emails = options.get("emails", True)
        self.patterns = list(options.get("patterns") or ())
        self.preview_chars = min(max(int(preview_chars), 0), SESSION_EVENT_LIMITS["preview"])

    def string(self, value: str) -> str:
        return redact_string(value, self.emails, self.patterns) if self.enabled else value

    def value(self, value: Any) -> Any:
        return _redact(value, self.emails, self.patterns) if self.enabled else value

    def preview(self, value: Any) -> Optional[str]:
        if not self.preview_chars or value is None:
            return None
        try:
            if isinstance(value, str):
                text = value
            else:
                plain = json.loads(json.dumps(value, ensure_ascii=False, default=_jsonable))
                text = json.dumps(self.value(plain), ensure_ascii=False, separators=(",", ":"))
        except Exception:
            return None
        return clip(self.string(text), self.preview_chars) if text else None

    def error(self, message: str) -> str:
        return clip(self.string(message), SESSION_EVENT_LIMITS["error"])


def clean_telemetry(raw: Any, scrubber: Scrubber) -> Optional[Dict[str, str]]:
    """Keep the known telemetry fields, trimmed, redacted and capped; None when nothing is left."""
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        dump = getattr(raw, "model_dump", None)
        raw = dump() if callable(dump) else getattr(raw, "__dict__", None)
        if not isinstance(raw, Mapping):
            return None
    out: Dict[str, str] = {}
    for key in ("user_intent", "agent_thinking"):
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            out[key] = clip(scrubber.string(value.strip()), SESSION_EVENT_LIMITS["telemetry"])
    model = raw.get("agent_model")
    if isinstance(model, str) and model.strip():
        out["agent_model"] = clip(model.strip(), 128)
    frustration = raw.get("user_frustration")
    if isinstance(frustration, str) and frustration in FRUSTRATION_LEVELS:
        out["user_frustration"] = frustration
    # Keep the TS key order: user_intent, agent_thinking, user_frustration, agent_model.
    order = ("user_intent", "agent_thinking", "user_frustration", "agent_model")
    return {k: out[k] for k in order if k in out} or None


class EventQueue:
    """Queues events and POSTs them in batches from one background daemon thread.

    A send failure goes to ``on_error`` (default: one logged warning) and is
    never raised to the code that pushed the event.
    """

    def __init__(
        self,
        url: Optional[str] = None,
        ingest_key: Optional[str] = None,
        on_events: Optional[OnEvents] = None,
        flush_ms: float = 1000,
        on_error: Optional[Callable[[BaseException], None]] = None,
        timeout: float = 5.0,
    ) -> None:
        self.endpoint = url.rstrip("/") + "/v1/sessions/events" if url else None
        self.ingest_key = ingest_key
        self.on_events = on_events
        self.flush_s = max(float(flush_ms), 0) / 1000
        self.timeout = timeout
        self.enabled = bool(self.endpoint or on_events)
        self._on_error = on_error
        self._warned = False
        self._cond = threading.Condition()
        self._send_lock = threading.Lock()
        self._queue: List[SessionEvent] = []
        self._thread: Optional[threading.Thread] = None
        if self.enabled:
            atexit.register(self.flush)

    def push(self, event: SessionEvent) -> None:
        if not self.enabled:
            return
        with self._cond:
            self._queue.append(event)
            # Started lazily, and again in a forked worker (threads don't survive fork).
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, name="backloop-events", daemon=True)
                self._thread.start()
            self._cond.notify()

    def flush(self) -> None:
        """Send what is queued now, in the calling thread. Never raises."""
        with self._send_lock:
            with self._cond:
                events, self._queue = self._queue, []
            if not events:
                return
            try:
                self._send(events)
            except BaseException as e:  # noqa: BLE001 - never raised into the caller
                self._error(e)

    def _run(self) -> None:
        batch = SESSION_EVENT_LIMITS["batch"]
        while True:
            with self._cond:
                while not self._queue:
                    self._cond.wait()
                deadline = time.monotonic() + self.flush_s
                while 0 < len(self._queue) < batch:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    self._cond.wait(remaining)
            self.flush()

    def _send(self, events: List[SessionEvent]) -> None:
        if self.on_events is not None:
            self.on_events(events)
        if not self.endpoint:
            return
        headers = {"content-type": "application/json"}
        if self.ingest_key:
            headers["authorization"] = f"Bearer {self.ingest_key}"
        size = SESSION_EVENT_LIMITS["batch"]
        for i in range(0, len(events), size):
            body = _http.dumps({"events": events[i : i + size]})
            last_error: Optional[BaseException] = None
            for _ in range(2):
                try:
                    status, _headers, _raw = _http.request(self.endpoint, "POST", body, headers, self.timeout)
                except Exception as e:
                    last_error = e
                    continue
                if 200 <= status < 300:
                    last_error = None
                    break
                last_error = RuntimeError(f"Backloop returned HTTP {status}")
                if status < 500 and status != 429:
                    break
            if last_error is not None:
                raise last_error

    def _error(self, error: BaseException) -> None:
        if self._on_error is not None:
            try:
                self._on_error(error)
            except Exception:
                pass
            return
        if not self._warned:
            self._warned = True
            logger.warning("[backloop] session events not sent: %s", error)
