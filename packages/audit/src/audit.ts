/**
 * Agent-readiness audit: how usable a public API or MCP server is for AI agents.
 *
 * No dependencies and no imports, on purpose: Backloop's hosted audit runs an
 * exact copy of this file, and a test keeps the two equal.
 */

export type Severity = "critical" | "high" | "medium" | "low";

export interface AuditCheck {
  id: string;
  ok: boolean;
  severity: Severity;
  /** What the audit saw. */
  finding: string;
  /** What to change. Empty when the check passed. */
  fix: string;
}

export interface AuditCategory {
  name: string;
  /** 0-100. */
  score: number;
  checks: AuditCheck[];
}

export interface AuditGap extends AuditCheck {
  category: string;
}

export interface AuditReport {
  url: string;
  kind: "http" | "mcp";
  /** 0-100. */
  score: number;
  categories: AuditCategory[];
  /** The failed checks that cost the most, worst first. */
  top_gaps: AuditGap[];
  /** Things the score doesn't show: auth walls, checks that couldn't run, the time limit. */
  notes: string[];
  /** The MCP server needs credentials; only its public surface was audited. */
  auth_required?: boolean;
  server?: { name?: string; version?: string; protocol_version?: string };
  duration_ms: number;
}

export interface AuditOptions {
  /** Every request goes through it (the hosted audit passes an SSRF-guarded fetch). */
  fetch?: typeof fetch;
  /** Overall budget. Default 20 s. */
  timeoutMs?: number;
}

export class AuditError extends Error {}

export const AUDIT_USER_AGENT = "BackloopAudit/0.1 (+https://trybackloop.com/audit)";

const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 5, high: 3, medium: 2, low: 1 };
const MAX_BODY = 5 * 1024 * 1024;
const REQUEST_TIMEOUT = 8_000;

// ── scoring ─────────────────────────────────────────────────────────────

/** A check while it's being built: `ratio` (0-1) is how much of it passed. */
interface Scored extends AuditCheck {
  ratio: number;
}

function check(id: string, passed: boolean | number, severity: Severity, finding: string, fix: string): Scored {
  const ratio = typeof passed === "number" ? Math.max(0, Math.min(1, passed)) : passed ? 1 : 0;
  const ok = typeof passed === "number" ? ratio >= 0.9 : passed;
  return { id, ok, severity, finding, fix: ok ? "" : fix, ratio };
}

interface Section {
  name: string;
  weight: number;
  checks: Scored[];
}

function finish(url: string, kind: "http" | "mcp", sections: Section[], notes: string[], started: number, extra: Partial<AuditReport> = {}): AuditReport {
  const scored = sections.filter((s) => s.checks.length);
  const categories = scored.map((s) => {
    const total = s.checks.reduce((n, c) => n + SEVERITY_WEIGHT[c.severity], 0);
    const got = s.checks.reduce((n, c) => n + SEVERITY_WEIGHT[c.severity] * c.ratio, 0);
    return { name: s.name, weight: s.weight, score: Math.round((100 * got) / total), checks: s.checks };
  });
  const weights = categories.reduce((n, c) => n + c.weight, 0);
  const score = weights ? Math.round(categories.reduce((n, c) => n + c.weight * c.score, 0) / weights) : 0;
  const gaps = categories
    .flatMap((c) => c.checks.filter((k) => !k.ok).map((k) => ({ category: c.name, cost: SEVERITY_WEIGHT[k.severity] * (1 - k.ratio) * c.weight, k })))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5)
    .map(({ category, k }) => ({ category, ...strip(k) }));
  return {
    url,
    kind,
    score,
    categories: categories.map((c) => ({ name: c.name, score: c.score, checks: c.checks.map(strip) })),
    top_gaps: gaps,
    notes,
    ...extra,
    duration_ms: Date.now() - started,
  };
}

const strip = ({ ratio: _ratio, ...rest }: Scored): AuditCheck => rest;

const pct = (n: number, of: number) => (of ? Math.round((100 * n) / of) : 100);

/** "a, b, c and 4 more" */
function some(names: string[], max = 5): string {
  const shown = names.slice(0, max).map((n) => `\`${n}\``);
  return names.length > max ? `${shown.join(", ")} and ${names.length - max} more` : shown.join(", ");
}

// ── HTTP ────────────────────────────────────────────────────────────────

interface Res {
  status: number;
  headers: Headers;
  text: string;
  /** The URL after redirects. */
  url: string;
}

class Client {
  constructor(
    private fetchImpl: typeof fetch,
    private deadline: AbortSignal,
  ) {}

  get expired() {
    return this.deadline.aborted;
  }

  /** null: the request failed (network, timeout, refused by the fetch). */
  async req(url: string, init: RequestInit = {}): Promise<Res | null> {
    if (this.deadline.aborted) return null;
    const headers = new Headers(init.headers);
    if (!headers.has("user-agent")) headers.set("user-agent", AUDIT_USER_AGENT);
    try {
      const res = await this.fetchImpl(url, {
        ...init,
        headers,
        redirect: "follow",
        signal: AbortSignal.any([this.deadline, AbortSignal.timeout(REQUEST_TIMEOUT)]),
      });
      return { status: res.status, headers: res.headers, text: await readText(res), url: res.url || url };
    } catch {
      return null;
    }
  }

  /** Like req, but the error is kept (the first request tells the person why nothing worked). */
  async first(url: string, init: RequestInit = {}): Promise<Res | Error> {
    const headers = new Headers(init.headers);
    headers.set("user-agent", AUDIT_USER_AGENT);
    try {
      const res = await this.fetchImpl(url, { ...init, headers, signal: AbortSignal.any([this.deadline, AbortSignal.timeout(REQUEST_TIMEOUT)]) });
      return { status: res.status, headers: res.headers, text: await readText(res), url: res.url || url };
    } catch (e) {
      return e as Error;
    }
  }
}

async function readText(res: Response, max = MAX_BODY): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (size >= max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return out + decoder.decode();
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const isHtml = (r: Res) => /text\/html/i.test(r.headers.get("content-type") ?? "") || /^\s*<(!doctype|html)/i.test(r.text);
const ok2xx = (r: Res | null): r is Res => !!r && r.status >= 200 && r.status < 300;

function hasFeedbackLink(r: Res | null) {
  const link = r?.headers.get("link") ?? "";
  return /rel\s*=\s*"?[^";]*\bagent-feedback\b/i.test(link);
}

/** Join a path onto a base, keeping the base's path (https://x.com/v1 + /llms.txt → https://x.com/v1/llms.txt). */
function under(base: URL, path: string) {
  const u = new URL(base);
  u.search = "";
  u.hash = "";
  u.pathname = u.pathname.replace(/\/+$/, "") + path;
  return u.toString();
}
const atRoot = (base: URL, path: string) => new URL(path, base.origin).toString();

interface OpenApiStats {
  ops: number;
  opsDescribed: number;
  undescribedOps: string[];
  params: number;
  paramsDescribed: number;
  undescribedParams: string[];
  /** A GET operation with no path parameters, to probe for error quality. */
  probe?: string;
  feedback: boolean;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");

function openApiStats(doc: Obj, base: URL): OpenApiStats {
  const deref = (v: unknown): Obj | undefined => {
    let o = obj(v);
    for (let i = 0; o && typeof o.$ref === "string" && i < 5; i++) {
      const ref = o.$ref as string;
      if (!ref.startsWith("#/")) return o;
      o = obj(ref.slice(2).split("/").reduce<unknown>((at, key) => obj(at)?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], doc));
    }
    return o;
  };
  const stats: OpenApiStats = { ops: 0, opsDescribed: 0, undescribedOps: [], params: 0, paramsDescribed: 0, undescribedParams: [], feedback: false };
  const methods = ["get", "put", "post", "delete", "patch", "options", "head"];
  for (const [path, rawItem] of Object.entries(obj(doc.paths) ?? {})) {
    const item = deref(rawItem);
    if (!item) continue;
    if (/\/feedback\/?$/.test(path)) stats.feedback = true;
    for (const method of methods) {
      const op = obj(item[method]);
      if (!op) continue;
      const label = `${method.toUpperCase()} ${path}`;
      stats.ops++;
      if (str(op.summary) || str(op.description)) stats.opsDescribed++;
      else stats.undescribedOps.push(label);
      if (method === "get" && !path.includes("{") && !stats.probe) stats.probe = path;
      const params = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])];
      for (const raw of params) {
        const p = deref(raw);
        if (!p || p.in === "body") continue;
        stats.params++;
        if (str(p.description) || str(deref(p.schema)?.description)) stats.paramsDescribed++;
        else stats.undescribedParams.push(`${label} ${str(p.name) || "?"}`);
      }
      // Request body fields (OpenAPI 3) or the body parameter (Swagger 2), one level deep.
      const bodyParam = params.map(deref).find((p) => p?.in === "body");
      const content = obj(deref(op.requestBody)?.content);
      const schema = deref(bodyParam?.schema ?? obj(content?.["application/json"])?.schema ?? obj(Object.values(content ?? {})[0])?.schema);
      for (const [name, rawProp] of Object.entries(obj(schema?.properties) ?? {})) {
        const prop = deref(rawProp);
        stats.params++;
        if (str(prop?.description)) stats.paramsDescribed++;
        else stats.undescribedParams.push(`${label} body.${name}`);
      }
    }
  }
  // Probe under the API's server URL when it lives on the audited host.
  if (stats.probe) {
    const servers = Array.isArray(doc.servers) ? doc.servers : [];
    let prefix = str(obj(servers[0])?.url) || str(doc.basePath);
    try {
      const u = new URL(prefix, base.origin);
      prefix = u.host === base.host ? u.pathname.replace(/\/+$/, "") : "";
    } catch {
      prefix = "";
    }
    stats.probe = new URL(prefix + stats.probe, base.origin).toString();
  }
  return stats;
}

/** Does the group for every user agent (`User-agent: *`) disallow the whole site? */
function robotsBlocksAll(text: string): boolean {
  let agents: string[] = [];
  let inRules = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [key, value] = [m[1]!.toLowerCase(), m[2]!.trim()];
    if (key === "user-agent") {
      if (inRules) agents = [];
      inRules = false;
      agents.push(value);
    } else {
      inRules = true;
      if (key === "disallow" && value === "/" && agents.includes("*")) return true;
    }
  }
  return false;
}

/** A message-like field in an error body. */
function errorMessage(body: unknown): string {
  const o = obj(body);
  if (!o) return "";
  for (const key of ["message", "detail", "error_description", "title", "error", "errors"]) {
    const v = o[key];
    if (str(v)) return str(v);
    const inner = obj(v) ?? obj(Array.isArray(v) ? v[0] : undefined);
    if (inner) {
      const m = errorMessage(inner);
      if (m) return m;
    }
  }
  return "";
}

async function auditHttp(base: URL, client: Client, notes: string[]): Promise<Section[]> {
  const bogusPath = `backloop-audit-${Math.random().toString(36).slice(2, 10)}`;
  const bogusParam = "backloop_audit_bogus";
  const jsonHeaders = { accept: "application/json" };
  const specPaths = ["/openapi.json", "/openapi.yaml", "/openapi.yml", "/.well-known/openapi", "/.well-known/openapi.json", "/swagger.json"];
  const specUrls = [...new Set([...specPaths.map((p) => under(base, p)), ...specPaths.map((p) => atRoot(base, p))])];

  const [discovery, llms, robots, bogus, ...specs] = await Promise.all([
    client.req(atRoot(base, "/.well-known/agent-feedback"), { headers: jsonHeaders }),
    client.req(atRoot(base, "/llms.txt")),
    client.req(atRoot(base, "/robots.txt")),
    client.req(under(base, `/${bogusPath}`), { headers: jsonHeaders }),
    ...specUrls.map((u) => client.req(u, { headers: { accept: "application/json, application/yaml;q=0.9, */*;q=0.5" } })),
  ]);

  // OpenAPI: the first candidate that parses as a spec.
  let spec: { url: string; doc?: Obj; yaml?: boolean } | undefined;
  for (const [i, r] of specs.entries()) {
    if (!ok2xx(r) || isHtml(r)) continue;
    const doc = obj(json(r.text));
    if (doc && (str(doc.openapi) || str(doc.swagger)) && obj(doc.paths)) {
      spec = { url: specUrls[i]!, doc };
      break;
    }
    if (!doc && /^\s*(openapi|swagger)\s*:/m.test(r.text) && /^\s*paths\s*:/m.test(r.text)) spec ??= { url: specUrls[i]!, yaml: true };
  }
  const stats = spec?.doc ? openApiStats(spec.doc, base) : undefined;

  // AFP: discovery, then the endpoint it names (or /feedback).
  const disc = ok2xx(discovery) && !isHtml(discovery) ? obj(json(discovery.text)) : undefined;
  let feedbackUrl = under(base, "/feedback");
  if (str(disc?.endpoint)) {
    try {
      feedbackUrl = new URL(str(disc!.endpoint), base).toString();
    } catch {
      /* keep the default */
    }
  }
  // An empty body is invalid AFP feedback, so nothing gets recorded: a 4xx means the endpoint is there.
  const probeUrl = stats?.probe ?? base.toString();
  const withParam = new URL(probeUrl);
  withParam.searchParams.set(bogusParam, "1");
  const [feedback, param] = await Promise.all([
    client.req(feedbackUrl, { method: "POST", headers: { "content-type": "application/json", ...jsonHeaders }, body: "{}" }),
    client.req(withParam.toString(), { headers: jsonHeaders }),
  ]);

  // ── Agent Feedback Protocol
  const afp: Scored[] = [];
  afp.push(
    check(
      "afp.discovery",
      !!disc && !!str(disc.endpoint),
      "high",
      disc
        ? str(disc.endpoint)
          ? `/.well-known/agent-feedback advertises ${str(disc.endpoint)}.`
          : "/.well-known/agent-feedback is JSON but has no `endpoint`."
        : "No discovery document at /.well-known/agent-feedback.",
      'Serve /.well-known/agent-feedback: {"spec_version":"0.1","endpoint":"https://…/feedback","auth":"optional"} (Agent Feedback Protocol §2).',
    ),
  );
  const feedbackThere = !!feedback && ![404, 405, 501].includes(feedback.status) && feedback.status < 500 && !(ok2xx(feedback) && isHtml(feedback));
  afp.push(
    check(
      "afp.endpoint",
      feedbackThere,
      "high",
      feedbackThere
        ? `POST ${new URL(feedbackUrl).pathname} answers (${feedback!.status} to an empty body).`
        : `No feedback endpoint: POST ${new URL(feedbackUrl).pathname} ${feedback ? `returned ${feedback.status}` : "failed"}. Agents that hit a wall have nowhere to say so.`,
      "Accept POST /feedback with the Agent Feedback Protocol body (@backloop/sdk does it in a few lines), so agents can report what blocked them.",
    ),
  );
  afp.push(
    check(
      "afp.error_link",
      hasFeedbackLink(bogus),
      "medium",
      hasFeedbackLink(bogus)
        ? "Error responses carry `Link: </feedback>; rel=\"agent-feedback\"`."
        : "Error responses have no `Link: </feedback>; rel=\"agent-feedback\"` header, so an agent that fails isn't told where to report it.",
      'Add `Link: </feedback>; rel="agent-feedback"` to every 4xx and 5xx response.',
    ),
  );

  // ── Documentation for agents
  const docs: Scored[] = [];
  const llmsOk = ok2xx(llms) && !isHtml(llms) && llms.text.trim().length > 20;
  docs.push(
    check(
      "docs.llms_txt",
      llmsOk,
      "medium",
      llmsOk ? `/llms.txt is there (${llms!.text.length.toLocaleString("en-US")} characters).` : "No /llms.txt.",
      "Publish /llms.txt: a Markdown index of your docs written for models (what the API does, auth, the main endpoints, links to full pages).",
    ),
  );
  docs.push(
    check(
      "docs.openapi",
      !!spec,
      "high",
      spec ? `OpenAPI found at ${new URL(spec.url).pathname}.` : `No OpenAPI description at ${specPaths.join(", ")}.`,
      "Serve your OpenAPI description at /openapi.json: agents and their tool builders read it to learn every endpoint and parameter.",
    ),
  );
  if (stats) {
    docs.push(
      check(
        "docs.operations_described",
        stats.ops ? stats.opsDescribed / stats.ops : 0,
        "medium",
        stats.ops
          ? `${pct(stats.opsDescribed, stats.ops)}% of ${stats.ops} operations have a summary or description.${stats.undescribedOps.length ? ` Missing: ${some(stats.undescribedOps)}.` : ""}`
          : "The OpenAPI description lists no operations.",
        "Give every operation a summary and a description that says when to use it and what it returns.",
      ),
    );
    docs.push(
      check(
        "docs.parameters_described",
        stats.params ? stats.paramsDescribed / stats.params : 1,
        "medium",
        stats.params
          ? `${pct(stats.paramsDescribed, stats.params)}% of ${stats.params} parameters and body fields are described.${stats.undescribedParams.length ? ` Missing: ${some(stats.undescribedParams)}.` : ""}`
          : "No parameters to describe.",
        "Describe every parameter and body field: its format, its units, its allowed values and an example.",
      ),
    );
  } else if (spec?.yaml) {
    notes.push(`The OpenAPI description at ${new URL(spec.url).pathname} is YAML: its description coverage wasn't measured. Serve /openapi.json too.`);
  }

  // ── Error quality
  const errors: Scored[] = [];
  if (bogus) {
    const body = json(bogus.text);
    const notFound = bogus.status >= 400 && bogus.status < 500;
    errors.push(
      check(
        "errors.status",
        notFound,
        "medium",
        notFound ? `An unknown path returns ${bogus.status}.` : `An unknown path returns ${bogus.status}${ok2xx(bogus) ? ", so agents can't tell a wrong URL from a success" : ""}.`,
        "Return 404 for unknown paths, never 200.",
      ),
    );
    errors.push(
      check(
        "errors.json",
        body !== undefined && !isHtml(bogus),
        "high",
        body !== undefined ? "Errors come back as JSON." : `Errors come back as ${isHtml(bogus) ? "an HTML page" : (bogus.headers.get("content-type") ?? "untyped text")}, which an agent has to guess at.`,
        "Return errors as JSON (application/problem+json works), even for unknown paths and when the client sends Accept: application/json.",
      ),
    );
    const message = errorMessage(body);
    errors.push(
      check(
        "errors.message",
        message.length >= 10,
        "medium",
        message.length >= 10 ? `Error bodies carry a message: "${message.slice(0, 80)}".` : "Error bodies have no readable message field.",
        "Put a sentence in `message` (or `detail`) that says what went wrong and what to do instead.",
      ),
    );
  }
  if (param && param.status !== 401 && param.status !== 403) {
    const named = param.status >= 400 && param.status < 500 && param.text.includes(bogusParam);
    const path = new URL(probeUrl).pathname;
    const accepted = param.status >= 200 && param.status < 300;
    errors.push(
      check(
        "errors.names_field",
        named,
        accepted ? "low" : "medium",
        named
          ? `An unknown query parameter on ${path} is rejected and the error names it.`
          : accepted
            ? `An unknown query parameter on ${path} is silently ignored: a typo in a filter returns unfiltered data.`
            : `An unknown query parameter on ${path} returns ${param.status}, but the error doesn't name the parameter.`,
        "Reject unknown or invalid parameters with a 400 whose message names the field and lists the valid ones.",
      ),
    );
  } else if (param) {
    notes.push(`Parameter errors weren't tested: ${new URL(probeUrl).pathname} needs credentials (${param.status}).`);
  }

  // ── Crawling policy
  const policy: Scored[] = [];
  const robotsText = ok2xx(robots) && !isHtml(robots) ? robots.text : "";
  const signal = robotsText.match(/^\s*content-signal\s*:\s*(.+)$/im)?.[1]?.trim();
  policy.push(
    check(
      "robots.content_signal",
      !!signal,
      "low",
      signal ? `robots.txt sets Content-Signal: ${signal}.` : robotsText ? "robots.txt has no Content-Signal line." : "No robots.txt.",
      "Add a Content-Signal line to robots.txt (for example `Content-Signal: search=yes, ai-input=yes, ai-train=no`) so agents know what they may do with your content.",
    ),
  );
  if (robotsText) {
    const blocksAll = robotsBlocksAll(robotsText);
    policy.push(
      check(
        "robots.open",
        !blocksAll,
        "low",
        blocksAll ? "robots.txt disallows everything for every user agent, agents included." : "robots.txt doesn't shut agents out.",
        "Allow agents to read your docs and API reference in robots.txt, even if you block training crawlers by name.",
      ),
    );
  }

  if (stats?.feedback && !feedbackThere) notes.push("The OpenAPI description lists a /feedback path, but it didn't answer.");
  return [
    { name: "Agent Feedback Protocol", weight: 25, checks: afp },
    { name: "Documentation for agents", weight: 35, checks: docs },
    { name: "Error quality", weight: 30, checks: errors },
    { name: "Crawling policy", weight: 10, checks: policy },
  ];
}

// ── MCP (Streamable HTTP, by hand) ──────────────────────────────────────

const PROTOCOL_VERSION = "2025-06-18";

interface RpcReply {
  status: number;
  headers: Headers;
  message?: Obj;
}

class Mcp {
  session?: string;
  protocol = PROTOCOL_VERSION;
  private nextId = 1;

  constructor(
    private fetchImpl: typeof fetch,
    private deadline: AbortSignal,
    readonly url: string,
  ) {}

  private headers(): Headers {
    const h = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": AUDIT_USER_AGENT });
    if (this.session) h.set("mcp-session-id", this.session);
    if (this.nextId > 2) h.set("mcp-protocol-version", this.protocol);
    return h;
  }

  /** One JSON-RPC request; the reply may be JSON or an SSE stream. null: the request failed. */
  async call(method: string, params: Obj = {}): Promise<RpcReply | null> {
    const id = this.nextId++;
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.any([this.deadline, AbortSignal.timeout(REQUEST_TIMEOUT)]),
      });
    } catch {
      return null;
    }
    const type = res.headers.get("content-type") ?? "";
    try {
      if (/text\/event-stream/i.test(type)) return { status: res.status, headers: res.headers, message: await readSse(res, id) };
      const body = json(await readText(res));
      const message = Array.isArray(body) ? body.map(obj).find((m) => m?.id === id) : obj(body);
      return { status: res.status, headers: res.headers, message: message?.jsonrpc === "2.0" ? message : undefined };
    } catch {
      return { status: res.status, headers: res.headers };
    }
  }

  async notify(method: string) {
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: "2.0", method }),
        signal: AbortSignal.any([this.deadline, AbortSignal.timeout(REQUEST_TIMEOUT)]),
      });
      await res.body?.cancel().catch(() => {});
    } catch {
      /* a notification's answer doesn't matter */
    }
  }

  async close() {
    if (!this.session) return;
    try {
      const res = await this.fetchImpl(this.url, { method: "DELETE", headers: this.headers(), signal: AbortSignal.timeout(2_000) });
      await res.body?.cancel().catch(() => {});
    } catch {
      /* best effort */
    }
  }
}

/** Read an SSE stream until the JSON-RPC response with this id. */
async function readSse(res: Response, id: number): Promise<Obj | undefined> {
  if (!res.body) return undefined;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        size += value.byteLength;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      }
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0 || (done && buffer.trim() && (cut = buffer.length) >= 0)) {
        const event = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = event
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        const message = obj(json(data));
        if (message && message.id === id && ("result" in message || "error" in message)) return message;
        if (done) break;
      }
      if (done || size > MAX_BODY) return undefined;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

interface Tool {
  name: string;
  description?: string;
  inputSchema?: Obj;
  annotations?: Obj;
}

const VAGUE = /\b(stuff|things?|various|misc(ellaneous)?|etc\.?|helper|utility|generic|general[- ]purpose|handles?|manages?|does)\b/i;
const CONSTRAINED_NAME = /^(sort|sort_?by|order|order_?by|direction|dir|status|state|kind|mode|format|unit|units|currency|visibility|priority|level|granularity|interval|period|method)$/i;
const CONSTRAINED_TEXT = /\b(one of|either|must be (one of|either)|allowed values?|valid values?|possible values?|options are|can be (one of|either))\b|(["'`][\w-]+["'`]\s*(,|\/|\||or)\s*){1,}["'`][\w-]+["'`]/i;

function auditTools(tools: Tool[], instructions: string): Section[] {
  const server: Scored[] = [];
  server.push(
    check(
      "server.instructions",
      instructions.length >= 20,
      "medium",
      instructions.length >= 20 ? `The server sends instructions (${instructions.length} characters).` : instructions ? "The server's instructions are a few words." : "The server sends no instructions on initialize.",
      "Return `instructions` from initialize: what the server is for, the order tools are used in, auth and limits. Clients put it in the model's context.",
    ),
  );
  const n = tools.length;
  server.push(
    check(
      "server.tool_count",
      n === 0 ? 0 : n <= 40 ? 1 : Math.max(0, 1 - (n - 40) / 80),
      n === 0 ? "critical" : n > 80 ? "high" : "medium",
      n === 0 ? "tools/list returned no tools." : n <= 40 ? `${n} tool${n === 1 ? "" : "s"}.` : `${n} tools: past about 40, models pick the wrong one more often and the list eats context.`,
      n === 0 ? "Expose your capabilities as tools." : "Merge close tools (one search tool with filters, not one per field) or split them across servers by job.",
    ),
  );

  const describe: Scored[] = [];
  const short = tools.filter((t) => str(t.description).length < 40).map((t) => t.name);
  describe.push(
    check(
      "tools.description_length",
      n ? (n - short.length) / n : 0,
      "high",
      short.length ? `${short.length} of ${n} tools have a description under 40 characters: ${some(short)}.` : "Every tool has a description of 40 characters or more.",
      "Say in each description what the tool does, when to use it instead of its neighbours, and what it returns.",
    ),
  );
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const vague = tools
    .filter((t) => {
      const d = str(t.description);
      return d && (VAGUE.test(d) || words(d) === words(t.name));
    })
    .map((t) => t.name);
  describe.push(
    check(
      "tools.description_vague",
      n ? (n - vague.length) / n : 0,
      "medium",
      vague.length ? `${vague.length} tool${vague.length === 1 ? "" : "s"} use vague wording ("handles", "manages", "various", "etc.") or repeat the name: ${some(vague)}.` : "No vague tool descriptions.",
      "Replace vague verbs with the exact action and object: \"Creates a refund for a captured payment\", not \"Handles payments\".",
    ),
  );

  const params: Scored[] = [];
  const all: Array<{ tool: string; name: string; schema: Obj }> = [];
  for (const t of tools) {
    const props = obj(obj(t.inputSchema)?.properties) ?? {};
    for (const [name, raw] of Object.entries(props)) {
      const schema = obj(raw) ?? {};
      all.push({ tool: t.name, name, schema });
      // One level into object parameters.
      for (const [inner, rawInner] of Object.entries(obj(schema.properties) ?? {})) all.push({ tool: t.name, name: `${name}.${inner}`, schema: obj(rawInner) ?? {} });
    }
  }
  const undescribed = all.filter((p) => !str(p.schema.description)).map((p) => `${p.tool}.${p.name}`);
  params.push(
    check(
      "params.described",
      all.length ? (all.length - undescribed.length) / all.length : 1,
      "high",
      all.length
        ? undescribed.length
          ? `${undescribed.length} of ${all.length} parameters have no description: ${some(undescribed)}.`
          : `All ${all.length} parameters are described.`
        : "No tool takes parameters.",
      "Describe every parameter: its format, units, an example, and what happens when it's left out.",
    ),
  );
  const isString = (s: Obj) => s.type === "string" || (Array.isArray(s.type) && s.type.includes("string"));
  const strings = all.filter((p) => isString(p.schema));
  const free = strings
    .filter((p) => !p.schema.enum && p.schema.const === undefined && !p.schema.oneOf && !p.schema.anyOf && !p.schema.format && !p.schema.pattern)
    .filter((p) => CONSTRAINED_NAME.test(p.name.split(".").pop()!) || CONSTRAINED_TEXT.test(str(p.schema.description)))
    .map((p) => `${p.tool}.${p.name}`);
  params.push(
    check(
      "params.enums",
      strings.length ? 1 - free.length / strings.length : 1,
      "medium",
      free.length ? `${free.length} string parameter${free.length === 1 ? " looks" : "s look"} constrained but ${free.length === 1 ? "is" : "are"} free text: ${some(free)}.` : "Constrained values use enums.",
      "Declare an `enum` for parameters with a fixed set of values, so the model can't invent one.",
    ),
  );

  const hints: Scored[] = [];
  const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
  const bare = tools.filter((t) => !HINTS.some((h) => typeof obj(t.annotations)?.[h] === "boolean")).map((t) => t.name);
  hints.push(
    check(
      "tools.annotations",
      n ? (n - bare.length) / n : 0,
      "medium",
      bare.length ? `${bare.length} of ${n} tools have no annotations (readOnlyHint, destructiveHint…): ${some(bare)}.` : "Every tool is annotated.",
      "Set `readOnlyHint`, `destructiveHint` and `idempotentHint` on every tool: clients use them to decide what runs without asking.",
    ),
  );

  const feedback: Scored[] = [];
  const has = tools.some((t) => t.name === "submit_feedback" || /(^|[._-])submit_feedback$/.test(t.name));
  feedback.push(
    check(
      "feedback.submit_feedback",
      has,
      "high",
      has ? "A `submit_feedback` tool is there." : "No `submit_feedback` tool: when an agent can't do what it came for, you never hear about it.",
      "Add the Agent Feedback Protocol's `submit_feedback` tool (registerFeedbackTool from @backloop/mcp) and its server instructions.",
    ),
  );

  return [
    { name: "Server", weight: 15, checks: server },
    { name: "Tool descriptions", weight: 30, checks: describe },
    { name: "Parameters", weight: 30, checks: params },
    { name: "Safety hints", weight: 10, checks: hints },
    { name: "Agent feedback", weight: 15, checks: feedback },
  ];
}

/** Try initialize. Returns the session, "auth" for a 401 that looks like MCP, or null: not an MCP server. */
async function detectMcp(fetchImpl: typeof fetch, deadline: AbortSignal, url: string, guessed: boolean) {
  const mcp = new Mcp(fetchImpl, deadline, url);
  const reply = await mcp.call("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "backloop-audit", version: "0.1.0" } });
  if (!reply) return null;
  const result = obj(reply.message?.result);
  if (result && (str(result.protocolVersion) || obj(result.serverInfo))) {
    mcp.session = reply.headers.get("mcp-session-id") ?? undefined;
    mcp.protocol = str(result.protocolVersion) || PROTOCOL_VERSION;
    return { mcp, result, reply };
  }
  if (reply.status === 401) {
    const www = reply.headers.get("www-authenticate") ?? "";
    // MCP's auth spec points at the protected resource metadata; a typed /mcp URL is MCP too.
    if (/resource_metadata/i.test(www) || (!guessed && /mcp|sse/i.test(new URL(url).pathname))) return { auth: www as string };
  }
  return null;
}

async function auditMcpAuth(url: URL, www: string, client: Client, notes: string[]): Promise<Section[]> {
  notes.push("Auth required; audited the public surface only. Tools, descriptions and parameters need a signed-in session.");
  const metaUrl = www.match(/resource_metadata\s*=\s*"?([^",\s]+)"?/i)?.[1];
  const candidates = [metaUrl, atRoot(url, `/.well-known/oauth-protected-resource${url.pathname.replace(/\/+$/, "")}`), atRoot(url, "/.well-known/oauth-protected-resource")].filter(
    (u): u is string => !!u,
  );
  let meta: Obj | undefined;
  for (const u of [...new Set(candidates)]) {
    let target: string;
    try {
      target = new URL(u, url).toString();
    } catch {
      continue;
    }
    const r = await client.req(target, { headers: { accept: "application/json" } });
    meta = ok2xx(r) ? obj(json(r.text)) : undefined;
    if (meta) break;
  }
  const servers = Array.isArray(meta?.authorization_servers) ? (meta!.authorization_servers as unknown[]).filter(str) : [];
  return [
    {
      name: "Auth discovery",
      weight: 100,
      checks: [
        check(
          "auth.www_authenticate",
          /resource_metadata/i.test(www),
          "high",
          /resource_metadata/i.test(www) ? "The 401 points at the protected resource metadata." : "The 401 has no `resource_metadata` in WWW-Authenticate, so a client can't find where to sign in.",
          'Answer 401 with `WWW-Authenticate: Bearer resource_metadata="https://…/.well-known/oauth-protected-resource"` (MCP authorization spec).',
        ),
        check(
          "auth.protected_resource",
          servers.length > 0,
          "high",
          servers.length ? `Protected resource metadata names ${servers.length} authorization server${servers.length === 1 ? "" : "s"}.` : "No OAuth protected resource metadata with `authorization_servers`.",
          "Serve /.well-known/oauth-protected-resource (RFC 9728) listing your authorization server, so MCP clients can sign agents in without manual setup.",
        ),
      ],
    },
  ];
}

// ── entry point ─────────────────────────────────────────────────────────

/** Normalize what a person typed: add https://, drop the fragment. */
export function normalizeTarget(input: string): URL {
  const raw = input.trim();
  if (!raw) throw new AuditError("Enter the URL of an API or MCP server.");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new AuditError(`That isn't a URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new AuditError("Only http and https URLs can be audited.");
  url.hash = "";
  return url;
}

/** Audit a public API or MCP server for agent readiness. */
export async function audit(input: string, options: AuditOptions = {}): Promise<AuditReport> {
  const started = Date.now();
  const fetchImpl = options.fetch ?? fetch;
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const url = normalizeTarget(input);
  const notes: string[] = [];
  const client = new Client(fetchImpl, deadline);

  // MCP first: at the URL itself, then at /mcp when only a host was given.
  let found = await detectMcp(fetchImpl, deadline, url.toString(), false);
  if (!found && (url.pathname === "/" || url.pathname === "")) found = await detectMcp(fetchImpl, deadline, atRoot(url, "/mcp"), true);

  if (found && "auth" in found) {
    const sections = await auditMcpAuth(url, found.auth ?? "", client, notes);
    return finish(url.toString(), "mcp", sections, notes, started, { auth_required: true });
  }
  if (found) {
    const { mcp, result } = found;
    const server = obj(result.serverInfo);
    await mcp.notify("notifications/initialized");
    const tools: Tool[] = [];
    let cursor: string | undefined;
    let authWall = false;
    for (let page = 0; page < 10; page++) {
      const reply = await mcp.call("tools/list", cursor ? { cursor } : {});
      if (!reply || reply.status === 401 || reply.status === 403 || !reply.message || reply.message.error) {
        if (reply?.status === 401 || reply?.status === 403) authWall = true;
        else if (page === 0) notes.push(`tools/list failed${reply?.message?.error ? `: ${str(obj(reply.message.error)?.message) || "error"}` : ""}.`);
        break;
      }
      const res = obj(reply.message.result);
      for (const t of Array.isArray(res?.tools) ? res!.tools : []) {
        const tool = obj(t);
        if (tool && str(tool.name)) tools.push({ name: str(tool.name), description: str(tool.description), inputSchema: obj(tool.inputSchema), annotations: obj(tool.annotations) });
      }
      cursor = str(res?.nextCursor) || undefined;
      if (!cursor) break;
    }
    await mcp.close();
    const extra: Partial<AuditReport> = {
      server: { name: str(server?.name) || undefined, version: str(server?.version) || undefined, protocol_version: mcp.protocol },
    };
    if (authWall) {
      notes.push("Auth required; audited the public surface only. initialize answered without credentials, tools/list didn't.");
      extra.auth_required = true;
    }
    if (deadline.aborted) notes.push("The audit hit its time limit; some checks didn't run.");
    const sections = auditTools(tools, str(result.instructions));
    if (authWall) sections.splice(1); // without tools, only the server's instructions can be judged
    if (authWall) sections[0]!.checks = sections[0]!.checks.filter((c) => c.id !== "server.tool_count");
    return finish(mcp.url, "mcp", sections, notes, started, extra);
  }

  const first = await client.first(url.toString(), { headers: { accept: "application/json" } });
  if (first instanceof Error) {
    const reason = (first.cause as Error | undefined)?.message || first.message;
    throw new AuditError(`Couldn't reach ${url.host}: ${reason}`);
  }
  const sections = await auditHttp(url, client, notes);
  if (deadline.aborted) notes.push("The audit hit its time limit; some checks didn't run.");
  return finish(url.toString(), "http", sections, notes, started);
}
