import unittest

from backloop import (
    FEEDBACK_SCHEMA,
    format_issues,
    validate_ack,
    validate_record,
    validate_submission,
)

from .helpers import conformance_cases

BASE = {"type": "bug", "goal": "g", "message": "m"}

VALID = conformance_cases("valid")
INVALID = conformance_cases("invalid")


class ConformanceTest(unittest.TestCase):
    """spec/conformance: one generated test per case (see below)."""

    def test_suite_is_present(self):
        self.assertGreater(len(VALID), 0)
        self.assertGreater(len(INVALID), 0)


def _valid_test(case):
    def test(self):
        result = validate_submission(case["submission"])
        self.assertTrue(result.valid, result.issues)
        self.assertEqual(result.issues, [])
        self.assertIs(result.value, case["submission"])

    return test


def _invalid_test(case):
    def test(self):
        result = validate_submission(case["submission"])
        self.assertFalse(result.valid)
        prefix = case.get("expect_error_path", "")
        self.assertTrue(
            any(issue["path"].startswith(prefix) for issue in result.issues),
            f"expected an issue at {prefix!r}, got {result.issues}",
        )

    return test


for _name, _case in VALID:
    setattr(ConformanceTest, f"test_valid_{_name.replace('-', '_')}", _valid_test(_case))
for _name, _case in INVALID:
    setattr(ConformanceTest, f"test_invalid_{_name.replace('-', '_')}", _invalid_test(_case))


class MessagesTest(unittest.TestCase):
    """Messages and paths match validate.ts exactly."""

    def issues(self, value):
        return validate_submission(value).issues

    def test_required(self):
        self.assertEqual(
            self.issues({"type": "bug"}),
            [{"path": "goal", "message": "is required"}, {"path": "message", "message": "is required"}],
        )

    def test_unknown_field(self):
        self.assertEqual(
            self.issues({**BASE, "severity": "high"}),
            [{"path": "severity", "message": "is not a recognised field"}],
        )

    def test_nested_dot_path(self):
        self.assertEqual(
            self.issues({**BASE, "agent": {"api_key": "x"}}),
            [{"path": "agent.api_key", "message": "is not a recognised field"}],
        )

    def test_empty_string(self):
        self.assertEqual(self.issues({**BASE, "goal": ""}), [{"path": "goal", "message": "must not be empty"}])

    def test_max_length(self):
        self.assertEqual(
            self.issues({**BASE, "goal": "x" * 1001}),
            [{"path": "goal", "message": "must be at most 1000 characters"}],
        )

    def test_enum(self):
        self.assertEqual(
            self.issues({**BASE, "outcome": "failed"}),
            [{"path": "outcome", "message": "must be one of: blocked, degraded, completed"}],
        )

    def test_const(self):
        self.assertEqual(
            self.issues({**BASE, "spec_version": "1.0"}),
            [{"path": "spec_version", "message": 'must be "0.1"'}],
        )

    def test_root_not_object(self):
        for value in (None, [], "x", 1, True):
            with self.subTest(value=value):
                self.assertEqual(self.issues(value), [{"path": "", "message": "must be an object"}])

    def test_type_messages(self):
        self.assertEqual(
            self.issues({**BASE, "workaround": "no", "metadata": [], "evidence": {"status_code": "400"}}),
            [
                {"path": "workaround", "message": "must be a boolean"},
                {"path": "metadata", "message": "must be an object"},
                {"path": "evidence.status_code", "message": "must be an integer"},
            ],
        )

    def test_range_messages(self):
        self.assertEqual(
            self.issues({**BASE, "evidence": {"status_code": 99}}),
            [{"path": "evidence.status_code", "message": "must be >= 100"}],
        )
        self.assertEqual(
            self.issues({**BASE, "evidence": {"status_code": 600}}),
            [{"path": "evidence.status_code", "message": "must be <= 599"}],
        )

    def test_reports_every_issue(self):
        issues = self.issues({"type": "nope", "goal": "", "extra": 1})
        self.assertEqual([i["path"] for i in issues], ["message", "type", "goal", "extra"])

    def test_format_issues(self):
        self.assertEqual(
            format_issues([{"path": "", "message": "must be an object"}, {"path": "goal", "message": "is required"}]),
            "must be an object; goal: is required",
        )


class PythonTypesTest(unittest.TestCase):
    """Python's bool-is-int and 1.0 == 1 must not leak into JSON Schema semantics."""

    def status(self, code):
        return validate_submission({**BASE, "evidence": {"status_code": code}})

    def test_bool_is_not_an_integer(self):
        self.assertFalse(self.status(True).valid)
        self.assertEqual(self.status(True).issues[0]["message"], "must be an integer")

    def test_fractional_float_is_not_an_integer(self):
        self.assertFalse(self.status(400.5).valid)

    def test_integral_float_is_an_integer(self):
        # Same as Number.isInteger(400.0) and JSON Schema: 400.0 is an integer.
        self.assertTrue(self.status(400.0).valid)

    def test_nan_and_infinity_are_not_integers(self):
        self.assertFalse(self.status(float("nan")).valid)
        self.assertFalse(self.status(float("inf")).valid)

    def test_bool_is_not_a_string_or_enum_member(self):
        self.assertFalse(validate_submission({**BASE, "type": True}).valid)

    def test_bool_never_matches_numeric_enum_or_const(self):
        from backloop.validate import _check

        issues = []
        _check({"enum": [0, 1]}, True, "a", issues)
        _check({"const": 1}, True, "b", issues)
        _check({"const": True}, 1, "c", issues)
        _check({"const": 1}, 1.0, "ok", issues)  # 1.0 and 1 are the same JSON number
        self.assertEqual([i["path"] for i in issues], ["a", "b", "c"])

    def test_int_is_not_a_boolean(self):
        self.assertFalse(validate_submission({**BASE, "workaround": 0}).valid)

    def test_tuple_is_an_array_not_an_object(self):
        self.assertFalse(validate_submission({**BASE, "metadata": (1, 2)}).valid)

    def test_length_counts_code_points(self):
        self.assertTrue(validate_submission({**BASE, "goal": "\U0001F600" * 1000}).valid)
        self.assertFalse(validate_submission({**BASE, "goal": "\U0001F600" * 1001}).valid)

    def test_schema_is_not_mutated(self):
        before = repr(FEEDBACK_SCHEMA)
        validate_submission({**BASE, "extra": 1})
        self.assertEqual(repr(FEEDBACK_SCHEMA), before)


class RecordAndAckTest(unittest.TestCase):
    RECORD = {"id": "fb_1", "received_at": "2026-09-28T10:04:11.123Z", "source": "http", "feedback": BASE}

    def test_valid_record(self):
        self.assertTrue(validate_record(self.RECORD).valid)

    def test_record_ref_uses_feedback_paths(self):
        issues = validate_record({**self.RECORD, "feedback": {"type": "bug"}}).issues
        self.assertEqual([i["path"] for i in issues], ["feedback.goal", "feedback.message"])

    def test_record_date_time(self):
        for value in ("2026-09-28T10:04:11Z", "2026-09-28t10:04:11.5+02:00"):
            with self.subTest(value=value):
                self.assertTrue(validate_record({**self.RECORD, "received_at": value}).valid)
        for value in ("2026-09-28 10:04:11Z", "2026-09-28T10:04:11", "2026-09-28T10:04:11Z\n", "yesterday"):
            with self.subTest(value=value):
                self.assertEqual(
                    validate_record({**self.RECORD, "received_at": value}).issues,
                    [{"path": "received_at", "message": "must be an RFC 3339 date-time"}],
                )

    def test_record_rejects_unknown_fields_and_sources(self):
        issues = validate_record({**self.RECORD, "source": "email", "extra": 1}).issues
        self.assertEqual(
            issues,
            [
                {"path": "source", "message": "must be one of: http, mcp, sdk, other"},
                {"path": "extra", "message": "is not a recognised field"},
            ],
        )

    def test_ack(self):
        ack = {
            "id": "fb_1",
            "status": "accepted",
            "received_at": "2026-09-28T10:04:11Z",
            "known_issue": {"id": "iss_1", "title": "t", "status": "planned"},
        }
        self.assertTrue(validate_ack(ack).valid)
        self.assertEqual(
            validate_ack({**ack, "status": "ok", "known_issue": {"id": "i", "title": "t", "status": "done"}}).issues,
            [
                {"path": "status", "message": 'must be "accepted"'},
                {
                    "path": "known_issue.status",
                    "message": "must be one of: acknowledged, planned, in_progress, fixed, wont_fix",
                },
            ],
        )


if __name__ == "__main__":
    unittest.main()
