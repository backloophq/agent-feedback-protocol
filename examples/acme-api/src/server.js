// Acme Companies API — a demo API that implements the Agent Feedback Protocol.
//
//   BACKLOOP_URL          collector or platform to forward feedback to (default http://localhost:4700,
//                         the reference collector)
//   BACKLOOP_INGEST_KEY   its ingest key (default dev-ingest-key)
//   ACCOUNT_HASH_SECRET   secret used to pseudonymize customer accounts
//   ACME_PORT             default 4610
import { serve } from "@hono/node-server";
import { forwardTo } from "@backloop/sdk";
import { createApp } from "./app.js";

const backloop = {
  url: process.env.BACKLOOP_URL ?? "http://localhost:4700",
  ingestKey: process.env.BACKLOOP_INGEST_KEY ?? "dev-ingest-key",
};
const app = createApp({
  secret: process.env.ACCOUNT_HASH_SECRET ?? "demo-secret",
  onRecord: forwardTo(backloop),
  // Agent requests become sessions, and agents can read what was fixed (GET /feedback/changes).
  // The reference collector doesn't take them: only with the platform (BACKLOOP_URL set).
  ...(process.env.BACKLOOP_URL ? { backloop } : {}),
  // The demo fleet sends many reports from few keys; production APIs keep the default.
  rateLimit: { max: 1000, windowMs: 60_000 },
});

const port = Number(process.env.ACME_PORT ?? 4610);
serve({ fetch: app.fetch, port }, () => console.log(`Acme Companies API on http://localhost:${port}`));
