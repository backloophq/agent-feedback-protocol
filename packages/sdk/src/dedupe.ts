import type { FeedbackRecord } from "./types.js";

function fnv1a(input: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function normalizeText(text: string | undefined): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_/]+/gu, " ")
    .trim();
}

/**
 * Duplicate key for a record, or undefined if it cannot be a duplicate.
 * Two records are duplicates when the same agent run (`session_id`, scoped
 * to the account) reported the same problem twice. Identical reports from
 * different runs are *not* duplicates: they are the signal.
 */
export function duplicateKey(record: FeedbackRecord): string | undefined {
  const f = record.feedback;
  if (!f.session_id) return undefined;
  const material = [
    record.account ?? "",
    f.session_id,
    f.type,
    f.endpoint ?? "",
    normalizeText(f.message),
  ].join("\u0000");
  return `${fnv1a(material, 0x811c9dc5)}${fnv1a(material, 0x01000193)}`;
}
