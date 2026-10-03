import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AGENT_FEEDBACK_INSTRUCTIONS,
  FEEDBACK_TOOL_DESCRIPTION,
  FEEDBACK_TOOL_NAME,
  FeedbackClient,
  FeedbackError,
  type AgentInfo,
  type FeedbackSubmission,
} from "@backloop/sdk";
import { z } from "zod";
import { clientAgent } from "./index.js";
import { feedbackInputShape } from "./shape.js";

export interface FeedbackProxyOptions {
  /**
   * Fixed feedback endpoint (a service's `/feedback` URL). When unset, the
   * tool takes a `service_url` argument and discovers the endpoint.
   */
  endpoint?: string;
  /** Bearer credential sent to the service, so feedback is attributed to your account. */
  apiKey?: string;
  /** Reported as `agent` on every submission. Default: the connected MCP client's `clientInfo`. */
  agent?: AgentInfo;
  sessionId?: string;
  fetch?: typeof fetch;
}

function text(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

/**
 * An agent-side MCP server exposing `submit_feedback`, which forwards
 * feedback to any service implementing the protocol. Give it to an agent
 * (Claude Code, Claude Desktop, any MCP client) so it can report problems
 * with the APIs it uses.
 */
export function createFeedbackProxyServer(options: FeedbackProxyOptions = {}): McpServer {
  // MCP clients show server instructions to the model; agents report when they are told to.
  const server = new McpServer({ name: "backloop-feedback", version: "0.1.5" }, { instructions: AGENT_FEEDBACK_INSTRUCTIONS });
  const clients = new Map<string, FeedbackClient>();

  async function clientFor(serviceUrl?: string): Promise<FeedbackClient> {
    const key = options.endpoint ?? serviceUrl;
    if (!key) throw new FeedbackError("service_url is required: the base URL of the API you are reporting on", "invalid_feedback");
    const cached = clients.get(key);
    if (cached) return cached;
    const common = { apiKey: options.apiKey, agent: options.agent ?? clientAgent(server), sessionId: options.sessionId, fetch: options.fetch };
    const client = options.endpoint
      ? new FeedbackClient({ ...common, endpoint: options.endpoint })
      : ((await FeedbackClient.fromDiscovery(key, common)) ?? new FeedbackClient({ ...common, baseUrl: key }));
    clients.set(key, client);
    return client;
  }

  // With a fixed endpoint the tool is exactly the protocol's; otherwise the
  // agent also says which service it is reporting on.
  const inputSchema = {
    ...(options.endpoint
      ? {}
      : {
          service_url: z
            .string()
            .url()
            .describe("Base URL of the API or service you are reporting on, e.g. https://api.example.com"),
        }),
    ...feedbackInputShape,
  } as typeof feedbackInputShape & { service_url?: z.ZodString };

  server.registerTool(
    FEEDBACK_TOOL_NAME,
    {
      title: "Report feedback",
      description: FEEDBACK_TOOL_DESCRIPTION,
      inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const { service_url, ...submission } = JSON.parse(JSON.stringify(args)) as FeedbackSubmission & { service_url?: string };
      try {
        const client = await clientFor(service_url);
        return text(await client.submit(submission));
      } catch (e) {
        const err = e instanceof FeedbackError ? e : new FeedbackError(String(e), "network_error");
        return text({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }, true);
      }
    },
  );
  return server;
}
