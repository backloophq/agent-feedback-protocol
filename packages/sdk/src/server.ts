import { newId } from "./ids.js";
import { redact, type RedactOptions } from "./redact.js";
import {
  DEFAULT_MAX_BYTES,
  FEEDBACK_TYPES,
  LINK_REL,
  SPEC_VERSION,
  WELL_KNOWN_PATH,
  type AuthMode,
  type AgentInfo,
  type DiscoveryDocument,
  type ErrorBody,
  type FeedbackAck,
  type FeedbackErrorCode,
  type FeedbackRecord,
  type FeedbackSource,
  type KnownIssue,
  type ValidationIssue,
} from "./types.js";
import { formatIssues, validateSubmission } from "./validate.js";

export interface RecordContext {
  request: Request;
}

/** What `onRecord` may return: a known issue to pass back to the agent. */
export type OnRecordResult = void | undefined | { known_issue?: KnownIssue };

export interface FeedbackHandlerOptions {
  /** Called for every accepted submission. Store it, forward it, or both. */
  onRecord: (record: FeedbackRecord, ctx: RecordContext) => OnRecordResult | Promise<OnRecordResult>;
  /** Service name recorded on every record. */
  service?: string;
  /**
   * Resolve the customer account behind the request (from the same
   * credentials as the rest of your API). Return undefined for anonymous
   * requests. Return a pseudonymous ID: see `hashAccount`.
   */
  identify?: (request: Request) => string | undefined | Promise<string | undefined>;
  /** Default "optional": anonymous feedback accepted, authenticated feedback attributed. */
  auth?: AuthMode;
  /**
   * Remove secrets, card numbers and email addresses from what agents send, before
   * `onRecord` sees it. Default true: not every agent uses a client that does.
   */
  redact?: boolean | RedactOptions;
  maxBytes?: number;
  /** Public URL of the feedback endpoint, for the discovery document. Default: derived from the request. */
  publicEndpoint?: string;
  /** Per-account (or per-IP) limit. Default 60 per minute. `false` disables it. */
  rateLimit?: { max: number; windowMs: number } | false;
  /** Read the client IP for rate limiting anonymous requests. */
  clientIp?: (request: Request) => string | undefined;
  source?: FeedbackSource;
  generateId?: () => string;
  now?: () => Date;
}

export interface FeedbackHandler {
  /** Route a request: `POST …/feedback` submits, `GET /.well-known/agent-feedback` discovers. */
  fetch(request: Request): Promise<Response>;
  /** Handle `POST /feedback` directly. */
  submit(request: Request): Promise<Response>;
  /** Handle `GET /.well-known/agent-feedback` directly. */
  discovery(request: Request): Response;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export function errorResponse(
  status: number,
  code: FeedbackErrorCode,
  message: string,
  details?: ValidationIssue[],
  headers: Record<string, string> = {},
): Response {
  const body: ErrorBody = { error: { code, message, ...(details ? { details } : {}) } };
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

/** `Link` header value advertising the feedback endpoint. Add it to your API's error responses. */
export function feedbackLinkHeader(path = "/feedback"): string {
  return `<${path}>; rel="${LINK_REL}"`;
}

/** Return a copy of `response` with the feedback `Link` header appended. */
export function withFeedbackLink(response: Response, path = "/feedback"): Response {
  const headers = new Headers(response.headers);
  headers.append("link", feedbackLinkHeader(path));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** HTTP libraries, browsers and the SDK clients: a User-Agent that says nothing about the agent. */
const GENERIC_USER_AGENT =
  /^(mozilla|backloop-sdk|python|curl|wget|node|undici|axios|got|go-http-client|okhttp|java|apache-httpclient|aiohttp|werkzeug|ruby|deno|bun|postmanruntime|libwww)/i;

/**
 * An `agent` block from a `User-Agent` header (its first product token), for
 * submissions that don't say who sent them. Undefined when the header only
 * names an HTTP library or a browser.
 */
export function agentFromUserAgent(userAgent: string | null | undefined): AgentInfo | undefined {
  const m = /^([^\s/()]{1,128})(?:\/([^\s()]{1,64}))?/.exec(userAgent?.trim() ?? "");
  if (!m || GENERIC_USER_AGENT.test(m[1]!)) return undefined;
  return { name: m[1]!, ...(m[2] ? { version: m[2] } : {}) };
}

class RateLimiter {
  private hits = new Map<string, { count: number; reset: number }>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}
  /** Returns seconds to wait, or 0 if allowed. */
  take(key: string, now: number): number {
    const entry = this.hits.get(key);
    if (!entry || entry.reset <= now) {
      if (this.hits.size > 10_000) this.hits.clear();
      this.hits.set(key, { count: 1, reset: now + this.windowMs });
      return 0;
    }
    entry.count++;
    return entry.count > this.max ? Math.ceil((entry.reset - now) / 1000) : 0;
  }
}

/**
 * Framework-agnostic handler built on the Fetch API `Request`/`Response`.
 * Works with Hono, Next.js route handlers, Bun, Deno, Cloudflare Workers, and
 * Node (via `@backloop/sdk/node`).
 */
export function createFeedbackHandler(options: FeedbackHandlerOptions): FeedbackHandler {
  const auth = options.auth ?? "optional";
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const limiter =
    options.rateLimit === false
      ? undefined
      : new RateLimiter(options.rateLimit?.max ?? 60, options.rateLimit?.windowMs ?? 60_000);
  const now = options.now ?? (() => new Date());
  const generateId = options.generateId ?? (() => newId("fb"));

  function discovery(request: Request): Response {
    // Behind a TLS-terminating proxy the request arrives as http: trust X-Forwarded-Proto.
    const base = new URL(request.url);
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    if (proto === "https" || proto === "http") base.protocol = `${proto}:`;
    const doc: DiscoveryDocument = {
      spec_version: SPEC_VERSION,
      endpoint: options.publicEndpoint ?? new URL("/feedback", base).toString(),
      types: FEEDBACK_TYPES,
      max_bytes: maxBytes,
      auth,
    };
    return new Response(JSON.stringify(doc), {
      status: 200,
      headers: { ...JSON_HEADERS, "cache-control": "public, max-age=3600" },
    });
  }

  async function submit(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return errorResponse(405, "method_not_allowed", "Use POST to submit feedback", undefined, { allow: "POST" });
    }
    const contentType = request.headers.get("content-type") ?? "";
    if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType)) {
      return errorResponse(415, "unsupported_media_type", "Content-Type must be application/json");
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > maxBytes) return errorResponse(413, "payload_too_large", `Feedback is limited to ${maxBytes} bytes`);

    const account = options.identify ? await options.identify(request) : undefined;
    if (auth === "required" && !account) {
      return errorResponse(401, "unauthorized", "Authenticate with the same credentials as the rest of the API");
    }

    if (limiter) {
      const key = account ?? options.clientIp?.(request) ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anonymous";
      const wait = limiter.take(key, now().getTime());
      if (wait > 0) {
        return errorResponse(429, "rate_limited", "Too many feedback submissions", undefined, { "retry-after": String(wait) });
      }
    }

    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > maxBytes) {
      return errorResponse(413, "payload_too_large", `Feedback is limited to ${maxBytes} bytes`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return errorResponse(400, "invalid_json", "Body is not valid JSON");
    }
    const result = validateSubmission(parsed);
    if (!result.valid) return errorResponse(400, "invalid_feedback", formatIssues(result.issues), result.issues);

    const feedback = options.redact === false ? result.value : redact(result.value, typeof options.redact === "object" ? options.redact : {});
    // Agents often skip `agent`: the User-Agent may still say who is calling.
    const seen = feedback.agent?.name ? undefined : agentFromUserAgent(request.headers.get("user-agent"));
    const record: FeedbackRecord = {
      id: generateId(),
      received_at: now().toISOString(),
      ...(options.service ? { service: options.service } : {}),
      ...(account ? { account } : {}),
      source: options.source ?? "http",
      feedback: seen ? { ...feedback, agent: { ...seen, ...feedback.agent } } : feedback,
    };

    let outcome: OnRecordResult;
    try {
      outcome = await options.onRecord(record, { request });
    } catch (e) {
      console.error("[backloop] failed to store feedback record", e);
      return errorResponse(503, "unavailable", "Feedback could not be stored. Retry once later.", undefined, { "retry-after": "5" });
    }

    const ack: FeedbackAck = {
      id: record.id,
      status: "accepted",
      received_at: record.received_at,
      ...(outcome?.known_issue ? { known_issue: outcome.known_issue } : {}),
    };
    return new Response(JSON.stringify(ack), { status: 202, headers: JSON_HEADERS });
  }

  return {
    submit,
    discovery,
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (pathname.endsWith(WELL_KNOWN_PATH)) {
        return request.method === "GET" || request.method === "HEAD"
          ? discovery(request)
          : errorResponse(405, "method_not_allowed", "Use GET", undefined, { allow: "GET" });
      }
      return submit(request);
    },
  };
}
