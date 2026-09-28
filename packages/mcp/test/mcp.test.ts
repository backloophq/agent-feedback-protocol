import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FEEDBACK_SCHEMA, createFeedbackHandler, memorySink } from "@backloop/sdk";
import { describe, expect, it } from "vitest";
import { createFeedbackProxyServer, registerFeedbackTool } from "../src/index.js";

async function connect(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const feedback = {
  type: "missing_capability",
  goal: "Find companies hiring GTM engineers",
  message: "No hiring-role filter on search_companies",
  endpoint: "search_companies",
};

function textOf(result: Awaited<ReturnType<Client["callTool"]>>) {
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}

describe("registerFeedbackTool", () => {
  it("exposes a tool whose schema matches spec/feedback.schema.json", async () => {
    const server = new McpServer({ name: "acme", version: "1.0.0" });
    registerFeedbackTool(server, { onRecord: () => {} });
    const client = await connect(server);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "submit_feedback")!;
    const specProps = Object.keys(FEEDBACK_SCHEMA.properties).filter((k) => k !== "spec_version").sort();
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(specProps);
    expect([...(tool.inputSchema.required ?? [])].sort()).toEqual([...FEEDBACK_SCHEMA.required].sort());
    const props = tool.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.type!.enum).toEqual([...FEEDBACK_SCHEMA.properties.type.enum]);
    expect(props.outcome!.enum).toEqual([...FEEDBACK_SCHEMA.properties.outcome.enum]);
    expect(tool.annotations?.destructiveHint).toBe(false);
  });

  it("records feedback with source mcp and returns an ack with known issues", async () => {
    const sink = memorySink();
    const server = new McpServer({ name: "acme", version: "1.0.0" });
    registerFeedbackTool(server, {
      service: "acme-mcp",
      identify: () => "acct_mcp",
      onRecord: (record) => {
        sink(record);
        return { known_issue: { id: "iss_1", title: "Hiring filter", status: "planned" } };
      },
    });
    const client = await connect(server);
    const result = await client.callTool({ name: "submit_feedback", arguments: feedback });
    expect(result.isError).toBeFalsy();
    const ack = textOf(result);
    expect(ack).toMatchObject({ status: "accepted", known_issue: { id: "iss_1" } });
    expect(sink.records[0]).toMatchObject({ id: ack.id, source: "mcp", service: "acme-mcp", account: "acct_mcp", feedback });
  });

  it("returns a tool error for invalid input instead of throwing", async () => {
    const server = new McpServer({ name: "acme", version: "1.0.0" });
    registerFeedbackTool(server, { onRecord: () => {} });
    const client = await connect(server);
    const result = await client.callTool({ name: "submit_feedback", arguments: { type: "bug", goal: "", message: "m" } });
    expect(result.isError).toBe(true);
  });
});

describe("createFeedbackProxyServer", () => {
  const sink = memorySink();
  const handler = createFeedbackHandler({ onRecord: sink, service: "acme" });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => handler.fetch(new Request(input, init))) as typeof fetch;

  it("discovers the service's endpoint from service_url and forwards feedback", async () => {
    const client = await connect(createFeedbackProxyServer({ fetch: fetchImpl, agent: { name: "proxy-test" } }));
    const { tools } = await client.listTools();
    expect(tools[0]!.inputSchema.properties).toHaveProperty("service_url");
    const result = await client.callTool({
      name: "submit_feedback",
      arguments: { service_url: "https://api.example.com", ...feedback },
    });
    expect(textOf(result).status).toBe("accepted");
    expect(sink.records.at(-1)!.feedback).toMatchObject({ ...feedback, agent: { name: "proxy-test" } });
  });

  it("uses a fixed endpoint when configured", async () => {
    const client = await connect(createFeedbackProxyServer({ endpoint: "https://api.example.com/feedback", fetch: fetchImpl }));
    const { tools } = await client.listTools();
    expect(tools[0]!.inputSchema.properties).not.toHaveProperty("service_url");
    const result = await client.callTool({ name: "submit_feedback", arguments: feedback });
    expect(textOf(result).status).toBe("accepted");
  });

  it("surfaces service errors as tool errors", async () => {
    const failing = (async () => new Response(JSON.stringify({ error: { code: "unauthorized", message: "no" } }), { status: 401 })) as typeof fetch;
    const client = await connect(createFeedbackProxyServer({ endpoint: "https://x/feedback", fetch: failing }));
    const result = await client.callTool({ name: "submit_feedback", arguments: feedback });
    expect(result.isError).toBe(true);
    expect(textOf(result).error.code).toBe("unauthorized");
  });
});
