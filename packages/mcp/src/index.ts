import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  FEEDBACK_TOOL_DESCRIPTION,
  FEEDBACK_TOOL_NAME,
  formatIssues,
  newId,
  redact,
  validateSubmission,
  type AgentInfo,
  type FeedbackAck,
  type FeedbackRecord,
  type FeedbackSubmission,
  type OnRecordResult,
  type RedactOptions,
} from "@backloop/sdk";
import { feedbackInputShape } from "./shape.js";

export { feedbackInputShape } from "./shape.js";
export { createFeedbackProxyServer, type FeedbackProxyOptions } from "./proxy.js";

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface RegisterFeedbackToolOptions {
  /** Called for every accepted submission, like the HTTP handler's `onRecord`. */
  onRecord: (record: FeedbackRecord) => OnRecordResult | Promise<OnRecordResult>;
  service?: string;
  /** Resolve the (pseudonymous) account behind the MCP session, e.g. from `extra.authInfo`. */
  identify?: (extra: ToolExtra) => string | undefined | Promise<string | undefined>;
  /** Remove secrets, card numbers and email addresses from what agents send. Default true. */
  redact?: boolean | RedactOptions;
  /** Tool name. Default `submit_feedback`. */
  name?: string;
  description?: string;
}

function text(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

/** Strip keys whose value is undefined (Zod leaves them in for optional fields). */
function compact<T extends object>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** An `agent` block from the `clientInfo` the connected MCP client sent in `initialize`. */
export function clientAgent(server: McpServer): AgentInfo | undefined {
  const info = server.server.getClientVersion();
  if (!info?.name) return undefined;
  return { name: info.name.slice(0, 128), ...(info.version ? { version: info.version.slice(0, 64) } : {}) };
}

/**
 * Add the protocol's `submit_feedback` tool to an existing MCP server.
 *
 *   registerFeedbackTool(server, { service: "acme", onRecord: forwardTo({ url, ingestKey }) });
 */
export function registerFeedbackTool(server: McpServer, options: RegisterFeedbackToolOptions) {
  return server.registerTool(
    options.name ?? FEEDBACK_TOOL_NAME,
    {
      title: "Report feedback",
      description: options.description ?? FEEDBACK_TOOL_DESCRIPTION,
      inputSchema: feedbackInputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) => {
      const result = validateSubmission(compact(args));
      if (!result.valid) {
        return text({ error: { code: "invalid_feedback", message: formatIssues(result.issues), details: result.issues } }, true);
      }
      const account = options.identify ? await options.identify(extra) : undefined;
      const feedback = options.redact === false ? result.value : redact(result.value, typeof options.redact === "object" ? options.redact : {});
      // Agents often skip `agent`: the MCP client said who it is when it connected.
      const seen = feedback.agent?.name ? undefined : clientAgent(server);
      const record: FeedbackRecord = {
        id: newId("fb"),
        received_at: new Date().toISOString(),
        ...(options.service ? { service: options.service } : {}),
        ...(account ? { account } : {}),
        source: "mcp",
        feedback: seen ? { ...feedback, agent: { ...seen, ...feedback.agent } } : feedback,
      };
      try {
        const outcome = await options.onRecord(record);
        const ack: FeedbackAck = {
          id: record.id,
          status: "accepted",
          received_at: record.received_at,
          ...(outcome?.known_issue ? { known_issue: outcome.known_issue } : {}),
        };
        return text(ack);
      } catch (e) {
        return text({ error: { code: "unavailable", message: `Feedback could not be stored: ${(e as Error).message}` } }, true);
      }
    },
  );
}

export type { FeedbackSubmission };
