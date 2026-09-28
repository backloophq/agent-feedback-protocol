import { FEEDBACK_SCHEMA, FEEDBACK_TOOL_DESCRIPTION } from "./generated.js";

export const FEEDBACK_TOOL_NAME = "submit_feedback";

/**
 * JSON Schema for the tool's input: the submission schema without
 * `spec_version` and without JSON-Schema meta keys, ready for any LLM
 * tool-calling API.
 */
export function feedbackToolInputSchema(): Record<string, unknown> {
  const { properties, required, additionalProperties } = structuredClone(FEEDBACK_SCHEMA) as unknown as {
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };
  delete properties.spec_version;
  return { type: "object", properties, required, additionalProperties };
}

/**
 * The feedback tool in the shape the Claude Messages API expects
 * (`{ name, description, input_schema }`). Add it to your agent's tools and
 * send its input with `FeedbackClient.submit`.
 */
export function feedbackTool(options: { name?: string; description?: string } = {}) {
  return {
    name: options.name ?? FEEDBACK_TOOL_NAME,
    description: options.description ?? FEEDBACK_TOOL_DESCRIPTION,
    input_schema: feedbackToolInputSchema(),
  };
}
