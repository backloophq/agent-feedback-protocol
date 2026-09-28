"""Minimal urllib wrapper: returns every HTTP status instead of raising on 4xx/5xx."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Mapping, Optional, Tuple

Response = Tuple[int, Mapping[str, str], bytes]


def request(
    url: str,
    method: str = "GET",
    body: Optional[bytes] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: float = 10.0,
) -> Response:
    """Send a request and return ``(status, headers, body)``.

    Network failures (connection refused, timeouts, bad URLs) raise. Like
    fetch, only http(s) URLs are allowed: urllib would also open file:// URLs.
    """
    if urllib.parse.urlsplit(url).scheme.lower() not in ("http", "https"):
        raise ValueError(f"Unsupported URL: {url}")
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.headers, res.read()
    except urllib.error.HTTPError as e:
        try:
            raw = e.read()  # reading to the end also releases the connection
        except Exception:
            raw = b""
        return e.code, e.headers, raw


def parse_json(raw: bytes) -> Any:
    """Parse a JSON body, or return None when it is not JSON."""
    try:
        return json.loads(raw)
    except ValueError:
        return None


def dumps(value: Any) -> bytes:
    """Compact UTF-8 JSON, like ``JSON.stringify``."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
