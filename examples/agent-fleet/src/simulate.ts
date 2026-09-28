/**
 * Simulate a fleet of agents hitting the Acme Companies API.
 *
 *   tsx src/simulate.ts            send every report through the API's POST /feedback
 *                                  (the real protocol path: API → forwardTo → collector)
 *   tsx src/simulate.ts --backfill post records straight to the collector's /v1/records,
 *                                  backdated over two weeks, to seed a realistic history
 *
 *   ACME_URL             default http://localhost:4610
 *   BACKLOOP_URL         collector or platform, default http://localhost:4700 (the reference collector)
 *   BACKLOOP_INGEST_KEY  default dev-ingest-key
 */
import { FeedbackClient, hashAccount, newId, type FeedbackRecord } from "@backloop/sdk";
import { simulate } from "./scenarios.js";

const ACME_URL = process.env.ACME_URL ?? "http://localhost:4610";
const BACKLOOP_URL = process.env.BACKLOOP_URL ?? "http://localhost:4700";
const INGEST_KEY = process.env.BACKLOOP_INGEST_KEY ?? "dev-ingest-key";
const backfill = process.argv.includes("--backfill");

const reports = simulate();
const tally: Record<string, number> = {};
let knownIssues = 0;

if (backfill) {
  const now = Date.now();
  const records: FeedbackRecord[] = [];
  for (const r of reports) {
    records.push({
      id: newId("fb"),
      received_at: new Date(now - r.minutesAgo * 60_000).toISOString(),
      service: "acme-companies-api",
      account: await hashAccount(r.account, process.env.ACCOUNT_HASH_SECRET ?? "demo-secret"),
      source: "http",
      feedback: r.submission,
    });
  }
  records.sort((a, b) => a.received_at.localeCompare(b.received_at));
  for (let i = 0; i < records.length; i += 100) {
    const res = await fetch(`${BACKLOOP_URL}/v1/records`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_KEY}` },
      body: JSON.stringify({ records: records.slice(i, i + 100) }),
    });
    if (!res.ok) throw new Error(`${BACKLOOP_URL} returned HTTP ${res.status}: ${await res.text()}`);
    const { results } = (await res.json()) as { results: Array<{ status: string; known_issue?: unknown }> };
    for (const result of results) {
      tally[result.status] = (tally[result.status] ?? 0) + 1;
      if (result.known_issue) knownIssues++;
    }
  }
} else {
  // Each simulated agent discovers the endpoint the way a real one would.
  const doc = await FeedbackClient.discover(ACME_URL);
  if (!doc) throw new Error(`${ACME_URL} does not advertise /.well-known/agent-feedback. Is the Acme API running?`);
  for (const r of reports) {
    const client = new FeedbackClient({ endpoint: doc.endpoint, apiKey: r.apiKey });
    const result = await client.trySubmit(r.submission);
    const status = result.ok ? "accepted" : `error:${result.error.code}`;
    tally[status] = (tally[status] ?? 0) + 1;
    if (result.ok && result.ack.known_issue) knownIssues++;
  }
}

console.log(`Sent ${reports.length} reports from ${new Set(reports.map((r) => r.account)).size} accounts ${backfill ? "(backfilled)" : `via ${ACME_URL}/feedback`}`);
console.log(tally);
if (knownIssues) console.log(`${knownIssues} agents were told their problem is a known issue.`);
if (backfill) console.log(`Records went to ${BACKLOOP_URL}`);
