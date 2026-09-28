#!/usr/bin/env node
/**
 * backloop-mcp — a stdio MCP server that lets any agent report feedback to
 * services implementing the Agent Feedback Protocol.
 *
 *   BACKLOOP_FEEDBACK_URL   fixed feedback endpoint (optional; otherwise the
 *                           tool asks for the service's base URL)
 *   BACKLOOP_FEEDBACK_TOKEN bearer credential for that service (optional)
 *   BACKLOOP_AGENT_NAME     reported as agent.name (optional)
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { newId } from "@backloop/sdk";
import { createFeedbackProxyServer } from "./proxy.js";

const server = createFeedbackProxyServer({
  endpoint: process.env.BACKLOOP_FEEDBACK_URL || undefined,
  apiKey: process.env.BACKLOOP_FEEDBACK_TOKEN || undefined,
  agent: process.env.BACKLOOP_AGENT_NAME ? { name: process.env.BACKLOOP_AGENT_NAME } : undefined,
  sessionId: newId("sess"),
});

await server.connect(new StdioServerTransport());
