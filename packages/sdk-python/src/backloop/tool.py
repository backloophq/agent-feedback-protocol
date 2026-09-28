"""The ``submit_feedback`` tool for LLM tool-calling APIs (spec §7)."""

from __future__ import annotations

import copy
from typing import Any, Dict, Optional

from ._generated import FEEDBACK_SCHEMA, FEEDBACK_TOOL_DESCRIPTION

FEEDBACK_TOOL_NAME = "submit_feedback"


def feedback_tool_input_schema() -> Dict[str, Any]:
    """
    JSON Schema for the tool's input: the submission schema without
    ``spec_version`` and without JSON-Schema meta keys, ready for any LLM
    tool-calling API.
    """
    schema = copy.deepcopy(FEEDBACK_SCHEMA)
    properties = schema["properties"]
    properties.pop("spec_version", None)
    return {
        "type": "object",
        "properties": properties,
        "required": schema["required"],
        "additionalProperties": schema["additionalProperties"],
    }


def feedback_tool(name: Optional[str] = None, description: Optional[str] = None) -> Dict[str, Any]:
    """
    The feedback tool in the shape the Claude Messages API expects
    (``{"name", "description", "input_schema"}``). Add it to your agent's tools
    and send its input with ``FeedbackClient.submit``.
    """
    return {
        "name": name if name is not None else FEEDBACK_TOOL_NAME,
        "description": description if description is not None else FEEDBACK_TOOL_DESCRIPTION,
        "input_schema": feedback_tool_input_schema(),
    }
