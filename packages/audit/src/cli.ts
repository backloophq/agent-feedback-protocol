#!/usr/bin/env node
/**
 * backloop-audit <url> [--json] — how usable is this API or MCP server for AI agents?
 */
import { audit, AuditError } from "./audit.js";
import { formatReport } from "./format.js";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const timeout = args.find((a) => a.startsWith("--timeout="));
const url = args.find((a) => !a.startsWith("--"));

if (!url || args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: backloop-audit <url> [--json] [--timeout=<seconds>]

Scores a public API or MCP server (0-100) on how usable it is for AI agents,
and lists the gaps worth fixing first.`);
  process.exit(url ? 0 : 1);
}

try {
  const report = await audit(url, { timeoutMs: timeout ? Number(timeout.slice(10)) * 1000 : undefined });
  console.log(asJson ? JSON.stringify(report, null, 2) : formatReport(report, { color: process.stdout.isTTY && !process.env.NO_COLOR }));
} catch (e) {
  console.error(e instanceof AuditError ? e.message : `Audit failed: ${(e as Error).message}`);
  process.exit(2);
}
