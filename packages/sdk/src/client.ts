import { redact, type RedactOptions } from "./redact.js";
import {
  SPEC_VERSION,
  WELL_KNOWN_PATH,
  type AgentInfo,
  type DiscoveryDocument,
  type ErrorBody,
  type FeedbackAck,
  type FeedbackSubmission,
  type ValidationIssue,
} from "./types.js";
import { formatIssues, validateSubmission } from "./validate.js";

export class FeedbackError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly details?: ValidationIssue[],
  ) {
    super(message);
    this.name = "FeedbackError";
  }
}

export interface FeedbackClientOptions {
  /** API base URL; feedback goes to `${baseUrl}/feedback`. */
  baseUrl?: string;
  /** Full feedback URL. Overrides `baseUrl`. */
  endpoint?: string;
  /** Sent as `Authorization: Bearer <apiKey>` so feedback is attributed to your account. */
  apiKey?: string;
  headers?: Record<string, string>;
  /** Default `agent` block added to every submission. */
  agent?: AgentInfo;
  /** Default `session_id` added to every submission. */
  sessionId?: string;
  /** Redact secrets and emails before sending. Default true. */
  redact?: boolean | RedactOptions;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export type SubmitResult = { ok: true; ack: FeedbackAck } | { ok: false; error: FeedbackError };

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class FeedbackClient {
  readonly endpoint: string;
  private readonly options: FeedbackClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FeedbackClientOptions) {
    const endpoint = options.endpoint ?? (options.baseUrl ? `${options.baseUrl.replace(/\/+$/, "")}/feedback` : undefined);
    if (!endpoint) throw new Error("FeedbackClient needs `endpoint` or `baseUrl`");
    this.endpoint = endpoint;
    this.options = options;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Build the submission that would be sent: defaults applied, redacted and validated. */
  prepare(feedback: FeedbackSubmission): FeedbackSubmission {
    let body: FeedbackSubmission = { ...feedback };
    if (this.options.agent && !body.agent) body.agent = this.options.agent;
    if (this.options.sessionId && !body.session_id) body.session_id = this.options.sessionId;
    if (this.options.redact !== false) {
      body = redact(body, typeof this.options.redact === "object" ? this.options.redact : {});
    }
    const result = validateSubmission(body);
    if (!result.valid) {
      throw new FeedbackError(formatIssues(result.issues), "invalid_feedback", undefined, result.issues);
    }
    return body;
  }

  /** Send feedback. Throws `FeedbackError` on validation, network or HTTP errors. */
  async submit(feedback: FeedbackSubmission): Promise<FeedbackAck> {
    const body = JSON.stringify(this.prepare(feedback));
    let response = await this.post(body);
    if (RETRYABLE.has(response.status)) {
      const delay = Math.min(retryAfterMs(response.headers.get("retry-after")) ?? 1000, 10_000);
      await new Promise((r) => setTimeout(r, delay));
      response = await this.post(body);
    }
    const payload = (await response.json().catch(() => undefined)) as FeedbackAck | ErrorBody | undefined;
    if (response.status === 202 || response.status === 200) return payload as FeedbackAck;
    const err = (payload as ErrorBody | undefined)?.error;
    throw new FeedbackError(
      err?.message ?? `Feedback endpoint returned HTTP ${response.status}`,
      err?.code ?? "http_error",
      response.status,
      err?.details,
    );
  }

  /** Like `submit`, but never throws: feedback must never break the agent's task. */
  async trySubmit(feedback: FeedbackSubmission): Promise<SubmitResult> {
    try {
      return { ok: true, ack: await this.submit(feedback) };
    } catch (e) {
      const error = e instanceof FeedbackError ? e : new FeedbackError(String((e as Error)?.message ?? e), "network_error");
      return { ok: false, error };
    }
  }

  private async post(body: string): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": `backloop-sdk-js/${SPEC_VERSION}`,
      ...this.options.headers,
    };
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
    try {
      return await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch (e) {
      throw new FeedbackError(`Could not reach ${this.endpoint}: ${(e as Error).message}`, "network_error");
    }
  }

  /**
   * Look up a service's discovery document at `/.well-known/agent-feedback`.
   * Returns null when the service does not implement the protocol.
   */
  static async discover(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<DiscoveryDocument | null> {
    try {
      const url = new URL(WELL_KNOWN_PATH, baseUrl);
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return null;
      const doc = (await res.json()) as DiscoveryDocument;
      return typeof doc?.endpoint === "string" ? doc : null;
    } catch {
      return null;
    }
  }

  /** Create a client from a service's discovery document, if it has one. */
  static async fromDiscovery(
    baseUrl: string,
    options: Omit<FeedbackClientOptions, "endpoint" | "baseUrl"> = {},
  ): Promise<FeedbackClient | null> {
    const doc = await FeedbackClient.discover(baseUrl, options.fetch);
    return doc ? new FeedbackClient({ ...options, endpoint: new URL(doc.endpoint, baseUrl).toString() }) : null;
  }
}

/** Parse a `Link` header and return the agent-feedback URL, if any. */
export function feedbackUrlFromLink(link: string | null, base: string): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;(.*)/);
    if (m && /rel="?[^";]*\bagent-feedback\b/.test(m[2] ?? "")) return new URL(m[1]!, base).toString();
  }
  return null;
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
