import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The MCP SDK is a dev dependency of this package; until `pnpm install` links it here, load @backloop/mcp's copy.
import { McpServer } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js";
import { StreamableHTTPServerTransport } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js";
import { z } from "../../mcp/node_modules/zod/index.js";
import { audit, AuditError, formatReport, type AuditReport } from "../src/index.js";

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL, body: string) => void | Promise<void>;

async function serve(handler: Handler): Promise<{ origin: string; server: Server }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      Promise.resolve(handler(req, res, url, body)).catch((e) => {
        res.statusCode = 500;
        res.end(String(e));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json", ...headers });
  res.end(text);
};

const checkOf = (r: AuditReport, id: string) => r.categories.flatMap((c) => c.checks).find((k) => k.id === id);

const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

// ── fixtures ────────────────────────────────────────────────────────────

/** An API that does everything the audit looks for. */
async function goodApi() {
  const link = { link: '</feedback>; rel="agent-feedback"' };
  const s = await serve((req, res, url) => {
    const origin = `http://${req.headers.host}`;
    if (url.pathname === "/.well-known/agent-feedback") return send(res, 200, { spec_version: "0.1", endpoint: `${origin}/feedback`, auth: "optional" });
    if (url.pathname === "/feedback" && req.method === "POST") return send(res, 400, { error: { code: "invalid_feedback", message: "`type`, `goal` and `message` are required" } }, link);
    if (url.pathname === "/llms.txt") return send(res, 200, "# Widgets API\n\nCreate and search widgets. Auth: bearer token. See /openapi.json.");
    if (url.pathname === "/robots.txt") return send(res, 200, "User-agent: *\nAllow: /\nContent-Signal: search=yes, ai-input=yes, ai-train=no\n");
    if (url.pathname === "/openapi.json") {
      return send(res, 200, {
        openapi: "3.1.0",
        servers: [{ url: origin }],
        paths: {
          "/widgets": {
            get: {
              summary: "Search widgets",
              parameters: [{ name: "color", in: "query", description: "Widget color, one of red, blue", schema: { type: "string", enum: ["red", "blue"] } }],
            },
            post: {
              summary: "Create a widget",
              requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Widget" } } } },
            },
          },
          "/feedback": { post: { summary: "Report a problem (Agent Feedback Protocol)" } },
        },
        components: { schemas: { Widget: { type: "object", properties: { name: { type: "string", description: "Display name" } } } } },
      });
    }
    if (url.pathname === "/widgets") {
      const unknown = [...url.searchParams.keys()].filter((k) => k !== "color");
      if (unknown.length) return send(res, 400, { error: { message: `Unknown query parameter ${unknown[0]}; valid: color` } }, link);
      return send(res, 200, { data: [] });
    }
    return send(res, 404, { error: { message: `No route ${req.method} ${url.pathname}. See /openapi.json.` } }, link);
  });
  servers.push(s.server);
  return s.origin;
}

/** A site that answers everything with the same HTML page. */
async function badApi() {
  const s = await serve((req, res, url) => {
    if (url.pathname === "/robots.txt") return send(res, 200, "User-agent: *\nDisallow: /\n");
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><body>Welcome</body></html>");
  });
  servers.push(s.server);
  return s.origin;
}

function mcpServer() {
  const server = new McpServer({ name: "fixture", version: "1.2.3" }, { instructions: "Search the widget catalog, then fetch one widget by id." });
  server.registerTool(
    "search_widgets",
    {
      description: "Search the widget catalog by color and name. Returns up to 50 widgets, newest first.",
      inputSchema: {
        query: z.string().describe("Words to match in the widget name"),
        color: z.enum(["red", "blue"]).describe("Only widgets of this color"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({ content: [{ type: "text", text: "[]" }] }),
  );
  server.registerTool(
    "widgets",
    { description: "Handles widget stuff", inputSchema: { sort: z.string(), id: z.string().describe("Widget id") } },
    async () => ({ content: [{ type: "text", text: "ok" }] }),
  );
  return server;
}

/** A Streamable HTTP MCP server at /mcp (stateless; SSE or JSON responses). */
async function mcpApi(json: boolean) {
  const s = await serve(async (req, res, url, body) => {
    if (url.pathname !== "/mcp") return send(res, 404, { error: "not found" });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: json });
    const server = mcpServer();
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  servers.push(s.server);
  return s.origin;
}

/** An MCP server behind OAuth. */
async function authMcp() {
  const s = await serve((req, res, url) => {
    const origin = `http://${req.headers.host}`;
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return send(res, 200, { resource: `${origin}/mcp`, authorization_servers: [`${origin}/auth`] });
    if (url.pathname === "/mcp") {
      return send(res, 401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
    }
    return send(res, 404, { error: "not found" });
  });
  servers.push(s.server);
  return s.origin;
}

// ── tests ───────────────────────────────────────────────────────────────

describe("HTTP APIs", () => {
  let good: string;
  let bad: string;
  beforeAll(async () => {
    [good, bad] = await Promise.all([goodApi(), badApi()]);
  });

  it("scores an agent-ready API near the top", async () => {
    const report = await audit(good);
    expect(report.kind).toBe("http");
    const failed = report.categories.flatMap((c) => c.checks).filter((k) => !k.ok);
    expect(failed).toEqual([]);
    expect(report.score).toBe(100);
    expect(report.top_gaps).toEqual([]);
    for (const id of ["afp.discovery", "afp.endpoint", "afp.error_link", "docs.llms_txt", "docs.openapi", "docs.operations_described", "docs.parameters_described", "errors.json", "errors.names_field", "robots.content_signal"]) {
      expect(checkOf(report, id), id).toMatchObject({ ok: true, fix: "" });
    }
    // The parameter probe used an operation from the OpenAPI description.
    expect(checkOf(report, "errors.names_field")!.finding).toContain("/widgets");
  });

  it("finds the gaps in an API that isn't", async () => {
    const report = await audit(bad);
    expect(report.kind).toBe("http");
    expect(report.score).toBeLessThan(15);
    expect(checkOf(report, "errors.status")).toMatchObject({ ok: false });
    expect(checkOf(report, "errors.status")!.finding).toMatch(/returns 200/);
    expect(checkOf(report, "errors.json")).toMatchObject({ ok: false, severity: "high" });
    expect(checkOf(report, "afp.endpoint")).toMatchObject({ ok: false });
    expect(checkOf(report, "docs.openapi")).toMatchObject({ ok: false });
    expect(checkOf(report, "robots.open")).toMatchObject({ ok: false });
    expect(report.top_gaps.length).toBe(5);
    expect(report.top_gaps.every((g) => !g.ok && g.fix && g.category)).toBe(true);
    // Worst first: high before medium before low.
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    expect(order[report.top_gaps[0]!.severity]).toBeLessThanOrEqual(order[report.top_gaps.at(-1)!.severity]);
  });

  it("sends every request through the fetch it's given", async () => {
    const urls: string[] = [];
    const spy: typeof fetch = (input, init) => {
      urls.push(String(input));
      return fetch(input, init);
    };
    await audit(good, { fetch: spy });
    expect(urls.some((u) => u.endsWith("/.well-known/agent-feedback"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/openapi.json"))).toBe(true);
    expect(urls.every((u) => u.startsWith(good))).toBe(true);
  });

  it("says when the host can't be reached", async () => {
    const s = await serve(() => {});
    const origin = s.origin;
    await new Promise((r) => s.server.close(r));
    await expect(audit(origin)).rejects.toThrow(AuditError);
  });

  it("prints a readable report", async () => {
    const text = formatReport(await audit(bad));
    expect(text).toContain("Score");
    expect(text).toContain("✗");
    expect(text).toContain("Top gaps");
    expect(text).toContain("Fix these automatically with Backloop →");
  });
});

describe("MCP servers", () => {
  for (const json of [false, true]) {
    it(`audits tools over Streamable HTTP (${json ? "JSON" : "SSE"} responses)`, async () => {
      const origin = await mcpApi(json);
      const report = await audit(`${origin}/mcp`);
      expect(report.kind).toBe("mcp");
      expect(report.server).toMatchObject({ name: "fixture", version: "1.2.3" });
      expect(checkOf(report, "server.instructions")!.ok).toBe(true);
      expect(checkOf(report, "server.tool_count")!.finding).toBe("2 tools.");
      expect(checkOf(report, "tools.description_length")).toMatchObject({ ok: false });
      expect(checkOf(report, "tools.description_length")!.finding).toContain("`widgets`");
      expect(checkOf(report, "tools.description_vague")!.finding).toContain("`widgets`");
      expect(checkOf(report, "params.described")!.finding).toContain("`widgets.sort`");
      expect(checkOf(report, "params.enums")!.finding).toContain("`widgets.sort`");
      expect(checkOf(report, "params.enums")!.finding).not.toContain("search_widgets");
      expect(checkOf(report, "tools.annotations")!.finding).toContain("1 of 2");
      expect(checkOf(report, "feedback.submit_feedback")).toMatchObject({ ok: false, severity: "high" });
      expect(report.score).toBeGreaterThan(30);
      expect(report.score).toBeLessThan(80);
    });
  }

  it("finds the MCP endpoint at /mcp when given only the host", async () => {
    const origin = await mcpApi(false);
    const report = await audit(origin);
    expect(report.kind).toBe("mcp");
    expect(report.url).toBe(`${origin}/mcp`);
  });

  it("reports an auth wall and audits only the public surface", async () => {
    const origin = await authMcp();
    const report = await audit(`${origin}/mcp`);
    expect(report.kind).toBe("mcp");
    expect(report.auth_required).toBe(true);
    expect(report.notes.join(" ")).toMatch(/auth required; audited the public surface only/i);
    expect(checkOf(report, "auth.www_authenticate")!.ok).toBe(true);
    expect(checkOf(report, "auth.protected_resource")!.ok).toBe(true);
  });
});
