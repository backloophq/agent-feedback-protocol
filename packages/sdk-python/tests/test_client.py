import json
import unittest
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from unittest import mock

from backloop import FeedbackClient, FeedbackError, feedback_url_from_link
from backloop.client import _retry_after_seconds

from .helpers import LocalServer, refused_url

FEEDBACK = {"type": "missing_capability", "goal": "Find hiring companies", "message": "No role filter"}
ACK = {"id": "fb_1", "status": "accepted", "received_at": "2026-09-28T10:04:11.123Z"}
INVALID = {
    "error": {
        "code": "invalid_feedback",
        "message": "goal: is required",
        "details": [{"path": "goal", "message": "is required"}],
    }
}
UNAVAILABLE = {"error": {"code": "unavailable", "message": "Feedback could not be stored. Retry once later."}}


class ConstructorTest(unittest.TestCase):
    def test_endpoint_from_base_url(self):
        self.assertEqual(FeedbackClient("https://api.example.com/v1//").endpoint, "https://api.example.com/v1/feedback")

    def test_endpoint_overrides_base_url(self):
        client = FeedbackClient("https://api.example.com", endpoint="https://fb.example.com/in")
        self.assertEqual(client.endpoint, "https://fb.example.com/in")

    def test_needs_a_url(self):
        with self.assertRaises(ValueError):
            FeedbackClient()


class PrepareTest(unittest.TestCase):
    def test_applies_defaults_without_overriding(self):
        client = FeedbackClient("http://x", agent={"name": "bot"}, session_id="sess_1")
        self.assertEqual(client.prepare(FEEDBACK), {**FEEDBACK, "agent": {"name": "bot"}, "session_id": "sess_1"})
        own = {**FEEDBACK, "agent": {"name": "mine"}, "session_id": "sess_2"}
        self.assertEqual(client.prepare(own), own)

    def test_does_not_mutate_input(self):
        feedback = {**FEEDBACK, "message": "Bearer abcdefghijklmnop failed"}
        prepared = FeedbackClient("http://x", session_id="s").prepare(feedback)
        self.assertEqual(prepared["message"], "[REDACTED] failed")
        self.assertEqual(feedback["message"], "Bearer abcdefghijklmnop failed")
        self.assertNotIn("session_id", feedback)

    def test_redaction_options(self):
        feedback = {**FEEDBACK, "message": "mail a@b.co with Bearer abcdefghijklmnop"}
        self.assertEqual(FeedbackClient("http://x", redact=False).prepare(feedback), feedback)
        self.assertEqual(
            FeedbackClient("http://x", redact={"emails": False}).prepare(feedback)["message"],
            "mail a@b.co with [REDACTED]",
        )

    def test_raises_invalid_feedback(self):
        with self.assertRaises(FeedbackError) as ctx:
            FeedbackClient("http://x").prepare({"type": "bug", "message": "m"})
        err = ctx.exception
        self.assertEqual((err.code, err.status, str(err)), ("invalid_feedback", None, "goal: is required"))
        self.assertEqual(err.details, [{"path": "goal", "message": "is required"}])

    def test_non_object_input(self):
        with self.assertRaises(FeedbackError) as ctx:
            FeedbackClient("http://x").prepare(["bug"])  # type: ignore[arg-type]
        self.assertEqual(ctx.exception.details, [{"path": "", "message": "must be an object"}])


class SubmitTest(unittest.TestCase):
    def test_202_returns_the_ack(self):
        with LocalServer((202, ACK, {})) as server:
            client = FeedbackClient(server.url, api_key="key_123", agent={"name": "bot"}, headers={"x-extra": "1"})
            ack = client.submit({**FEEDBACK, "suggestion": "see https://x.io/?token=abc"})
        self.assertEqual(ack, ACK)
        request = server.requests[0]
        self.assertEqual((request["method"], request["path"]), ("POST", "/feedback"))
        self.assertEqual(request["headers"]["authorization"], "Bearer key_123")
        self.assertEqual(request["headers"]["content-type"], "application/json")
        self.assertEqual(request["headers"]["x-extra"], "1")
        self.assertTrue(request["headers"]["user-agent"].startswith("backloop-sdk-python/"))
        sent = json.loads(request["body"])
        self.assertEqual(sent["agent"], {"name": "bot"})
        self.assertEqual(sent["suggestion"], "see https://x.io/?token=[REDACTED]")

    def test_sends_utf8(self):
        with LocalServer((202, ACK, {})) as server:
            FeedbackClient(server.url).submit({**FEEDBACK, "goal": "Trouver les entreprises à Zürich"})
        sent = json.loads(server.requests[0]["body"].decode("utf-8"))
        self.assertEqual(sent["goal"], "Trouver les entreprises à Zürich")

    def test_400_raises_with_details_and_does_not_retry(self):
        with LocalServer((400, INVALID, {})) as server:
            with self.assertRaises(FeedbackError) as ctx:
                FeedbackClient(server.url).submit(FEEDBACK)
        err = ctx.exception
        self.assertEqual((err.code, err.status, err.message), ("invalid_feedback", 400, "goal: is required"))
        self.assertEqual(err.details, [{"path": "goal", "message": "is required"}])
        self.assertEqual(len(server.requests), 1)

    def test_503_then_202_retries_once(self):
        with LocalServer((503, UNAVAILABLE, {"retry-after": "0"}), (202, ACK, {})) as server:
            ack = FeedbackClient(server.url).submit(FEEDBACK)
        self.assertEqual(ack, ACK)
        self.assertEqual(len(server.requests), 2)
        self.assertEqual(server.requests[0]["body"], server.requests[1]["body"])

    def test_gives_up_after_one_retry(self):
        with LocalServer((503, UNAVAILABLE, {"retry-after": "0"})) as server:
            with self.assertRaises(FeedbackError) as ctx:
                FeedbackClient(server.url).submit(FEEDBACK)
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("unavailable", 503))
        self.assertEqual(len(server.requests), 2)

    def test_non_json_error_body(self):
        with LocalServer((500, b"<html>oops</html>", {"retry-after": "0", "content-type": "text/html"})) as server:
            with self.assertRaises(FeedbackError) as ctx:
                FeedbackClient(server.url).submit(FEEDBACK)
        self.assertEqual(ctx.exception.code, "http_error")
        self.assertEqual(ctx.exception.message, "Feedback endpoint returned HTTP 500")

    def test_retry_after_is_honoured_and_capped(self):
        cases = [({"retry-after": "120"}, 10.0), ({"retry-after": "2"}, 2.0), ({}, 1.0)]
        for headers, expected in cases:
            with self.subTest(headers=headers):
                limited = (429, {"error": {"code": "rate_limited", "message": "slow"}}, headers)
                with LocalServer(limited, (202, ACK, {})) as server:
                    with mock.patch("backloop.client.time.sleep") as sleep:
                        self.assertEqual(FeedbackClient(server.url).submit(FEEDBACK), ACK)
                sleep.assert_called_once_with(expected)

    def test_network_error(self):
        with self.assertRaises(FeedbackError) as ctx:
            FeedbackClient(refused_url(), timeout=2).submit(FEEDBACK)
        self.assertEqual(ctx.exception.code, "network_error")
        self.assertIn("Could not reach", ctx.exception.message)


    def test_only_http_urls(self):
        for url in ("file:///etc/hosts", "ftp://example.com/feedback"):
            with self.subTest(url=url):
                with self.assertRaises(FeedbackError) as ctx:
                    FeedbackClient(endpoint=url).submit(FEEDBACK)
                self.assertEqual(ctx.exception.code, "network_error")
        self.assertIsNone(FeedbackClient.discover("file:///"))


class TrySubmitTest(unittest.TestCase):
    def test_success(self):
        with LocalServer((202, ACK, {})) as server:
            result = FeedbackClient(server.url).try_submit(FEEDBACK)
        self.assertTrue(result.ok)
        self.assertEqual(result.ack, ACK)
        self.assertIsNone(result.error)

    def test_connection_refused_never_raises(self):
        result = FeedbackClient(refused_url(), timeout=2).try_submit(FEEDBACK)
        self.assertFalse(result.ok)
        self.assertIsNone(result.ack)
        self.assertEqual(result.error.code, "network_error")

    def test_invalid_feedback_never_raises(self):
        result = FeedbackClient(refused_url()).try_submit({"type": "nope"})
        self.assertFalse(result.ok)
        self.assertEqual(result.error.code, "invalid_feedback")

    def test_http_error_never_raises(self):
        with LocalServer((400, INVALID, {})) as server:
            result = FeedbackClient(server.url).try_submit(FEEDBACK)
        self.assertEqual((result.ok, result.error.status), (False, 400))


class DiscoveryTest(unittest.TestCase):
    DOC = {
        "spec_version": "0.1",
        "endpoint": "/v2/feedback",
        "types": ["bug"],
        "max_bytes": 16384,
        "auth": "optional",
    }

    def test_discover(self):
        with LocalServer((200, self.DOC, {})) as server:
            self.assertEqual(FeedbackClient.discover(server.url + "/some/path"), self.DOC)
        self.assertEqual(server.requests[0]["path"], "/.well-known/agent-feedback")
        self.assertEqual(server.requests[0]["method"], "GET")

    def test_discover_returns_none_when_unsupported(self):
        for reply in ((404, {"error": "nope"}, {}), (200, b"not json", {}), (200, {"no": "endpoint"}, {})):
            with self.subTest(reply=reply):
                with LocalServer(reply) as server:
                    self.assertIsNone(FeedbackClient.discover(server.url))
        self.assertIsNone(FeedbackClient.discover(refused_url()))
        self.assertIsNone(FeedbackClient.discover("not a url"))

    def test_from_discovery(self):
        def reply(request):
            if request["method"] == "GET":
                return 200, self.DOC, {}
            return 202, ACK, {}

        with LocalServer(reply) as server:
            client = FeedbackClient.from_discovery(server.url, api_key="k")
            self.assertEqual(client.endpoint, server.url + "/v2/feedback")
            self.assertEqual(client.submit(FEEDBACK), ACK)
        self.assertEqual(server.requests[1]["path"], "/v2/feedback")
        self.assertEqual(server.requests[1]["headers"]["authorization"], "Bearer k")

    def test_from_discovery_without_document(self):
        with LocalServer((404, {}, {})) as server:
            self.assertIsNone(FeedbackClient.from_discovery(server.url))


class LinkHeaderTest(unittest.TestCase):
    def test_parses_agent_feedback_link(self):
        base = "https://api.example.com/v1/companies"
        self.assertEqual(
            feedback_url_from_link('</feedback>; rel="agent-feedback"', base), "https://api.example.com/feedback"
        )
        self.assertEqual(
            feedback_url_from_link('<https://x.io/next>; rel="next", <fb>; rel=agent-feedback', base),
            "https://api.example.com/v1/fb",
        )
        self.assertEqual(
            feedback_url_from_link('</feedback>; rel="help agent-feedback"', base), "https://api.example.com/feedback"
        )

    def test_ignores_other_links(self):
        for link in (None, "", '</next>; rel="next"', '</f>; rel="agent-feedbacks"', "garbage"):
            with self.subTest(link=link):
                self.assertIsNone(feedback_url_from_link(link, "https://api.example.com"))


class RetryAfterTest(unittest.TestCase):
    def test_parsing(self):
        self.assertEqual(_retry_after_seconds("5"), 5.0)
        self.assertEqual(_retry_after_seconds("0.5"), 0.5)
        for header in (None, "", "soon", "nan"):
            with self.subTest(header=header):
                self.assertIsNone(_retry_after_seconds(header))

    def test_http_date(self):
        future = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=30), usegmt=True)
        self.assertTrue(25 <= _retry_after_seconds(future) <= 30)
        past = format_datetime(datetime.now(timezone.utc) - timedelta(seconds=30), usegmt=True)
        self.assertEqual(_retry_after_seconds(past), 0.0)


if __name__ == "__main__":
    unittest.main()
