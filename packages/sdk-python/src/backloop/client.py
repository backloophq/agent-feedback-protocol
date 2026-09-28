"""Send feedback to a service's ``/feedback`` endpoint."""

from __future__ import annotations

import email.utils
import math
import re
import time
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Union

from . import _http
from .redact import redact as _redact
from .types import (
    SPEC_VERSION,
    WELL_KNOWN_PATH,
    AgentInfo,
    DiscoveryDocument,
    FeedbackAck,
    FeedbackSubmission,
    ValidationIssue,
)
from .validate import format_issues, validate_submission

RETRYABLE = frozenset({429, 500, 502, 503, 504})
USER_AGENT = f"backloop-sdk-python/{SPEC_VERSION}"


class FeedbackError(Exception):
    """Raised on validation, network or HTTP errors. ``code`` is the protocol error code."""

    def __init__(
        self,
        message: str,
        code: str,
        status: Optional[int] = None,
        details: Optional[List[ValidationIssue]] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status
        self.details = details


@dataclass
class SubmitResult:
    """Result of ``try_submit``: ``ack`` when ``ok``, otherwise ``error``."""

    ok: bool
    ack: Optional[FeedbackAck] = None
    error: Optional[FeedbackError] = None


class FeedbackClient:
    """Client for a service's feedback endpoint.

    ``redact`` may be ``True`` (default), ``False``, or a dict of ``redact()``
    options such as ``{"emails": False}``.
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        *,
        endpoint: Optional[str] = None,
        api_key: Optional[str] = None,
        headers: Optional[Dict[str, str]] = None,
        agent: Optional[AgentInfo] = None,
        session_id: Optional[str] = None,
        redact: Union[bool, Mapping[str, Any]] = True,
        timeout: float = 10.0,
    ) -> None:
        if endpoint is None and base_url:
            endpoint = base_url.rstrip("/") + "/feedback"
        if not endpoint:
            raise ValueError("FeedbackClient needs `endpoint` or `base_url`")
        self.endpoint = endpoint
        self.api_key = api_key
        self.headers = dict(headers or {})
        self.agent = agent
        self.session_id = session_id
        self.redact = redact
        self.timeout = timeout

    def prepare(self, feedback: FeedbackSubmission) -> FeedbackSubmission:
        """Build the submission that would be sent: defaults applied, redacted and validated."""
        body: Any = dict(feedback) if isinstance(feedback, dict) else feedback
        if isinstance(body, dict):
            if self.agent and not body.get("agent"):
                body["agent"] = self.agent
            if self.session_id and not body.get("session_id"):
                body["session_id"] = self.session_id
        if self.redact is not False:
            options = self.redact if isinstance(self.redact, Mapping) else {}
            body = _redact(body, **options)
        result = validate_submission(body)
        if not result.valid:
            raise FeedbackError(format_issues(result.issues), "invalid_feedback", None, result.issues)
        return body

    def submit(self, feedback: FeedbackSubmission) -> FeedbackAck:
        """Send feedback. Raises ``FeedbackError`` on validation, network or HTTP errors.

        Retries once on 429 and 5xx, after ``Retry-After`` (default 1s, capped at 10s).
        """
        body = _http.dumps(self.prepare(feedback))
        status, headers, raw = self._post(body)
        if status in RETRYABLE:
            delay = _retry_after_seconds(headers.get("retry-after"))
            time.sleep(max(0.0, min(1.0 if delay is None else delay, 10.0)))
            status, headers, raw = self._post(body)
        payload = _http.parse_json(raw)
        if status in (200, 202):
            return payload
        error = payload.get("error") if isinstance(payload, dict) else None
        if not isinstance(error, dict):
            error = {}
        message = error.get("message")
        code = error.get("code")
        raise FeedbackError(
            message if message is not None else f"Feedback endpoint returned HTTP {status}",
            code if code is not None else "http_error",
            status,
            error.get("details"),
        )

    def try_submit(self, feedback: FeedbackSubmission) -> SubmitResult:
        """Like ``submit``, but never raises: feedback must never break the agent's task."""
        try:
            return SubmitResult(ok=True, ack=self.submit(feedback))
        except FeedbackError as e:
            return SubmitResult(ok=False, error=e)
        except Exception as e:  # noqa: BLE001 - best effort by design
            return SubmitResult(ok=False, error=FeedbackError(str(e), "network_error"))

    def _post(self, body: bytes) -> _http.Response:
        headers = {"content-type": "application/json", "user-agent": USER_AGENT, **self.headers}
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        try:
            return _http.request(self.endpoint, "POST", body, headers, self.timeout)
        except Exception as e:
            reason = getattr(e, "reason", e)
            raise FeedbackError(f"Could not reach {self.endpoint}: {reason}", "network_error") from e

    @staticmethod
    def discover(base_url: str, timeout: float = 5.0) -> Optional[DiscoveryDocument]:
        """Fetch a service's discovery document at ``/.well-known/agent-feedback``.

        Returns None when the service does not implement the protocol.
        """
        try:
            url = urllib.parse.urljoin(base_url, WELL_KNOWN_PATH)
            status, _, raw = _http.request(url, headers={"user-agent": USER_AGENT}, timeout=timeout)
        except Exception:
            return None
        if not 200 <= status < 300:
            return None
        doc = _http.parse_json(raw)
        return doc if isinstance(doc, dict) and isinstance(doc.get("endpoint"), str) else None

    @classmethod
    def from_discovery(cls, base_url: str, **options: Any) -> Optional[FeedbackClient]:
        """Create a client from a service's discovery document, if it has one."""
        doc = cls.discover(base_url)
        if doc is None:
            return None
        return cls(endpoint=urllib.parse.urljoin(base_url, doc["endpoint"]), **options)


_LINK_PART = re.compile(r"<([^>]+)>\s*;(.*)")
_LINK_REL = re.compile(r'rel="?[^";]*\bagent-feedback\b', re.ASCII)


def feedback_url_from_link(link: Optional[str], base: str) -> Optional[str]:
    """Parse a ``Link`` header and return the agent-feedback URL, if any."""
    if not link:
        return None
    for part in link.split(","):
        m = _LINK_PART.search(part)
        if m and _LINK_REL.search(m.group(2)):
            return urllib.parse.urljoin(base, m.group(1))
    return None


def _retry_after_seconds(header: Optional[str]) -> Optional[float]:
    """Seconds to wait from a ``Retry-After`` header (delta-seconds or HTTP-date)."""
    if not header:
        return None
    try:
        seconds = float(header)
        if math.isfinite(seconds):
            return seconds
    except ValueError:
        pass
    try:
        when = email.utils.parsedate_to_datetime(header)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max(0.0, (when - datetime.now(timezone.utc)).total_seconds())
