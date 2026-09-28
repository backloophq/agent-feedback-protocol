# @backloop/mcp

The [Agent Feedback Protocol](https://trybackloop.com/spec/) for MCP.

```bash
npm install @backloop/mcp @backloop/sdk
```

## Add `submit_feedback` to your MCP server

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFeedbackTool } from "@backloop/mcp";
import { forwardTo } from "@backloop/sdk";

const server = new McpServer({ name: "acme", version: "1.0.0" });
registerFeedbackTool(server, {
  service: "acme-mcp",
  identify: (extra) => extra.authInfo?.clientId,     // optional
  onRecord: forwardTo({ url: BACKLOOP_URL, ingestKey }),
});
```

The tool's input schema mirrors the protocol's `feedback.schema.json` (a test keeps them in sync), its description is the standard agent guidance, and it returns the acknowledgement JSON, including any `known_issue`. Invalid input comes back as a tool error, never an exception.

## Give any agent a feedback tool

`backloop-mcp` is a stdio MCP server that forwards `submit_feedback` to any service implementing the protocol:

```bash
claude mcp add feedback -- npx @backloop/mcp                        # agent passes service_url; endpoint is discovered
BACKLOOP_FEEDBACK_URL=https://api.acme.com/feedback npx @backloop/mcp # fixed endpoint
```

| Variable | |
|---|---|
| `BACKLOOP_FEEDBACK_URL` | Fixed feedback endpoint. Without it the tool takes a `service_url` and uses `/.well-known/agent-feedback`. |
| `BACKLOOP_FEEDBACK_TOKEN` | Bearer credential sent to the service |
| `BACKLOOP_AGENT_NAME` | Reported as `agent.name` |
