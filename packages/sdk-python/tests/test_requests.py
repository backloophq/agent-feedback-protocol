"""record_requests: http_request events from ASGI and WSGI apps, and detect_agent."""

import asyncio
import importlib.util
import io
import json
import re
import unittest
from wsgiref.util import setup_testing_defaults

from backloop import collapse_path, detect_agent, record_requests

from .helpers import LocalServer

ISO = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
CLAUDE = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)"
BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


def _installed(*modules):
    return all(importlib.util.find_spec(m) is not None for m in modules)


class DetectAgentTest(unittest.TestCase):
    def test_user_agents(self):
        cases = {
            CLAUDE: "Claude-User",
            "Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)": "ChatGPT-User",
            "claude-code/1.0.83 (external, cli)": "claude-code",
            "Mozilla/5.0 Cursor/0.42.3 Chrome/124.0 Electron/30.0": "Cursor",
            "Anthropic/Python 0.40.0": "anthropic-sdk",
            "OpenAI/Python 1.54.0": "openai-sdk",
            "Perplexity-User/1.0": "Perplexity-User",
            "acme-research-agent/2.1": "agent",
            BROWSER: None,
            "python-httpx/0.27.0": None,
            "python-requests/2.32.3": None,
            "": None,
        }
        for user_agent, name in cases.items():
            with self.subTest(user_agent=user_agent):
                self.assertEqual(detect_agent({"User-Agent": user_agent}), name)

    def test_headers(self):
        self.assertEqual(detect_agent({"X-Agent-Name": " research-bot ", "User-Agent": BROWSER}), "research-bot")
        self.assertEqual(detect_agent({"x-agent": "acme"}), "acme")
        self.assertEqual(detect_agent({"Signature-Agent": '"https://chatgpt.com"', "User-Agent": BROWSER}), "chatgpt.com")
        # An HTTP library is an agent when it sends an agent or MCP session header.
        self.assertEqual(detect_agent({"User-Agent": "python-httpx/0.27.0", "X-Agent-Session": "s1"}), "agent")
        self.assertEqual(detect_agent([(b"user-agent", b"python-requests/2.32"), (b"mcp-session-id", b"abc")]), "agent")
        self.assertIsNone(detect_agent(None))

    def test_collapse_path(self):
        self.assertEqual(collapse_path("/companies/cmp_001234/jobs/42"), "/companies/:id/jobs/:id")
        self.assertEqual(collapse_path("/users/0b7c3e3a-8d7e-4a43-9a1f-2c4b5d6e7f80"), "/users/:id")
        self.assertEqual(collapse_path("/companies/search"), "/companies/search")
        self.assertEqual(collapse_path(""), "/")


# -- ASGI -----------------------------------------------------------------------


def asgi_app(status=200, body=b'{"ok":true}', content_type=b"application/json", route=None, raise_error=None):
    async def app(scope, receive, send):
        if scope["type"] != "http":
            return
        received = b""
        while True:
            message = await receive()
            received += message.get("body", b"")
            if not message.get("more_body"):
                break
        if route is not None:
            scope["route"] = type("APIRoute", (), {"path": route, "path_format": route})()
        if raise_error:
            raise raise_error
        await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", content_type)]})
        await send({"type": "http.response.body", "body": body})

    return app


def call_asgi(app, path="/companies", method="GET", headers=None, query=b"", body=b""):
    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "query_string": query,
        "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
    }
    sent = []
    chunks = [{"type": "http.request", "body": body, "more_body": False}]

    async def receive():
        return chunks.pop(0) if chunks else {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    asyncio.run(app(scope, receive, send))
    return sent


def recorder(app, **options):
    events = []
    return record_requests(app, on_events=events.extend, **options), events


class ASGITest(unittest.TestCase):
    def test_http_request_event_shape(self):
        app, events = recorder(
            asgi_app(body=b'{"id":"cmp_1","email":"ceo@acme.com"}', route="/companies/{company_id}"),
            service="acme-api",
            identify=lambda scope: "acct_9",
        )
        sent = call_asgi(
            app,
            path="/companies/cmp_1",
            headers={"User-Agent": "claude-code/1.0.83", "X-Agent-Session": "sess-1"},
            query=b"fields=name%2Cdomain&token=abc",
        )
        app.flush()
        self.assertEqual(sent[1]["body"], b'{"id":"cmp_1","email":"ceo@acme.com"}')  # the response is untouched
        [event] = events
        self.assertRegex(event.pop("id"), r"^ev_[0-9A-Z]{26}$")
        self.assertRegex(event.pop("started_at"), ISO)
        self.assertIsInstance(event.pop("duration_ms"), int)
        self.assertEqual(
            event,
            {
                "kind": "http_request",
                "session_id": "sess-1",
                "service": "acme-api",
                "account": "acct_9",
                "client": {"name": "claude-code", "version": "1.0.83"},
                "method": "GET",
                "route": "/companies/{company_id}",
                "status": 200,
                "input": "fields=name,domain token=abc",
                "result": '{"id":"cmp_1","email":"[REDACTED]"}',
            },
        )

    def test_humans_are_not_recorded_unless_asked(self):
        app, events = recorder(asgi_app())
        call_asgi(app, headers={"User-Agent": BROWSER})
        app.flush()
        self.assertEqual(events, [])

        app, events = recorder(asgi_app(), agents_only=False)
        call_asgi(app, path="/companies/12345", headers={"User-Agent": BROWSER})
        app.flush()
        self.assertEqual(len(events), 1)
        self.assertNotIn("client", events[0])
        self.assertNotIn("session_id", events[0])
        self.assertEqual(events[0]["route"], "/companies/:id")  # no framework route: ids collapsed

    def test_errors_and_body_input(self):
        app, events = recorder(asgi_app(status=422, body=b'{"error":{"message":"limit too high"}}'))
        call_asgi(
            app,
            method="post",
            headers={"User-Agent": CLAUDE, "Content-Type": "application/json"},
            body=b'{"limit":5000,"password":"hunter2"}',
        )
        app.flush()
        event = events[0]
        self.assertEqual((event["method"], event["status"]), ("POST", 422))
        self.assertEqual(event["error"], '{"error":{"message":"limit too high"}}')
        self.assertEqual(event["input"], '{"limit":5000,"password":"[REDACTED]"}')

    def test_exception_is_recorded_and_reraised(self):
        app, events = recorder(asgi_app(raise_error=RuntimeError("db down")))
        with self.assertRaisesRegex(RuntimeError, "db down"):
            call_asgi(app, headers={"User-Agent": CLAUDE})
        app.flush()
        self.assertEqual((events[0]["status"], events[0]["error"]), (500, "db down"))

    def test_skip_route_and_preview_options(self):
        app, events = recorder(asgi_app(body=b"x" * 50, content_type=b"text/plain"))
        for path in ("/feedback", "/.well-known/agent-feedback", "/healthz"):
            call_asgi(app, path=path, headers={"User-Agent": CLAUDE})
        app.flush()
        self.assertEqual(events, [])

        app, events = recorder(
            asgi_app(body=b"x" * 50, content_type=b"text/plain"),
            skip=lambda path: False,
            route=lambda scope: "/custom",
            preview_chars=10,
        )
        call_asgi(app, path="/feedback", headers={"User-Agent": CLAUDE})
        app.flush()
        self.assertEqual((events[0]["route"], events[0]["result"]), ("/custom", "x" * 9 + "…"))

        app, events = recorder(asgi_app(body=b"\x89PNG", content_type=b"image/png"))
        call_asgi(app, headers={"User-Agent": CLAUDE})
        app.flush()
        self.assertNotIn("result", events[0])

    def test_async_identify_and_non_http_scopes(self):
        async def identify(scope):
            return "acct_async"

        app, events = recorder(asgi_app(), identify=identify)
        call_asgi(app, headers={"User-Agent": CLAUDE})
        asyncio.run(app({"type": "lifespan"}, None, None))
        app.flush()
        self.assertEqual([e["account"] for e in events], ["acct_async"])

    def test_posts_to_the_platform(self):
        with LocalServer((202, {}, {})) as platform:
            app = record_requests(asgi_app(), url=platform.url, ingest_key="ik_2", flush_ms=60_000)
            call_asgi(app, headers={"User-Agent": CLAUDE})
            app.flush()
        request = platform.requests[0]
        self.assertEqual((request["method"], request["path"]), ("POST", "/v1/sessions/events"))
        self.assertEqual(request["headers"]["authorization"], "Bearer ik_2")
        self.assertEqual(platform.json_bodies()[0]["events"][0]["kind"], "http_request")


# -- WSGI -----------------------------------------------------------------------


def wsgi_app(status="200 OK", body=b'{"ok":true}', content_type="application/json", raise_error=None):
    def app(environ, start_response):
        length = int(environ.get("CONTENT_LENGTH") or 0)
        environ["wsgi.input"].read(length)
        if raise_error:
            raise raise_error
        start_response(status, [("Content-Type", content_type)])
        return [body[:5], body[5:]]

    return app


def call_wsgi(app, path="/companies", method="GET", headers=None, query="", body=b""):
    environ = {"PATH_INFO": path, "REQUEST_METHOD": method, "QUERY_STRING": query}
    for key, value in (headers or {}).items():
        name = key.upper().replace("-", "_")
        environ[name if name in ("CONTENT_TYPE", "CONTENT_LENGTH") else "HTTP_" + name] = value
    environ["CONTENT_LENGTH"] = str(len(body))
    environ["wsgi.input"] = io.BytesIO(body)
    setup_testing_defaults(environ)
    status = []
    result = app(environ, lambda s, h, exc_info=None: status.append(s))
    try:
        out = b"".join(result)
    finally:
        getattr(result, "close", lambda: None)()
    return status[0], out


class WSGITest(unittest.TestCase):
    def test_http_request_event(self):
        app, events = recorder(wsgi_app(status="404 Not Found", body=b'{"error":"no such company"}'))
        status, out = call_wsgi(
            app,
            path="/companies/cmp_001234",
            method="POST",
            headers={"User-Agent": "Anthropic/Python 0.40.0", "Mcp-Session-Id": "m-1", "Content-Type": "application/json"},
            body=b'{"name":"Acme"}',
        )
        app.flush()
        self.assertEqual((status, out), ("404 Not Found", b'{"error":"no such company"}'))
        event = events[0]
        self.assertEqual(event["session_id"], "m-1")
        self.assertEqual(event["client"], {"name": "anthropic-sdk"})
        self.assertEqual((event["method"], event["route"], event["status"]), ("POST", "/companies/:id", 404))
        self.assertEqual(event["error"], '{"error":"no such company"}')
        self.assertEqual(event["input"], '{"name":"Acme"}')
        self.assertEqual(event["result"], '{"error":"no such company"}')
        self.assertRegex(event["started_at"], ISO)

    def test_humans_skipped_and_exceptions_recorded(self):
        app, events = recorder(wsgi_app(raise_error=ValueError("boom")), identify=lambda environ: "acct_w")
        with self.assertRaisesRegex(ValueError, "boom"):
            call_wsgi(app, headers={"User-Agent": BROWSER})  # not recorded
        with self.assertRaisesRegex(ValueError, "boom"):
            call_wsgi(app, headers={"User-Agent": CLAUDE})
        app.flush()
        self.assertEqual(len(events), 1)
        self.assertEqual((events[0]["status"], events[0]["error"], events[0]["account"]), (500, "boom", "acct_w"))

    def test_flask_like_url_map_names_the_route(self):
        class Rule:
            rule = "/companies/<company_id>"

        class UrlMap:
            def bind_to_environ(self, environ):
                return self

            def match(self, return_rule=False):
                return Rule(), {}

        class App:
            url_map = UrlMap()

            def wsgi_app(self, environ, start_response):
                return wsgi_app()(environ, start_response)

        app, events = recorder(App().wsgi_app)
        call_wsgi(app, path="/companies/cmp_001234", headers={"User-Agent": CLAUDE})
        app.flush()
        self.assertEqual(events[0]["route"], "/companies/<company_id>")

    def test_detects_asgi_and_wsgi(self):
        from backloop.requests_recorder import RecordRequestsASGI, RecordRequestsWSGI

        self.assertIsInstance(record_requests(asgi_app()), RecordRequestsASGI)
        self.assertIsInstance(record_requests(wsgi_app()), RecordRequestsWSGI)
        self.assertIsInstance(record_requests(wsgi_app(), asgi=True), RecordRequestsASGI)


@unittest.skipUnless(_installed("fastapi", "httpx"), "fastapi (and httpx) not installed")
class FastAPITest(unittest.TestCase):
    def test_route_template(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        events = []
        api = FastAPI()

        @api.get("/companies/{company_id}")
        def company(company_id: str):
            return {"id": company_id}

        api.add_middleware(record_requests, on_events=events.extend, flush_ms=60_000)
        client = TestClient(api)
        self.assertEqual(client.get("/companies/cmp_1", headers={"user-agent": CLAUDE}).json(), {"id": "cmp_1"})
        client.get("/companies/cmp_2", headers={"user-agent": BROWSER})
        _flush_all(api.middleware_stack)
        self.assertEqual([(e["route"], e["status"]) for e in events], [("/companies/{company_id}", 200)])


def _flush_all(app, depth=0):
    """Find the recorder inside Starlette's middleware stack and flush it."""
    while app is not None and depth < 20:
        if hasattr(app, "flush") and hasattr(app, "_recorder"):
            app.flush()
            return
        app = getattr(app, "app", None)
        depth += 1


@unittest.skipUnless(_installed("flask"), "flask not installed")
class FlaskTest(unittest.TestCase):
    def test_url_rule(self):
        from flask import Flask, jsonify

        events = []
        app = Flask(__name__)

        @app.route("/companies/<company_id>", methods=["GET", "POST"])
        def company(company_id):
            return jsonify(id=company_id)

        app.wsgi_app = record_requests(app.wsgi_app, on_events=events.extend, flush_ms=60_000)
        client = app.test_client()
        res = client.post("/companies/cmp_1?verbose=1", json={"a": 1}, headers={"User-Agent": CLAUDE})
        self.assertEqual(json.loads(res.data), {"id": "cmp_1"})
        app.wsgi_app.flush()
        [event] = events
        self.assertEqual((event["route"], event["status"], event["input"]), ("/companies/<company_id>", 200, "verbose=1"))
        self.assertEqual(json.loads(event["result"]), {"id": "cmp_1"})


if __name__ == "__main__":
    unittest.main()
