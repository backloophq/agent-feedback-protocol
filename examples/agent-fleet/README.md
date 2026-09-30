# Agent fleet

Agents that use the [Acme Companies API](../acme-api) and report what gets in their way.

| Command (from the repo root) | What |
|---|---|
| `pnpm demo:agents` | 67 simulated reports from 17 accounts, through the API's `POST /feedback` |
| `pnpm demo:claude-agent` | One real Claude agent on one task, with the feedback tool and instructions |
| `pnpm bench` | The report-rate benchmark, below |

## Report-rate benchmark

Agents decide whether to send feedback. This measures how often they do.

Real Claude and GPT agents do real tasks against the Acme API, which has deliberate gaps. Each run gets a fresh copy of
the API in process and a generic `http_request` tool. The arms change one thing: how the agent can learn that
`POST /feedback` exists.

| Arm | The agent can learn about feedback from |
|---|---|
| `none` | Nothing. The endpoint exists, but nothing mentions it |
| `docs` | The API docs in its prompt, which list `POST /feedback` |
| `docs-instructed` | The same docs, with the standard instructions at the end of `info.description` |
| `link` | `Link: </feedback>; rel="agent-feedback"` on every error, as the spec says today |
| `hint` | The Link header, plus a hint in the response body on errors, ignored parameters and empty searches |
| `tool` | A `submit_feedback` tool, as an MCP server would expose it, without instructions |
| `instructed` | The tool, plus `AGENT_FEEDBACK_INSTRUCTIONS` in the system prompt |

| Task | The gap |
|---|---|
| `hiring-role` | Search cannot filter by hiring role, and ignores unknown parameters without saying so. A `200`, no error |
| `country-name` | `country` only takes ISO codes; `Germany` fails with a bare `invalid request` |
| `employee-count` | `employee_count` is a size band string though the docs say integer; no size filter |
| `control` | None of its own: a plain lookup. It still shows the `employee_count` mismatch |

```bash
pnpm bench --dry-run                                   # the grid, no API calls
pnpm bench                                             # 7 arms × 4 tasks × 3 trials on claude-opus-5-5
pnpm bench --models claude-opus-5-5,claude-sonnet-5-5,gpt-5.4-2026-03-05 --trials 5
pnpm bench --arms link,hint --tasks hiring-role,country-name
pnpm bench --summarize .backloop/bench/<run>           # re-score answers, rebuild summary.md
```

Options: `--concurrency` (default 4), `--max-iterations` (API requests per run, default 30), `--effort`,
`--out`. Models named `claude-*` run on the Claude API (`ANTHROPIC_API_KEY`), anything else on OpenAI's Chat
Completions (`OPENAI_API_KEY`), with the same tools and prompt. Each run's results are appended to `.backloop/bench/<timestamp>/results.jsonl`
as they finish: the scores, the agent's final answer, every call it made and every report it sent.
`summary.md` has one table per model:

- **Reported**: runs that hit a gap and sent at least one accepted report.
- **On target**: the report is about that gap (keyword match on the report, not the goal).
- **Worked around, said nothing**: the agent got the right answer and sent nothing. The signal a service never sees.
- **Saw the channel**: the arm showed it, a response carried the Link header or the hint, or the agent found
  `/feedback` itself. For `link` and `hint`, this separates "never found out" from "found out and didn't bother".
- **False alarms**: control runs that reported something none of the known gaps explain. Every company record shows
  the `employee_count` mismatch, so reporting it during the control task is a real report, not a false alarm.

Agents end with an `ANSWER:` line, the same in every arm; a company counts when its name or domain is on it, and
naming any other company makes the answer wrong. The agent sees response headers, which favors `link`: many agent
HTTP tools only return the body.

### Results, 2026-09-30

900 runs, 5 trials per cell, $14.69. Runs that hit a gap and sent an accepted report:

| Arm | Claude Opus 5.5 | Claude Sonnet 5.5 | Claude Haiku 4.5 | GPT-5.4 | GPT-5.4-mini |
|---|---|---|---|---|---|
| `none` | 0/14 | 0/15 | 0/15 | 0/15 | 0/15 |
| `docs` | 1/14 | 0/15 | 0/15 | 1/15 | 0/15 |
| `link` | 0/15 | 0/15 | 0/15 | 0/15 | 0/15 |
| `hint` | 0/15 | 0/15 | 0/15 | 0/15 | 0/15 |
| `tool` | 15/15 | 5/15 | 0/15 | 10/15 | 5/15 |
| `docs-instructed` | 15/15 | 15/15 | 0/15 | 15/15 | 1/15 |
| `instructed` | 15/15 | 15/15 | 0/15 | 15/15 | 10/15 → 12/15 |

- Without instructions, agents worked around every gap and said nothing: 584 of the first 600 answers were right.
- The `Link` header reached agents on every error (a third of runs); none reported. No agent ever sent a parameter
  the API doesn't support, so the body hint never showed where it was meant to.
- The instructions work in the API docs as well as in the system prompt, for the models that follow them.
- Opus found the real `employee_count` mismatch during the unrelated control task in every run where it had the tool.
- `docs-instructed` and the second `instructed` figure ran with the revised instructions ("even if you found a
  workaround", "before your final answer"): no worse, and at the ceiling for the strongest models. A revised tool
  description was tried too and dropped: GPT-5.4 went 10/15 → 15/15, but Sonnet 5/15 → 1/15 and mini 5/15 → 2/15.
