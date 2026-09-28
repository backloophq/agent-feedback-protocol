import { ACK_SCHEMA, FEEDBACK_SCHEMA, RECORD_SCHEMA } from "./generated.js";
import type { FeedbackAck, FeedbackRecord, FeedbackSubmission, ValidationIssue } from "./types.js";

/**
 * A small JSON Schema interpreter covering exactly the keywords the protocol
 * schemas use, so the SDK validates against spec/*.schema.json with zero
 * dependencies. The conformance suite checks it agrees with Ajv.
 */
type Schema = {
  type?: string;
  const?: unknown;
  enum?: readonly unknown[];
  required?: readonly string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  format?: string;
  $ref?: string;
};

const REFS: Record<string, Schema> = {
  "feedback.schema.json": FEEDBACK_SCHEMA as Schema,
};

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function check(schema: Schema, value: unknown, path: string, issues: ValidationIssue[]): void {
  if (schema.$ref) {
    const target = REFS[schema.$ref];
    if (!target) throw new Error(`Unresolvable $ref ${schema.$ref}`);
    check(target, value, path, issues);
    return;
  }
  const actual = typeOf(value);
  switch (schema.type) {
    case "object":
      if (actual !== "object") return void issues.push({ path, message: "must be an object" });
      break;
    case "string":
      if (actual !== "string") return void issues.push({ path, message: "must be a string" });
      break;
    case "boolean":
      if (actual !== "boolean") return void issues.push({ path, message: "must be a boolean" });
      break;
    case "integer":
      if (!Number.isInteger(value)) return void issues.push({ path, message: "must be an integer" });
      break;
    case "number":
      if (actual !== "number" || !Number.isFinite(value)) {
        return void issues.push({ path, message: "must be a number" });
      }
      break;
  }
  if ("const" in schema && value !== schema.const) {
    issues.push({ path, message: `must be ${JSON.stringify(schema.const)}` });
  }
  if (schema.enum && !schema.enum.includes(value)) {
    issues.push({ path, message: `must be one of: ${schema.enum.join(", ")}` });
  }
  if (typeof value === "string") {
    const length = [...value].length; // code points, as JSON Schema specifies
    if (schema.minLength !== undefined && length < schema.minLength) {
      issues.push({
        path,
        message: schema.minLength === 1 ? "must not be empty" : `must be at least ${schema.minLength} characters`,
      });
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      issues.push({ path, message: `must be at most ${schema.maxLength} characters` });
    }
    if (schema.format === "date-time" && !RFC3339.test(value)) {
      issues.push({ path, message: "must be an RFC 3339 date-time" });
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path, message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path, message: `must be <= ${schema.maximum}` });
    }
  }
  if (actual === "object" && (schema.properties || schema.required)) {
    const obj = value as Record<string, unknown>;
    const join = (key: string) => (path ? `${path}.${key}` : key);
    for (const key of schema.required ?? []) {
      if (!(key in obj)) issues.push({ path: join(key), message: "is required" });
    }
    for (const [key, child] of Object.entries(obj)) {
      const childSchema = schema.properties?.[key];
      if (childSchema) check(childSchema, child, join(key), issues);
      else if (schema.additionalProperties === false) {
        issues.push({ path: join(key), message: "is not a recognised field" });
      }
    }
  }
}

export type ValidationResult<T> =
  | { valid: true; value: T; issues: [] }
  | { valid: false; issues: ValidationIssue[] };

function run<T>(schema: Schema, value: unknown): ValidationResult<T> {
  const issues: ValidationIssue[] = [];
  check(schema, value, "", issues);
  return issues.length === 0 ? { valid: true, value: value as T, issues: [] } : { valid: false, issues };
}

/** Validate an agent's submission against spec/feedback.schema.json. */
export function validateSubmission(value: unknown): ValidationResult<FeedbackSubmission> {
  return run(FEEDBACK_SCHEMA as Schema, value);
}

/** Validate a stored/forwarded record against spec/record.schema.json. */
export function validateRecord(value: unknown): ValidationResult<FeedbackRecord> {
  return run(RECORD_SCHEMA as Schema, value);
}

/** Validate a `202` acknowledgement against spec/ack.schema.json. */
export function validateAck(value: unknown): ValidationResult<FeedbackAck> {
  return run(ACK_SCHEMA as Schema, value);
}

export function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ");
}
