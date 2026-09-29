"""Framework-agnostic handler for ``POST /feedback`` and the discovery document."""

from __future__ import annotations

import inspect
import json
import logging
import math
import re
import threading
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple, Union

from .ids import new_id
from .redact import redact as _redact
from .types import (
    DEFAULT_MAX_BYTES,
    FEEDBACK_TYPES,
    LINK_REL,
    SPEC_VERSION,
    AuthMode,
    DiscoveryDocument,
    FeedbackRecord,
    FeedbackSource,
    ValidationIssue,
)
from .validate import format_issues, validate_submission

logger = logging.getLogger("backloop")

#: ``(status, json_body, headers)``, ready to hand to any web framework.
HandlerResponse = Tuple[int, Dict[str, Any], Dict[str, str]]
#: What ``on_record`` may return: ``{"known_issue": {...}}`` to pass back to the agent, or None.
OnRecordResult = Optional[Mapping[str, Any]]
OnRecord = Callable[[FeedbackRecord], OnRecordResult]

JSON_HEADERS = {"content-type": "application/json; charset=utf-8"}
_JSON_CONTENT_TYPE = re.compile(r"application/(?:[\w.+-]+\+)?json\b", re.I | re.ASCII)


def error_response(
    status: int,
    code: str,
    message: str,
    details: Optional[List[ValidationIssue]] = None,
    headers: Optional[Dict[str, str]] = None,
) -> HandlerResponse:
    """Build a protocol error: ``{"error": {"code", "message", "details"?}}``."""
    error: Dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        error["details"] = details
    return status, {"error": error}, {**JSON_HEADERS, **(headers or {})}


def feedback_link_header(path: str = "/feedback") -> str:
    """``Link`` header value advertising the feedback endpoint. Add it to your API's error responses."""
    return f'<{path}>; rel="{LINK_REL}"'


class _RateLimiter:
    def __init__(self, limit: int, window: float) -> None:
        self._limit = limit
        self._window = window
        self._hits: Dict[str, List[float]] = {}  # key -> [count, reset_at]
        self._lock = threading.Lock()

    def take(self, key: str, now: float) -> int:
        """Returns seconds to wait, or 0 if allowed."""
        with self._lock:
            entry = self._hits.get(key)
            if entry is None or entry[1] <= now:
                if len(self._hits) > 10_000:
                    self._hits.clear()
                self._hits[key] = [1, now + self._window]
                return 0
            entry[0] += 1
            return math.ceil(entry[1] - now) if entry[0] > self._limit else 0


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not valid JSON")


class FeedbackHandler:
    """Validates submissions, builds records and hands them to ``on_record``.

    Framework-agnostic: your route reads the body and the caller's account,
    calls ``handle_submit`` and returns the ``(status, body, headers)`` it gets.

    - ``on_record(record)`` stores or forwards each accepted record. It may
      return ``{"known_issue": {...}}`` to pass back to the agent. If it raises,
      the agent gets ``503 unavailable``.
    - ``identify(request)`` resolves the (pseudonymous, see ``hash_account``)
      account behind a framework request; used by the integrations.
    - ``rate_limit`` is ``(max, window_seconds)`` per account (or per IP), or
      None to disable it.
    - ``redact`` removes secrets, card numbers and email addresses from what
      agents send, before ``on_record`` sees it. True (default), False, or a
      dict of ``redact()`` options. Not every agent uses a client that does.
    """

    def __init__(
        self,
        on_record: OnRecord,
        *,
        service: Optional[str] = None,
        identify: Optional[Callable[[Any], Any]] = None,
        auth: AuthMode = "optional",
        max_bytes: int = DEFAULT_MAX_BYTES,
        public_endpoint: Optional[str] = None,
        rate_limit: Optional[Tuple[int, float]] = (60, 60.0),
        source: FeedbackSource = "http",
        redact: Union[bool, Mapping[str, Any]] = True,
        generate_id: Optional[Callable[[], str]] = None,
        now: Optional[Callable[[], datetime]] = None,
    ) -> None:
        if inspect.iscoroutinefunction(on_record):
            raise TypeError("on_record must be a regular (synchronous) function")
        self.on_record = on_record
        self.service = service
        self.identify = identify
        self.auth = auth
        self.max_bytes = max_bytes
        self.public_endpoint = public_endpoint
        self.source = source
        self.redact = redact
        self._limiter = _RateLimiter(*rate_limit) if rate_limit else None
        self._generate_id = generate_id or (lambda: new_id("fb"))
        self._now = now or (lambda: datetime.now(timezone.utc))

    def handle_submit(
        self,
        body: Union[bytes, str],
        content_type: Optional[str],
        account: Optional[str] = None,
        client_ip: Optional[str] = None,
    ) -> HandlerResponse:
        """Handle ``POST /feedback``. Returns ``(status, json_body, headers)``."""
        raw = body.encode("utf-8") if isinstance(body, str) else bytes(body)
        if not _JSON_CONTENT_TYPE.match(content_type or ""):
            return error_response(415, "unsupported_media_type", "Content-Type must be application/json")
        if len(raw) > self.max_bytes:
            return error_response(413, "payload_too_large", f"Feedback is limited to {self.max_bytes} bytes")
        if self.auth == "required" and not account:
            return error_response(
                401, "unauthorized", "Authenticate with the same credentials as the rest of the API"
            )

        if self._limiter is not None:
            key = account if account is not None else client_ip if client_ip is not None else "anonymous"
            wait = self._limiter.take(key, self._utc_now().timestamp())
            if wait > 0:
                return error_response(
                    429, "rate_limited", "Too many feedback submissions", headers={"retry-after": str(wait)}
                )

        try:
            # Decode like fetch's Request.text(): UTF-8, BOM stripped, invalid bytes replaced.
            parsed = json.loads(raw.decode("utf-8-sig", "replace"), parse_constant=_reject_constant)
        except ValueError:
            return error_response(400, "invalid_json", "Body is not valid JSON")
        result = validate_submission(parsed)
        if not result.valid:
            return error_response(400, "invalid_feedback", format_issues(result.issues), result.issues)

        record: FeedbackRecord = {"id": self._generate_id(), "received_at": _iso(self._utc_now())}  # type: ignore[typeddict-item]
        if self.service:
            record["service"] = self.service
        if account:
            record["account"] = account
        record["source"] = self.source or "http"
        if self.redact is not False:
            parsed = _redact(parsed, **(self.redact if isinstance(self.redact, Mapping) else {}))
        record["feedback"] = parsed

        try:
            outcome = self.on_record(record)
        except Exception:
            logger.exception("[backloop] failed to store feedback record")
            return error_response(
                503, "unavailable", "Feedback could not be stored. Retry once later.", headers={"retry-after": "5"}
            )

        ack: Dict[str, Any] = {"id": record["id"], "status": "accepted", "received_at": record["received_at"]}
        known_issue = outcome.get("known_issue") if isinstance(outcome, Mapping) else None
        if known_issue:
            ack["known_issue"] = known_issue
        return 202, ack, dict(JSON_HEADERS)

    def discovery(self, base_url: Optional[str] = None) -> DiscoveryDocument:
        """The document for ``GET /.well-known/agent-feedback``.

        The endpoint is ``public_endpoint`` if set, else ``{base_url}/feedback``.
        """
        endpoint = self.public_endpoint
        if endpoint is None:
            endpoint = (base_url or "").rstrip("/") + "/feedback"
        return {
            "spec_version": SPEC_VERSION,
            "endpoint": endpoint,
            "types": list(FEEDBACK_TYPES),  # type: ignore[typeddict-item]
            "max_bytes": self.max_bytes,
            "auth": self.auth,
        }

    def _utc_now(self) -> datetime:
        now = self._now()
        return now.replace(tzinfo=timezone.utc) if now.tzinfo is None else now


def _iso(dt: datetime) -> str:
    """Format like ``Date.toISOString()``: UTC, millisecond precision."""
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"
