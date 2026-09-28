/**
 * Best-effort removal of secrets and personal data from feedback before it
 * leaves the agent. The protocol forbids sending them; this catches mistakes.
 */

export const REDACTED = "[REDACTED]";

export interface RedactOptions {
  /** Replace email addresses. Default true. */
  emails?: boolean;
  /** Extra patterns to redact. */
  patterns?: RegExp[];
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9\-._~+/]{8,}=*/gi,
  /\bBasic\s+[A-Za-z0-9+/]{8,}=*/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, // JWT
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g, // Anthropic / OpenAI style
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, // Stripe
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /([?&](?:api_?key|access_token|token|secret|password|signature)=)[^&\s"']+/gi,
];

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

const SENSITIVE_KEY =
  /^(?:authorization|cookie|set-cookie|password|passwd|secret|client_secret|api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|token|private[_-]?key|ssn|card[_-]?number|cvv)$/i;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function redactString(input: string, options: RedactOptions = {}): string {
  let out = input;
  for (const pattern of [...SECRET_PATTERNS, ...(options.patterns ?? [])]) {
    out = out.replace(pattern, (match, prefix?: string) =>
      typeof prefix === "string" && match.startsWith(prefix) ? `${prefix}${REDACTED}` : REDACTED,
    );
  }
  out = out.replace(CARD_CANDIDATE, (match) => {
    const digits = match.replace(/[ -]/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? REDACTED : match;
  });
  if (options.emails !== false) out = out.replace(EMAIL, REDACTED);
  return out;
}

/** Recursively redact every string in a JSON value, and the values of sensitive keys. */
export function redact<T>(value: T, options: RedactOptions = {}): T {
  if (typeof value === "string") return redactString(value, options) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, options)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) && v !== null && v !== undefined ? REDACTED : redact(v, options);
    }
    return out as T;
  }
  return value;
}
