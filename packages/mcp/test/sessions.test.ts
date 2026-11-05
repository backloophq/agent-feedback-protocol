import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionEvent } from "@backloop/sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { instrumentServer, registerFeedbackTool } from "../src/index.js";

async function connect(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "2.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function acme() {
  const server = new McpServer({ name: "acme", version: "1.0.0" });
  const seen: unknown[] = [];
  server.registerTool(
    "send_invoice",
    { description: "Send an invoice", inputSchema: { customer_id: z.string(), email: z.string().optional() } },
    async (args) => {
      seen.push(args);
      if (args.customer_id === "cus_unpaid") return { content: [{ type: "text", text: "402: billing contact required" }], isError: true };
      if (args.customer_id === "boom") throw new Error("database unavailable");
      return { content: [{ type: "text", text: `sent to ${args.customer_id}` }] };
    },
  );
  return { server, seen };
}

describe("instrumentServer", () => {
  it("records each call, with the agent's telemetry, and strips it before the handler runs", async () => {
    const { server, seen } = acme();
    const events: SessionEvent[] = [];
    const analytics = instrumentServer(server, { service: "acme-mcp", onEvents: (e) => void events.push(...e), identify: () => "acct_1" });
    const client = await connect(server);

    const { tools } = await client.listTools();
    const props = tools[0]!.inputSchema.properties as Record<string, { properties?: Record<string, unknown> }>;
    expect(Object.keys(props)).toEqual(["customer_id", "email", "telemetry"]);
    expect(Object.keys(props.telemetry!.properties!)).toEqual(["user_intent", "agent_thinking", "user_frustration", "agent_model"]);

    await client.callTool({
      name: "send_invoice",
      arguments: {
        customer_id: "cus_unpaid",
        email: "jane@acme.com",
        telemetry: { user_intent: "Invoice ACME for the paid plan", agent_thinking: "Customer found, sending", user_frustration: "low" },
      },
    });
    await client.callTool({ name: "send_invoice", arguments: { customer_id: "cus_1", telemetry: { agent_thinking: "Retry with owner" } } });
    await expect(client.callTool({ name: "send_invoice", arguments: { customer_id: "boom" } })).resolves.toMatchObject({ isError: true });
    await analytics.flush();

    expect(seen).toEqual([{ customer_id: "cus_unpaid", email: "jane@acme.com" }, { customer_id: "cus_1" }, { customer_id: "boom" }]);
    expect(events).toHaveLength(3);
    const [first, second, third] = events;
    expect(first).toMatchObject({
      kind: "tool_call",
      service: "acme-mcp",
      account: "acct_1",
      client: { name: "claude-code", version: "2.1.0" },
      tool: "send_invoice",
      ok: false,
      error: "402: billing contact required",
      telemetry: { user_intent: "Invoice ACME for the paid plan", agent_thinking: "Customer found, sending", user_frustration: "low" },
    });
    // Previews are redacted, and never carry the telemetry.
    expect(first!.input).toBe('{"customer_id":"cus_unpaid","email":"[REDACTED]"}');
    expect(second).toMatchObject({ ok: true, result: "sent to cus_1", telemetry: { agent_thinking: "Retry with owner" } });
    expect(third).toMatchObject({ ok: false, error: "database unavailable" });
    // One stdio-like connection: one session.
    expect(new Set(events.map((e) => e.session_id)).size).toBe(1);
  });

  it("covers tools registered after it, tools without a schema, and keeps submit_feedback's schema", async () => {
    const server = new McpServer({ name: "acme", version: "1.0.0" });
    const events: SessionEvent[] = [];
    const analytics = instrumentServer(server, { onEvents: (e) => void events.push(...e) });
    let called = false;
    server.registerTool("ping", { description: "Ping" }, async () => {
      called = true;
      return { content: [{ type: "text", text: "pong" }] };
    });
    registerFeedbackTool(server, { onRecord: () => {} });
    const client = await connect(server);
    const { tools } = await client.listTools();
    const ping = tools.find((t) => t.name === "ping")!;
    expect(Object.keys(ping.inputSchema.properties ?? {})).toEqual(["telemetry"]);
    const feedback = tools.find((t) => t.name === "submit_feedback")!;
    expect(feedback.inputSchema.properties).not.toHaveProperty("telemetry");

    await client.callTool({ name: "ping", arguments: { telemetry: { user_intent: "Check the service is up" } } });
    await client.callTool({ name: "submit_feedback", arguments: { type: "bug", goal: "Ping", message: "Slow" } });
    await analytics.flush();
    expect(called).toBe(true);
    expect(events.map((e) => [e.tool, e.ok])).toEqual([
      ["ping", true],
      ["submit_feedback", true],
    ]);
    expect(events[0]!.telemetry).toEqual({ user_intent: "Check the service is up" });
  });

  it("posts batches to the platform with the ingest key, and never throws into tools when it can't", async () => {
    const { server } = acme();
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const analytics = instrumentServer(server, { url: "https://backloop.test/", ingestKey: "ik_1", fetch: fetch as never });
    const client = await connect(server);
    await client.callTool({ name: "send_invoice", arguments: { customer_id: "cus_1" } });
    await client.callTool({ name: "send_invoice", arguments: { customer_id: "cus_2" } });
    await analytics.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://backloop.test/v1/sessions/events");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ik_1");
    expect(JSON.parse(init.body as string).events).toHaveLength(2);

    const errors: unknown[] = [];
    const broken = acme();
    const down = instrumentServer(broken.server, {
      url: "https://backloop.test",
      fetch: (async () => {
        throw new Error("offline");
      }) as never,
      onError: (e) => errors.push(e),
    });
    const c2 = await connect(broken.server);
    const result = await c2.callTool({ name: "send_invoice", arguments: { customer_id: "cus_1" } });
    expect(result.isError).toBeFalsy();
    await down.flush();
    expect(errors).toHaveLength(1);
  });

  it("does nothing without a destination", async () => {
    const { server } = acme();
    instrumentServer(server);
    const client = await connect(server);
    const result = await client.callTool({ name: "send_invoice", arguments: { customer_id: "cus_1", telemetry: { user_intent: "x" } } });
    expect(result.content).toEqual([{ type: "text", text: "sent to cus_1" }]);
  });
});
