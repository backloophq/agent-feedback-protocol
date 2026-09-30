/**
 * The benchmark's agent loop for OpenAI models: Chat Completions with function tools, the same
 * tools and system prompt as the Claude runs. Plain fetch, so the examples need no OpenAI package.
 */
import type { AgentRun, Trial } from "./trial.js";

const API = "https://api.openai.com/v1";

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface Completion {
  choices: Array<{ finish_reason: string; message: { content: string | null; tool_calls?: ToolCall[] } }>;
  usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } };
}

function key(): string {
  const value = process.env.OPENAI_API_KEY;
  if (!value) throw new Error("OPENAI_API_KEY is not set");
  return value;
}

async function post(path: string, body: unknown): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key()}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const wait = Number(res.headers.get("retry-after")) || 2 ** attempt * 2;
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      continue;
    }
    throw new Error(`OpenAI ${res.status}: ${text.slice(0, 300)}`);
  }
}

/** Throws if the key or the model ID is wrong. Free. */
export async function checkOpenAIModel(model: string): Promise<void> {
  const res = await fetch(`${API}/models/${encodeURIComponent(model)}`, { headers: { authorization: `Bearer ${key()}` } });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function runOpenAI(
  model: string,
  trial: Trial,
  prompt: string,
  options: { maxIterations: number; effort?: string },
  progress: AgentRun,
): Promise<void> {
  const tools = trial.tools.map((t) => {
    if (!("input_schema" in t)) throw new Error(`${t.name} is not a function tool`);
    return { type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } };
  });
  const messages: ChatMessage[] = [
    { role: "system", content: trial.system },
    { role: "user", content: prompt },
  ];

  for (let i = 0; i < options.maxIterations; i++) {
    const completion = (await post("/chat/completions", {
      model,
      messages,
      tools,
      max_completion_tokens: 16000,
      ...(options.effort ? { reasoning_effort: options.effort } : {}),
    })) as Completion;
    const choice = completion.choices[0];
    if (!choice) throw new Error("OpenAI returned no choices");
    const u = completion.usage;
    const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
    progress.iterations++;
    progress.usage.input_tokens += (u?.prompt_tokens ?? 0) - cached;
    progress.usage.cache_read_input_tokens += cached;
    progress.usage.output_tokens += u?.completion_tokens ?? 0;
    progress.stopReason = choice.finish_reason;
    if (choice.message.content?.trim()) progress.finalText = choice.message.content;

    const calls = choice.message.tool_calls ?? [];
    messages.push({ role: "assistant", content: choice.message.content, ...(calls.length ? { tool_calls: calls } : {}) });
    if (calls.length === 0) return;
    for (const call of calls) {
      const tool = trial.tools.find((t) => t.name === call.function.name);
      let output: string;
      try {
        output = tool ? String(await tool.run(JSON.parse(call.function.arguments) as never)) : `Error: no tool named ${call.function.name}`;
      } catch (err) {
        output = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
    }
  }
}
