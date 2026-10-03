import { FEEDBACK_TYPES, OUTCOMES } from "@backloop/sdk";
import { z } from "zod";

/**
 * The submission schema as a Zod shape, for `McpServer.registerTool`.
 * Mirrors spec/feedback.schema.json (a test keeps them in sync); the
 * canonical validator still runs on every call.
 */
export const feedbackInputShape = {
  type: z.enum(FEEDBACK_TYPES).describe("Category of the problem."),
  goal: z
    .string()
    .min(1)
    .max(1000)
    .describe("What you or your user were trying to accomplish, in plain language. The task, not the API call."),
  message: z.string().min(1).max(4000).describe("What prevented or complicated the task, specifically."),
  endpoint: z.string().min(1).max(512).optional().describe("Path template or tool name involved."),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional(),
  outcome: z
    .enum(OUTCOMES)
    .optional()
    .describe("blocked: task failed. degraded: completed worse or slower. completed: suggestion only."),
  workaround: z.boolean().optional().describe("Whether you found a workaround."),
  workaround_description: z.string().max(2000).optional(),
  expected: z.string().max(2000).optional().describe("What you expected to find or happen."),
  suggestion: z.string().max(2000).optional().describe("A concrete change that would have let you succeed."),
  request_id: z.string().max(256).optional(),
  session_id: z.string().max(256).optional().describe("Same value for every report in one task."),
  agent: z
    .object({
      name: z.string().max(128).optional(),
      version: z.string().max(64).optional(),
      model: z.string().max(128).optional(),
      framework: z.string().max(128).optional(),
    })
    .strict()
    .optional()
    .describe("Who you are: the agent or product you run as (name) and your model. Always fill it."),
  evidence: z
    .object({
      status_code: z.number().int().min(100).max(599).optional(),
      request: z.record(z.string(), z.unknown()).optional(),
      response_excerpt: z.string().max(4000).optional(),
    })
    .strict()
    .optional()
    .describe("Sanitized details of the failing interaction. Never include credentials or personal data."),
  metadata: z.record(z.string(), z.unknown()).optional(),
};
