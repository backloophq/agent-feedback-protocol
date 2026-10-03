"""Python SDK for the Agent Feedback Protocol: validate, send and receive structured feedback from AI agents."""

from ._generated import (
    ACK_SCHEMA,
    AGENT_FEEDBACK_INSTRUCTIONS,
    FEEDBACK_SCHEMA,
    FEEDBACK_TOOL_DESCRIPTION,
    RECORD_SCHEMA,
)
from .client import FeedbackClient, FeedbackError, SubmitResult, feedback_url_from_link
from .forward import ForwardError, MemorySink, fan_out, forward_to, memory_sink
from .ids import hash_account, new_id
from .integrations import fastapi_router, flask_blueprint
from .redact import REDACTED, redact, redact_string
from .server import (
    FeedbackHandler,
    HandlerResponse,
    OnRecordResult,
    agent_from_user_agent,
    error_response,
    feedback_link_header,
)
from .tool import FEEDBACK_TOOL_NAME, feedback_tool, feedback_tool_input_schema
from .types import (
    DEFAULT_MAX_BYTES,
    FEEDBACK_TYPES,
    LINK_REL,
    OUTCOMES,
    SPEC_VERSION,
    WELL_KNOWN_PATH,
    AgentInfo,
    DiscoveryDocument,
    Evidence,
    FeedbackAck,
    FeedbackRecord,
    FeedbackSubmission,
    KnownIssue,
    ValidationIssue,
)
from .validate import (
    ValidationResult,
    format_issues,
    validate_ack,
    validate_record,
    validate_submission,
)

__version__ = "0.1.5"

__all__ = [
    "ACK_SCHEMA",
    "AGENT_FEEDBACK_INSTRUCTIONS",
    "DEFAULT_MAX_BYTES",
    "FEEDBACK_SCHEMA",
    "FEEDBACK_TOOL_DESCRIPTION",
    "FEEDBACK_TOOL_NAME",
    "FEEDBACK_TYPES",
    "LINK_REL",
    "OUTCOMES",
    "RECORD_SCHEMA",
    "REDACTED",
    "SPEC_VERSION",
    "WELL_KNOWN_PATH",
    "AgentInfo",
    "DiscoveryDocument",
    "Evidence",
    "FeedbackAck",
    "FeedbackClient",
    "FeedbackError",
    "FeedbackHandler",
    "FeedbackRecord",
    "FeedbackSubmission",
    "ForwardError",
    "HandlerResponse",
    "KnownIssue",
    "MemorySink",
    "OnRecordResult",
    "SubmitResult",
    "ValidationIssue",
    "ValidationResult",
    "agent_from_user_agent",
    "error_response",
    "fan_out",
    "fastapi_router",
    "feedback_link_header",
    "feedback_tool",
    "feedback_tool_input_schema",
    "feedback_url_from_link",
    "flask_blueprint",
    "format_issues",
    "forward_to",
    "hash_account",
    "memory_sink",
    "new_id",
    "redact",
    "redact_string",
    "validate_ack",
    "validate_record",
    "validate_submission",
]
