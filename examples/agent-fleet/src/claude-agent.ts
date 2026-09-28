/**
 * A real Claude agent doing a real task against the Acme Companies API, with
 * the Agent Feedback Protocol's instructions and `submit_feedback` tool.
 * When it hits the missing hiring-role filter, it reports it.
 *
 *   ANTHROPIC_API_KEY=... tsx src/claude-agent.ts ["your task"]
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import {
  AGENT_FEEDBACK_INSTRUCTIONS,
  FeedbackClient,
  FEEDBACK_TOOL_DESCRIPTION,
  feedbackToolInputSchema,
  newId,
  type FeedbackSubmission,
} from "@backloop/sdk";

const ACME_URL = process.env.ACME_URL ?? "http://localhost:4610";
const API_KEY = process.env.ACME_API_KEY ?? "acme_live_customer01";
const task = process.argv[2] ?? "Find companies currently hiring GTM engineers. Give me their names and domains.";

async function acme(path: string): Promise<string> {
  const res = await fetch(`${ACME_URL}${path}`, { headers: { authorization: `Bearer ${API_KEY}` } });
  const body = await res.text();
  const link = res.headers.get("link");
  return `HTTP ${res.status}${link ? `\nLink: ${link}` : ""}\n${body}`;
}

const feedback = new FeedbackClient({
  baseUrl: ACME_URL,
  apiKey: API_KEY,
  sessionId: newId("sess"),
  agent: { name: "acme-demo-agent", model: "claude-opus-5", framework: "anthropic-sdk-tool-runner" },
});

// Typed loosely on purpose: deep JSON-Schema type inference is not worth it here.
const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    q: { type: "string" },
    industry: { type: "string" },
    country: { type: "string" },
    page: { type: "integer" },
    per_page: { type: "integer" },
    extra_params: { type: "object", description: "Any other query parameters to try, as name/value pairs" },
  },
} as { type: "object"; properties: Record<string, object> };

const tools = [
  betaTool({
    name: "search_companies",
    description:
      "GET /companies/search. Query parameters: q (matches company names), industry (saas|fintech|healthcare|logistics|ecommerce|manufacturing), country (ISO code), page, per_page (max 25).",
    inputSchema: SEARCH_SCHEMA,
    run: async (args) => {
      const { extra_params, ...params } = args as Record<string, unknown> & { extra_params?: Record<string, unknown> };
      const all: Record<string, unknown> = { ...params, ...extra_params };
      const query = new URLSearchParams(Object.entries(all).map(([k, v]) => [k, String(v)]));
      return acme(`/companies/search?${query}`);
    },
  }),
  betaTool({
    name: "get_company",
    description: "GET /companies/{id}",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: async ({ id }) => acme(`/companies/${encodeURIComponent(id)}`),
  }),
  betaTool({
    name: "list_company_jobs",
    description: "GET /companies/{id}/jobs: a company's open job postings.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: async ({ id }) => acme(`/companies/${encodeURIComponent(id)}/jobs`),
  }),
  betaTool({
    name: "submit_feedback",
    description: FEEDBACK_TOOL_DESCRIPTION,
    inputSchema: feedbackToolInputSchema() as { type: "object" },
    run: async (input) => {
      const result = await feedback.trySubmit(input as unknown as FeedbackSubmission);
      console.log(`\n[feedback] ${result.ok ? `accepted ${result.ack.id}` : `failed: ${result.error.message}`}`);
      return JSON.stringify(result.ok ? result.ack : { error: result.error.message });
    },
  }),
];

const client = new Anthropic();
const runner = client.beta.messages.toolRunner({
  model: "claude-opus-5",
  max_tokens: 16000,
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
  system: `You are a sales research agent using the Acme Companies API (${ACME_URL}).\n\n${AGENT_FEEDBACK_INSTRUCTIONS}`,
  tools,
  messages: [{ role: "user", content: task }],
});

for await (const message of runner) {
  if (message.stop_reason === "refusal") {
    console.log("The model declined this request.");
    break;
  }
  for (const block of message.content) {
    if (block.type === "text" && block.text.trim()) console.log(`\n${block.text}`);
    if (block.type === "tool_use") console.log(`→ ${block.name} ${JSON.stringify(block.input)}`);
  }
}
