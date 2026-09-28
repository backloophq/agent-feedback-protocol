import json
import unittest

from backloop import FeedbackHandler, ForwardError, fan_out, forward_to, memory_sink

from .helpers import LocalServer, refused_url

RECORD = {
    "id": "fb_1",
    "received_at": "2026-09-28T10:04:11.123Z",
    "source": "http",
    "feedback": {"type": "bug", "goal": "g", "message": "m"},
}
KNOWN_ISSUE = {"id": "iss_1", "title": "Fix it", "status": "in_progress"}
ACCEPTED = {"results": [{"id": "fb_1", "status": "accepted"}]}
DUPLICATE = {"results": [{"id": "fb_1", "status": "duplicate", "known_issue": KNOWN_ISSUE}]}


class ForwardToTest(unittest.TestCase):
    def test_posts_records_and_returns_known_issue(self):
        with LocalServer((200, DUPLICATE, {})) as collector:
            result = forward_to(collector.url + "/", ingest_key="ik_123")(RECORD)
        self.assertEqual(result, {"known_issue": KNOWN_ISSUE})
        request = collector.requests[0]
        self.assertEqual((request["method"], request["path"]), ("POST", "/v1/records"))
        self.assertEqual(request["headers"]["authorization"], "Bearer ik_123")
        self.assertEqual(request["headers"]["content-type"], "application/json")
        self.assertEqual(json.loads(request["body"]), {"records": [RECORD]})

    def test_accepted_without_known_issue(self):
        with LocalServer((200, ACCEPTED, {})) as collector:
            self.assertIsNone(forward_to(collector.url)(RECORD))
        self.assertNotIn("authorization", collector.requests[0]["headers"])

    def test_retries_once_on_5xx(self):
        with LocalServer((500, {}, {}), (200, DUPLICATE, {})) as collector:
            self.assertEqual(forward_to(collector.url)(RECORD), {"known_issue": KNOWN_ISSUE})
        self.assertEqual(len(collector.requests), 2)

    def test_retries_once_on_429(self):
        with LocalServer((429, {}, {}), (200, ACCEPTED, {})) as collector:
            self.assertIsNone(forward_to(collector.url)(RECORD))
        self.assertEqual(len(collector.requests), 2)

    def test_raises_after_second_failure(self):
        with LocalServer((503, {}, {})) as collector:
            with self.assertRaises(ForwardError) as ctx:
                forward_to(collector.url)(RECORD)
        self.assertEqual(ctx.exception.status, 503)
        self.assertEqual(len(collector.requests), 2)

    def test_does_not_retry_4xx(self):
        with LocalServer((401, {"error": {"code": "unauthorized"}}, {})) as collector:
            with self.assertRaises(ForwardError) as ctx:
                forward_to(collector.url, ingest_key="wrong")(RECORD)
        self.assertEqual(ctx.exception.status, 401)
        self.assertEqual(len(collector.requests), 1)

    def test_rejected_record_raises(self):
        rejected = {"results": [{"id": "fb_1", "status": "rejected", "error": {"code": "invalid", "message": "bad"}}]}
        with LocalServer((200, rejected, {})) as collector:
            with self.assertRaisesRegex(ForwardError, "Collector rejected record: bad"):
                forward_to(collector.url)(RECORD)
        self.assertEqual(len(collector.requests), 1)

    def test_network_error_raises(self):
        with self.assertRaisesRegex(ForwardError, "Could not reach"):
            forward_to(refused_url(), timeout=2)(RECORD)


class HandlerForwardingTest(unittest.TestCase):
    BODY = json.dumps({"type": "bug", "goal": "g", "message": "m"})

    def test_known_issue_reaches_the_agent(self):
        with LocalServer((200, DUPLICATE, {})) as collector:
            handler = FeedbackHandler(forward_to(collector.url), service="acme")
            status, ack, _ = handler.handle_submit(self.BODY, "application/json", "acct_1")
        self.assertEqual(status, 202)
        self.assertEqual(ack["known_issue"], KNOWN_ISSUE)
        forwarded = json.loads(collector.requests[0]["body"])["records"][0]
        self.assertEqual((forwarded["id"], forwarded["service"], forwarded["account"]), (ack["id"], "acme", "acct_1"))

    def test_collector_down_is_503(self):
        handler = FeedbackHandler(forward_to(refused_url(), timeout=2))
        with self.assertLogs("backloop", "ERROR"):
            status, body, headers = handler.handle_submit(self.BODY, "application/json")
        self.assertEqual((status, body["error"]["code"], headers["retry-after"]), (503, "unavailable", "5"))


class SinksTest(unittest.TestCase):
    def test_memory_sink(self):
        sink = memory_sink()
        self.assertIsNone(sink(RECORD))
        self.assertEqual(sink.records, [RECORD])

    def test_fan_out_runs_every_sink_and_first_known_issue_wins(self):
        first, other = memory_sink(), {"id": "iss_2", "title": "Other", "status": "fixed"}
        sink = fan_out(first, lambda r: None, lambda r: {"known_issue": KNOWN_ISSUE}, lambda r: {"known_issue": other})
        self.assertEqual(sink(RECORD), {"known_issue": KNOWN_ISSUE})
        self.assertEqual(first.records, [RECORD])
        self.assertIsNone(fan_out(memory_sink())(RECORD))


if __name__ == "__main__":
    unittest.main()
