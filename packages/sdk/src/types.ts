export const SPEC_VERSION = "0.1";

export const FEEDBACK_TYPES = [
  "missing_capability",
  "bug",
  "unclear_documentation",
  "unexpected_response",
  "unhelpful_error",
  "performance",
  "other",
] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export const OUTCOMES = ["blocked", "degraded", "completed"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export interface AgentInfo {
  name?: string;
  version?: string;
  model?: string;
  framework?: string;
}

export interface Evidence {
  status_code?: number;
  request?: Record<string, unknown>;
  response_excerpt?: string;
}

/** What an agent sends to `POST /feedback`. See spec/feedback.schema.json. */
export interface FeedbackSubmission {
  spec_version?: typeof SPEC_VERSION;
  type: FeedbackType;
  goal: string;
  message: string;
  endpoint?: string;
  method?: HttpMethod;
  outcome?: Outcome;
  workaround?: boolean;
  workaround_description?: string;
  expected?: string;
  suggestion?: string;
  request_id?: string;
  session_id?: string;
  agent?: AgentInfo;
  evidence?: Evidence;
  metadata?: Record<string, unknown>;
}

export type FeedbackSource = "http" | "mcp" | "sdk" | "other";

/** A submission after a service accepted it. See spec/record.schema.json. */
export interface FeedbackRecord {
  id: string;
  received_at: string;
  service?: string;
  account?: string;
  source?: FeedbackSource;
  feedback: FeedbackSubmission;
}

export type KnownIssueStatus = "acknowledged" | "planned" | "in_progress" | "fixed" | "wont_fix";

export interface KnownIssue {
  id: string;
  title: string;
  status: KnownIssueStatus;
  url?: string;
  workaround?: string;
}

/** Body of a `202` response. See spec/ack.schema.json. */
export interface FeedbackAck {
  id: string;
  status: "accepted";
  received_at: string;
  known_issue?: KnownIssue;
}

export type FeedbackErrorCode =
  | "invalid_json"
  | "invalid_feedback"
  | "unauthorized"
  | "payload_too_large"
  | "unsupported_media_type"
  | "rate_limited"
  | "method_not_allowed"
  | "unavailable";

export interface ValidationIssue {
  /** Dot path to the offending field; "" for the root object. */
  path: string;
  message: string;
}

export interface ErrorBody {
  error: {
    code: FeedbackErrorCode;
    message: string;
    details?: ValidationIssue[];
  };
}

export type AuthMode = "none" | "optional" | "required";

/** Served at `GET /.well-known/agent-feedback`. */
export interface DiscoveryDocument {
  spec_version: typeof SPEC_VERSION;
  endpoint: string;
  types: readonly FeedbackType[];
  max_bytes: number;
  auth: AuthMode;
}

/** Collector ingestion: `POST /v1/records`. */
export interface IngestRequest {
  records: FeedbackRecord[];
}

export interface IngestResult {
  id: string;
  status: "accepted" | "duplicate" | "rejected";
  known_issue?: KnownIssue;
  error?: { code: string; message: string; details?: ValidationIssue[] };
}

export interface IngestResponse {
  results: IngestResult[];
}

export const DEFAULT_MAX_BYTES = 16_384;
export const WELL_KNOWN_PATH = "/.well-known/agent-feedback";
export const LINK_REL = "agent-feedback";
