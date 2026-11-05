import { describe, expect, it } from "vitest";
import {
  changesFrom,
  collapsePath,
  createFeedbackHandler,
  detectAgent,
  memorySink,
  recordRequests,
  type HttpRequestEvent,
  type SessionEvent,
} from "../src/index.js";

const api = async (request: Request) => {
  const url = new URL(request.url);
  if (url.pathname === "/companies/search" && !url.searchParams.get("country")) {
    return Response.json({ error: { message: "country is required" } }, { status: 400 });
  }
  return Response.json({ results: [{ id: "cmp_001", name: "Acme", email: "jane@acme.com" }] });
};

describe("detectAgent", () => {
  it("names agents from explicit headers and user agents, and leaves browsers alone", () => {
    expect(detectAgent(new Headers({ "user-agent": "claude-code/2.1.0 (external, cli)" }))).toEqual({ name: "claude-code", version: "2.1.0" });
    expect(detectAgent(new Headers({ "user-agent": "Mozilla/5.0 AppleWebKit (KHTML, like Gecko; compatible; ChatGPT-User/1.0)" }))).toMatchObject({ name: "ChatGPT-User" });
    expect(detectAgent(new Headers({ "x-agent-name": "acme-bot" }))).toEqual({ name: "acme-bot" });
    expect(detectAgent(new Headers({ "signature-agent": '"https://chatgpt.com"' }))).toEqual({ name: "chatgpt.com" });
    expect(detectAgent(new Headers({ "user-agent": "python-httpx/0.27", "x-agent-session": "s1" }))).toEqual({ name: "agent" });
    expect(detectAgent(new Headers({ "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Safari/605.1.15" }))).toBeUndefined();
    expect(detectAgent({ "user-agent": "Anthropic/Python 0.40.0" })).toMatchObject({ name: "anthropic-sdk" });
  });

  it("collapses ids in paths into a route", () => {
    expect(collapsePath("/companies/cmp_0012345/jobs")).toBe("/companies/:id/jobs");
    expect(collapsePath("/companies/42")).toBe("/companies/:id");
    expect(collapsePath("/companies/search")).toBe("/companies/search");
  });
});

describe("recordRequests", () => {
  it("records agent requests with route, status, redacted previews and session id, and skips humans and /feedback", async () => {
    const events: SessionEvent[] = [];
    const recorder = recordRequests({ service: "acme-api", onEvents: (e) => void events.push(...e), identify: () => "acct_1" });
    const handler = recorder.wrap(api);
    const agent = { "user-agent": "claude-code/2.1.0", "x-agent-session": "sess_1" };
    await handler(new Request("https://api.acme.com/companies/search?q=fintech", { headers: agent }));
    await handler(new Request("https://api.acme.com/companies/search?q=fintech&country=DE", { headers: agent }));
    await handler(new Request("https://api.acme.com/companies/search?country=DE", { headers: { "user-agent": "Mozilla/5.0 Safari/605" } }));
    await handler(new Request("https://api.acme.com/feedback", { method: "POST", headers: agent }));
    await new Promise((r) => setTimeout(r, 10));
    await recorder.flush();

    expect(events).toHaveLength(2);
    const [failed, ok] = events as HttpRequestEvent[];
    expect(failed).toMatchObject({
      kind: "http_request",
      session_id: "sess_1",
      service: "acme-api",
      account: "acct_1",
      client: { name: "claude-code", version: "2.1.0" },
      method: "GET",
      route: "/companies/search",
      status: 400,
      input: "q=fintech",
    });
    expect(failed!.error).toContain("country is required");
    expect(ok!.status).toBe(200);
    expect(ok!.result).not.toContain("jane@acme.com");
  });

  it("takes the route from Hono and Express", async () => {
    const events: SessionEvent[] = [];
    const recorder = recordRequests({ onEvents: (e) => void events.push(...e) });
    const res = new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    const c = { req: { raw: new Request("https://x.dev/companies/cmp_9999999", { headers: { "user-agent": "claude-code/2" } }), routePath: "/companies/:id" }, res };
    await recorder.hono()(c, async () => {});
    let finish: () => void = () => {};
    recorder.express()(
      { method: "GET", url: "/jobs/77", headers: { "user-agent": "ChatGPT-User/1.0", host: "x.dev" }, route: { path: "/:id" }, baseUrl: "/jobs" },
      { statusCode: 200, on: (_e, l) => (finish = l) },
      () => {},
    );
    finish();
    await new Promise((r) => setTimeout(r, 10));
    await recorder.flush();
    expect((events as HttpRequestEvent[]).find((e) => e.route === "/companies/:id")!.input).toBe("/companies/cmp_9999999");
    expect((events as HttpRequestEvent[]).map((e) => [e.route, e.status]).sort()).toEqual([
      ["/companies/:id", 404],
      ["/jobs/:id", 200],
    ]);
  });
});

describe("changes", () => {
  it("serves the changelog at /feedback/changes and links it from discovery", async () => {
    const handler = createFeedbackHandler({
      onRecord: memorySink(),
      changes: () => [{ id: "cl_1", title: "Add a hiring_role filter", status: "fixed", fixed_at: "2026-10-02T14:00:00Z", endpoints: ["/companies/search"] }],
    });
    const discovery = await (await handler.fetch(new Request("https://api.acme.com/.well-known/agent-feedback"))).json();
    expect(discovery.changes).toBe("https://api.acme.com/feedback/changes");
    const res = await handler.fetch(new Request("https://api.acme.com/feedback/changes"));
    expect(res.status).toBe(200);
    expect((await res.json()).changes[0]).toMatchObject({ id: "cl_1", status: "fixed" });
    const none = createFeedbackHandler({ onRecord: memorySink() });
    expect((await none.fetch(new Request("https://api.acme.com/feedback/changes"))).status).toBe(404);
  });

  it("changesFrom caches Backloop's changelog and keeps the last good copy", async () => {
    let calls = 0;
    let fail = false;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls++;
      expect(url).toBe("https://bl.dev/v1/changes");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer k");
      if (fail) return new Response("no", { status: 500 });
      return Response.json({ changes: [{ id: "a", title: "t", status: "fixed" }] });
    }) as unknown as typeof fetch;
    const source = changesFrom({ url: "https://bl.dev/", ingestKey: "k", cacheMs: 0, fetch: fetchImpl });
    expect((await source()).changes).toHaveLength(1);
    fail = true;
    expect((await source()).changes).toHaveLength(1);
    expect(calls).toBe(2);
  });
});
