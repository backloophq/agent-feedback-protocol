export * from "./types.js";
export {
  FEEDBACK_SCHEMA,
  RECORD_SCHEMA,
  ACK_SCHEMA,
  AGENT_FEEDBACK_INSTRUCTIONS,
  FEEDBACK_TOOL_DESCRIPTION,
} from "./generated.js";
export { validateSubmission, validateRecord, validateAck, formatIssues, type ValidationResult } from "./validate.js";
export { redact, redactString, REDACTED, type RedactOptions } from "./redact.js";
export { newId, hashAccount } from "./ids.js";
export {
  FeedbackClient,
  FeedbackError,
  feedbackUrlFromLink,
  type FeedbackClientOptions,
  type SubmitResult,
} from "./client.js";
export {
  createFeedbackHandler,
  errorResponse,
  feedbackLinkHeader,
  withFeedbackLink,
  type FeedbackHandler,
  type FeedbackHandlerOptions,
  type OnRecordResult,
  type RecordContext,
} from "./server.js";
export { forwardTo, fanOut, memorySink, type ForwardOptions } from "./forward.js";
export { feedbackTool, feedbackToolInputSchema, FEEDBACK_TOOL_NAME } from "./tool.js";
export { duplicateKey, normalizeText } from "./dedupe.js";
