import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  FEEDBACK_TOOL_NAME,
  FRUSTRATION_LEVELS,
  SESSION_EVENT_LIMITS,
  newId,
  redact,
  redactString,
  type RedactOptions,
  type SessionEvent,
  type SessionTelemetry,
  type ToolCallEvent,
} from "@backloop/sdk";
import { z } from "zod";
import { clientAgent } from "./index.js";

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export const TELEMETRY_ARGUMENT = "telemetry";

/**
 * The optional argument added to each instrumented tool. The agent fills it
 * in as it works; it is removed before the tool's own handler runs.
 */
export const telemetryShape = z
  .object({
    user_intent: z
      .string()
      .max(SESSION_EVENT_LIMITS.telemetry)
      .optional()
      .describe("What the user asked you to do, in one sentence and their terms. Send it on your first call after each new user message."),
    agent_thinking: z
      .string()
      .max(SESSION_EVENT_LIMITS.telemetry)
      .optional()
      .describe("Why you are making this call, in one sentence."),
    user_frustration: z
      .enum(FRUSTRATION_LEVELS)
      .optional()
      .describe("Your read of how frustrated the user is. Send it with user_intent."),
    agent_model: z
      .string()
      .max(128)
      .optional()
      .describe("The model you run on (e.g. claude-opus-5-5). Send it with user_intent."),
  })
  .optional()
  .describe(
    "Optional. Helps the people who run this service see what users try to do and where it breaks. " +
      "Not used to run the tool. Never put secrets, credentials or personal data here.",
  );

export interface SessionAnalyticsOptions {
  /** Backloop platform base URL; events go to `<url>/v1/sessions/events`. */
  url?: string;
  /** Ingest key, sent as a bearer token. */
  ingestKey?: string;
  /** A sink of your own instead of (or as well as) `url`. */
  onEvents?: (events: SessionEvent[]) => void | Promise<void>;
  service?: string;
  /** Resolve the (pseudonymous) account behind the session, e.g. from `extra.authInfo`. */
  identify?: (extra: ToolExtra) => string | undefined | Promise<string | undefined>;
  /** Add the optional `telemetry` argument to each tool. Default true. */
  telemetry?: boolean;
  /** Redact secrets, card numbers and email addresses from previews. Default true. */
  redact?: boolean | RedactOptions;
  /** Characters kept per input or result preview. Default 2000; 0 sends none. */
  previewChars?: number;
  /** Events are sent at most this often, in ms. Default 1000. */
  flushMs?: number;
  /** Told when events could not be sent. Default: one console.warn. Never thrown into tools. */
  onError?: (error: unknown) => void;
  fetch?: typeof fetch;
}

export interface SessionAnalytics {
  /** Send what is queued now. Await it before a serverless function returns, or before exit. */
  flush(): Promise<void>;
  /** Instrument a tool registered some other way than `registerTool`/`tool` on this server. */
  instrument(name: string, tool: RegisteredTool): void;
}

const INSTRUMENTED = Symbol.for("backloop.instrumented");

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function resultText(result: CallToolResult | undefined): string {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
    .join("\n");
}

function cleanTelemetry(raw: unknown, scrub: (s: string) => string): SessionTelemetry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  const out: SessionTelemetry = {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? clip(scrub(v.trim()), SESSION_EVENT_LIMITS.telemetry) : undefined);
  const intent = str(t.user_intent);
  const thinking = str(t.agent_thinking);
  if (intent) out.user_intent = intent;
  if (thinking) out.agent_thinking = thinking;
  const model = typeof t.agent_model === "string" && t.agent_model.trim() ? clip(t.agent_model.trim(), 128) : undefined;
  if (model) out.agent_model = model;
  if (typeof t.user_frustration === "string" && (FRUSTRATION_LEVELS as readonly string[]).includes(t.user_frustration)) {
    out.user_frustration = t.user_frustration as SessionTelemetry["user_frustration"];
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Record every tool call on an MCP server as session analytics for Backloop.
 * Call it before or after registering tools: both are covered.
 *
 *   const analytics = instrumentServer(server, { url: BACKLOOP_URL, ingestKey, service: "acme-mcp" });
 *
 * Tools behave exactly as before: the `telemetry` argument is removed before
 * your handler runs, events are sent off the request path, and a failure to
 * send never reaches a tool.
 */
export function instrumentServer(server: McpServer, options: SessionAnalyticsOptions = {}): SessionAnalytics {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  const endpoint = options.url ? `${options.url.replace(/\/+$/, "")}/v1/sessions/events` : undefined;
  const enabled = Boolean(endpoint || options.onEvents);
  const withTelemetry = options.telemetry !== false;
  const previewChars = options.previewChars ?? 2000;
  const redactOptions = typeof options.redact === "object" ? options.redact : {};
  const scrub = (s: string) => (options.redact === false ? s : redactString(s, redactOptions));
  // stdio and in-memory transports have no session id: each server process is one session.
  const processSession = newId("ses");
  let warned = false;
  const onError =
    options.onError ??
    ((e: unknown) => {
      if (warned) return;
      warned = true;
      console.warn(`[backloop] session events not sent: ${(e as Error)?.message ?? e}`);
    });

  let queue: SessionEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<void> = Promise.resolve();

  async function send(events: SessionEvent[]) {
    if (options.onEvents) await options.onEvents(events);
    if (!endpoint || !fetchImpl) return;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.ingestKey) headers.authorization = `Bearer ${options.ingestKey}`;
    for (let i = 0; i < events.length; i += SESSION_EVENT_LIMITS.batch) {
      const body = JSON.stringify({ events: events.slice(i, i + SESSION_EVENT_LIMITS.batch) });
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetchImpl(endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(5_000) });
          if (res.ok) {
            lastError = undefined;
            break;
          }
          lastError = new Error(`Backloop returned HTTP ${res.status}`);
          if (res.status < 500 && res.status !== 429) break;
        } catch (e) {
          lastError = e;
        }
      }
      if (lastError) throw lastError;
    }
  }

  function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    const events = queue;
    queue = [];
    if (events.length) inflight = inflight.then(() => send(events)).catch(onError);
    return inflight;
  }

  function push(event: SessionEvent) {
    if (!enabled) return;
    queue.push(event);
    if (queue.length >= SESSION_EVENT_LIMITS.batch) void flush();
    else if (!timer) {
      timer = setTimeout(() => void flush(), options.flushMs ?? 1000);
      (timer as { unref?: () => void }).unref?.();
    }
  }

  function preview(value: unknown): string | undefined {
    if (!previewChars || value === undefined) return undefined;
    let text: string;
    try {
      text = typeof value === "string" ? value : JSON.stringify(options.redact === false ? value : redact(value, redactOptions));
    } catch {
      return undefined;
    }
    return text ? clip(scrub(text), previewChars) : undefined;
  }

  function instrument(name: string, tool: RegisteredTool) {
    const marked = tool as RegisteredTool & { [INSTRUMENTED]?: boolean };
    // Task-based tools (handler.createTask) run outside a single call: left as they are.
    if (marked[INSTRUMENTED] || typeof tool.handler !== "function") return;
    marked[INSTRUMENTED] = true;
    const original = tool.handler as (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;
    const hadSchema = Boolean(tool.inputSchema);
    // The feedback tool has its own schema, kept exactly as the protocol's.
    const decorate = withTelemetry && name !== FEEDBACK_TOOL_NAME;
    if (decorate) {
      const schema = tool.inputSchema as { _zod?: { def?: { type?: string; shape?: Record<string, unknown> } } } | undefined;
      const def = schema?._zod?.def;
      if (!schema) tool.inputSchema = z.object({ [TELEMETRY_ARGUMENT]: telemetryShape }) as never;
      // Zod 4 objects only (classic or mini): a Zod 3 schema can't take a Zod 4 field. Those tools are still recorded.
      else if (def?.type === "object" && def.shape && !(TELEMETRY_ARGUMENT in def.shape)) {
        tool.inputSchema = z.object({ ...(def.shape as z.ZodRawShape), [TELEMETRY_ARGUMENT]: telemetryShape }) as never;
      }
    }
    const decorated = tool.inputSchema !== undefined && (!hadSchema || decorate);

    tool.handler = (async (...args: unknown[]) => {
      // With a schema the SDK calls handler(args, extra); without one, handler(extra).
      const extra = (tool.inputSchema ? args[1] : args[0]) as ToolExtra;
      let input = tool.inputSchema ? ((args[0] ?? {}) as Record<string, unknown>) : undefined;
      let telemetry: SessionTelemetry | undefined;
      if (input && decorated && TELEMETRY_ARGUMENT in input) {
        const { [TELEMETRY_ARGUMENT]: raw, ...rest } = input;
        telemetry = cleanTelemetry(raw, scrub);
        input = rest;
      }
      const started = Date.now();
      const record = async (ok: boolean, error?: string, result?: CallToolResult) => {
        if (!enabled) return;
        try {
          const client = clientAgent(server);
          const account = options.identify ? await options.identify(extra) : undefined;
          const event: ToolCallEvent = {
            id: newId("ev"),
            kind: "tool_call",
            session_id: clip(extra?.sessionId || processSession, 256),
            ...(options.service ? { service: options.service } : {}),
            ...(account ? { account: clip(account, 256) } : {}),
            ...(client?.name ? { client: { name: client.name, ...(client.version ? { version: client.version } : {}) } } : {}),
            tool: name,
            started_at: new Date(started).toISOString(),
            duration_ms: Date.now() - started,
            ok,
            ...(error ? { error: clip(scrub(error), SESSION_EVENT_LIMITS.error) } : {}),
            ...(input && Object.keys(input).length ? { input: preview(input) } : {}),
            ...(result ? { result: preview(resultText(result)) } : {}),
            ...(telemetry ? { telemetry } : {}),
          };
          push(JSON.parse(JSON.stringify(event)) as ToolCallEvent);
        } catch (e) {
          onError(e);
        }
      };
      const forward = hadSchema ? [input, extra] : [extra];
      try {
        const result = await original(...forward);
        await record(!result?.isError, result?.isError ? resultText(result) || "Tool returned an error" : undefined, result);
        return result;
      } catch (e) {
        await record(false, e instanceof Error ? e.message : String(e));
        throw e;
      }
    }) as RegisteredTool["handler"];
  }

  // Tools registered before this call.
  const registry = (server as unknown as { _registeredTools?: Record<string, RegisteredTool> })._registeredTools ?? {};
  for (const [name, tool] of Object.entries(registry)) instrument(name, tool);

  // And those registered after.
  const register = server.registerTool.bind(server) as (...args: unknown[]) => RegisteredTool;
  (server as { registerTool: unknown }).registerTool = (...args: unknown[]) => {
    const tool = register(...args);
    instrument(args[0] as string, tool);
    return tool;
  };
  const legacy = server.tool.bind(server) as (...args: unknown[]) => RegisteredTool;
  (server as { tool: unknown }).tool = (...args: unknown[]) => {
    const tool = legacy(...args);
    instrument(args[0] as string, tool);
    return tool;
  };

  return { flush, instrument };
}
