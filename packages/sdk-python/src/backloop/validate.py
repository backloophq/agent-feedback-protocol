"""
A small JSON Schema interpreter covering exactly the keywords the protocol
schemas use, so the SDK validates against spec/*.schema.json with zero
dependencies. Mirrors validate.ts in the TypeScript SDK.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Any, Dict, Generic, List, Optional, TypeVar

from ._generated import ACK_SCHEMA, FEEDBACK_SCHEMA, RECORD_SCHEMA
from .types import FeedbackAck, FeedbackRecord, FeedbackSubmission, ValidationIssue

T = TypeVar("T")
Schema = Dict[str, Any]

_REFS: Dict[str, Schema] = {"feedback.schema.json": FEEDBACK_SCHEMA}

_RFC3339 = re.compile(
    r"\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})", re.ASCII
)


def _type_of(value: Any) -> str:
    """The JSON type of a Python value, as ``typeof`` would report it in validate.ts."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (list, tuple)):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def _is_integer(value: Any) -> bool:
    # Like Number.isInteger: 400 and 400.0 are integers, 400.5 and True are not.
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value) and value.is_integer()


def _same(a: Any, b: Any) -> bool:
    """JSON equality: unlike ``==``, ``True`` never equals ``1``."""
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    return a == b


def _num(n: Any) -> str:
    return str(int(n)) if isinstance(n, float) and n.is_integer() else str(n)


def _check(schema: Schema, value: Any, path: str, issues: List[ValidationIssue]) -> None:
    ref = schema.get("$ref")
    if ref:
        target = _REFS.get(ref)
        if target is None:
            raise ValueError(f"Unresolvable $ref {ref}")
        _check(target, value, path, issues)
        return

    actual = _type_of(value)
    expected = schema.get("type")
    if expected == "object" and actual != "object":
        issues.append({"path": path, "message": "must be an object"})
        return
    if expected == "string" and actual != "string":
        issues.append({"path": path, "message": "must be a string"})
        return
    if expected == "boolean" and actual != "boolean":
        issues.append({"path": path, "message": "must be a boolean"})
        return
    if expected == "integer" and not _is_integer(value):
        issues.append({"path": path, "message": "must be an integer"})
        return
    if expected == "number" and not (actual == "number" and math.isfinite(value)):
        issues.append({"path": path, "message": "must be a number"})
        return

    if "const" in schema and not _same(value, schema["const"]):
        const = json.dumps(schema["const"], ensure_ascii=False)
        issues.append({"path": path, "message": f"must be {const}"})
    enum = schema.get("enum")
    if enum is not None and not any(_same(value, option) for option in enum):
        issues.append({"path": path, "message": "must be one of: " + ", ".join(map(str, enum))})

    if actual == "string":
        length = len(value)  # code points, as JSON Schema specifies
        min_length = schema.get("minLength")
        if min_length is not None and length < min_length:
            message = (
                "must not be empty" if min_length == 1 else f"must be at least {min_length} characters"
            )
            issues.append({"path": path, "message": message})
        max_length = schema.get("maxLength")
        if max_length is not None and length > max_length:
            issues.append({"path": path, "message": f"must be at most {max_length} characters"})
        if schema.get("format") == "date-time" and not _RFC3339.fullmatch(value):
            issues.append({"path": path, "message": "must be an RFC 3339 date-time"})

    if actual == "number":
        minimum = schema.get("minimum")
        if minimum is not None and value < minimum:
            issues.append({"path": path, "message": f"must be >= {_num(minimum)}"})
        maximum = schema.get("maximum")
        if maximum is not None and value > maximum:
            issues.append({"path": path, "message": f"must be <= {_num(maximum)}"})

    if actual == "object" and ("properties" in schema or "required" in schema):
        properties: Schema = schema.get("properties") or {}

        def join(key: Any) -> str:
            return f"{path}.{key}" if path else str(key)

        for key in schema.get("required", ()):
            if key not in value:
                issues.append({"path": join(key), "message": "is required"})
        for key, child in value.items():
            child_schema = properties.get(key)
            if child_schema is not None:
                _check(child_schema, child, join(key), issues)
            elif schema.get("additionalProperties") is False:
                issues.append({"path": join(key), "message": "is not a recognised field"})


@dataclass
class ValidationResult(Generic[T]):
    """``valid`` is True when ``issues`` is empty; ``value`` is then the validated input."""

    valid: bool
    issues: List[ValidationIssue] = field(default_factory=list)
    value: Optional[T] = None

    def __bool__(self) -> bool:
        return self.valid


def _run(schema: Schema, value: Any) -> ValidationResult[Any]:
    issues: List[ValidationIssue] = []
    _check(schema, value, "", issues)
    if issues:
        return ValidationResult(valid=False, issues=issues)
    return ValidationResult(valid=True, issues=[], value=value)


def validate_submission(value: Any) -> ValidationResult[FeedbackSubmission]:
    """Validate an agent's submission against spec/feedback.schema.json."""
    return _run(FEEDBACK_SCHEMA, value)


def validate_record(value: Any) -> ValidationResult[FeedbackRecord]:
    """Validate a stored/forwarded record against spec/record.schema.json."""
    return _run(RECORD_SCHEMA, value)


def validate_ack(value: Any) -> ValidationResult[FeedbackAck]:
    """Validate a ``202`` acknowledgement against spec/ack.schema.json."""
    return _run(ACK_SCHEMA, value)


def format_issues(issues: List[ValidationIssue]) -> str:
    """``"goal: must not be empty; type: is required"``."""
    return "; ".join(f"{i['path']}: {i['message']}" if i["path"] else i["message"] for i in issues)
