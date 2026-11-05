/**
 * Simulated agent sessions on an MCP server for the Acme Companies API, instrumented
 * with `instrumentServer` from @backloop/mcp: every tool call, with the intent and
 * thinking the agent reports, goes to the platform's POST /v1/sessions/events.
 *
 *   tsx src/sessions.ts             sessions happen now; judged once idle (BACKLOOP_SESSION_IDLE_SECONDS)
 *   tsx src/sessions.ts --backfill  spread over the last two days, so they are judged at the next sweep
 *
 *   BACKLOOP_URL         default http://localhost:4600
 *   BACKLOOP_INGEST_KEY  default dev-ingest-key
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { instrumentServer, registerFeedbackTool } from "@backloop/mcp";
import type { SessionEvent } from "@backloop/sdk";
import { z } from "zod";

const BACKLOOP_URL = (process.env.BACKLOOP_URL ?? "http://localhost:4600").replace(/\/+$/, "");
const INGEST_KEY = process.env.BACKLOOP_INGEST_KEY ?? "dev-ingest-key";
const backfill = process.argv.includes("--backfill");

const COMPANIES = [
  { id: "co_1", name: "Northwind", industry: "logistics", city: "Berlin", employees: 420, hiring: ["GTM engineer", "AE"] },
  { id: "co_2", name: "Globex", industry: "fintech", city: "Paris", employees: 1300, hiring: ["data engineer"] },
  { id: "co_3", name: "Initech", industry: "saas", city: "Austin", employees: 85, hiring: ["GTM engineer"] },
  { id: "co_4", name: "Umbrella", industry: "biotech", city: "Boston", employees: 5200, hiring: [] },
];

/** The Acme MCP server, with its real gaps: no hiring filter, exports capped at 100 rows, no CRM push. */
function acmeServer(): McpServer {
  const server = new McpServer({ name: "acme-companies", version: "1.4.0" });
  const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

  server.registerTool(
    "search_companies",
    {
      description: "Search companies by industry, city and size.",
      inputSchema: { industry: z.string().optional(), city: z.string().optional(), min_employees: z.number().optional(), q: z.string().optional() },
    },
    async (a) => {
      if (a.q && /hiring|role|job/i.test(a.q)) return fail("400 invalid_parameter: q matches company names only; unknown filter 'hiring'");
      const rows = COMPANIES.filter(
        (c) => (!a.industry || c.industry === a.industry) && (!a.city || c.city === a.city) && (!a.min_employees || c.employees >= a.min_employees),
      );
      return text({ total: rows.length, results: rows.map(({ hiring: _h, ...c }) => c) });
    },
  );
  server.registerTool("get_company", { description: "Get one company by id.", inputSchema: { id: z.string() } }, async ({ id }) => {
    const c = COMPANIES.find((x) => x.id === id);
    return c ? text(c) : fail(`404 not_found: no company ${id}`);
  });
  server.registerTool(
    "export_companies",
    { description: "Export search results as CSV.", inputSchema: { industry: z.string().optional(), limit: z.number().optional() } },
    async ({ limit }) => {
      if ((limit ?? 100) > 100) return fail("422 limit_exceeded: limit must be at most 100");
      return text({ csv: "id,name\nco_1,Northwind\nco_2,Globex", truncated: true });
    },
  );
  server.registerTool(
    "push_to_crm",
    { description: "Push companies to the connected CRM.", inputSchema: { ids: z.array(z.string()), crm: z.string() } },
    async ({ crm }) => (crm === "hubspot" ? text({ pushed: true }) : fail(`501 not_implemented: CRM '${crm}' is not supported`)),
  );
  registerFeedbackTool(server, { service: "acme-companies-mcp", onRecord: () => {} });
  return server;
}

type Step = { tool: string; args?: Record<string, unknown>; intent?: string; thinking?: string; frustration?: "low" | "medium" | "high" };

/** One agent session: what the user asked for, and the calls the agent made. */
const SCENARIOS: Array<{ client: string; weight: number; steps: Step[] }> = [
  // Find hiring companies: the filter doesn't exist; agents loop, then give up.
  {
    client: "claude-code",
    weight: 6,
    steps: [
      { tool: "search_companies", args: { q: "hiring GTM engineer" }, intent: "Find SaaS companies hiring GTM engineers", thinking: "Search with the role in the query" },
      { tool: "search_companies", args: { q: "GTM engineer job" }, thinking: "Maybe the query needs the word job" },
      { tool: "search_companies", args: { q: "role:GTM engineer" }, thinking: "Try a field-style filter", frustration: "medium" },
    ],
  },
  {
    client: "cursor",
    weight: 3,
    steps: [
      { tool: "search_companies", args: { industry: "saas" }, intent: "List companies currently hiring GTM engineers in SaaS", thinking: "No hiring filter: search SaaS, then check each company" },
      { tool: "get_company", args: { id: "co_3" }, thinking: "Check Initech's open roles" },
      { tool: "get_company", args: { id: "co_1" }, thinking: "Check Northwind's open roles" },
    ],
  },
  // Export: limit over 100 fails; some agents recover, some don't.
  {
    client: "claude-desktop",
    weight: 4,
    steps: [
      { tool: "export_companies", args: { industry: "fintech", limit: 500 }, intent: "Export every fintech company to a CSV", thinking: "Export them all at once" },
      { tool: "export_companies", args: { industry: "fintech", limit: 100 }, thinking: "The limit is 100: export the first page" },
    ],
  },
  {
    client: "chatgpt",
    weight: 2,
    steps: [
      { tool: "search_companies", args: { industry: "fintech" }, intent: "Export all fintech companies as a spreadsheet" },
      { tool: "export_companies", args: { industry: "fintech", limit: 1000 }, thinking: "Export everything" },
    ],
  },
  // CRM push: only HubSpot works.
  {
    client: "claude-code",
    weight: 3,
    steps: [
      { tool: "search_companies", args: { city: "Berlin" }, intent: "Push Berlin logistics companies into our Salesforce", thinking: "Find them first" },
      { tool: "push_to_crm", args: { ids: ["co_1"], crm: "salesforce" }, thinking: "Push to Salesforce", frustration: "high" },
    ],
  },
  {
    client: "claude-desktop",
    weight: 2,
    steps: [
      { tool: "search_companies", args: { city: "Austin" }, intent: "Send Austin SaaS companies to HubSpot", thinking: "Search Austin" },
      { tool: "push_to_crm", args: { ids: ["co_3"], crm: "hubspot" }, thinking: "Push the match to HubSpot" },
    ],
  },
  // Lookups that just work.
  {
    client: "cursor",
    weight: 5,
    steps: [
      { tool: "search_companies", args: { industry: "biotech" }, intent: "How many employees does Umbrella have?", thinking: "Find Umbrella" },
      { tool: "get_company", args: { id: "co_4" }, thinking: "Read its headcount" },
    ],
  },
  {
    client: "chatgpt",
    weight: 3,
    steps: [{ tool: "search_companies", args: { city: "Paris", min_employees: 1000 }, intent: "Find large companies in Paris", thinking: "Filter by city and size" }],
  },
  // Wrong id, recovered.
  {
    client: "claude-code",
    weight: 2,
    steps: [
      { tool: "get_company", args: { id: "globex" }, intent: "Get Globex's company profile", thinking: "Try the name as the id" },
      { tool: "search_companies", args: { industry: "fintech" }, thinking: "Find Globex's id" },
      { tool: "get_company", args: { id: "co_2" } },
    ],
  },
  // The agent reports the gap itself: the session is not filed again.
  {
    client: "claude-code",
    weight: 1,
    steps: [
      { tool: "push_to_crm", args: { ids: ["co_2"], crm: "pipedrive" }, intent: "Add Globex to our Pipedrive", thinking: "Push to Pipedrive" },
      {
        tool: "submit_feedback",
        args: { type: "missing_capability", goal: "Add Globex to Pipedrive", message: "push_to_crm only supports HubSpot", endpoint: "push_to_crm", outcome: "blocked" },
      },
    ],
  },
];

const sessions = SCENARIOS.flatMap((s) => Array.from({ length: s.weight }, () => s));
const now = Date.now();
let sent = 0;

async function post(events: SessionEvent[]) {
  const res = await fetch(`${BACKLOOP_URL}/v1/sessions/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_KEY}` },
    body: JSON.stringify({ events }),
  });
  if (!res.ok) throw new Error(`Backloop returned HTTP ${res.status}: ${await res.text()}`);
  sent += events.length;
}

for (const [i, scenario] of sessions.entries()) {
  // Backfill: each session starts somewhere in the last two days, its calls a few seconds apart.
  const shift = backfill ? -Math.floor(((i * 7919) % 2880) + 10) * 60_000 : 0;
  let tick = 0;
  const server = acmeServer();
  const analytics = instrumentServer(server, {
    service: "acme-companies-mcp",
    identify: () => `acct_demo_${i % 9}`,
    onEvents: (events) =>
      post(events.map((e) => ({ ...e, started_at: new Date(Date.parse(e.started_at) + shift + 2500 * tick++).toISOString() }))),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: scenario.client, version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  for (const step of scenario.steps) {
    const telemetry =
      step.tool === "submit_feedback"
        ? undefined
        : { ...(step.intent ? { user_intent: step.intent } : {}), ...(step.thinking ? { agent_thinking: step.thinking } : {}), ...(step.frustration ? { user_frustration: step.frustration } : {}) };
    await client.callTool({ name: step.tool, arguments: { ...step.args, ...(telemetry && Object.keys(telemetry).length ? { telemetry } : {}) } });
    await analytics.flush();
  }
  await client.close();
}

console.log(`${sessions.length} sessions, ${sent} tool calls sent to ${BACKLOOP_URL}.`);
console.log(backfill ? "Backdated: they are judged at the platform's next sweep (every 30s)." : "Judged once idle (BACKLOOP_SESSION_IDLE_SECONDS, default 300).");
