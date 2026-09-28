"""Protocol types and constants. See spec/*.schema.json."""

from typing import Any, Dict, List, Literal, Tuple, TypedDict

SPEC_VERSION = "0.1"

FEEDBACK_TYPES: Tuple[str, ...] = (
    "missing_capability",
    "bug",
    "unclear_documentation",
    "unexpected_response",
    "unhelpful_error",
    "performance",
    "other",
)
OUTCOMES: Tuple[str, ...] = ("blocked", "degraded", "completed")

DEFAULT_MAX_BYTES = 16_384
WELL_KNOWN_PATH = "/.well-known/agent-feedback"
LINK_REL = "agent-feedback"

FeedbackType = Literal[
    "missing_capability",
    "bug",
    "unclear_documentation",
    "unexpected_response",
    "unhelpful_error",
    "performance",
    "other",
]
Outcome = Literal["blocked", "degraded", "completed"]
HttpMethod = Literal["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
FeedbackSource = Literal["http", "mcp", "sdk", "other"]
KnownIssueStatus = Literal["acknowledged", "planned", "in_progress", "fixed", "wont_fix"]
AuthMode = Literal["none", "optional", "required"]
FeedbackErrorCode = Literal[
    "invalid_json",
    "invalid_feedback",
    "unauthorized",
    "payload_too_large",
    "unsupported_media_type",
    "rate_limited",
    "method_not_allowed",
    "unavailable",
]


class AgentInfo(TypedDict, total=False):
    name: str
    version: str
    model: str
    framework: str


class Evidence(TypedDict, total=False):
    status_code: int
    request: Dict[str, Any]
    response_excerpt: str


class _FeedbackSubmissionRequired(TypedDict):
    type: FeedbackType
    goal: str
    message: str


class FeedbackSubmission(_FeedbackSubmissionRequired, total=False):
    """What an agent sends to ``POST /feedback``. See spec/feedback.schema.json."""

    spec_version: Literal["0.1"]
    endpoint: str
    method: HttpMethod
    outcome: Outcome
    workaround: bool
    workaround_description: str
    expected: str
    suggestion: str
    request_id: str
    session_id: str
    agent: AgentInfo
    evidence: Evidence
    metadata: Dict[str, Any]


class _FeedbackRecordRequired(TypedDict):
    id: str
    received_at: str
    feedback: FeedbackSubmission


class FeedbackRecord(_FeedbackRecordRequired, total=False):
    """A submission after a service accepted it. See spec/record.schema.json."""

    service: str
    account: str
    source: FeedbackSource


class _KnownIssueRequired(TypedDict):
    id: str
    title: str
    status: KnownIssueStatus


class KnownIssue(_KnownIssueRequired, total=False):
    url: str
    workaround: str


class _FeedbackAckRequired(TypedDict):
    id: str
    status: Literal["accepted"]
    received_at: str


class FeedbackAck(_FeedbackAckRequired, total=False):
    """Body of a ``202`` response. See spec/ack.schema.json."""

    known_issue: KnownIssue


class ValidationIssue(TypedDict):
    """``path`` is a dot path to the offending field; ``""`` for the root object."""

    path: str
    message: str


class _ErrorInfoRequired(TypedDict):
    code: str
    message: str


class ErrorInfo(_ErrorInfoRequired, total=False):
    details: List[ValidationIssue]


class ErrorBody(TypedDict):
    error: ErrorInfo


class DiscoveryDocument(TypedDict):
    """Served at ``GET /.well-known/agent-feedback``."""

    spec_version: Literal["0.1"]
    endpoint: str
    types: List[FeedbackType]
    max_bytes: int
    auth: AuthMode


class _IngestResultRequired(TypedDict):
    id: str
    status: Literal["accepted", "duplicate", "rejected"]


class IngestResult(_IngestResultRequired, total=False):
    known_issue: KnownIssue
    error: ErrorInfo


class IngestResponse(TypedDict):
    """Collector response to ``POST /v1/records``."""

    results: List[IngestResult]
