/**
 * The report-rate benchmark without the model: the discovery arms, the tasks, one trial's
 * environment (the Acme API in process, the agent's tools, a trace of every call), scoring
 * and the summary. run.ts drives it with real Claude agents.
 */
import { readFileSync } from "node:fs";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import {
  AGENT_FEEDBACK_INSTRUCTIONS,
  FEEDBACK_TOOL_DESCRIPTION,
  FeedbackClient,
  feedbackToolInputSchema,
  memorySink,
  newId,
  WELL_KNOWN_PATH,
  type FeedbackRecord,
  type FeedbackSubmission,
} from "@backloop/sdk";
import { createApp } from "../../../acme-api/src/app.js";
import { companies as acmeCompanies } from "../../../acme-api/src/data.js";

const BASE_URL = "http://acme.test";
const API_KEY = "acme_live_bench";

// ── Arms: how the agent can learn that POST /feedback exists ────────────────

export type ArmName = "none" | "docs" | "docs-instructed" | "link" | "hint" | "tool" | "instructed";

export interface Arm {
  name: ArmName;
  summary: string;
  /** The API docs in the system prompt describe POST /feedback. */
  docs: boolean;
  /** The docs also carry AGENT_FEEDBACK_INSTRUCTIONS, at the end of info.description. */
  docsInstructions: boolean;
  /** `Link: </feedback>; rel="agent-feedback"` on every error, as the spec says today. */
  linkHeader: boolean;
  /** A feedback hint in error bodies, and in searches that ignored a parameter or found nothing. */
  bodyHints: boolean;
  /** A `submit_feedback` tool next to `http_request`, as an MCP server would expose it. */
  tool: boolean;
  /** The standard AGENT_FEEDBACK_INSTRUCTIONS in the system prompt. */
  instructions: boolean;
}

const off = { docs: false, docsInstructions: false, linkHeader: false, bodyHints: false, tool: false, instructions: false };

export const ARMS: Arm[] = [
  { name: "none", summary: "The endpoint exists, nothing mentions it", ...off },
  { name: "docs", summary: "The API docs list POST /feedback", ...off, docs: true },
  { name: "docs-instructed", summary: "The API docs list POST /feedback and carry the standard instructions", ...off, docs: true, docsInstructions: true },
  { name: "link", summary: "Link header on every error (the spec today)", ...off, linkHeader: true },
  { name: "hint", summary: "Link header, plus a hint in the body when the agent is likely stuck", ...off, linkHeader: true, bodyHints: true },
  { name: "tool", summary: "A submit_feedback tool, no instructions", ...off, tool: true },
  { name: "instructed", summary: "The tool, plus the standard instructions in the system prompt", ...off, tool: true, instructions: true },
];

// ── Tasks: real requests that run into the Acme API's deliberate gaps ──────

/** A company in acme-api/src/data.js (TypeScript cannot infer it from the JS tuples). */
interface Company {
  name: string;
  domain: string;
  industry: string;
  country: string;
  employee_count: string;
  jobs: Array<{ title: string; role: string }>;
}
const companies = acmeCompanies as unknown as Company[];

export interface Task {
  name: string;
  prompt: string;
  /** What in the API gets in the way, or null for the control task. */
  gap: string | null;
  /** Whether a run ran into the gap. */
  hitGap: (calls: Call[]) => boolean;
  /** Whether a report is about the gap. The goal is left out: it restates the task. */
  onTarget: (feedback: FeedbackSubmission) => boolean;
  /**
   * What a correct answer names, and what it must not. Each entry lists the ways to name
   * one thing: a company's name or its domain.
   */
  answer: { include: string[][]; exclude: string[][] };
}

function answerFor(pick: (c: Company) => boolean): Task["answer"] {
  return {
    include: companies.filter(pick).map((c) => [c.name, c.domain]),
    exclude: companies.filter((c) => !pick(c)).map((c) => [c.name, c.domain]),
  };
}

function about(pattern: RegExp): (feedback: FeedbackSubmission) => boolean {
  return (f) =>
    pattern.test([f.message, f.expected, f.suggestion, f.workaround_description, f.endpoint].filter(Boolean).join(" "));
}

export const TASKS: Task[] = [
  {
    name: "hiring-role",
    prompt: "Find the companies that are currently hiring GTM engineers. Give me their names and domains.",
    gap: "/companies/search cannot filter by hiring role, and ignores unknown parameters without saying so",
    hitGap: () => true,
    onTarget: about(/hir(e|ing)|role|job|position|opening|recruit/i),
    answer: answerFor((c) => c.jobs.some((j) => j.role === "gtm_engineer")),
  },
  {
    name: "country-name",
    prompt: "Which fintech companies are based in Germany? Give me their names and domains.",
    gap: "`country` only takes ISO codes, and a country name fails with a bare `invalid request`",
    hitGap: (calls) => calls.some((c) => c.path === "/companies/search" && c.status === 400 && "country" in c.query),
    onTarget: about(/country|iso|germany|invalid request|error/i),
    answer: answerFor((c) => c.industry === "fintech" && c.country === "DE"),
  },
  {
    name: "employee-count",
    prompt: "Find SaaS companies with more than 200 employees. Give me their names and domains.",
    gap: "`employee_count` is a size band string though the docs say integer, and search cannot filter by size",
    hitGap: (calls) => calls.some((c) => c.path.startsWith("/companies") && c.status === 200),
    onTarget: about(/employee|headcount|size|band|integer/i),
    answer: answerFor((c) => c.industry === "saas" && Number.parseInt(c.employee_count, 10) > 200),
  },
  {
    name: "control",
    prompt: "What is Canopy CRM's domain, and how many open jobs does it have?",
    gap: null,
    hitGap: () => false,
    onTarget: () => false,
    answer: { include: [["canopycrm.com"], ["2"]], exclude: [] },
  },
];

// ── One trial ───────────────────────────────────────────────────────────────

export interface Call {
  tool: "http_request" | "submit_feedback";
  method: string;
  path: string;
  query: Record<string, string>;
  status: number;
  /** The response carried the Link header or the body hint. */
  channel: boolean;
}

const OPENAPI = readFileSync(new URL("../../../acme-api/docs/openapi.yaml", import.meta.url), "utf8");

/** The same docs with the /feedback path taken out. */
export const OPENAPI_WITHOUT_FEEDBACK = (() => {
  const start = OPENAPI.indexOf("  /feedback:\n");
  const end = OPENAPI.indexOf("components:\n");
  if (start < 0 || end < start) throw new Error("acme-api/docs/openapi.yaml changed: cannot find its /feedback path");
  return OPENAPI.slice(0, start) + OPENAPI.slice(end);
})();

/** The docs with the standard instructions at the end of info.description, where a service would put them. */
export const OPENAPI_WITH_INSTRUCTIONS = (() => {
  const line = "  description: Search companies, their people and their open jobs.\n";
  if (!OPENAPI.includes(line)) throw new Error("acme-api/docs/openapi.yaml changed: cannot find info.description");
  const indented = AGENT_FEEDBACK_INSTRUCTIONS.split("\n").map((l) => (l ? `    ${l}` : "")).join("\n");
  return OPENAPI.replace(line, `  description: |\n    Search companies, their people and their open jobs.\n\n${indented}\n`);
})();

export function systemPrompt(arm: Arm): string {
  const parts = [
    "You are a research agent for a sales team. You work through the Acme Companies API with the http_request tool; " +
      "authentication is added for you. Work on your own: nobody can answer questions during the task. " +
      "End your final message with one line that starts with `ANSWER:` and gives just the answer, " +
      "such as the company names, comma-separated.",
    `<api_docs>\n${arm.docsInstructions ? OPENAPI_WITH_INSTRUCTIONS : arm.docs ? OPENAPI : OPENAPI_WITHOUT_FEEDBACK}</api_docs>`,
  ];
  if (arm.instructions) parts.push(AGENT_FEEDBACK_INSTRUCTIONS);
  return parts.join("\n\n");
}

interface HttpInput {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

// Typed loosely on purpose, as in claude-agent.ts.
const HTTP_SCHEMA = {
  type: "object",
  properties: {
    method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
    path: { type: "string", description: "Path on the Acme API, such as /companies/search" },
    query: { type: "object", description: "Query parameters, as name/value pairs" },
    body: { type: "object", description: "JSON body" },
  },
  required: ["method", "path"],
} as { type: "object"; properties: Record<string, object>; required: string[] };

function hasBodyHint(text: string): boolean {
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === "object" && body !== null && "feedback" in body;
  } catch {
    return false;
  }
}

/** A fresh Acme API for one run, the agent's tools, and what the run did. */
export function createTrial(arm: Arm, agent: { model: string; framework?: string }) {
  const sink = memorySink();
  const app = createApp({ onRecord: sink, linkHeader: arm.linkHeader, bodyHints: arm.bodyHints, rateLimit: false });
  const fetchApp = async (input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init));
  const calls: Call[] = [];

  async function request({ method, path, query, body }: HttpInput): Promise<string> {
    const url = new URL(path, BASE_URL);
    if (url.origin !== BASE_URL) return "Error: `path` must be a path on the Acme API, such as /companies/search";
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, String(value));
    const hasBody = body !== undefined && method !== "GET";
    const response = await fetchApp(url, {
      method,
      headers: { authorization: `Bearer ${API_KEY}`, ...(hasBody ? { "content-type": "application/json" } : {}) },
      body: hasBody ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    calls.push({
      tool: "http_request",
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      status: response.status,
      channel: /rel="?agent-feedback/.test(response.headers.get("link") ?? "") || hasBodyHint(text),
    });
    const headers: string[] = [];
    response.headers.forEach((value, name) => headers.push(`${name}: ${value}`));
    return `HTTP ${response.status}\n${headers.join("\n")}\n\n${text}`;
  }

  const tools = [
    betaTool({
      name: "http_request",
      description: "Call the Acme Companies API. Returns the status, the response headers and the body.",
      inputSchema: HTTP_SCHEMA,
      run: async (input) => request(input as unknown as HttpInput),
    }),
  ];

  if (arm.tool) {
    const client = new FeedbackClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      sessionId: newId("sess"),
      agent: { name: "backloop-bench", ...agent },
      fetch: fetchApp,
    });
    tools.push(
      betaTool({
        name: "submit_feedback",
        description: FEEDBACK_TOOL_DESCRIPTION,
        inputSchema: feedbackToolInputSchema() as { type: "object" },
        run: async (input) => {
          const result = await client.trySubmit(input as unknown as FeedbackSubmission);
          calls.push({
            tool: "submit_feedback",
            method: "POST",
            path: "/feedback",
            query: {},
            status: result.ok ? 202 : (result.error.status ?? 400),
            channel: true,
          });
          return JSON.stringify(result.ok ? result.ack : { error: result.error.message });
        },
      }),
    );
  }

  return { system: systemPrompt(arm), tools, calls, records: sink.records as FeedbackRecord[] };
}

export type Trial = ReturnType<typeof createTrial>;

// ── Scoring ─────────────────────────────────────────────────────────────────

export interface Score {
  hit_gap: boolean;
  /** The agent was shown the channel: by the arm itself, by a response, or by finding /feedback. */
  saw_channel: boolean;
  /** Called submit_feedback or POSTed /feedback, accepted or not. */
  attempted: boolean;
  /** At least one report was accepted. */
  reported: boolean;
  /** An accepted report is about this task's gap. */
  on_target: boolean;
  /** The ANSWER line (or, without one, the whole final message) names everything expected and no other company. */
  answer_correct: boolean;
  reports: Array<Pick<FeedbackSubmission, "type" | "endpoint" | "message" | "suggestion" | "outcome">>;
}

/** The last `ANSWER:` line of a final message, or the whole message if it has none. */
export function answerText(finalText: string): string {
  const lines = [...finalText.matchAll(/^[\s*_#>-]*ANSWER\s*[:：]\s*(.*)$/gim)];
  return (lines.at(-1)?.[1] ?? finalText).toLowerCase();
}

export function answerCorrect(task: Task, finalText: string): boolean {
  const text = answerText(finalText);
  const named = (ways: string[]) => ways.some((w) => text.includes(w.toLowerCase()));
  return task.answer.include.every(named) && !task.answer.exclude.some(named);
}

export function score(arm: Arm, task: Task, trial: Pick<Trial, "calls" | "records">, finalText: string): Score {
  const reports = trial.records.map((r) => r.feedback);
  const found = trial.calls.some((c) => c.channel || c.path === "/feedback" || c.path === WELL_KNOWN_PATH);
  return {
    hit_gap: task.hitGap(trial.calls),
    saw_channel: arm.docs || arm.tool || arm.instructions || found,
    attempted: trial.calls.some((c) => c.method === "POST" && c.path === "/feedback"),
    reported: reports.length > 0,
    on_target: reports.some(task.onTarget),
    answer_correct: answerCorrect(task, finalText),
    reports: reports.map(({ type, endpoint, message, suggestion, outcome }) => ({ type, endpoint, message, suggestion, outcome })),
  };
}

// ── Results ─────────────────────────────────────────────────────────────────

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** What an agent loop reports back. Updated as it goes, so a failed run keeps its usage. */
export interface AgentRun {
  iterations: number;
  usage: Usage;
  stopReason: string | null;
  finalText: string;
}

export interface Result extends Score {
  model: string;
  /** Short hash of the instructions and tool description the run used, to tell text versions apart. */
  guidance?: string;
  arm: ArmName;
  task: string;
  trial: number;
  stop_reason: string | null;
  iterations: number;
  calls: number;
  usage: Usage;
  cost_usd: number | null;
  error?: string;
  final_text: string;
  trace: Call[];
}

/**
 * A control run that reported something none of the known gaps explain. Reporting a gap the
 * control task happens to show (every company carries the employee_count mismatch) is not one.
 */
function falseAlarm(r: Result): boolean {
  return r.reported && !r.reports.some((f) => TASKS.some((t) => t.gap && t.onTarget(f as FeedbackSubmission)));
}

const pct = (n: number, of: number) => (of === 0 ? "–" : `${Math.round((100 * n) / of)}% (${n}/${of})`);

/** Markdown tables: one section per model, one row per arm. */
export function summarize(results: Result[]): string {
  const out: string[] = [];
  const models = [...new Set(results.map((r) => r.model))];
  const gapTasks = TASKS.filter((t) => t.gap && results.some((r) => r.task === t.name));

  for (const model of models) {
    const mine = results.filter((r) => r.model === model && !r.error);
    const arms = ARMS.filter((a) => mine.some((r) => r.arm === a.name));
    out.push(`## ${model}`, "");
    out.push("Among runs that hit a gap:", "");
    out.push("| Channel | Runs | Reported | On target | Worked around, said nothing | Saw the channel | False alarms (control) |");
    out.push("|---|---|---|---|---|---|---|");
    for (const arm of arms) {
      const runs = mine.filter((r) => r.arm === arm.name);
      const hit = runs.filter((r) => r.task !== "control" && r.hit_gap);
      const control = runs.filter((r) => r.task === "control");
      out.push(
        `| ${arm.name} | ${hit.length} | ${pct(hit.filter((r) => r.reported).length, hit.length)} | ` +
          `${pct(hit.filter((r) => r.on_target).length, hit.length)} | ` +
          `${pct(hit.filter((r) => r.answer_correct && !r.reported).length, hit.length)} | ` +
          `${pct(hit.filter((r) => r.saw_channel).length, hit.length)} | ` +
          `${control.length ? `${control.filter(falseAlarm).length}/${control.length}` : "–"} |`,
      );
    }
    if (gapTasks.length > 1) {
      out.push("", "Reported, by task (runs that hit the gap):", "");
      out.push(`| Channel | ${gapTasks.map((t) => t.name).join(" | ")} |`);
      out.push(`|---|${gapTasks.map(() => "---").join("|")}|`);
      for (const arm of arms) {
        const cells = gapTasks.map((t) => {
          const hit = mine.filter((r) => r.arm === arm.name && r.task === t.name && r.hit_gap);
          return hit.length ? `${hit.filter((r) => r.reported).length}/${hit.length}` : "–";
        });
        out.push(`| ${arm.name} | ${cells.join(" | ")} |`);
      }
    }
    out.push("");
  }

  const errors = results.filter((r) => r.error).length;
  const costs = results.map((r) => r.cost_usd);
  const cost = costs.every((c) => c !== null) ? `$${costs.reduce<number>((a, c) => a + (c ?? 0), 0).toFixed(2)}` : "unknown";
  out.push(`${results.length} runs, ${errors} failed and left out, cost ${cost}.`, "");
  out.push("Channels:", "", ...ARMS.map((a) => `- **${a.name}**: ${a.summary}`), "");
  out.push("Gaps:", "", ...TASKS.map((t) => `- **${t.name}**: ${t.gap ?? "none of its own (control)"}`));
  out.push("", "False alarms: control runs that reported something none of the known gaps explain.");
  return `${out.join("\n")}\n`;
}
