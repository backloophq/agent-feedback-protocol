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
| `BACKLOOP_AGENT_NAME` | Reported as `agent.name` |
