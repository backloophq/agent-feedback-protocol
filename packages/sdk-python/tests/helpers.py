"""Shared test fixtures: a scripted local HTTP server and conformance cases."""

import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Tuple, Union

CONFORMANCE = Path(__file__).resolve().parents[3] / "spec" / "conformance"

Reply = Tuple[int, Any, Dict[str, str]]
Script = Union[Reply, Callable[[Dict[str, Any]], Reply]]


def conformance_cases(kind: str) -> List[Tuple[str, Dict[str, Any]]]:
    """``[(name, case)]`` for ``valid`` or ``invalid``."""
    return [(p.stem, json.loads(p.read_text("utf-8"))) for p in sorted((CONFORMANCE / kind).glob("*.json"))]


class LocalServer:
    """An HTTP server on 127.0.0.1 that replies from a script, in a background thread.

    Each reply is ``(status, body, headers)`` or a callable taking the recorded
    request; replies are used in order and the last one repeats. Received
    requests are recorded in ``requests`` (method, path, headers, body).
    """

    def __init__(self, *script: Script) -> None:
        self.script = list(script)
        self.requests: List[Dict[str, Any]] = []
        server = self

        class Handler(BaseHTTPRequestHandler):
            def _handle(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                request = {
                    "method": self.command,
                    "path": self.path,
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                    "body": self.rfile.read(length) if length else b"",
                }
                server.requests.append(request)
                reply = server.script[min(len(server.requests), len(server.script)) - 1]
                status, body, headers = reply(request) if callable(reply) else reply
                data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
                self.send_response(status)
                for key, value in {"content-type": "application/json", **headers}.items():
                    self.send_header(key, value)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = _handle

            def log_message(self, *args: Any) -> None:
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def __enter__(self) -> "LocalServer":
        threading.Thread(target=self.httpd.serve_forever, args=(0.01,), daemon=True).start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    def json_bodies(self) -> List[Any]:
        return [json.loads(r["body"]) for r in self.requests]


def refused_url() -> str:
    """A URL on a port nothing listens on."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    return f"http://127.0.0.1:{port}"
