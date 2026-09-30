// The Acme Companies API as a Hono app. server.js serves it; the report-rate benchmark
// (examples/agent-fleet/src/bench) runs it in process with different feedback channels.
import { createFeedbackHandler, feedbackLinkHeader, hashAccount } from "@backloop/sdk";
import { Hono } from "hono";
import { ApiError, SEARCH_PARAMS, getCompany, listJobs, searchCompanies } from "./companies.js";

/** Put in a response body when an agent is likely stuck. Experimental: off unless `bodyHints` is set. */
export const FEEDBACK_HINT = {
  url: "/feedback",
  message:
    "This API takes reports from AI agents: a missing capability, unclear docs, an unhelpful error. " +
    "POST /feedback with type, goal and message. Details: GET /.well-known/agent-feedback.",
};

// In a real API this is your existing API-key lookup.
function customerFor(request) {
  const key = request.headers.get("authorization")?.match(/^Bearer\s+(acme_live_\w+)$/)?.[1];
  return key ?? undefined;
}

/**
 * @param {object} options
 * @param {import("@backloop/sdk").FeedbackHandlerOptions["onRecord"]} options.onRecord where accepted feedback goes
 * @param {string} [options.secret] pseudonymizes customer accounts
 * @param {boolean} [options.linkHeader] `Link: </feedback>; rel="agent-feedback"` on every error, as the spec says (default true)
 * @param {boolean} [options.bodyHints] also put FEEDBACK_HINT in error bodies, and in searches that ignored a parameter or found nothing
 * @param {{ max: number, windowMs: number } | false} [options.rateLimit]
 */
export function createApp({ onRecord, secret = "demo-secret", linkHeader = true, bodyHints = false, rateLimit }) {
  const feedback = createFeedbackHandler({
    service: "acme-companies-api",
    identify: async (request) => {
      const customer = customerFor(request);
      return customer ? hashAccount(customer, secret) : undefined;
    },
    onRecord,
    rateLimit,
  });

  const app = new Hono();

  // Every error response tells agents where to report problems.
  const error = (c, status, message) => {
    if (linkHeader) c.header("link", feedbackLinkHeader("/feedback"));
    return c.json(bodyHints ? { error: message, feedback: FEEDBACK_HINT } : { error: message }, status);
  };

  app.use("/companies/*", async (c, next) => {
    if (!customerFor(c.req.raw)) return error(c, 401, "missing or invalid API key");
    await next();
  });

  app.onError((err, c) =>
    err instanceof ApiError ? error(c, err.status, err.message) : error(c, 500, "internal error"),
  );
  app.notFound((c) => error(c, 404, "not found"));

  app.get("/companies/search", (c) => {
    const query = c.req.query();
    const result = searchCompanies(query);
    if (!bodyHints) return c.json(result);
    const ignored = Object.keys(query).filter((name) => !SEARCH_PARAMS.includes(name));
    if (ignored.length === 0 && result.total > 0) return c.json(result);
    return c.json({ ...result, ...(ignored.length ? { ignored_parameters: ignored } : {}), feedback: FEEDBACK_HINT });
  });
  app.get("/companies/:id", (c) => c.json(getCompany(c.req.param("id"))));
  app.get("/companies/:id/jobs", (c) => c.json(listJobs(c.req.param("id"))));

  app.post("/feedback", (c) => feedback.submit(c.req.raw));
  app.get("/.well-known/agent-feedback", (c) => feedback.discovery(c.req.raw));

  return app;
}
