import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { duplicateKey, type FeedbackRecord, type FeedbackType } from "@backloop/sdk";

export interface RecordQuery {
  type?: FeedbackType;
  endpoint?: string;
  service?: string;
  since?: string;
  limit?: number;
}

export interface Summary {
  total: number;
  duplicates: number;
  accounts: number;
  by_type: Record<string, number>;
  by_endpoint: Array<{ endpoint: string; count: number; blocked: number }>;
}

/**
 * Append-only JSONL store. One line per record, easy to grep, ship to a
 * warehouse, or replay into another collector. Duplicates are counted but
 * not stored twice.
 */
export class JsonlStore {
  private records: FeedbackRecord[] = [];
  private ids = new Set<string>();
  private keys = new Set<string>();
  duplicates = 0;

  constructor(readonly path?: string) {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        this.index(JSON.parse(line) as FeedbackRecord);
      } catch {
        // Skip a torn final line from a crash mid-write.
      }
    }
  }

  private index(record: FeedbackRecord) {
    this.records.push(record);
    this.ids.add(record.id);
    const key = duplicateKey(record);
    if (key) this.keys.add(key);
  }

  /** Returns "duplicate" when the record (or the same report from the same agent run) is already stored. */
  add(record: FeedbackRecord): "accepted" | "duplicate" {
    const key = duplicateKey(record);
    if (this.ids.has(record.id) || (key && this.keys.has(key))) {
      this.duplicates++;
      return "duplicate";
    }
    if (this.path) appendFileSync(this.path, `${JSON.stringify(record)}\n`);
    this.index(record);
    return "accepted";
  }

  query(q: RecordQuery = {}): FeedbackRecord[] {
    const out: FeedbackRecord[] = [];
    for (let i = this.records.length - 1; i >= 0 && out.length < (q.limit ?? 100); i--) {
      const r = this.records[i]!;
      if (q.type && r.feedback.type !== q.type) continue;
      if (q.endpoint && r.feedback.endpoint !== q.endpoint) continue;
      if (q.service && r.service !== q.service) continue;
      if (q.since && r.received_at < q.since) continue;
      out.push(r);
    }
    return out;
  }

  summary(): Summary {
    const byType: Record<string, number> = {};
    const byEndpoint = new Map<string, { count: number; blocked: number }>();
    const accounts = new Set<string>();
    for (const r of this.records) {
      byType[r.feedback.type] = (byType[r.feedback.type] ?? 0) + 1;
      if (r.account) accounts.add(r.account);
      const ep = r.feedback.endpoint ?? "(none)";
      const entry = byEndpoint.get(ep) ?? { count: 0, blocked: 0 };
      entry.count++;
      if (r.feedback.outcome === "blocked") entry.blocked++;
      byEndpoint.set(ep, entry);
    }
    return {
      total: this.records.length,
      duplicates: this.duplicates,
      accounts: accounts.size,
      by_type: byType,
      by_endpoint: [...byEndpoint.entries()]
        .map(([endpoint, v]) => ({ endpoint, ...v }))
        .sort((a, b) => b.count - a.count),
    };
  }
}
