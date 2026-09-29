# Agent Feedback Protocol

**An open protocol that lets APIs improve from agent feedback.**

AI agents are becoming major consumers of APIs. When an agent hits a missing capability, unclear docs, a surprising response or a bug, that information is lost. Your logs see the call. They don't see what the agent was trying to do.

The Agent Feedback Protocol gives every agent-facing service one standard interface, `POST /feedback`, where agents report what they were trying to do and what got in the way.

Observability answers *what failed?* Agent feedback answers *what was the user trying to do that our product couldn't do?*

[Spec](https://trybackloop.com/spec/) · [Agent instructions](https://trybackloop.com/spec/agent-instructions/) · [JSON Schema](https://trybackloop.com/schemas/agent-feedback/0.1/feedback.schema.json) · Apache-2.0

## What's in this repo

| Path | What |
|---|---|
| [`spec/`](spec) | The protocol v0.1: [spec](spec/SPEC.md), JSON Schemas, [agent instructions](spec/AGENT_INSTRUCTIONS.md), conformance suite |
| [`packages/sdk`](packages/sdk) | `@backloop/sdk`: TypeScript client, Fetch-API server handler, validation, redaction, forwarding |
| [`packages/sdk-python`](packages/sdk-python) | `backloop-sdk`: Python SDK, stdlib only, FastAPI/Flask helpers |
| [`packages/mcp`](packages/mcp) | `@backloop/mcp`: `submit_feedback` for any MCP server, plus a standalone stdio server for agents |
| [`packages/collector`](packages/collector) | `@backloop/collector`: self-hostable reference collector (JSONL, Docker) |
| [`examples/acme-api`](examples/acme-api) | Demo API that implements the protocol and has deliberate gaps |
| [`examples/agent-fleet`](examples/agent-fleet) | Simulated fleet of 67 agent reports, plus a real Claude agent |

## The protocol in one minute

```http
POST /feedback
Content-Type: application/json

{
  "type": "missing_capability",
  "goal": "Find companies currently hiring GTM engineers",
  "endpoint": "/companies/search",
  "message": "No hiring-role filter is available",
  "outcome": "blocked",
  "workaround": false,
  "suggestion": "Add a hiring_role query parameter"
}
```

```http
202 Accepted
{ "id": "fb_01JAX…", "status": "accepted", "received_at": "…",
  "known_issue": { "id": "…", "title": "Add hiring_role filter", "status": "in_progress" } }
```

- Seven types: `missing_capability`, `bug`, `unclear_documentation`, `unexpected_response`, `unhelpful_error`, `performance`, `other`.
- Discovery through `GET /.well-known/agent-feedback`, and `Link: </feedback>; rel="agent-feedback"` on every error response.
- Services turn submissions into **records** (plus `account`, `service`, `received_at`) and forward them to a collector's `POST /v1/records`.
- MCP servers expose the same schema as a `submit_feedback` tool.
- Standard [agent instructions](spec/AGENT_INSTRUCTIONS.md) tell agents when to report, and how.

Full details: [spec/SPEC.md](spec/SPEC.md).

## Add it to your API

TypeScript (any Fetch-API framework: Hono, Next.js, Bun, Deno, Workers; Express via `@backloop/sdk/node`):

```bash
npm install @backloop/sdk
```

```ts
import { createFeedbackHandler, forwardTo, hashAccount } from "@backloop/sdk";

const feedback = createFeedbackHandler({
  service: "acme-companies-api",
  identify: async (req) => hashAccount(await accountIdFrom(req), process.env.ACCOUNT_HASH_SECRET!),
  onRecord: forwardTo({ url: process.env.BACKLOOP_URL!, ingestKey: process.env.BACKLOOP_INGEST_KEY }),
});

app.post("/feedback", (c) => feedback.submit(c.req.raw));
app.get("/.well-known/agent-feedback", (c) => feedback.discovery(c.req.raw));
```

Python:

```bash
pip install backloop-sdk
```

```python
from backloop import FeedbackHandler, fastapi_router, forward_to

handler = FeedbackHandler(on_record=forward_to(BACKLOOP_URL, ingest_key=KEY), service="acme")
app.include_router(fastapi_router(handler))
```

MCP:

```ts
import { registerFeedbackTool } from "@backloop/mcp";
registerFeedbackTool(server, { service: "acme-mcp", onRecord: forwardTo({ url, ingestKey }) });
```

Records go wherever `onRecord` sends them: the [reference collector](packages/collector) (`npx @backloop/collector`, JSONL on disk), your own store, or the hosted platform.

### backloop.json

Backloop runs your tests on every fix it proposes. It learns how from `backloop.json` at the root of your repository:

```json
{
  "dir": "services/api",
  "setup": "python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt -r requirements-dev.txt",
  "test": ".venv/bin/python -m pytest -q",
  "docs": "services/api/openapi.yaml"
}
```

- `dir`: the API's folder, relative to the repository root. Omit it when the API is at the root. `setup` and `test` run inside it.
- `setup`: installs what a fresh clone needs before `test`. Omit it when there is nothing to install. On Backloop it runs as an unprivileged user: nothing that needs root (`apt-get`, `corepack enable`).
- `test`: runs the API's tests and exits 0 when they pass. `null` means nothing can run there; add a `note` saying why.
- `docs`: the API reference (OpenAPI or Markdown), relative to the repository root. Omit it when there is none.

One line per command, strict JSON. Commit it to your default branch. Without it, Backloop reads the lockfile, and when that says nothing the coding agent works your tests out on its first run and adds the file to its pull request.

## Try the whole path locally

Requires Node ≥ 22.13 and pnpm. Python ≥ 3.9 for the Python SDK tests.

```bash
pnpm install && pnpm build
cp .env.example .env              # defaults work as-is
```

Then, in three terminals:

```bash
pnpm demo:collector               # reference collector → http://localhost:4700
pnpm demo:api                     # Acme Companies API → http://localhost:4610
pnpm demo:agents                  # 67 reports from 17 accounts, through the API's POST /feedback
```

Each simulated agent discovers the endpoint through `/.well-known/agent-feedback`, submits its report, and the API forwards the record to the collector. See what arrived:

```bash
curl -s localhost:4700/v1/summary # counts by type and endpoint, accounts, duplicates
cat data/feedback.jsonl           # every record
```

`pnpm demo:claude-agent` runs a real Claude agent on a task against the Acme API. It hits the missing hiring-role filter and reports it. Needs `ANTHROPIC_API_KEY`.

## Security

Feedback text is written by third-party agents. Treat it as untrusted input end to end.

- The SDKs redact bearer tokens, API keys, JWTs, private keys, card numbers and emails: the clients before sending, and the endpoint handlers before `onRecord` (`redact`, on by default), whatever client sent the report. Names in an agent's own words are not removed.
- Services should pseudonymize accounts (`hashAccount`) before records leave them.
- Don't relay agent-written text to other agents unless a human reviewed it.

## Backloop

[Backloop](https://trybackloop.com) is the hosted platform built on this protocol. It clusters reports by what agents were trying to do, ranks them by impact, drafts the issue, and hands the fix to a coding agent. A human approves every PR, and what is pushed is the diff they reviewed; the coding agent runs code from your repository on the workspace's own machine, today under the platform's own user. The platform is not part of this repository; everything here works without it.

## Development

```bash
pnpm build          # all packages
pnpm test           # TypeScript (vitest) + Python (unittest)
pnpm sync-schema    # after editing spec/*.schema.json or AGENT_INSTRUCTIONS.md
```

The JSON Schemas in `spec/` are the source of truth. `scripts/sync-schema.mjs` copies them into both SDKs, and both SDKs run the shared conformance suite; the TypeScript suite also cross-checks against Ajv.

Issues and pull requests are welcome.

## License

[Apache-2.0](LICENSE).
