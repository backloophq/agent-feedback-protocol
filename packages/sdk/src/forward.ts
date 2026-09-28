import type { OnRecordResult } from "./server.js";
import type { FeedbackRecord, IngestResponse } from "./types.js";

export interface ForwardOptions {
  /** Collector base URL, e.g. `http://localhost:4700` (the reference collector) or the hosted platform. */
  url: string;
  /** Ingest key, sent as a bearer token. */
  ingestKey?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * An `onRecord` sink that forwards records to a collector's
 * `POST /v1/records` and passes any `known_issue` back to the agent.
 */
export function forwardTo(options: ForwardOptions): (record: FeedbackRecord) => Promise<OnRecordResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const endpoint = `${options.url.replace(/\/+$/, "")}/v1/records`;
  return async (record) => {
    const body = JSON.stringify({ records: [record] });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.ingestKey) headers.authorization = `Bearer ${options.ingestKey}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(endpoint, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
        });
      } catch (e) {
        lastError = e; // network error or timeout: retry once
        continue;
      }
      if (res.ok) {
        // A definitive answer: never retried.
        const data = (await res.json()) as IngestResponse;
        const result = data.results?.[0];
        if (result?.status === "rejected") {
          throw new Error(`Collector rejected record: ${result.error?.message ?? "unknown error"}`);
        }
        return result?.known_issue ? { known_issue: result.known_issue } : undefined;
      }
      lastError = new Error(`Collector returned HTTP ${res.status}`);
      if (res.status < 500 && res.status !== 429) break;
    }
    throw lastError;
  };
}

/** Run several sinks for each record; the first `known_issue` wins. */
export function fanOut(
  ...sinks: Array<(record: FeedbackRecord) => OnRecordResult | Promise<OnRecordResult>>
): (record: FeedbackRecord) => Promise<OnRecordResult> {
  return async (record) => {
    const results = await Promise.all(sinks.map((sink) => sink(record)));
    const known = results.find((r) => r?.known_issue);
    return known ?? undefined;
  };
}

/** Keeps records in memory. Useful for tests and prototypes. */
export function memorySink(): ((record: FeedbackRecord) => void) & { records: FeedbackRecord[] } {
  const records: FeedbackRecord[] = [];
  const sink = (record: FeedbackRecord) => {
    records.push(record);
  };
  return Object.assign(sink, { records });
}
