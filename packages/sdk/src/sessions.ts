/**
 * Session analytics: what an MCP server records about every tool call, so the
 * platform can rebuild each agent session, judge whether the user got what
 * they asked for, and turn failed sessions into problems, even when the agent
 * never reported one.
 *
 * Sent to `POST /v1/sessions/events` as `{ events: SessionEvent[] }`.
 */

export const FRUSTRATION_LEVELS = ["low", "medium", "high"] as const;
export type FrustrationLevel = (typeof FRUSTRATION_LEVELS)[number];

/** What the calling agent reports alongside a tool call, in the tool's optional `telemetry` argument. */
export interface SessionTelemetry {
  /** What the user asked for, in a sentence. Sent on the first call after each new user message. */
  user_intent?: string;
  /** Why the agent is making this call. */
  agent_thinking?: string;
  /** The agent's read of how frustrated the user is. */
  user_frustration?: FrustrationLevel;
  /** The model the agent runs on, as it reports it. */
  agent_model?: string;
}

export interface ToolCallEvent {
  /** Unique per event; the platform ignores one it has already stored. */
  id: string;
  kind: "tool_call";
  /** The MCP session: `Mcp-Session-Id` over HTTP, one per server process over stdio. */
  session_id: string;
  service?: string;
  /** Pseudonymous account behind the session, when the server can tell. */
  account?: string;
  /** The MCP client, from `initialize`'s `clientInfo`. */
  client?: { name: string; version?: string };
  tool: string;
  /** ISO 8601. */
  started_at: string;
  duration_ms: number;
  ok: boolean;
  /** The error message, or the text of a result returned with `isError: true`. */
  error?: string;
  /** Redacted, size-capped previews. */
  input?: string;
  result?: string;
  telemetry?: SessionTelemetry;
}

/**
 * A request an agent made to a REST API, recorded by `recordRequests`. The platform
 * stores it like a tool call whose tool is `"<METHOD> <route>"`, ok when status < 400.
 */
export interface HttpRequestEvent {
  id: string;
  kind: "http_request";
  /** From `X-Agent-Session` or `Mcp-Session-Id`; without one the platform groups calls by account, client and idle time. */
  session_id?: string;
  service?: string;
  account?: string;
  /** The agent, detected from the request's headers. */
  client?: { name: string; version?: string };
  method: string;
  /** The route template (`/companies/:id`) when the framework knows it, else the path. */
  route: string;
  status: number;
  started_at: string;
  duration_ms: number;
  error?: string;
  /** Redacted, size-capped previews of the query or body, and of the response. */
  input?: string;
  result?: string;
  telemetry?: SessionTelemetry;
}

export type SessionEvent = ToolCallEvent | HttpRequestEvent;

export const SESSION_EVENT_LIMITS = {
  /** Per preview (input, result). */
  preview: 4000,
  error: 1000,
  telemetry: 1000,
  /** Events per POST. */
  batch: 500,
} as const;
