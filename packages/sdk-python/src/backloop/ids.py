"""Record IDs and account pseudonymization."""

from __future__ import annotations

import hashlib
import hmac
import os
import time

_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # Crockford base32


def new_id(prefix: str = "fb") -> str:
    """Time-sortable unique ID (ULID layout) with a prefix, e.g. ``fb_01JAX3ZK7Q8W2M4N6P9RTV5B``."""
    ms = time.time_ns() // 1_000_000
    ts = ""
    for _ in range(10):
        ts = _ALPHABET[ms % 32] + ts
        ms //= 32
    rand = "".join(_ALPHABET[b % 32] for b in os.urandom(16))
    return f"{prefix}_{ts}{rand}"


def _utf8(value: str) -> bytes:
    # Encode like the WHATWG TextEncoder: lone surrogates become U+FFFD.
    return value.encode("utf-16", "surrogatepass").decode("utf-16", "replace").encode("utf-8")


def hash_account(account_id: str, secret: str) -> str:
    """
    Pseudonymize an account ID with HMAC-SHA256, so collectors can count
    affected customers without learning who they are.
    """
    digest = hmac.new(_utf8(secret), _utf8(account_id), hashlib.sha256).digest()
    return "acct_" + digest[:12].hex()
