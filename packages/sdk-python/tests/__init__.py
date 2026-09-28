"""Makes ``src`` importable for ``python3 -m unittest discover -s tests -t .``."""

import os
import sys

_SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)

# Reach the local test servers directly, even when an HTTP proxy is configured.
os.environ.setdefault("no_proxy", "127.0.0.1,localhost")
