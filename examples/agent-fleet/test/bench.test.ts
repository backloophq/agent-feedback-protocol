import { AGENT_FEEDBACK_INSTRUCTIONS, memorySink } from "@backloop/sdk";
import { describe, expect, it } from "vitest";
import { createApp, FEEDBACK_HINT } from "../../acme-api/src/app.js";
import {
  ARMS,
  OPENAPI_WITHOUT_FEEDBACK,
  TASKS,
  createTrial,
  score,
  summarize,
  systemPrompt,
  type ArmName,
  type Result,
  type Trial,
} from "../src/bench/trial.js";

const arm = (name: ArmName) => ARMS.find((a) => a.name === name)!;
const task = (name: string) => TASKS.find((t) => t.name === name)!;
const AUTH = { authorization: "Bearer acme_live_test" };

async function get(app: ReturnType<typeof createApp>, path: string) {
  const res = await app.fetch(new Request(`http://acme.test${path}`, { headers: AUTH }));
  return { status: res.status, link: res.headers.get("link"), body: (await res.json()) as Record<string, unknown> };
}

// A scripted agent: calls the trial's tools the way a model would.
function call(trial: Trial, tool: string, input: Record<string, unknown>): Promise<unknown> {
  const t = trial.tools.find((x) => x.name === tool);
  if (!t) throw new Error(`no ${tool} tool in this arm`);
  return Promise.resolve(t.run(input as never));
}

const REPORT = {
  type: "missing_capability",
  goal: "Find companies hiring GTM engineers",
  message: "No way to filter companies by the roles they are hiring for; hiring_role is ignored",
  endpoint: "/companies/search",
  suggestion: "Add a hiring_role filter",
};

describe("Acme API feedback channels", () => {
  it("keeps the spec's default: a Link header on every error, nothing in bodies", async () => {
    const app = createApp({ onRecord: memorySink() });
    const bad = await get(app, "/companies/search?country=Germany");
    expect(bad.status).toBe(400);
    expect(bad.link).toBe('</feedback>; rel="agent-feedback"');
    expect(bad.body).toEqual({ error: "invalid request" });
    expect((await get(app, "/jobs")).link).toContain("agent-feedback");
    const ignored = await get(app, "/companies/search?hiring_role=gtm_engineer");
    expect(ignored.status).toBe(200);
    expect(ignored.body.feedback).toBeUndefined();
  });

  it("drops the Link header when told to", async () => {
    const app = createApp({ onRecord: memorySink(), linkHeader: false });
    expect((await get(app, "/companies/search?country=Germany")).link).toBeNull();
  });

  it("puts the hint in bodies where an agent is likely stuck, and nowhere else", async () => {
    const app = createApp({ onRecord: memorySink(), bodyHints: true });
    expect((await get(app, "/companies/search?country=Germany")).body.feedback).toEqual(FEEDBACK_HINT);
    const ignored = await get(app, "/companies/search?hiring_role=gtm_engineer&industry=saas");
    expect(ignored.body.ignored_parameters).toEqual(["hiring_role"]);
    expect(ignored.body.feedback).toEqual(FEEDBACK_HINT);
    expect((await get(app, "/companies/search?q=nothing-matches")).body.feedback).toEqual(FEEDBACK_HINT);
    expect((await get(app, "/companies/search?industry=saas")).body.feedback).toBeUndefined();
  });
});

describe("arms", () => {
  it("never mentions feedback to an agent unless the arm does", () => {
    for (const name of ["none", "link", "hint", "tool"] as const) {
      expect(systemPrompt(arm(name))).not.toMatch(/feedback/i);
    }
    expect(OPENAPI_WITHOUT_FEEDBACK).toContain("/companies/{id}/jobs:");
    expect(systemPrompt(arm("docs"))).toContain("/feedback:");
    expect(systemPrompt(arm("instructed"))).toContain(AGENT_FEEDBACK_INSTRUCTIONS);
    // In the docs, the instructions sit inside info.description and the /feedback path is listed.
    const docs = systemPrompt(arm("docs-instructed"));
    expect(docs).toContain("  description: |\n    Search companies, their people and their open jobs.\n\n    ## Reporting feedback");
    expect(docs).toContain("/feedback:");
    expect(docs).not.toContain(`\n${AGENT_FEEDBACK_INSTRUCTIONS}`);
  });

  it("gives the feedback tool only to the tool arms", () => {
    for (const a of ARMS) {
      const names = createTrial(a, { model: "test" }).tools.map((t) => t.name);
      expect(names).toEqual(a.tool ? ["http_request", "submit_feedback"] : ["http_request"]);
    }
  });
});

describe("tasks", () => {
  it("expect the answers the Acme data gives", () => {
    const names = (name: string) => task(name).answer.include.map(([companyName]) => companyName);
    expect(names("hiring-role")).toEqual([
      "Northwind Analytics",
      "Lumen Pay",
      "Canopy CRM",
      "Tessellate AI",
      "Pivotal Ops",
      "Stackwise",
    ]);
    expect(names("country-name")).toEqual(["Lumen Pay", "Meridian Bank"]);
    expect(names("employee-count")).toEqual(["Helix Security", "Signal Ridge"]);
  });
});

describe("a trial", () => {
  it("scores an agent that finds the hint and reports the gap", async () => {
    const trial = createTrial(arm("hint"), { model: "test" });
    const out = String(
      await call(trial, "http_request", { method: "GET", path: "/companies/search", query: { hiring_role: "gtm_engineer" } }),
    );
    expect(out).toMatch(/^HTTP 200\n/);
    expect(out).toContain('"ignored_parameters":["hiring_role"]');
    expect(String(await call(trial, "http_request", { method: "POST", path: "/feedback", body: REPORT }))).toMatch(/^HTTP 202/);

    const answer = "Northwind Analytics, Lumen Pay, Canopy CRM, Tessellate AI, Pivotal Ops and Stackwise.";
    const s = score(arm("hint"), task("hiring-role"), trial, answer);
    expect(s).toMatchObject({ hit_gap: true, saw_channel: true, attempted: true, reported: true, on_target: true, answer_correct: true });
    expect(trial.records[0]?.feedback.message).toBe(REPORT.message);
  });

  it("does not count a silent 200 as showing the channel when only errors carry it", async () => {
    const trial = createTrial(arm("link"), { model: "test" });
    await call(trial, "http_request", { method: "GET", path: "/companies/search?hiring_role=gtm_engineer" });
    expect(score(arm("link"), task("hiring-role"), trial, "").saw_channel).toBe(false);

    await call(trial, "http_request", { method: "GET", path: "/companies/search", query: { country: "Germany" } });
    const s = score(arm("link"), task("country-name"), trial, "");
    expect(s).toMatchObject({ hit_gap: true, saw_channel: true, attempted: false, reported: false });
  });

  it("records reports sent through the submit_feedback tool", async () => {
    const trial = createTrial(arm("tool"), { model: "claude-test" });
    const ack = JSON.parse(String(await call(trial, "submit_feedback", REPORT))) as { status: string };
    expect(ack.status).toBe("accepted");
    expect(trial.records[0]?.feedback.agent?.model).toBe("claude-test");
    expect(score(arm("tool"), task("hiring-role"), trial, "")).toMatchObject({ attempted: true, reported: true, on_target: true });
  });

  it("counts a rejected report as attempted, not reported", async () => {
    const trial = createTrial(arm("docs"), { model: "test" });
    expect(String(await call(trial, "http_request", { method: "POST", path: "/feedback", body: { note: "hi" } }))).toMatch(/^HTTP 400/);
    expect(score(arm("docs"), task("hiring-role"), trial, "")).toMatchObject({ attempted: true, reported: false });
  });

  it("keeps the agent on the Acme API", async () => {
    const trial = createTrial(arm("none"), { model: "test" });
    expect(await call(trial, "http_request", { method: "GET", path: "http://elsewhere.test/x" })).toMatch(/^Error/);
    expect(trial.calls).toEqual([]);
  });

  it("scores the ANSWER line, so context around it does not count against the agent", () => {
    const trial = { calls: [], records: [] };
    const correct = (text: string) => score(arm("none"), task("country-name"), trial, text).answer_correct;
    expect(correct("Ledgerly is French, so it is out.\n\n**ANSWER:** Lumen Pay, Meridian Bank")).toBe(true);
    expect(correct("ANSWER: Lumen Pay, Meridian Bank, Ledgerly")).toBe(false);
    expect(correct("ANSWER: Lumen Pay")).toBe(false);
    expect(correct("ANSWER: Lumen Pay, meridianbank.de")).toBe(true);
    // Without an ANSWER line, the whole message is checked.
    expect(correct("Lumen Pay and Meridian Bank")).toBe(true);
    expect(correct("Lumen Pay, Meridian Bank, Ledgerly")).toBe(false);
  });
});

describe("summary", () => {
  it("reports rates among runs that hit a gap, and false alarms on the control", () => {
    const base = {
      model: "m",
      trial: 1,
      stop_reason: "end_turn",
      iterations: 3,
      calls: 2,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      cost_usd: 0.1,
      final_text: "",
      trace: [],
      saw_channel: true,
      attempted: false,
      on_target: false,
      answer_correct: false,
      reports: [],
    };
    const results: Result[] = [
      { ...base, arm: "link", task: "hiring-role", hit_gap: true, reported: true, attempted: true, on_target: true },
      { ...base, arm: "link", task: "hiring-role", hit_gap: true, reported: false, answer_correct: true },
      { ...base, arm: "link", task: "country-name", hit_gap: false, reported: false },
      { ...base, arm: "link", task: "control", hit_gap: false, reported: true },
      // A real gap seen during the control task is not a false alarm.
      { ...base, arm: "link", task: "control", hit_gap: false, reported: true, reports: [{ type: "bug", message: "employee_count is a string range, not an integer" }] },
    ];
    const md = summarize(results);
    expect(md).toContain("| link | 2 | 50% (1/2) | 50% (1/2) | 50% (1/2) | 100% (2/2) | 1/2 |");
    expect(md).toContain("| link | 1/2 | – |");
    expect(md).toContain("5 runs, 0 failed and left out, cost $0.50.");
  });
});
