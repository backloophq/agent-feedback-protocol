import {
  FEEDBACK_TYPES,
  createFeedbackHandler,
  errorResponse,
  formatIssues,
  forwardTo,
  validateRecord,
  type AuthMode,
  type FeedbackRecord,
  type FeedbackType,
  type IngestResult,
  type OnRecordResult,
} from "@backloop/sdk";
import { Hono } from "hono";
import { JsonlStore } from "./store.js";

export { JsonlStore, type RecordQuery, type Summary } from "./store.js";

export interface CollectorOptions {
  /** JSONL file to persist records to. In-memory when unset. */
  dataFile?: string;
  /** Keys accepted on `POST /v1/records` (services forwarding records). Empty = open. */
  ingestKeys?: string[];
  /** Keys accepted on the read API (`GET /v1/records`, `/v1/summary`). Empty = open. */
  adminKeys?: string[];
  /** Service name for feedback submitted directly to this collector's `/feedback`. */
  service?: string;
  /** Auth mode for the public `/feedback` endpoint. */
  auth?: AuthMode;
  /** Forward every accepted record to another collector or the hosted platform. */
  forward?: { url: string; ingestKey?: string };
}

const bearer = (header: string | undefined) => header?.match(/^Bearer\s+(.+)$/i)?.[1];

/**
 * The reference collector: a public `/feedback` endpoint for agents, an
 * ingestion API for services, and a small read API. Returns a Hono app;
 * run it with `@hono/node-server`, Bun, Deno or any Fetch-API runtime.
 */
export function createCollector(options: CollectorOptions = {}) {
  const store = new JsonlStore(options.dataFile);
  const forward = options.forward ? forwardTo(options.forward) : undefined;

  async function accept(record: FeedbackRecord): Promise<IngestResult> {
    const status = store.add(record);
    let known: OnRecordResult;
    if (status === "accepted" && forward) {
      try {
        known = await forward(record);
      } catch (e) {
        console.error(`[collector] forwarding ${record.id} failed: ${(e as Error).message}`);
      }
    }
    return { id: record.id, status, ...(known?.known_issue ? { known_issue: known.known_issue } : {}) };
  }

  const feedback = createFeedbackHandler({
    service: options.service,
    auth: options.auth ?? "none",
    onRecord: async (record) => {
      const result = await accept(record);
      return result.known_issue ? { known_issue: result.known_issue } : undefined;
    },
  });

  const allowed = (keys: string[] | undefined, header: string | undefined) =>
    !keys?.length || keys.includes(bearer(header) ?? "");

  const app = new Hono();

  app.get("/", (c) => c.json({ name: "backloop-collector", spec_version: "0.1", records: store.summary().total }));
  app.get("/healthz", (c) => c.text("ok"));

  // Agent-facing protocol endpoints.
  app.get("/.well-known/agent-feedback", (c) => feedback.discovery(c.req.raw));
  app.post("/feedback", (c) => feedback.submit(c.req.raw));

  // Service-facing ingestion.
  app.post("/v1/records", async (c) => {
    if (!allowed(options.ingestKeys, c.req.header("authorization"))) {
      return errorResponse(401, "unauthorized", "Invalid ingest key");
    }
    let body: { records?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(400, "invalid_json", "Body is not valid JSON");
    }
    if (!Array.isArray(body?.records) || body.records.length < 1 || body.records.length > 100) {
      return errorResponse(400, "invalid_feedback", "Body must be { records: [...] } with 1 to 100 records");
    }
    const results: IngestResult[] = [];
    for (const raw of body.records) {
      const v = validateRecord(raw);
      if (!v.valid) {
        const id = typeof (raw as { id?: unknown })?.id === "string" ? (raw as { id: string }).id : "";
        results.push({
          id,
          status: "rejected",
          error: { code: "invalid_feedback", message: formatIssues(v.issues), details: v.issues },
        });
        continue;
      }
      results.push(await accept(v.value));
    }
    return c.json({ results });
  });

  // Read API.
  app.get("/v1/records", (c) => {
    if (!allowed(options.adminKeys, c.req.header("authorization"))) return errorResponse(401, "unauthorized", "Invalid admin key");
    const type = c.req.query("type");
    if (type && !FEEDBACK_TYPES.includes(type as FeedbackType)) {
      return errorResponse(400, "invalid_feedback", `type must be one of: ${FEEDBACK_TYPES.join(", ")}`);
    }
    const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 1000);
    return c.json({
      records: store.query({
        type: type as FeedbackType | undefined,
        endpoint: c.req.query("endpoint"),
        service: c.req.query("service"),
        since: c.req.query("since"),
        limit,
      }),
    });
  });

  app.get("/v1/summary", (c) => {
    if (!allowed(options.adminKeys, c.req.header("authorization"))) return errorResponse(401, "unauthorized", "Invalid admin key");
    return c.json(store.summary());
  });

  return Object.assign(app, { store });
}
