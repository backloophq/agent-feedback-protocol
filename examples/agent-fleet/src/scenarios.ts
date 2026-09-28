import type { FeedbackSubmission } from "@backloop/sdk";

/**
 * Realistic feedback a fleet of agents might send the Acme Companies API.
 * Each scenario is one underlying problem, phrased many different ways by
 * different agents: that is what clustering has to see through.
 */
export interface Scenario {
  key: string;
  /** How many agent runs hit this problem in the simulation. */
  runs: number;
  goals: string[];
  reports: Array<Omit<FeedbackSubmission, "goal">>;
}

export const SCENARIOS: Scenario[] = [
  {
    key: "hiring-role-filter",
    runs: 24,
    goals: [
      "Find companies currently hiring GTM engineers",
      "Build a list of SaaS companies that are hiring GTM engineers in Europe",
      "Find B2B startups with open GTM engineer roles",
      "Identify companies recruiting for go-to-market engineering",
      "List fintech companies hiring sales engineers right now",
      "Find companies with open SDR and GTM roles for an outbound campaign",
      "Prospect accounts that are actively hiring revenue operations engineers",
      "Find Series B companies currently hiring for GTM engineering roles",
    ],
    reports: [
      {
        type: "missing_capability",
        endpoint: "/companies/search",
        method: "GET",
        message: "No hiring-role filter is available on /companies/search",
        outcome: "blocked",
        workaround: false,
        suggestion: "Add a hiring_role filter to /companies/search",
      },
      {
        type: "missing_capability",
        endpoint: "/companies/search",
        method: "GET",
        message: "Cannot filter companies by the roles they are hiring for. The q parameter only matches company names.",
        outcome: "blocked",
        workaround: false,
        expected: "A filter like hiring_role=gtm_engineer",
      },
      {
        type: "missing_capability",
        endpoint: "/companies/search",
        method: "GET",
        message: "There is no way to search companies by open job role; I had to call /companies/{id}/jobs for every company",
        outcome: "degraded",
        workaround: true,
        workaround_description: "Fetched /companies/{id}/jobs for each of 500 companies and filtered job titles locally",
        suggestion: "Support filtering /companies/search by hiring role or job title",
      },
      {
        type: "missing_capability",
        endpoint: "/companies/search",
        method: "GET",
        message: "Search has filters for industry, country and size but not for hiring roles or open positions",
        outcome: "blocked",
        workaround: false,
        suggestion: "Add hiring_role (or open_role) as a search filter",
      },
      {
        type: "unclear_documentation",
        endpoint: "/companies/search",
        method: "GET",
        message: "The docs do not say whether /companies/search can filter by hiring role. I tried hiring_role and roles params and both were ignored.",
        outcome: "blocked",
        workaround: false,
        expected: "Either a documented hiring role filter or a clear statement that it is not supported",
      },
      {
        type: "missing_capability",
        endpoint: "/companies/search",
        method: "GET",
        message: "Unable to filter by hiring role. Job postings exist per company but are not searchable across companies.",
        outcome: "degraded",
        workaround: true,
        workaround_description: "N+1 calls to /companies/{id}/jobs",
      },
    ],
  },
  {
    key: "employee-count-string",
    runs: 9,
    goals: [
      "Rank target accounts by number of employees",
      "Find companies with more than 200 employees in Germany",
      "Sort a prospect list by company size",
      "Compute the average headcount of companies in our pipeline",
    ],
    reports: [
      {
        type: "unexpected_response",
        endpoint: "/companies/{id}",
        method: "GET",
        message: "employee_count is returned as a string range like \"51-200\" but the docs say it is an integer",
        outcome: "degraded",
        workaround: true,
        workaround_description: "Parsed the lower bound of the range",
        expected: "An integer employee_count, or separate employee_count_min and employee_count_max fields",
      },
      {
        type: "bug",
        endpoint: "/companies/search",
        method: "GET",
        message: "Sorting by employee_count sorts lexically: \"1001-5000\" comes before \"51-200\" because the field is a string",
        outcome: "degraded",
        workaround: true,
        suggestion: "Return employee_count as a number and sort numerically",
      },
      {
        type: "unclear_documentation",
        endpoint: "/companies/{id}",
        method: "GET",
        message: "Documentation says employee_count is an integer, responses contain strings such as \"11-50\"",
        outcome: "completed",
        suggestion: "Fix the OpenAPI schema for employee_count or change the response type",
      },
    ],
  },
  {
    key: "pagination-cap",
    runs: 8,
    goals: [
      "Export every fintech company in the UK to a spreadsheet",
      "Download the complete list of companies in the healthcare industry",
      "Sync all companies matching our ICP into the CRM",
    ],
    reports: [
      {
        type: "performance",
        endpoint: "/companies/search",
        method: "GET",
        message: "Pagination is capped at 25 results per page and page numbers above 40 return 400, so result sets over 1000 companies cannot be retrieved",
        outcome: "blocked",
        workaround: false,
        suggestion: "Add cursor-based pagination or a bulk export endpoint",
        evidence: { status_code: 400, response_excerpt: "{\"error\":\"invalid page\"}" },
      },
      {
        type: "performance",
        endpoint: "/companies/search",
        method: "GET",
        message: "per_page maximum is 25 and deep pages fail, exporting a full segment takes hundreds of requests and then stops at page 40",
        outcome: "degraded",
        workaround: true,
        workaround_description: "Split the query by country to stay under 1000 results per query",
        suggestion: "Allow per_page up to 100 and provide cursor pagination",
      },
      {
        type: "missing_capability",
        endpoint: "/companies/search",
        method: "GET",
        message: "No cursor pagination or bulk export: page limit of 40 pages makes it impossible to fetch all results",
        outcome: "blocked",
        workaround: false,
      },
    ],
  },
  {
    key: "country-format-error",
    runs: 7,
    goals: [
      "Find logistics companies in the United Kingdom",
      "Search for software companies based in Germany",
      "List companies headquartered in France with 50 to 500 employees",
    ],
    reports: [
      {
        type: "unhelpful_error",
        endpoint: "/companies/search",
        method: "GET",
        message: "Passing country=United Kingdom returns 400 {\"error\":\"invalid request\"} without saying which parameter is wrong or what format is expected",
        outcome: "degraded",
        workaround: true,
        workaround_description: "Guessed that country needs an ISO 3166 alpha-2 code (GB)",
        suggestion: "Name the invalid parameter and the expected format (ISO 3166-1 alpha-2) in the error",
        evidence: { status_code: 400, response_excerpt: "{\"error\":\"invalid request\"}" },
      },
      {
        type: "unhelpful_error",
        endpoint: "/companies/search",
        method: "GET",
        message: "Error 400 'invalid request' for country=Germany. The error message does not mention the country parameter or ISO codes.",
        outcome: "degraded",
        workaround: true,
        expected: "An error like: country must be an ISO 3166-1 alpha-2 code, e.g. DE",
      },
      {
        type: "unclear_documentation",
        endpoint: "/companies/search",
        method: "GET",
        message: "Docs do not state the format of the country parameter; full country names fail with a generic invalid request error",
        outcome: "degraded",
        workaround: true,
      },
    ],
  },
  {
    key: "funding-filter",
    runs: 5,
    goals: [
      "Find companies that raised a Series A in the last 6 months",
      "Target recently funded startups for an outbound campaign",
    ],
    reports: [
      {
        type: "missing_capability",
        endpoint: "/companies/search",
        method: "GET",
        message: "No filter for funding stage or last funding date",
        outcome: "blocked",
        workaround: false,
        suggestion: "Add funding_stage and last_funding_after filters",
      },
      {
        type: "missing_capability",
        endpoint: "/companies/{id}",
        method: "GET",
        message: "Company records have no funding information at all (stage, amount or date), so recently funded companies cannot be identified",
        outcome: "blocked",
        workaround: false,
        suggestion: "Expose funding_stage, total_funding and last_funding_date on companies",
      },
    ],
  },
  {
    key: "stale-people",
    runs: 4,
    goals: [
      "Find the current VP of Sales at each target account",
      "Get decision makers at companies in our pipeline",
    ],
    reports: [
      {
        type: "bug",
        endpoint: "/people/search",
        method: "GET",
        message: "/people/search returns people who left the company years ago, with no end date or is_current flag",
        outcome: "degraded",
        workaround: false,
        suggestion: "Add is_current and ended_at to people results, and a current_only filter",
      },
      {
        type: "unexpected_response",
        endpoint: "/people/search",
        method: "GET",
        message: "People search results include former employees and there is no field to tell current from past roles",
        outcome: "degraded",
        workaround: true,
        workaround_description: "Cross-checked each person on LinkedIn",
      },
    ],
  },
  {
    key: "one-off-graphql",
    runs: 1,
    goals: ["Fetch companies and their people in a single round trip"],
    reports: [
      {
        type: "other",
        message: "A GraphQL endpoint would let me fetch companies with nested people and jobs in one request",
        outcome: "completed",
      },
    ],
  },
  {
    key: "one-off-webhooks",
    runs: 1,
    goals: ["Get notified when a target company starts hiring"],
    reports: [
      {
        type: "missing_capability",
        message: "No webhooks or change feed: I have to poll every company daily to detect changes",
        outcome: "degraded",
        workaround: true,
        suggestion: "Offer webhooks for company updates",
      },
    ],
  },
];

export const AGENTS = [
  { name: "claude-code", model: "claude-opus-5", framework: "claude-code" },
  { name: "sales-copilot", model: "claude-sonnet-5", framework: "claude-agent-sdk" },
  { name: "prospector", model: "gpt-5", framework: "openai-agents" },
  { name: "gtm-research-bot", model: "claude-haiku-4-5", framework: "langgraph" },
  { name: "crm-sync", model: "gemini-3-pro", framework: "custom" },
];

/** Small deterministic PRNG so every simulation run produces the same data. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimulatedReport {
  scenario: string;
  account: string;
  apiKey: string;
  submission: FeedbackSubmission;
  /** Minutes before "now" the report was sent, to spread activity over two weeks. */
  minutesAgo: number;
}

/** Expand the scenarios into a deterministic list of agent reports from ~18 customer accounts. */
export function simulate(seed = 7): SimulatedReport[] {
  const random = rng(seed);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
  const accounts = Array.from({ length: 18 }, (_, i) => `acme_live_customer${String(i + 1).padStart(2, "0")}`);
  const out: SimulatedReport[] = [];
  for (const scenario of SCENARIOS) {
    for (let run = 0; run < scenario.runs; run++) {
      const apiKey = pick(accounts);
      const agent = pick(AGENTS);
      const report = pick(scenario.reports);
      const sessionId = `sess_${scenario.key}_${run}`;
      const submission: FeedbackSubmission = {
        ...report,
        goal: pick(scenario.goals),
        session_id: sessionId,
        agent,
      };
      out.push({ scenario: scenario.key, account: apiKey, apiKey, submission, minutesAgo: Math.floor(random() * 14 * 24 * 60) });
      // Some agents retry and report the same problem twice in one run: these must be de-duplicated.
      if (random() < 0.1) {
        out.push({ scenario: scenario.key, account: apiKey, apiKey, submission: { ...submission }, minutesAgo: 0 });
      }
    }
  }
  return out;
}
