/**
 * Report-rate benchmark: when an agent runs into a gap in an API, how often does it
 * tell the API? Real Claude agents do real tasks against the Acme Companies API, which
 * has deliberate gaps. Each arm gives them a different way to learn that POST /feedback
 * exists, from nothing at all to a tool plus explicit instructions (see trial.ts).
 *
 *   pnpm bench --dry-run                              the grid, without calling the API
 *   pnpm bench --trials 3                             every arm and task on claude-opus-5-5
 *   pnpm bench --models claude-opus-5-5,gpt-5.4-2026-03-05 --arms link,hint --tasks hiring-role
 *   pnpm bench --summarize .backloop/bench/<run>      re-score answers, rebuild summary.md
 *
 * Models named claude-* run on the Claude API (ANTHROPIC_API_KEY); anything else on OpenAI's
 * Chat Completions (OPENAI_API_KEY). Results go to .backloop/bench/<timestamp>/.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { AGENT_FEEDBACK_INSTRUCTIONS, FEEDBACK_TOOL_DESCRIPTION } from "@backloop/sdk";
import { checkOpenAIModel, runOpenAI } from "./openai.js";
import {
  ARMS,
  TASKS,
  answerCorrect,
  createTrial,
  score,
  summarize,
  type AgentRun,
  type Arm,
  type Result,
  type Task,
  type Trial,
  type Usage,
} from "./trial.js";

/**
 * USD per million tokens, list prices as of 2026-09. Claude cache writes cost 1.25× input;
 * OpenAI caches for free. Dated model IDs fall back to their undated name.
 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02 },
};
const priceOf = (model: string) => PRICES[model] ?? PRICES[model.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
const isClaude = (model: string) => model.startsWith("claude-");
const guidance = createHash("sha256").update(AGENT_FEEDBACK_INSTRUCTIONS).update(FEEDBACK_TOOL_DESCRIPTION).digest("hex").slice(0, 8);

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

// pnpm passes a leading "--" through; parseArgs would read everything after it as positionals.
const argv = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--"));
const { values } = parseArgs({
  args: argv,
  options: {
    models: { type: "string", default: "claude-opus-5-5" },
    arms: { type: "string", default: ARMS.map((a) => a.name).join(",") },
    tasks: { type: "string", default: TASKS.map((t) => t.name).join(",") },
    trials: { type: "string", default: "3" },
    concurrency: { type: "string", default: "4" },
    "max-iterations": { type: "string", default: "30" },
    effort: { type: "string" },
    out: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    summarize: { type: "string" },
  },
});

if (values.summarize) {
  const results = readFileSync(join(values.summarize, "results.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Result);
  // Re-score answers with the current rules; the rest needs the run's full reports.
  for (const r of results) {
    const task = TASKS.find((t) => t.name === r.task);
    if (task) r.answer_correct = answerCorrect(task, r.final_text);
  }
  const summary = summarize(results);
  writeFileSync(join(values.summarize, "summary.md"), summary);
  console.log(summary);
  process.exit(0);
}

function pick<T extends { name: string }>(all: T[], list: string, what: string): T[] {
  return list.split(",").map((name) => {
    const found = all.find((x) => x.name === name.trim());
    if (!found) throw new Error(`Unknown ${what} "${name}". Known: ${all.map((x) => x.name).join(", ")}`);
    return found;
  });
}

const models = values.models.split(",").map((m) => m.trim());
const arms = pick(ARMS, values.arms, "arm");
const tasks = pick(TASKS, values.tasks, "task");
const trials = Number(values.trials);
const concurrency = Number(values.concurrency);
const maxIterations = Number(values["max-iterations"]);
const effort = values.effort as Effort | undefined;
if (effort && !EFFORTS.includes(effort)) throw new Error(`--effort must be one of ${EFFORTS.join(", ")}`);

interface Job {
  model: string;
  arm: Arm;
  task: Task;
  trial: number;
}

const jobs: Job[] = [];
// Trial by trial, models interleaved: providers share the load, and a stopped run stays balanced.
for (let trial = 1; trial <= trials; trial++)
  for (const arm of arms)
    for (const task of tasks) for (const model of models) jobs.push({ model, arm, task, trial });

console.log(
  `${jobs.length} runs: ${models.length} model(s) × ${arms.length} arm(s) × ${tasks.length} task(s) × ${trials} trial(s), ` +
    `up to ${maxIterations} requests each, ${concurrency} at a time.`,
);
for (const model of models) if (!priceOf(model)) console.log(`No price for ${model}: its cost will show as unknown.`);
if (values["dry-run"]) process.exit(0);

function costOf(model: string, u: Usage): number | null {
  const p = priceOf(model);
  if (!p) return null;
  const input = u.input_tokens * p.input + u.cache_creation_input_tokens * p.input * 1.25;
  return (input + u.cache_read_input_tokens * p.cacheRead + u.output_tokens * p.output) / 1e6;
}

const client = new Anthropic({ maxRetries: 6 });

// Free, and catches a missing key or a mistyped model before any run is paid for.
for (const model of models) {
  try {
    if (isClaude(model)) await client.models.retrieve(model);
    else await checkOpenAIModel(model);
  } catch (err) {
    console.error(`Cannot use ${model}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`Set ${isClaude(model) ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} (in .env or the environment) and check the model ID.`);
    process.exit(1);
  }
}

async function runClaude(model: string, trial: Trial, prompt: string, progress: AgentRun): Promise<void> {
  // No refusal fallbacks: a fallback would answer with another model and blur the per-model numbers.
  // A refusal is recorded as the run's stop_reason instead.
  const runner = client.beta.messages.toolRunner({
    model,
    max_tokens: 16000,
    max_iterations: maxIterations,
    cache_control: { type: "ephemeral" },
    ...(effort ? { output_config: { effort } } : {}),
    system: trial.system,
    tools: trial.tools,
    messages: [{ role: "user", content: prompt }],
  });
  for await (const message of runner) {
    progress.iterations++;
    progress.usage.input_tokens += message.usage.input_tokens;
    progress.usage.output_tokens += message.usage.output_tokens;
    progress.usage.cache_creation_input_tokens += message.usage.cache_creation_input_tokens ?? 0;
    progress.usage.cache_read_input_tokens += message.usage.cache_read_input_tokens ?? 0;
    progress.stopReason = message.stop_reason;
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    if (text.trim()) progress.finalText = text;
  }
}

async function run({ model, arm, task, trial: n }: Job): Promise<Result> {
  const framework = isClaude(model) ? "anthropic-sdk-tool-runner" : "openai-chat-completions";
  const trial = createTrial(arm, { model, framework });
  const progress: AgentRun = {
    iterations: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    stopReason: null,
    finalText: "",
  };
  let error: string | undefined;
  try {
    if (isClaude(model)) await runClaude(model, trial, task.prompt, progress);
    else await runOpenAI(model, trial, task.prompt, { maxIterations, effort }, progress);
  } catch (err) {
    error = err instanceof Anthropic.APIError ? `${err.status ?? ""} ${err.message}`.trim() : String(err);
  }

  return {
    model,
    guidance,
    arm: arm.name,
    task: task.name,
    trial: n,
    ...score(arm, task, trial, progress.finalText),
    stop_reason: progress.stopReason,
    iterations: progress.iterations,
    calls: trial.calls.length,
    usage: progress.usage,
    cost_usd: costOf(model, progress.usage),
    ...(error ? { error } : {}),
    final_text: progress.finalText,
    trace: trial.calls,
  };
}

const outDir = values.out ?? join(".backloop/bench", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(outDir, { recursive: true });
const resultsFile = join(outDir, "results.jsonl");
writeFileSync(resultsFile, "");

const results: Result[] = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++]!;
    const result = await run(job);
    results.push(result);
    appendFileSync(resultsFile, `${JSON.stringify(result)}\n`);
    const outcome = result.error
      ? `failed: ${result.error}`
      : `${result.reported ? (result.on_target ? "reported" : "reported (off target)") : "no report"}, ` +
        `${result.answer_correct ? "right answer" : "wrong answer"}, ${result.calls} calls`;
    console.log(`[${results.length}/${jobs.length}] ${job.model} ${job.arm.name} ${job.task.name} #${job.trial}: ${outcome}`);
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

const summary = summarize(results);
writeFileSync(join(outDir, "summary.md"), summary);
console.log(`\n${summary}\nResults: ${resultsFile}`);
