#!/usr/bin/env node
/**
 * backloop-collector — self-hosted Agent Feedback Protocol collector.
 *
 *   PORT                        default 4700
 *   COLLECTOR_DATA_FILE         default ./data/feedback.jsonl
 *   COLLECTOR_SERVICE           service name for direct submissions
 *   COLLECTOR_INGEST_KEYS       comma-separated keys for POST /v1/records
 *   COLLECTOR_ADMIN_KEYS        comma-separated keys for the read API
 *   COLLECTOR_FORWARD_URL       forward records to another collector / the platform
 *   COLLECTOR_FORWARD_KEY       ingest key for the forward target
 */
import { serve } from "@hono/node-server";
import { createCollector } from "./index.js";

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const app = createCollector({
  dataFile: process.env.COLLECTOR_DATA_FILE ?? "data/feedback.jsonl",
  service: process.env.COLLECTOR_SERVICE,
  ingestKeys: list(process.env.COLLECTOR_INGEST_KEYS),
  adminKeys: list(process.env.COLLECTOR_ADMIN_KEYS),
  forward: process.env.COLLECTOR_FORWARD_URL
    ? { url: process.env.COLLECTOR_FORWARD_URL, ingestKey: process.env.COLLECTOR_FORWARD_KEY }
    : undefined,
});

const port = Number(process.env.PORT ?? 4700);
serve({ fetch: app.fetch, port }, () => {
  console.log(`backloop collector listening on http://localhost:${port} (${app.store.summary().total} records loaded)`);
});
