import { newId } from "./ids.js";
import { redact, redactString, type RedactOptions } from "./redact.js";
import { SESSION_EVENT_LIMITS, type HttpRequestEvent, type SessionEvent } from "./sessions.js";

/**
 * Agent analytics for a REST API: every request an AI agent makes becomes an
 * `http_request` event, so Backloop rebuilds agent sessions on a plain API the
 * way it does on an MCP server, judges them, and files the failed ones as problems.
 *
 *   const recorder = recordRequests({ url: BACKLOOP_URL, ingestKey, service: "acme-api" });
 *   export default { fetch: recorder.wrap(app.fetch) };            // any Fetch-API server
 *   app.use("*", recorder.hono());                                  // Hono
 *   app.use(recorder.express());                                    // Express / Connect
 *
 * Human traffic (browsers, unknown clients) is not recorded unless `agentsOnly` is false.
 */

export interface RecordRequestsOptions {
  /** Backloop platform base URL; events go to `<url>/v1/sessions/events`. */
  url?: string;
  ingestKey?: string;
  /** A sink of your own instead of (or as well as) `url`. */
  onEvents?: (events: SessionEvent[]) => void | Promise<void>;
  service?: string;
  /** The (pseudonymous) account behind the request, from the same credentials as the rest of your API. */
  identify?: (request: Request) => string | undefined | Promise<string | undefined>;
  /** Record only requests from detected AI agents. Default true. */
  agentsOnly?: boolean;
  /** The route template for a request (`/companies/:id`). Default: the path, with ids collapsed to `:id`. */
  route?: (request: Request) => string | undefined;
  /** Skip requests: health checks, the feedback endpoint itself… Default skips /feedback, /.well-known/ and /healthz. */
  skip?: (request: Request) => boolean;
  /** Characters kept per input or result preview. Default 1000; 0 sends none. */
  previewChars?: number;
  redact?: boolean | RedactOptions;
  flushMs?: number;
  onError?: (error: unknown) => void;
  fetch?: typeof fetch;
}

export interface RequestRecorder {
  /** Wrap a Fetch-API handler: `(request) => Response`. */
  wrap<A extends unknown[]>(handler: (request: Request, ...rest: A) => Response | Promise<Response>): (request: Request, ...rest: A) => Promise<Response>;
  /** Hono middleware. */
  hono(): (c: { req: { raw: Request; routePath?: string }; res: Response }, next: () => Promise<void>) => Promise<void>;
  /** Express / Connect middleware. */
  express(): (req: ExpressLikeRequest, res: ExpressLikeResponse, next: () => void) => void;
  /** Record one request yourself. */
  record(request: Request, response: { status: number; body?: string }, startedAt: number, routeHint?: string): Promise<void>;
  /** Send what is queued now. */
  flush(): Promise<void>;
}

interface ExpressLikeRequest {
  method: string;
  originalUrl?: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  route?: { path?: string };
  baseUrl?: string;
  protocol?: string;
  get?: (name: string) => string | undefined;
}
interface ExpressLikeResponse {
  statusCode: number;
  on(event: "finish", listener: () => void): unknown;
}

/** Known AI agents and agent runtimes, by User-Agent product token. Order matters: specific first. */
const AGENT_PATTERNS: Array<[RegExp, string]> = [
  [/claude-code/i, "claude-code"],
  [/Claude-User/i, "Claude-User"],
  [/Claude-SearchBot/i, "Claude-SearchBot"],
  [/ClaudeBot/i, "ClaudeBot"],
  [/ChatGPT-User/i, "ChatGPT-User"],
  [/OAI-SearchBot/i, "OAI-SearchBot"],
  [/GPTBot/i, "GPTBot"],
  [/Perplexity-User/i, "Perplexity-User"],
  [/PerplexityBot/i, "PerplexityBot"],
  [/Google-Extended|Gemini/i, "Gemini"],
  [/MistralAI-User/i, "MistralAI-User"],
  [/\bCursor\b/i, "Cursor"],
  [/\bCodex\b/i, "Codex"],
  [/\bDevin\b/i, "Devin"],
  [/Manus/i, "Manus"],
  [/\bAnthropic\/|anthropic-(?:typescript|python|sdk)/i, "anthropic-sdk"],
  [/\bOpenAI\/|openai-(?:node|python)/i, "openai-sdk"],
  [/langchain|langgraph/i, "langchain"],
  [/llamaindex/i, "llamaindex"],
  [/mcp-remote|modelcontextprotocol|\bmcp\b/i, "mcp-client"],
  [/agent|\bbot\b|crawler|spider/i, "agent"],
];

/**
 * The AI agent behind a request, from its headers, or undefined for human or unknown
 * traffic. Explicit headers win (`X-Agent-Name`, `X-Agent`, `Signature-Agent` from
 * Web Bot Auth), then the User-Agent.
 */
export function detectAgent(headers: Headers | Record<string, string | string[] | undefined>): { name: string; version?: string } | undefined {
  const get = (name: string): string | undefined => {
    if (headers instanceof Headers) return headers.get(name) ?? undefined;
    const v = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const explicit = get("x-agent-name") ?? get("x-agent");
  if (explicit?.trim()) return { name: explicit.trim().slice(0, 128) };
  const signature = get("signature-agent")?.replace(/^"|"$/g, "").trim();
  if (signature) {
    try {
      return { name: new URL(signature).hostname.slice(0, 128) };
    } catch {
      return { name: signature.slice(0, 128) };
    }
  }
  const ua = get("user-agent") ?? "";
  for (const [pattern, name] of AGENT_PATTERNS) {
    const m = pattern.exec(ua);
    if (m) {
      const version = new RegExp(`${m[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([\\w.-]{1,32})`, "i").exec(ua)?.[1];
      return { name, ...(version ? { version } : {}) };
    }
  }
  // An HTTP library calling with an MCP or agent session header is an agent too.
  if (get("mcp-session-id") || get("x-agent-session")) return { name: "agent" };
  return undefined;
}

const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z]{2,6}_[A-Za-z0-9]{6,}|[0-9a-f]{16,}|[A-Za-z0-9]{20,})$/i;

/** `/companies/cmp_001/jobs` → `/companies/:id/jobs`. */
export function collapsePath(path: string): string {
  return (
    path
      .split("/")
      .map((seg) => (seg && ID_SEGMENT.test(seg) ? ":id" : seg))
      .join("/") || "/"
  );
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

export function recordRequests(options: RecordRequestsOptions = {}): RequestRecorder {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  const endpoint = options.url ? `${options.url.replace(/\/+$/, "")}/v1/sessions/events` : undefined;
  const enabled = Boolean(endpoint || options.onEvents);
  const agentsOnly = options.agentsOnly !== false;
  const previewChars = options.previewChars ?? 1000;
  const redactOptions = typeof options.redact === "object" ? options.redact : {};
  const scrub = (s: string) => (options.redact === false ? s : redactString(s, redactOptions));
  const skip = options.skip ?? ((r: Request) => /\/(feedback|healthz|health)(\/|$)|\/\.well-known\//.test(new URL(r.url).pathname));
  let warned = false;
  const onError =
    options.onError ??
    ((e: unknown) => {
      if (warned) return;
      warned = true;
      console.warn(`[backloop] request events not sent: ${(e as Error)?.message ?? e}`);
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
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ events: events.slice(i, i + SESSION_EVENT_LIMITS.batch) }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`Backloop returned HTTP ${res.status}`);
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
    queue.push(event);
    if (queue.length >= SESSION_EVENT_LIMITS.batch) void flush();
    else if (!timer) {
      timer = setTimeout(() => void flush(), options.flushMs ?? 1000);
      (timer as { unref?: () => void }).unref?.();
    }
  }

  function preview(text: string | undefined): string | undefined {
    if (!previewChars || !text) return undefined;
    let out = text;
    try {
      if (options.redact !== false && /^[[{]/.test(text.trim())) out = JSON.stringify(redact(JSON.parse(text), redactOptions));
    } catch {}
    return clip(scrub(out), Math.min(previewChars, SESSION_EVENT_LIMITS.preview));
  }

  async function record(request: Request, response: { status: number; body?: string }, startedAt: number, routeHint?: string) {
    if (!enabled) return;
    try {
      if (skip(request)) return;
      const client = detectAgent(request.headers);
      if (agentsOnly && !client) return;
      const url = new URL(request.url);
      const route = options.route?.(request) ?? routeHint ?? collapsePath(url.pathname);
      const account = options.identify ? await options.identify(request) : undefined;
      const sessionId = request.headers.get("x-agent-session") ?? request.headers.get("mcp-session-id") ?? undefined;
      const failed = response.status >= 400;
      const event: HttpRequestEvent = {
        id: newId("ev"),
        kind: "http_request",
        ...(sessionId ? { session_id: clip(sessionId, 256) } : {}),
        ...(options.service ? { service: options.service } : {}),
        ...(account ? { account: clip(account, 256) } : {}),
        ...(client ? { client } : {}),
        method: request.method.toUpperCase(),
        route: clip(route, 512),
        status: response.status,
        started_at: new Date(startedAt).toISOString(),
        duration_ms: Date.now() - startedAt,
        ...(failed && response.body ? { error: clip(scrub(response.body), SESSION_EVENT_LIMITS.error) } : {}),
        // The concrete path when the route hides ids in it (`/companies/cmp_001/jobs`), then the query.
        ...((): { input?: string } => {
          const query = url.search ? decodeURIComponent(url.search.slice(1)).replace(/&/g, " ") : "";
          const text = [route !== url.pathname ? url.pathname : "", query].filter(Boolean).join(" ");
          return text ? { input: preview(text) } : {};
        })(),
        ...(response.body ? { result: preview(response.body) } : {}),
      };
      push(JSON.parse(JSON.stringify(event)) as HttpRequestEvent);
    } catch (e) {
      onError(e);
    }
  }

  async function bodyOf(response: Response): Promise<string | undefined> {
    if (!previewChars && response.status < 400) return undefined;
    const type = response.headers.get("content-type") ?? "";
    if (!/json|text|xml/.test(type)) return undefined;
    try {
      return (await response.clone().text()).slice(0, 8000);
    } catch {
      return undefined;
    }
  }

  return {
    wrap(handler) {
      return async (request, ...rest) => {
        const started = Date.now();
        const response = await handler(request, ...rest);
        if (enabled) void bodyOf(response).then((body) => record(request, { status: response.status, body }, started));
        return response;
      };
    },
    hono() {
      return async (c, next) => {
        const started = Date.now();
        await next();
        if (!enabled) return;
        const response = c.res;
        const route = c.req.routePath && c.req.routePath !== "*" && c.req.routePath !== "/*" ? c.req.routePath : undefined;
        void bodyOf(response).then((body) => record(c.req.raw, { status: response.status, body }, started, route));
      };
    },
    express() {
      return (req, res, next) => {
        const started = Date.now();
        if (enabled) {
          res.on("finish", () => {
            const headers = new Headers();
            for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
            else if (Array.isArray(v) && v[0]) headers.set(k, v[0]);
            const host = req.get?.("host") ?? (typeof req.headers.host === "string" ? req.headers.host : "localhost");
            const request = new Request(`${req.protocol ?? "http"}://${host}${req.originalUrl ?? req.url}`, { method: req.method, headers });
            const route = req.route?.path ? `${req.baseUrl ?? ""}${req.route.path}` : undefined;
            void record(request, { status: res.statusCode }, started, route);
          });
        }
        next();
      };
    },
    record,
    flush,
  };
}
