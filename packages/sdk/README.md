# @backloop/sdk

TypeScript SDK for the [Agent Feedback Protocol](https://trybackloop.com/spec/). Zero runtime dependencies. Works anywhere the Fetch API does: Node ≥ 18, Bun, Deno, Cloudflare Workers, browsers.

```bash
npm install @backloop/sdk
```

## Agents: send feedback

```ts
import { FeedbackClient } from "@backloop/sdk";

const client = new FeedbackClient({ baseUrl: "https://api.acme.com", apiKey, sessionId: "task_42" });

const result = await client.trySubmit({   // never throws: feedback must not break the task
  type: "missing_capability",
  goal: "Find companies currently hiring GTM engineers",
  endpoint: "/companies/search",
  message: "No hiring-role filter is available",
  outcome: "blocked",
  suggestion: "Add a hiring_role query parameter",
});
if (result.ok && result.ack.known_issue) console.log("Already tracked:", result.ack.known_issue.title);
```

- `submit()` throws `FeedbackError` (`code`, `status`, `details`). Both validate before sending, redact secrets, card numbers and emails, and retry once on `429`/`5xx`.
- `FeedbackClient.fromDiscovery(baseUrl)` finds the endpoint via `/.well-known/agent-feedback`; `feedbackUrlFromLink(res.headers.get("link"), url)` reads it from an error response.
- `feedbackTool()` returns the `submit_feedback` tool in Claude's `{ name, description, input_schema }` shape. `AGENT_FEEDBACK_INSTRUCTIONS` is the standard system-prompt block.

## Services: receive feedback

```ts
import { createFeedbackHandler, forwardTo, hashAccount, withFeedbackLink } from "@backloop/sdk";

const feedback = createFeedbackHandler({
  service: "acme-companies-api",
  identify: async (req) => hashAccount(await accountIdFrom(req), SECRET), // undefined = anonymous
  // waitMs: answer the agent after at most 500 ms and go on forwarding in the background
  // (serverless: also pass waitUntil). Without it, the request waits for the collector.
  onRecord: forwardTo({ url: "https://collector.example.com", ingestKey, waitMs: 500 }), // or your own function
});

// Hono / Next.js / Workers:
app.post("/feedback", (c) => feedback.submit(c.req.raw));
app.get("/.well-known/agent-feedback", (c) => feedback.discovery(c.req.raw));

// Express / node:http:
import { toNodeListener } from "@backloop/sdk/node";
app.use(["/feedback", "/.well-known/agent-feedback"], toNodeListener(feedback));
```

The handler returns spec-compliant `202`, `400`, `401`, `413`, `415`, `429` and `503` responses, rate limits per account or IP (60/min by default), and passes a `known_issue` returned by `onRecord` back to the agent. Add `Link: </feedback>; rel="agent-feedback"` to your API's error responses with `withFeedbackLink(response)` or `feedbackLinkHeader()`.

## Also exported

`validateSubmission`, `validateRecord`, `validateAck`, the JSON Schemas (`FEEDBACK_SCHEMA`, …), `redact`, `newId`, `hashAccount`, `duplicateKey`, `fanOut`, `memorySink`.
