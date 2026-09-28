import json
import unittest
from datetime import datetime, timedelta, timezone

from backloop import (
    FEEDBACK_TYPES,
    FeedbackHandler,
    error_response,
    feedback_link_header,
    memory_sink,
    validate_ack,
    validate_record,
)

from .helpers import conformance_cases

FIXED = datetime(2026, 9, 28, 10, 4, 11, 123456, tzinfo=timezone.utc)
SUBMISSION = {"type": "missing_capability", "goal": "Find hiring companies", "message": "No role filter"}
BODY = json.dumps(SUBMISSION).encode()
JSON = "application/json"
KNOWN_ISSUE = {"id": "iss_1", "title": "Add a role filter", "status": "planned", "workaround": "Use /jobs"}


class Clock:
    def __init__(self) -> None:
        self.now = FIXED

    def __call__(self) -> datetime:
        return self.now


def make(on_record=None, **options):
    sink = memory_sink()
    options.setdefault("generate_id", lambda: "fb_test")
    options.setdefault("now", lambda: FIXED)
    return FeedbackHandler(on_record or sink, **options), sink


class HappyPathTest(unittest.TestCase):
    def test_accepts_valid_feedback(self):
        handler, sink = make()
        status, body, headers = handler.handle_submit(BODY, JSON)
        self.assertEqual(status, 202)
        self.assertEqual(
            body, {"id": "fb_test", "status": "accepted", "received_at": "2026-09-28T10:04:11.123Z"}
        )
        self.assertTrue(validate_ack(body).valid)
        self.assertEqual(headers["content-type"], "application/json; charset=utf-8")
        self.assertEqual(
            sink.records,
            [{"id": "fb_test", "received_at": "2026-09-28T10:04:11.123Z", "source": "http", "feedback": SUBMISSION}],
        )

    def test_record_carries_service_account_and_source(self):
        handler, sink = make(service="acme-api", source="mcp")
        handler.handle_submit(BODY, JSON, "acct_abc")
        record = sink.records[0]
        self.assertEqual((record["service"], record["account"], record["source"]), ("acme-api", "acct_abc", "mcp"))
        self.assertEqual(list(record), ["id", "received_at", "service", "account", "source", "feedback"])
        self.assertTrue(validate_record(record).valid)

    def test_known_issue_is_passed_back(self):
        handler, _ = make(lambda record: {"known_issue": KNOWN_ISSUE})
        status, body, _ = handler.handle_submit(BODY, JSON)
        self.assertEqual(status, 202)
        self.assertEqual(body["known_issue"], KNOWN_ISSUE)
        self.assertTrue(validate_ack(body).valid)

    def test_on_record_may_return_nothing_useful(self):
        for outcome in (None, {}, {"known_issue": None}, "ignored"):
            with self.subTest(outcome=outcome):
                handler, _ = make(lambda record, o=outcome: o)
                status, body, _ = handler.handle_submit(BODY, JSON)
                self.assertEqual(status, 202)
                self.assertNotIn("known_issue", body)

    def test_default_ids_and_timestamps(self):
        handler = FeedbackHandler(lambda record: None)
        _, body, _ = handler.handle_submit(BODY, JSON)
        self.assertRegex(body["id"], r"^fb_[0-9A-Z]{26}$")
        self.assertRegex(body["received_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")

    def test_rejects_async_on_record(self):
        async def on_record(record):
            return None

        with self.assertRaises(TypeError):
            FeedbackHandler(on_record)

    def test_json_content_type_variants(self):
        handler, _ = make(rate_limit=None)
        for content_type in ("application/json; charset=utf-8", "APPLICATION/JSON", "application/vnd.api+json"):
            with self.subTest(content_type=content_type):
                self.assertEqual(handler.handle_submit(BODY, content_type)[0], 202)

    def test_str_body_and_utf8_bom(self):
        handler, _ = make(rate_limit=None)
        self.assertEqual(handler.handle_submit(BODY.decode(), JSON)[0], 202)
        self.assertEqual(handler.handle_submit(b"\xef\xbb\xbf" + BODY, JSON)[0], 202)

    def test_every_valid_conformance_case_is_accepted(self):
        handler, _ = make(rate_limit=None)
        for name, case in conformance_cases("valid"):
            with self.subTest(case=name):
                self.assertEqual(handler.handle_submit(json.dumps(case["submission"]), JSON)[0], 202)


class ErrorPathTest(unittest.TestCase):
    def assertError(self, response, status, code):
        actual_status, body, headers = response
        self.assertEqual(actual_status, status, body)
        self.assertEqual(body["error"]["code"], code)
        self.assertIsInstance(body["error"]["message"], str)
        self.assertEqual(headers["content-type"], "application/json; charset=utf-8")
        return body, headers

    def test_415_unsupported_media_type(self):
        handler, sink = make()
        for content_type in ("text/plain", "", None, "application/jsonp", "multipart/form-data"):
            with self.subTest(content_type=content_type):
                self.assertError(handler.handle_submit(BODY, content_type), 415, "unsupported_media_type")
        self.assertEqual(sink.records, [])

    def test_413_payload_too_large(self):
        handler, _ = make(max_bytes=100, rate_limit=None)
        exact = BODY + b" " * (100 - len(BODY))
        self.assertEqual(handler.handle_submit(exact, JSON)[0], 202)
        body, _ = self.assertError(handler.handle_submit(exact + b" ", JSON), 413, "payload_too_large")
        self.assertEqual(body["error"]["message"], "Feedback is limited to 100 bytes")

    def test_413_counts_bytes_not_characters(self):
        handler, _ = make(max_bytes=60)
        text = json.dumps({"type": "bug", "goal": "é" * 15, "message": "m"}, ensure_ascii=False)
        self.assertLessEqual(len(text), 60)
        self.assertError(handler.handle_submit(text, JSON), 413, "payload_too_large")

    def test_401_when_auth_required(self):
        handler, sink = make(auth="required")
        self.assertError(handler.handle_submit(BODY, JSON, None), 401, "unauthorized")
        self.assertError(handler.handle_submit(BODY, JSON, ""), 401, "unauthorized")
        self.assertEqual(handler.handle_submit(BODY, JSON, "acct_1")[0], 202)
        self.assertEqual(len(sink.records), 1)

    def test_optional_auth_accepts_anonymous(self):
        handler, sink = make()
        self.assertEqual(handler.handle_submit(BODY, JSON, None)[0], 202)
        self.assertNotIn("account", sink.records[0])

    def test_400_invalid_json(self):
        handler, _ = make(rate_limit=None)
        for raw in (b"{not json", b"", b"NaN", b'{"type": Infinity}', b"\xff\xfe"):
            with self.subTest(raw=raw):
                body, _ = self.assertError(handler.handle_submit(raw, JSON), 400, "invalid_json")
                self.assertEqual(body["error"]["message"], "Body is not valid JSON")

    def test_400_invalid_feedback_lists_every_issue(self):
        handler, sink = make()
        raw = json.dumps({"type": "feature_request", "message": "m", "severity": "high"})
        body, _ = self.assertError(handler.handle_submit(raw, JSON), 400, "invalid_feedback")
        self.assertEqual(
            body["error"]["details"],
            [
                {"path": "goal", "message": "is required"},
                {"path": "type", "message": "must be one of: " + ", ".join(FEEDBACK_TYPES)},
                {"path": "severity", "message": "is not a recognised field"},
            ],
        )
        self.assertTrue(body["error"]["message"].startswith("goal: is required; type: must be one of:"))
        self.assertEqual(sink.records, [])

    def test_every_invalid_conformance_case_is_rejected(self):
        handler, _ = make(rate_limit=None)
        for name, case in conformance_cases("invalid"):
            with self.subTest(case=name):
                body, _ = self.assertError(
                    handler.handle_submit(json.dumps(case["submission"]), JSON), 400, "invalid_feedback"
                )
                prefix = case.get("expect_error_path", "")
                self.assertTrue(any(d["path"].startswith(prefix) for d in body["error"]["details"]))

    def test_503_when_on_record_fails(self):
        def failing(record):
            raise RuntimeError("database down")

        handler, _ = make(failing)
        with self.assertLogs("backloop", "ERROR"):
            body, headers = self.assertError(handler.handle_submit(BODY, JSON), 503, "unavailable")
        self.assertEqual(headers["retry-after"], "5")
        self.assertEqual(body["error"]["message"], "Feedback could not be stored. Retry once later.")


class OrderingTest(unittest.TestCase):
    """415 -> 413 -> 401 -> 429 -> 400 invalid_json -> 400 invalid_feedback, as in server.ts."""

    def test_415_before_413(self):
        handler, _ = make(max_bytes=10)
        self.assertEqual(handler.handle_submit(BODY, "text/plain")[0], 415)

    def test_413_before_401(self):
        handler, _ = make(max_bytes=10, auth="required")
        self.assertEqual(handler.handle_submit(BODY, JSON)[0], 413)

    def test_401_before_429_and_does_not_consume_the_limit(self):
        handler, _ = make(auth="required", rate_limit=(1, 60))
        self.assertEqual(handler.handle_submit(BODY, JSON, None, "1.2.3.4")[0], 401)
        self.assertEqual(handler.handle_submit(BODY, JSON, None, "1.2.3.4")[0], 401)
        self.assertEqual(handler.handle_submit(BODY, JSON, "acct_1", "1.2.3.4")[0], 202)

    def test_429_before_400(self):
        handler, _ = make(rate_limit=(1, 60))
        self.assertEqual(handler.handle_submit(b"{bad", JSON)[0], 400)
        self.assertEqual(handler.handle_submit(b"{bad", JSON)[0], 429)

    def test_invalid_json_before_invalid_feedback(self):
        handler, _ = make()
        self.assertEqual(handler.handle_submit(b"[", JSON)[1]["error"]["code"], "invalid_json")


class RateLimitTest(unittest.TestCase):
    def test_limits_per_account_with_retry_after(self):
        clock = Clock()
        handler, _ = make(rate_limit=(2, 60), now=clock)
        self.assertEqual(handler.handle_submit(BODY, JSON, "acct_a")[0], 202)
        self.assertEqual(handler.handle_submit(BODY, JSON, "acct_a")[0], 202)
        status, body, headers = handler.handle_submit(BODY, JSON, "acct_a")
        self.assertEqual((status, body["error"]["code"]), (429, "rate_limited"))
        self.assertEqual(headers["retry-after"], "60")
        self.assertEqual(handler.handle_submit(BODY, JSON, "acct_b")[0], 202)

        clock.now = FIXED + timedelta(seconds=59.5)
        self.assertEqual(handler.handle_submit(BODY, JSON, "acct_a")[2]["retry-after"], "1")
        clock.now = FIXED + timedelta(seconds=60)
        self.assertEqual(handler.handle_submit(BODY, JSON, "acct_a")[0], 202)

    def test_falls_back_to_client_ip_then_anonymous(self):
        handler, _ = make(rate_limit=(1, 60))
        self.assertEqual(handler.handle_submit(BODY, JSON, None, "10.0.0.1")[0], 202)
        self.assertEqual(handler.handle_submit(BODY, JSON, None, "10.0.0.1")[0], 429)
        self.assertEqual(handler.handle_submit(BODY, JSON, None, "10.0.0.2")[0], 202)
        self.assertEqual(handler.handle_submit(BODY, JSON)[0], 202)
        self.assertEqual(handler.handle_submit(BODY, JSON)[0], 429)

    def test_default_is_60_per_minute(self):
        handler, _ = make()
        statuses = [handler.handle_submit(BODY, JSON, "acct_a")[0] for _ in range(61)]
        self.assertEqual(statuses.count(202), 60)
        self.assertEqual(statuses[-1], 429)

    def test_can_be_disabled(self):
        handler, _ = make(rate_limit=None)
        self.assertTrue(all(handler.handle_submit(BODY, JSON)[0] == 202 for _ in range(100)))


class DiscoveryTest(unittest.TestCase):
    def test_document(self):
        handler, _ = make(auth="required", max_bytes=8192)
        self.assertEqual(
            handler.discovery("https://api.example.com/"),
            {
                "spec_version": "0.1",
                "endpoint": "https://api.example.com/feedback",
                "types": list(FEEDBACK_TYPES),
                "max_bytes": 8192,
                "auth": "required",
            },
        )

    def test_public_endpoint_wins(self):
        handler, _ = make(public_endpoint="https://feedback.example.com/v1/feedback")
        self.assertEqual(handler.discovery("http://internal:8080")["endpoint"], "https://feedback.example.com/v1/feedback")

    def test_defaults(self):
        doc = FeedbackHandler(lambda r: None).discovery("https://api.example.com")
        self.assertEqual((doc["auth"], doc["max_bytes"]), ("optional", 16384))


class HelpersTest(unittest.TestCase):
    def test_feedback_link_header(self):
        self.assertEqual(feedback_link_header(), '</feedback>; rel="agent-feedback"')
        self.assertEqual(feedback_link_header("/v2/feedback"), '</v2/feedback>; rel="agent-feedback"')

    def test_error_response(self):
        self.assertEqual(
            error_response(400, "invalid_feedback", "goal: is required", [{"path": "goal", "message": "is required"}]),
            (
                400,
                {
                    "error": {
                        "code": "invalid_feedback",
                        "message": "goal: is required",
                        "details": [{"path": "goal", "message": "is required"}],
                    }
                },
                {"content-type": "application/json; charset=utf-8"},
            ),
        )
        self.assertNotIn("details", error_response(415, "unsupported_media_type", "x")[1]["error"])


if __name__ == "__main__":
    unittest.main()
