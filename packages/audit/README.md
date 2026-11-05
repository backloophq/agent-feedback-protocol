# @backloop/audit

How ready is your API or MCP server for AI agents? A score out of 100, and the gaps that make agents fail.

```bash
npx @backloop/audit https://api.example.com
npx @backloop/audit https://mcp.example.com/mcp --json
```

**HTTP APIs:** the [Agent Feedback Protocol](https://trybackloop.com/spec/) (`/.well-known/agent-feedback`, `POST /feedback`, the `Link` header on errors), `llms.txt`, an OpenAPI description and how much of it is described, whether errors are JSON and name the bad parameter, and `robots.txt` Content-Signal.

**MCP servers** (Streamable HTTP): server instructions, tool and parameter descriptions, enums for constrained values, annotations, a `submit_feedback` tool, and tool count. Servers that need auth are audited on their public surface.

```ts
import { audit } from "@backloop/audit";

const report = await audit("https://api.example.com");
console.log(report.score, report.top_gaps);
```

No runtime dependencies. Also hosted at [app.trybackloop.com/audit](https://app.trybackloop.com/audit).

Apache-2.0.
