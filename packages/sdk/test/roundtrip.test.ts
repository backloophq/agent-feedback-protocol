import { describe, expect, it, vi } from "vitest";
import {
  FeedbackClient,
  FeedbackError,
  createFeedbackHandler,
  feedbackTool,
  feedbackUrlFromLink,
  forwardTo,
  hashAccount,
  memorySink,
  newId,
  validateAck,
  withFeedbackLink,
  type FeedbackHandlerOptions,
} from "../src/index.js";

const valid = { type: "missing_capability", goal: "Find companies hiring GTM engineers", message: "No hiring-role filter" } as const;

function setup(overrides: Partial<FeedbackHandlerOptions> = {}) {
  const sink = memorySink();
  const handler = createFeedbackHandler({ onRecord: sink, service: "acme", ...overrides });
  // A fetch that routes straight into the handler: no sockets needed.
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler.fetch(new Request(input, init))) as typeof fetch;
  return { sink, handler, fetchImpl };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://api.example.com/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("server handler", () => {
  it("accepts valid feedback and returns a schema-valid ack", async () => {
    const { handler, sink } = setup({ identify: (req) => (req.headers.get("authorization") ? "acct_1" : undefined) });
    const res = await handler.fetch(post(valid, { authorization: "Bearer k" }));
    expect(res.status).toBe(202);
    const ack = await res.json();
    expect(validateAck(ack).valid).toBe(true);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({ id: ack.id, service: "acme", account: "acct_1", source: "http", feedback: valid });
  });

  it("names the agent from the User-Agent when the submission doesn't", async () => {
    const { handler, sink } = setup();
    await handler.fetch(post(valid, { "user-agent": "claude-code/2.1.0 (external, cli)" }));
    await handler.fetch(post({ ...valid, agent: { model: "m" } }, { "user-agent": "ChatGPT-User/1.0" }));
    // What the agent says about itself wins; an HTTP library is not an agent.
    await handler.fetch(post({ ...valid, agent: { name: "ops-agent" } }, { "user-agent": "claude-code/2.1.0" }));
    await handler.fetch(post(valid, { "user-agent": "python-requests/2.32.3" }));
    expect(sink.records.map((r) => r.feedback.agent)).toEqual([
      { name: "claude-code", version: "2.1.0" },
      { name: "ChatGPT-User", version: "1.0", model: "m" },
      { name: "ops-agent" },
      undefined,
    ]);
  });

  it("removes secrets and email addresses, whatever client sent them", async () => {
    const leaky = { ...valid, message: "401 with Bearer 9f8e7d6c5b4a3f2e for jane@acme.test", metadata: { password: "hunter2", plan: "team" } };
    const { handler, sink } = setup();
    expect((await handler.fetch(post(leaky))).status).toBe(202);
    expect(sink.records[0]!.feedback).toMatchObject({ message: "401 with [REDACTED] for [REDACTED]", metadata: { password: "[REDACTED]", plan: "team" } });
    // Asked not to: as sent.
    const raw = setup({ redact: false });
    await raw.handler.fetch(post(leaky));
    expect(raw.sink.records[0]!.feedback).toMatchObject({ message: leaky.message });
  });

  it("passes a known issue from onRecord back to the agent", async () => {
    const known_issue = { id: "iss_1", title: "Add hiring_role filter", status: "planned" as const, workaround: "Use /jobs" };
    const { handler } = setup({ onRecord: () => ({ known_issue }) });
    const ack = await (await handler.fetch(post(valid))).json();
    expect(ack.known_issue).toEqual(known_issue);
  });

  it.each([
    ["wrong content type", post(valid, { "content-type": "text/plain" }), 415, "unsupported_media_type"],
    ["invalid JSON", post("{nope"), 400, "invalid_json"],
    ["invalid feedback", post({ type: "bug" }), 400, "invalid_feedback"],
    ["too large", post({ ...valid, metadata: { blob: "x".repeat(20_000) } }), 413, "payload_too_large"],
  ])("rejects %s", async (_name, request, status, code) => {
    const { handler, sink } = setup();
    const res = await handler.fetch(request);
    expect(res.status).toBe(status);
    expect((await res.json()).error.code).toBe(code);
    expect(sink.records).toHaveLength(0);
  });

  it("lists every validation problem", async () => {
    const { handler } = setup();
    const body = await (await handler.fetch(post({ type: "bug", goal: "", extra: true }))).json();
    expect(body.error.details.map((d: { path: string }) => d.path)).toEqual(["message", "goal", "extra"]);
  });

  it("requires auth when configured", async () => {
    const { handler } = setup({ auth: "required", identify: () => undefined });
    expect((await handler.fetch(post(valid))).status).toBe(401);
  });

  it("rate limits per account", async () => {
    const { handler } = setup({ identify: () => "acct_1", rateLimit: { max: 2, windowMs: 60_000 } });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await handler.fetch(post(valid))).status);
    expect(statuses).toEqual([202, 202, 429]);
  });

  it("returns 503 when the sink fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { handler } = setup({ onRecord: () => Promise.reject(new Error("db down")) });
    const res = await handler.fetch(post(valid));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
  });

  it("advertises https behind a TLS-terminating proxy", async () => {
    const { handler } = setup();
    const res = await handler.fetch(
      new Request("http://api.example.com/.well-known/agent-feedback", { headers: { "x-forwarded-proto": "https" } }),
    );
    expect((await res.json()).endpoint).toBe("https://api.example.com/feedback");
  });

  it("serves the discovery document", async () => {
    const { handler } = setup();
    const res = await handler.fetch(new Request("https://api.example.com/.well-known/agent-feedback"));
    expect(await res.json()).toMatchObject({
      spec_version: "0.1",
      endpoint: "https://api.example.com/feedback",
      max_bytes: 16384,
      auth: "optional",
    });
  });
});

describe("client", () => {
  it("submits, adding agent and session defaults and redacting secrets", async () => {
    const { fetchImpl, sink } = setup();
    const client = new FeedbackClient({
      baseUrl: "https://api.example.com/",
      agent: { name: "test-agent" },
      sessionId: "sess_1",
      fetch: fetchImpl,
    });
    const ack = await client.submit({ ...valid, message: "Tried key sk-ant-abcdefghijklmnopqrstu, no filter" });
    expect(ack.status).toBe("accepted");
    expect(sink.records[0]!.feedback).toMatchObject({
      agent: { name: "test-agent" },
      session_id: "sess_1",
      message: "Tried key [REDACTED], no filter",
    });
  });

  it("validates before sending", async () => {
    const fetchImpl = vi.fn();
    const client = new FeedbackClient({ baseUrl: "https://x", fetch: fetchImpl as unknown as typeof fetch });
    await expect(client.submit({ ...valid, type: "nope" as never })).rejects.toThrow(FeedbackError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries once on 503, then succeeds", async () => {
    const { fetchImpl: ok } = setup();
    let calls = 0;
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) =>
      ++calls === 1 ? new Response("{}", { status: 503, headers: { "retry-after": "0" } }) : ok(input, init)) as typeof fetch;
    const client = new FeedbackClient({ baseUrl: "https://x", fetch: flaky });
    await expect(client.submit(valid)).resolves.toMatchObject({ status: "accepted" });
    expect(calls).toBe(2);
  });

  it("trySubmit never throws", async () => {
    const client = new FeedbackClient({ endpoint: "http://127.0.0.1:1/feedback", timeoutMs: 500 });
    const result = await client.trySubmit(valid);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("network_error");
  });

  it("discovers the endpoint", async () => {
    const { fetchImpl } = setup({ publicEndpoint: "https://feedback.example.com/v1/feedback" });
    const client = await FeedbackClient.fromDiscovery("https://api.example.com", { fetch: fetchImpl });
    expect(client?.endpoint).toBe("https://feedback.example.com/v1/feedback");
  });
});

describe("forwarding", () => {
  it("forwards records to a collector and relays known issues", async () => {
    const received: unknown[] = [];
    const collector = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      received.push(...body.records);
      return Response.json({
        results: [{ id: body.records[0].id, status: "accepted", known_issue: { id: "i", title: "t", status: "planned" } }],
      });
    }) as typeof fetch;
    const { handler } = setup({ onRecord: forwardTo({ url: "http://collector", ingestKey: "k", fetch: collector }) });
    const ack = await (await handler.fetch(post(valid))).json();
    expect(received).toHaveLength(1);
    expect(ack.known_issue.id).toBe("i");
  });

  it("answers the agent without waiting for a slow collector, and still forwards", async () => {
    const record = { id: "x", received_at: "2026-09-28T00:00:00Z", feedback: valid };
    let release = () => {};
    const received: unknown[] = [];
    const slow = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      await new Promise<void>((r) => (release = r));
      received.push(JSON.parse(String(init?.body)).records[0]);
      return Response.json({ results: [{ id: "x", status: "accepted", known_issue: { id: "i", title: "t", status: "planned" } }] });
    }) as typeof fetch;
    const kept: Promise<unknown>[] = [];
    const forward = forwardTo({ url: "http://collector", fetch: slow, waitMs: 20, waitUntil: (w) => kept.push(w) });
    const started = Date.now();
    expect(await forward(record)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);
    expect(received).toHaveLength(0);
    // What a serverless runtime is asked to keep alive is the forward itself.
    release();
    await kept[0];
    expect(received).toHaveLength(1);
  });

  it("with a wait, a quick answer still reaches the agent and a quick failure is a 503", async () => {
    const quick = (async () => Response.json({ results: [{ id: "x", status: "accepted", known_issue: { id: "i", title: "t", status: "planned" } }] })) as typeof fetch;
    const ok = setup({ onRecord: forwardTo({ url: "http://collector", fetch: quick, waitMs: 1000 }) });
    expect((await (await ok.handler.fetch(post(valid))).json()).known_issue.id).toBe("i");
    const down = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    const failing = setup({ onRecord: forwardTo({ url: "http://collector", fetch: down, waitMs: 1000 }) });
    expect((await failing.handler.fetch(post(valid))).status).toBe(503);
  });

  it("tells onError about a forward that failed after the agent was answered", async () => {
    const record = { id: "x", received_at: "2026-09-28T00:00:00Z", feedback: valid };
    const late = (async () => {
      await new Promise((r) => setTimeout(r, 40));
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    const failed: unknown[] = [];
    const kept: Promise<unknown>[] = [];
    const forward = forwardTo({ url: "http://collector", fetch: late, waitMs: 5, waitUntil: (w) => kept.push(w), onError: (e, r) => failed.push([String(e), r.id]) });
    expect(await forward(record)).toBeUndefined();
    await kept[0];
    expect(failed).toEqual([["Error: connect ECONNREFUSED", "x"]]);
  });

  it("does not retry a record the collector rejected", async () => {
    let calls = 0;
    const collector = (async () => {
      calls++;
      return Response.json({ results: [{ id: "x", status: "rejected", error: { code: "invalid_feedback", message: "bad" } }] });
    }) as typeof fetch;
    const forward = forwardTo({ url: "http://collector", fetch: collector });
    await expect(forward({ id: "x", received_at: "2026-09-28T00:00:00Z", feedback: valid })).rejects.toThrow(/rejected/);
    expect(calls).toBe(1);
  });

  it("retries once on a network error", async () => {
    let calls = 0;
    const collector = (async () => {
      if (++calls === 1) throw new TypeError("fetch failed");
      return Response.json({ results: [{ id: "x", status: "accepted" }] });
    }) as typeof fetch;
    const forward = forwardTo({ url: "http://collector", fetch: collector });
    await expect(forward({ id: "x", received_at: "2026-09-28T00:00:00Z", feedback: valid })).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});

describe("helpers", () => {
  it("generates sortable prefixed IDs", async () => {
    const a = newId("fb");
    await new Promise((r) => setTimeout(r, 2));
    const b = newId("fb");
    expect(a).toMatch(/^fb_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
  });

  it("hashes accounts deterministically", async () => {
    const h = await hashAccount("customer-42", "secret");
    expect(h).toMatch(/^acct_[0-9a-f]{24}$/);
    expect(await hashAccount("customer-42", "secret")).toBe(h);
    expect(await hashAccount("customer-43", "secret")).not.toBe(h);
  });

  it("adds and parses the Link header", () => {
    const res = withFeedbackLink(new Response("{}", { status: 400, headers: { link: '</docs>; rel="help"' } }));
    expect(res.headers.get("link")).toBe('</docs>; rel="help", </feedback>; rel="agent-feedback"');
    expect(feedbackUrlFromLink(res.headers.get("link"), "https://api.example.com/v2/x")).toBe("https://api.example.com/feedback");
  });

  it("exposes a Claude-compatible tool definition", () => {
    const tool = feedbackTool();
    expect(tool.name).toBe("submit_feedback");
    expect(tool.input_schema).toMatchObject({ type: "object", required: ["type", "goal", "message"] });
    expect((tool.input_schema.properties as Record<string, unknown>).spec_version).toBeUndefined();
  });
});
