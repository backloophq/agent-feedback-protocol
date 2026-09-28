import type { IncomingMessage, ServerResponse } from "node:http";
import type { FeedbackHandler } from "./server.js";

type NodeRequest = IncomingMessage & { body?: unknown; originalUrl?: string };

async function readBody(req: NodeRequest): Promise<string> {
  // Express/Connect may already have parsed the body.
  if (req.body !== undefined) return typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function toWebRequest(req: NodeRequest): Promise<Request> {
  const host = req.headers.host ?? "localhost";
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? "http";
  const url = new URL(req.originalUrl ?? req.url ?? "/", `${proto}://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else if (value !== undefined) headers.set(key, value);
  }
  const method = req.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
  if (body !== undefined) headers.delete("content-length");
  return new Request(url, { method, headers, body });
}

export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

/**
 * Adapt a feedback handler to Node's `http` module or Express:
 *
 *   app.post("/feedback", toNodeListener(handler));
 *   app.get("/.well-known/agent-feedback", toNodeListener(handler));
 */
export function toNodeListener(handler: FeedbackHandler) {
  return async (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => {
    try {
      await sendWebResponse(res, await handler.fetch(await toWebRequest(req)));
    } catch (e) {
      if (next) next(e);
      else {
        res.statusCode = 500;
        res.end();
      }
    }
  };
}
