/**
 * Simulated AI agents calling the Acme Companies API over plain HTTP. The API records
 * their requests with `recordRequests` (@backloop/sdk), so Backloop rebuilds REST agent
 * sessions, judges them, and files the failed ones, with no MCP server involved.
 *
 *   pnpm demo:api        (with BACKLOOP_URL set, so the API records requests)
 *   pnpm demo:requests
 *
 *   ACME_URL  default http://localhost:4610
 */
const ACME = (process.env.ACME_URL ?? "http://localhost:4610").replace(/\/+$/, "");

interface Agent {
  ua: string;
  key: string;
  run: (get: (path: string) => Promise<{ status: number; body: unknown }>) => Promise<void>;
}

const ids = async (get: (p: string) => Promise<{ status: number; body: unknown }>, query: string) => {
  const res = await get(`/companies/search?${query}`);
  return ((res.body as { data?: Array<{ id: string }> }).data ?? []).map((c) => c.id);
};

const AGENTS: Agent[] = [
  // The hiring-role gap: the filter is ignored (200), so the agent checks every company's jobs, one at a time.
  ...["claude-code/2.1.0", "ChatGPT-User/1.0", "Cursor/1.4 (agent)"].map((ua, i) => ({
    ua,
    key: `acme_live_customer0${i + 1}`,
    run: async (get: (p: string) => Promise<{ status: number; body: unknown }>) => {
      const all = await ids(get, "hiring_role=gtm_engineer");
      for (const id of all) await get(`/companies/${id}/jobs`);
    },
  })),
  // Country names: 400, then the agent gives up.
  ...["claude-code/2.1.0", "Perplexity-User/1.0"].map((ua, i) => ({
    ua,
    key: `acme_live_customer1${i}`,
    run: async (get: (p: string) => Promise<{ status: number; body: unknown }>) => {
      await get("/companies/search?country=Germany");
      await get("/companies/search?country=Germany&industry=fintech");
    },
  })),
  // A session that goes fine.
  {
    ua: "claude-code/2.1.0",
    key: "acme_live_customer05",
    run: async (get) => {
      const [first] = await ids(get, "industry=saas&country=US");
      if (first) await get(`/companies/${first}`);
    },
  },
];

for (const agent of AGENTS) {
  const get = async (path: string) => {
    const res = await fetch(`${ACME}${path}`, { headers: { "user-agent": agent.ua, authorization: `Bearer ${agent.key}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  await agent.run(get);
  console.log(`${agent.ua.padEnd(22)} done`);
}
console.log(`\nSent. Sessions are judged once idle (BACKLOOP_SESSION_IDLE_SECONDS, default 300): see Sessions and Tools in the dashboard.`);
