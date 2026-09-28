import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCollector } from "../src/index.js";

const submission = { type: "missing_capability", goal: "Find companies hiring GTM engineers", message: "No hiring-role filter", session_id: "s1" };
const record = (id: string, extra: object = {}) => ({
  id,
  received_at: "2026-09-28T10:00:00.000Z",
  service: "acme",
  account: "acct_1",
  source: "http",
  feedback: { ...submission, ...extra },
});

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("collector", () => {
  it("accepts direct submissions on /feedback and persists them as JSONL", async () => {
    const dataFile = join(mkdtempSync(join(tmpdir(), "collector-")), "feedback.jsonl");
    const app = createCollector({ dataFile, service: "acme" });
    const res = await app.request("/feedback", json(submission));
    expect(res.status).toBe(202);
    const lines = readFileSync(dataFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ service: "acme", feedback: submission });
    // A restarted collector reloads what was stored.
    expect(createCollector({ dataFile }).store.summary().total).toBe(1);
  });

  it("ingests records, de-duplicating by id and by agent run", async () => {
    const app = createCollector({ ingestKeys: ["k1"] });
    const res = await app.request(
      "/v1/records",
      json(
        {
          records: [
            record("fb_1"),
            record("fb_1"), // same id
            record("fb_2"), // same session + same problem
            record("fb_3", { session_id: "s2" }), // a different run: counts
            { id: "bad", feedback: {} },
          ],
        },
        { authorization: "Bearer k1" },
      ),
    );
    expect(res.status).toBe(200);
    const { results } = await res.json();
    expect(results.map((r: { status: string }) => r.status)).toEqual(["accepted", "duplicate", "duplicate", "accepted", "rejected"]);
    expect(results[4].error.details.map((d: { path: string }) => d.path)).toContain("received_at");
    expect(app.store.summary()).toMatchObject({ total: 2, duplicates: 2, accounts: 1 });
  });

  it("requires the ingest key when configured", async () => {
    const app = createCollector({ ingestKeys: ["k1"] });
    expect((await app.request("/v1/records", json({ records: [record("fb_1")] }))).status).toBe(401);
  });

  it("serves the read API", async () => {
    const app = createCollector({ adminKeys: ["admin"] });
    await app.request("/v1/records", json({ records: [record("fb_1"), record("fb_2", { type: "bug", session_id: "s9" })] }));
    expect((await app.request("/v1/records")).status).toBe(401);
    const auth = { headers: { authorization: "Bearer admin" } };
    const { records } = await (await app.request("/v1/records?type=bug", auth)).json();
    expect(records.map((r: { id: string }) => r.id)).toEqual(["fb_2"]);
    const summary = await (await app.request("/v1/summary", auth)).json();
    expect(summary.by_type).toEqual({ missing_capability: 1, bug: 1 });
  });

  it("forwards accepted records and relays known issues to the agent", async () => {
    const originalFetch = globalThis.fetch;
    const forwarded: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      forwarded.push(...body.records.map((r: { id: string }) => r.id));
      return Response.json({ results: [{ id: body.records[0].id, status: "accepted", known_issue: { id: "iss_9", title: "Hiring filter", status: "in_progress" } }] });
    }) as typeof fetch;
    try {
      const app = createCollector({ forward: { url: "http://platform.test" } });
      const ack = await (await app.request("/feedback", json(submission))).json();
      expect(forwarded).toEqual([ack.id]);
      expect(ack.known_issue.id).toBe("iss_9");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
