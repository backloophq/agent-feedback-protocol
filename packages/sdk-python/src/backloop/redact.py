"""
Best-effort removal of secrets and personal data from feedback before it
leaves the agent. The protocol forbids sending them; this catches mistakes.
"""

from __future__ import annotations

import re
from typing import Iterable, Optional, TypeVar, Union

T = TypeVar("T")

REDACTED = "[REDACTED]"

# Patterns use re.ASCII so \b and \d behave like the (non-unicode) JS regexes
# in redact.ts. JS's \s is Unicode-aware, so it is spelled out where it matters.
_A = re.ASCII
_WS = r"\s   -     　﻿"

_SECRET_PATTERNS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----", _A),
    re.compile(rf"\bBearer[{_WS}]+[A-Za-z0-9\-._~+/]{{8,}}=*", _A | re.I),
    re.compile(rf"\bBasic[{_WS}]+[A-Za-z0-9+/]{{8,}}=*", _A),
    re.compile(r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b", _A),  # JWT
    re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b", _A),  # Anthropic / OpenAI style
    re.compile(r"\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b", _A),  # Stripe
    re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b", _A),  # GitHub
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b", _A),
    re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b", _A),  # Slack
    re.compile(r"\bAKIA[0-9A-Z]{16}\b", _A),  # AWS access key id
    re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b", _A),  # Google API key
    re.compile(
        rf"([?&](?:api_?key|access_token|token|secret|password|signature)=)[^&{_WS}\"']+",
        _A | re.I,
    ),
]

_EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b", _A)
_CARD_CANDIDATE = re.compile(r"\b(?:\d[ -]?){12,18}\d\b", _A)

_SENSITIVE_KEY = re.compile(
    r"authorization|cookie|set-cookie|password|passwd|secret|client_secret|api[_-]?key|x-api-key"
    r"|access[_-]?token|refresh[_-]?token|token|private[_-]?key|ssn|card[_-]?number|cvv",
    _A | re.I,
)

PatternLike = Union[str, "re.Pattern[str]"]


def _luhn(digits: str) -> bool:
    total = 0
    double = False
    for ch in reversed(digits):
        d = ord(ch) - 48
        if double:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        double = not double
    return total % 10 == 0


def _replace_secret(match: re.Match[str]) -> str:
    # Keep a leading capture group (e.g. "?api_key=") and redact the rest.
    prefix = match.group(1) if match.re.groups else None
    if isinstance(prefix, str) and match.group(0).startswith(prefix):
        return prefix + REDACTED
    return REDACTED


def _replace_card(match: re.Match[str]) -> str:
    digits = re.sub(r"[ -]", "", match.group(0))
    return REDACTED if 13 <= len(digits) <= 19 and _luhn(digits) else match.group(0)


def redact_string(
    value: str, emails: bool = True, patterns: Optional[Iterable[PatternLike]] = None
) -> str:
    """Redact secrets, card numbers and (unless ``emails=False``) email addresses in a string."""
    out = value
    extra = [re.compile(p) if isinstance(p, str) else p for p in (patterns or ())]
    for pattern in [*_SECRET_PATTERNS, *extra]:
        out = pattern.sub(_replace_secret, out)
    out = _CARD_CANDIDATE.sub(_replace_card, out)
    if emails:
        out = _EMAIL.sub(REDACTED, out)
    return out


def redact(value: T, emails: bool = True, patterns: Optional[Iterable[PatternLike]] = None) -> T:
    """Recursively redact every string in a JSON value, and the values of sensitive keys.

    Returns a new value; the input is not modified.
    """
    extra = list(patterns or ())
    if isinstance(value, str):
        return redact_string(value, emails, extra)  # type: ignore[return-value]
    if isinstance(value, (list, tuple)):
        return [redact(v, emails, extra) for v in value]  # type: ignore[return-value]
    if isinstance(value, dict):
        return {  # type: ignore[return-value]
            key: REDACTED
            if isinstance(key, str) and _SENSITIVE_KEY.fullmatch(key) and v is not None
            else redact(v, emails, extra)
            for key, v in value.items()
        }
    return value
