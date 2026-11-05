# @backloop/mcp

The [Agent Feedback Protocol](https://trybackloop.com/spec/) for MCP.

```bash
npm install @backloop/mcp @backloop/sdk
```

## Add `submit_feedback` to your MCP server

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFeedbackTool } from "@backloop/mcp";
import { AGENT_FEEDBACK_INSTRUCTIONS, forwardTo } from "@backloop/sdk";

// Server instructions reach the model: without them, agents rarely report.
const server = new McpServer({ name: "acme", version: "1.0.0" }, { instructions: AGENT_FEEDBACK_INSTRUCTIONS });
registerFeedbackTool(server, {
  service: "acme-mcp",
  identify: (extra) => extra.authInfo?.clientId,     // optional
  onRecord: forwardTo({ url: BACKLOOP_URL, ingestKey }),
});
```

The tool's input schema mirrors the protocol's `feedback.schema.json` (a test keeps them in sync), its description is the standard agent guidance, and it returns the acknowledgement JSON, including any `known_issue`. Invalid input comes back as a tool error, never an exception.

Keep the instructions. If your server already has some, add `AGENT_FEEDBACK_INSTRUCTIONS` after them. With the tool alone, most models reported only some problems; with the instructions too, the strongest models reported all of them, including gaps they had worked around ([the benchmark](https://github.com/backloophq/agent-feedback-protocol/tree/main/examples/agent-fleet#report-rate-benchmark)).

## Session analytics: see what agents do on your MCP

Agents report some problems. Most sessions that go wrong end silently. `instrumentServer` records every tool call so Backloop can rebuild each session, judge whether the user got what they asked for, and file failed sessions as problems, even when the agent never reported anything.

```ts
import { instrumentServer, registerFeedbackTool } from "@backloop/mcp";

const analytics = instrumentServer(server, {
  url: process.env.BACKLOOP_URL,             // events go to <url>/v1/sessions/events
  ingestKey: process.env.BACKLOOP_INGEST_KEY,
  service: "acme-mcp",
  identify: (extra) => extra.authInfo?.clientId, // optional
});
```

- Call it before or after you register tools: both are covered.
- Each tool gets one optional `telemetry` argument: `user_intent`, `agent_thinking` and `user_frustration`. Agents fill it in as they work; it is removed before your handler runs. `submit_feedback` keeps the protocol's schema.
- Each call is recorded with its timing, its outcome (including results returned with `isError: true`) and redacted previews of its input and result. Events are sent in the background, and a failure to send never reaches a tool.
- Sessions follow `Mcp-Session-Id` over HTTP. Over stdio, each server process is one session.
- On serverless, `await analytics.flush()` before the function returns.

In the dashboard, **Sessions** shows the replays, the use cases (sessions grouped by the intent agents reported, with pass rates), and which failed sessions became problems.

## Give any agent a feedback tool

`backloop-mcp` is a stdio MCP server that forwards `submit_feedback` to any service implementing the protocol. Its server instructions are the standard agent guidance, so the agent knows when to use it:

```bash
claude mcp add feedback -- npx @backloop/mcp                        # agent passes service_url; endpoint is discovered
BACKLOOP_FEEDBACK_URL=https://api.acme.com/feedback npx @backloop/mcp # fixed endpoint
```

| Variable | |
|---|---|
| `BACKLOOP_FEEDBACK_URL` | Fixed feedback endpoint. Without it the tool takes a `service_url` and uses `/.well-known/agent-feedback`. |
| `BACKLOOP_FEEDBACK_TOKEN` | Bearer credential sent to the service |
| `BACKLOOP_AGENT_NAME` | Reported as `agent.name`. Default: the name the MCP client gave in `clientInfo`. |
