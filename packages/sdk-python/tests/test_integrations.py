"""Framework helpers. Skipped when the framework is not installed."""

import importlib.util
import json
import unittest

from backloop import FeedbackHandler, memory_sink

BODY = {"type": "bug", "goal": "g", "message": "m"}
KNOWN_ISSUE = {"id": "iss_1", "title": "Fix it", "status": "planned"}


def _installed(*modules):
    return all(importlib.util.find_spec(m) is not None for m in modules)


def make(**options):
    sink = memory_sink()

    def on_record(record):
        sink(record)
        return {"known_issue": KNOWN_ISSUE}

    return FeedbackHandler(on_record, **options), sink


@unittest.skipUnless(_installed("fastapi", "httpx"), "fastapi (and httpx) not installed")
class FastAPITest(unittest.TestCase):
    def client(self, handler, identify=None):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from backloop import fastapi_router

        app = FastAPI()
        app.include_router(fastapi_router(handler, identify=identify))
        return TestClient(app)

    def test_submit(self):
        handler, sink = make(service="acme")
        res = self.client(handler).post("/feedback", json=BODY)
        self.assertEqual(res.status_code, 202)
        self.assertEqual(res.json()["known_issue"], KNOWN_ISSUE)
        self.assertEqual(sink.records[0]["feedback"], BODY)

    def test_identify_sync_and_async(self):
        async def async_identify(request):
            return request.headers.get("authorization", "")[7:] or None

        for identify in (lambda request: "acct_sync", async_identify):
            with self.subTest(identify=identify):
                handler, sink = make()
                res = self.client(handler, identify).post(
                    "/feedback", json=BODY, headers={"authorization": "Bearer acct_async"}
                )
                self.assertEqual(res.status_code, 202)
                self.assertIn(sink.records[0]["account"], ("acct_sync", "acct_async"))

    def test_handler_identify_is_the_default(self):
        handler, sink = make(identify=lambda request: "acct_default", auth="required")
        self.assertEqual(self.client(handler).post("/feedback", json=BODY).status_code, 202)
        self.assertEqual(sink.records[0]["account"], "acct_default")

    def test_errors(self):
        handler, _ = make(auth="required", max_bytes=64)
        client = self.client(handler, identify=lambda request: request.headers.get("x-account"))
        res = client.post("/feedback", content=json.dumps(BODY), headers={"content-type": "text/plain"})
        self.assertEqual((res.status_code, res.json()["error"]["code"]), (415, "unsupported_media_type"))
        res = client.post("/feedback", json={**BODY, "goal": "x" * 100})
        self.assertEqual(res.status_code, 413)
        self.assertEqual(client.post("/feedback", json=BODY).status_code, 401)
        res = client.post("/feedback", json={"type": "bug"}, headers={"x-account": "a"})
        self.assertEqual((res.status_code, res.json()["error"]["details"][0]["path"]), (400, "goal"))

    def test_rate_limit_uses_forwarded_ip(self):
        handler, _ = make(rate_limit=(1, 60))
        client = self.client(handler)
        headers = {"x-forwarded-for": "1.1.1.1, 10.0.0.1"}
        self.assertEqual(client.post("/feedback", json=BODY, headers=headers).status_code, 202)
        res = client.post("/feedback", json=BODY, headers=headers)
        self.assertEqual(res.status_code, 429)
        self.assertEqual(res.headers["retry-after"], "60")
        self.assertEqual(client.post("/feedback", json=BODY, headers={"x-forwarded-for": "2.2.2.2"}).status_code, 202)

    def test_discovery(self):
        handler, _ = make()
        res = self.client(handler).get("/.well-known/agent-feedback")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["endpoint"], "http://testserver/feedback")
        self.assertEqual(res.headers["cache-control"], "public, max-age=3600")


@unittest.skipUnless(_installed("flask"), "flask not installed")
class FlaskTest(unittest.TestCase):
    def client(self, handler, identify=None):
        from flask import Flask

        from backloop import flask_blueprint

        app = Flask(__name__)
        app.register_blueprint(flask_blueprint(handler, identify=identify))
        return app.test_client()

    def test_submit(self):
        handler, sink = make()
        res = self.client(handler, identify=lambda request: "acct_1").post("/feedback", json=BODY)
        self.assertEqual(res.status_code, 202)
        self.assertEqual(res.get_json()["known_issue"], KNOWN_ISSUE)
        self.assertEqual(sink.records[0]["account"], "acct_1")

    def test_errors(self):
        handler, _ = make(max_bytes=64)
        client = self.client(handler)
        res = client.post("/feedback", data=json.dumps(BODY), content_type="text/plain")
        self.assertEqual((res.status_code, res.get_json()["error"]["code"]), (415, "unsupported_media_type"))
        self.assertEqual(client.post("/feedback", json={**BODY, "goal": "x" * 100}).status_code, 413)
        res = client.post("/feedback", data="{bad", content_type="application/json")
        self.assertEqual((res.status_code, res.get_json()["error"]["code"]), (400, "invalid_json"))

    def test_discovery(self):
        handler, _ = make()
        res = self.client(handler).get("/.well-known/agent-feedback")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json()["endpoint"], "http://localhost/feedback")
        self.assertEqual(res.headers["cache-control"], "public, max-age=3600")


if __name__ == "__main__":
    unittest.main()
