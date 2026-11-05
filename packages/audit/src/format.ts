import type { AuditReport } from "./audit.js";

/** A readable terminal report. `color` adds ANSI colors. */
export function formatReport(report: AuditReport, opts: { color?: boolean } = {}): string {
  const c = (code: string, s: string) => (opts.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const bold = (s: string) => c("1", s);
  const dim = (s: string) => c("2", s);
  const tone = (score: number, s: string) => c(score >= 80 ? "32" : score >= 50 ? "33" : "31", s);
  const lines: string[] = [];
  const kind = report.kind === "mcp" ? "MCP server" : "HTTP API";
  const server = report.server?.name ? ` · ${report.server.name}${report.server.version ? ` ${report.server.version}` : ""}` : "";
  lines.push(`${bold("Agent-readiness audit")}  ${report.url}`);
  lines.push(dim(`${kind}${server} · ${(report.duration_ms / 1000).toFixed(1)}s`));
  lines.push("");
  lines.push(`${bold("Score")}  ${tone(report.score, bold(`${report.score}/100`))}`);
  for (const note of report.notes) lines.push(c("33", `! ${note}`));
  for (const cat of report.categories) {
    lines.push("");
    lines.push(`${bold(cat.name)}  ${tone(cat.score, `${cat.score}/100`)}`);
    for (const k of cat.checks) {
      const mark = k.ok ? c("32", "✓") : c("31", "✗");
      lines.push(`  ${mark} ${k.ok ? "" : dim(`[${k.severity}] `)}${k.finding}`);
      if (!k.ok && k.fix) lines.push(dim(`      fix: ${k.fix}`));
    }
  }
  if (report.top_gaps.length) {
    lines.push("");
    lines.push(bold("Top gaps"));
    report.top_gaps.forEach((g, i) => lines.push(`  ${i + 1}. ${g.fix || g.finding} ${dim(`(${g.category}, ${g.severity})`)}`));
  }
  lines.push("");
  lines.push(`Fix these automatically with Backloop → https://app.trybackloop.com/new`);
  return lines.join("\n");
}
