import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { validateRecord, validateSubmission } from "../src/validate.js";

const specDir = join(import.meta.dirname, "../../../spec");
const load = (dir: string) =>
  readdirSync(join(specDir, "conformance", dir)).map((file) => ({
    file,
    ...(JSON.parse(readFileSync(join(specDir, "conformance", dir, file), "utf8")) as {
      description: string;
      submission: unknown;
      expect_error_path?: string;
    }),
  }));

const ajv = new Ajv2020.default({ allErrors: true, strict: false });
addFormats.default(ajv);
const feedbackSchema = JSON.parse(readFileSync(join(specDir, "feedback.schema.json"), "utf8"));
ajv.addSchema(feedbackSchema, "feedback.schema.json");
const ajvSubmission = ajv.getSchema("feedback.schema.json")!;
const ajvRecord = ajv.compile(JSON.parse(readFileSync(join(specDir, "record.schema.json"), "utf8")));

describe("conformance: valid submissions", () => {
  for (const c of load("valid")) {
    it(`${c.file} — ${c.description}`, () => {
      const result = validateSubmission(c.submission);
      expect(result.issues).toEqual([]);
      expect(ajvSubmission(c.submission)).toBe(true);
    });
  }
});

describe("conformance: invalid submissions", () => {
  for (const c of load("invalid")) {
    it(`${c.file} — ${c.description}`, () => {
      const result = validateSubmission(c.submission);
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.path.startsWith(c.expect_error_path ?? ""))).toBe(true);
      expect(ajvSubmission(c.submission)).toBe(false);
    });
  }
});

describe("records", () => {
  const feedback = { type: "bug", goal: "g", message: "m" };
  it("accepts a well-formed record and agrees with Ajv", () => {
    const record = { id: "fb_1", received_at: "2026-09-28T10:04:11.123Z", source: "http", account: "acct_1", feedback };
    expect(validateRecord(record).valid).toBe(true);
    expect(ajvRecord(record)).toBe(true);
  });
  it("rejects a bad timestamp and an invalid nested submission", () => {
    const record = { id: "fb_1", received_at: "yesterday", feedback: { ...feedback, type: "nope" } };
    const result = validateRecord(record);
    expect(result.issues.map((i) => i.path).sort()).toEqual(["feedback.type", "received_at"]);
    expect(ajvRecord(record)).toBe(false);
  });
});

it("reports every problem at once", () => {
  const result = validateSubmission({ type: "x", goal: "", extra: 1 });
  expect(result.issues).toEqual([
    { path: "message", message: "is required" },
    { path: "type", message: expect.stringContaining("must be one of") },
    { path: "goal", message: "must not be empty" },
    { path: "extra", message: "is not a recognised field" },
  ]);
});
