import { describe, expect, it } from "vitest";
import { REDACTED, redact, redactString } from "../src/redact.js";

describe("redactString", () => {
  it.each([
    ["Authorization: Bearer abc.def-ghi_jkl123", `Authorization: ${REDACTED}`],
    ["key sk-ant-api03-abcdefghijklmnopqrstuv was rejected", `key ${REDACTED} was rejected`],
    ["stripe sk_live_abcdefghijklmnop", `stripe ${REDACTED}`],
    ["token ghp_abcdefghijklmnopqrstuvwxyz0123", `token ${REDACTED}`],
    ["aws AKIAABCDEFGHIJKLMNOP here", `aws ${REDACTED} here`],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijk", `jwt ${REDACTED}`],
    ["GET /search?q=acme&api_key=supersecret&page=2", `GET /search?q=acme&api_key=${REDACTED}&page=2`],
    ["card 4242 4242 4242 4242 declined", `card ${REDACTED} declined`],
    ["email jane.doe@example.com bounced", `email ${REDACTED} bounced`],
  ])("redacts %s", (input, expected) => {
    expect(redactString(input)).toBe(expected);
  });

  it("keeps ordinary text, IDs and numbers that are not card numbers", () => {
    const text = "Company 1234567890123 has 250 employees; request req_8f2c1a failed with 400";
    expect(redactString(text)).toBe(text);
  });

  it("can keep emails", () => {
    expect(redactString("ops@example.com", { emails: false })).toBe("ops@example.com");
  });
});

describe("redact", () => {
  it("walks objects and blanks sensitive keys", () => {
    const out = redact({
      goal: "Sync contacts",
      evidence: { request: { headers: { Authorization: "Bearer xyz12345678", Accept: "json" }, api_key: "k", q: "acme" } },
      metadata: { notes: ["contact bob@example.com"] },
    });
    expect(out).toEqual({
      goal: "Sync contacts",
      evidence: { request: { headers: { Authorization: REDACTED, Accept: "json" }, api_key: REDACTED, q: "acme" } },
      metadata: { notes: [`contact ${REDACTED}`] },
    });
  });
});
