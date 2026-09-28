import json
import unittest

from backloop import (
    FEEDBACK_SCHEMA,
    FEEDBACK_TOOL_DESCRIPTION,
    FEEDBACK_TOOL_NAME,
    feedback_tool,
    feedback_tool_input_schema,
    validate_submission,
)

from .helpers import conformance_cases


class ToolTest(unittest.TestCase):
    def test_messages_api_shape(self):
        tool = feedback_tool()
        self.assertEqual(set(tool), {"name", "description", "input_schema"})
        self.assertEqual(tool["name"], "submit_feedback")
        self.assertEqual(FEEDBACK_TOOL_NAME, "submit_feedback")
        self.assertEqual(tool["description"], FEEDBACK_TOOL_DESCRIPTION)
        json.dumps(tool)  # serializable as-is

    def test_custom_name_and_description(self):
        tool = feedback_tool(name="report_problem", description="Tell us")
        self.assertEqual((tool["name"], tool["description"]), ("report_problem", "Tell us"))

    def test_input_schema(self):
        schema = feedback_tool_input_schema()
        self.assertEqual(set(schema), {"type", "properties", "required", "additionalProperties"})
        self.assertEqual(schema["type"], "object")
        self.assertEqual(schema["required"], ["type", "goal", "message"])
        self.assertIs(schema["additionalProperties"], False)
        self.assertNotIn("spec_version", schema["properties"])
        self.assertEqual(set(schema["properties"]), set(FEEDBACK_SCHEMA["properties"]) - {"spec_version"})
        self.assertEqual(schema["properties"]["type"]["enum"], FEEDBACK_SCHEMA["properties"]["type"]["enum"])

    def test_returns_a_copy(self):
        schema = feedback_tool_input_schema()
        schema["properties"]["goal"]["maxLength"] = 1
        schema["required"].append("x")
        self.assertIn("spec_version", FEEDBACK_SCHEMA["properties"])
        self.assertEqual(FEEDBACK_SCHEMA["properties"]["goal"]["maxLength"], 1000)
        self.assertEqual(FEEDBACK_SCHEMA["required"], ["type", "goal", "message"])

    def test_tool_input_is_a_valid_submission(self):
        properties = feedback_tool_input_schema()["properties"]
        for name, case in conformance_cases("valid"):
            tool_input = {k: v for k, v in case["submission"].items() if k in properties}
            with self.subTest(case=name):
                self.assertTrue(validate_submission(tool_input).valid)


if __name__ == "__main__":
    unittest.main()
