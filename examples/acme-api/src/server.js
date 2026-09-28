// Acme Companies API — a demo API that implements the Agent Feedback Protocol.
//
//   BACKLOOP_URL          collector or platform to forward feedback to (default http://localhost:4700,
//                         the reference collector)
//   BACKLOOP_INGEST_KEY   its ingest key (default dev-ingest-key)
//   ACCOUNT_HASH_SECRET   secret used to pseudonymize customer accounts
//   ACME_PORT             default 4610
import { serve } from "@hono/node-server";
import { createFeedbackHandler, feedbackLinkHeader, forwardTo, hashAccount } from "@backloop/sdk";
import { Hono } from "hono";
import { ApiError, getCompany, listJobs, searchCompanies } from "./companies.js";

const secret = process.env.ACCOUNT_HASH_SECRET ?? "demo-secret";

// In a real API this is your existing API-key lookup.
function customerFor(request) {
  const key = request.headers.get("authorization")?.match(/^Bearer\s+(acme_live_\w+)$/)?.[1];
  return key ?? undefined;
}

const feedback = createFeedbackHandler({
  service: "acme-companies-api",
  identify: async (request) => {
    const customer = customerFor(request);
    return customer ? hashAccount(customer, secret) : undefined;
  },
  onRecord: forwardTo({
    url: process.env.BACKLOOP_URL ?? "http://localhost:4700",
    ingestKey: process.env.BACKLOOP_INGEST_KEY ?? "dev-ingest-key",
  }),
  // The demo fleet sends many reports from few keys; production APIs keep the default.
  rateLimit: { max: 1000, windowMs: 60_000 },
});

const app = new Hono();

app.use("/companies/*", async (c, next) => {
  if (!customerFor(c.req.raw)) return c.json({ error: "missing or invalid API key" }, 401);
  await next();
});

// Every error response tells agents where to report problems.
app.onError((err, c) => {
  const status = err instanceof ApiError ? err.status : 500;
  c.header("link", feedbackLinkHeader("/feedback"));
  return c.json({ error: err instanceof ApiError ? err.message : "internal error" }, status);
});

app.get("/companies/search", (c) => c.json(searchCompanies(c.req.query())));
app.get("/companies/:id", (c) => c.json(getCompany(c.req.param("id"))));
app.get("/companies/:id/jobs", (c) => c.json(listJobs(c.req.param("id"))));

app.post("/feedback", (c) => feedback.submit(c.req.raw));
app.get("/.well-known/agent-feedback", (c) => feedback.discovery(c.req.raw));

const port = Number(process.env.ACME_PORT ?? 4610);
serve({ fetch: app.fetch, port }, () => console.log(`Acme Companies API on http://localhost:${port}`));
