# Agent Feedback Protocol — v0.1

**Status:** Draft · **License:** Apache-2.0

The Agent Feedback Protocol (AFP) defines one small interface that any agent-facing service — an HTTP API, an MCP server, a tool — can expose so that AI agents can report *what they were trying to do* when the service got in the way.

Logs and error tracking tell a provider **what failed**. AFP tells them **what the user was trying to do that the product couldn't do**.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as described in RFC 2119.

---

## 1. Terminology

| Term | Meaning |
|---|---|
| **Agent** | Software acting on behalf of a user that calls a service, usually driven by an LLM. |
| **Service** | The API or MCP server the agent is using. It exposes the feedback endpoint. |
| **Submission** | The JSON object an agent sends ([`feedback.schema.json`](feedback.schema.json)). |
| **Record** | A submission after the service has accepted it, plus server-side context ([`record.schema.json`](record.schema.json)). |
| **Collector** | Anything that receives records from services: the open-source reference collector, a hosted platform, or your own store. |

## 2. Discovery

An agent needs to know a service accepts feedback before it can send any. A service implementing AFP:

1. **MUST** accept `POST /feedback` relative to its API base URL, or advertise a different URL through one of the mechanisms below.
2. **SHOULD** serve a discovery document at `GET /.well-known/agent-feedback`:

   ```json
   {
     "spec_version": "0.1",
     "endpoint": "https://api.example.com/feedback",
     "types": ["missing_capability", "bug", "unclear_documentation", "unexpected_response", "unhelpful_error", "performance", "other"],
     "max_bytes": 16384,
     "auth": "optional"
   }
   ```

   `auth` is one of `none` (credentials are ignored), `optional` (anonymous submissions accepted; authenticated ones are attributed to an account) or `required`.

3. **SHOULD** add a `Link` header to every error response (4xx and 5xx), so an agent learns about the endpoint exactly when it is most useful:

   ```http
   Link: </feedback>; rel="agent-feedback"
   ```

4. **SHOULD** document the endpoint in its OpenAPI description and in any `llms.txt` or agent-facing documentation.
5. An MCP server **SHOULD** expose the `submit_feedback` tool described in §7.

## 3. Submitting feedback

```http
POST /feedback HTTP/1.1
Content-Type: application/json
Authorization: Bearer <the agent's normal API credential>   (optional)

{
  "type": "missing_capability",
  "goal": "Find companies currently hiring GTM engineers",
  "endpoint": "/companies/search",
  "method": "GET",
  "message": "No hiring-role filter is available",
  "outcome": "blocked",
  "workaround": false,
  "suggestion": "Add a hiring_role query parameter"
}
```

- The body **MUST** be a JSON object that validates against [`feedback.schema.json`](feedback.schema.json).
- The body **MUST NOT** exceed 16 KiB (16,384 bytes) unless the discovery document advertises a larger `max_bytes`.
- The service **SHOULD** accept the same credentials as the rest of its API so feedback can be attributed to a customer account. It **MAY** accept anonymous feedback.
- Submitting feedback **MUST NOT** have side effects on the agent's account other than recording the feedback.

### 3.1 Fields

| Field | Req. | Type | Description |
|---|---|---|---|
| `type` | ✓ | enum | `missing_capability`, `bug`, `unclear_documentation`, `unexpected_response`, `unhelpful_error`, `performance`, `other` |
| `goal` | ✓ | string ≤ 1000 | What the agent or its user was trying to accomplish. The task, in plain language — not the API call. |
| `message` | ✓ | string ≤ 4000 | What prevented or complicated the task. |
| `endpoint` | | string ≤ 512 | Path template (`/companies/search`) or tool name (`search_companies`). |
| `method` | | enum | HTTP method, when `endpoint` is a path. |
| `outcome` | | enum | `blocked` (task failed), `degraded` (completed worse or slower), `completed` (suggestion only). |
| `workaround` | | boolean | Whether the agent found a workaround. |
| `workaround_description` | | string ≤ 2000 | The workaround, if any. |
| `expected` | | string ≤ 2000 | What the agent expected to find or happen. |
| `suggestion` | | string ≤ 2000 | A concrete change that would have let the agent succeed. |
| `request_id` | | string ≤ 256 | The service's request ID for a related call. |
| `session_id` | | string ≤ 256 | Opaque ID shared by every submission in one agent task run. Services use it to de-duplicate retries. |
| `agent` | | object | `name`, `version`, `model`, `framework` — all optional strings. Agents **SHOULD** send `name` and `model`. |
| `evidence` | | object | `status_code` (integer), `request` (object), `response_excerpt` (string ≤ 4000). Sanitized. |
| `metadata` | | object | Free-form. Services MAY ignore it. |
| `spec_version` | | `"0.1"` | Protocol version. Defaults to `"0.1"`. |

Unknown top-level fields **MUST** be rejected, so that typos surface during integration instead of silently dropping data. Extensions go in `metadata`.

### 3.2 Choosing a `type`

| Type | Use when |
|---|---|
| `missing_capability` | The service cannot do something the task needs (a filter, an endpoint, a field, a bulk operation). |
| `bug` | The service behaved incorrectly according to its own documentation. |
| `unclear_documentation` | The docs were missing, ambiguous or wrong, and the agent had to guess. |
| `unexpected_response` | The response shape, values or semantics were surprising even if not strictly a bug. |
| `unhelpful_error` | An error happened and its message did not explain how to fix the request. |
| `performance` | Latency, rate limits or pagination made the task impractical. |
| `other` | Anything else worth a human's attention. |

## 4. Responses

### 4.1 Accepted — `202`

```json
{
  "id": "fb_01JAX3ZK7Q8W2M4N6P9R",
  "status": "accepted",
  "received_at": "2026-09-28T10:04:11Z",
  "known_issue": {
    "id": "iss_hiring_role_filter",
    "title": "Add hiring-role filter to /companies/search",
    "status": "planned",
    "url": "https://github.com/acme/api/issues/412",
    "workaround": "Search /jobs?role=... and join on company_id"
  }
}
```

The body validates against [`ack.schema.json`](ack.schema.json). `known_issue` is **OPTIONAL**. When present, it tells the agent the problem is already tracked, so it can stop retrying, tell its user, or apply the workaround. This closes the loop in both directions.

A service **SHOULD** return `202` for duplicates too (same `session_id` and content), so agents never need to reason about duplicates themselves.

### 4.2 Errors

Errors use a single shape:

```json
{
  "error": {
    "code": "invalid_feedback",
    "message": "goal: must be a non-empty string",
    "details": [{ "path": "goal", "message": "must be a non-empty string" }]
  }
}
```

| Status | `code` | When |
|---|---|---|
| `400` | `invalid_json` | Body is not valid JSON. |
| `400` | `invalid_feedback` | Body does not validate. `details` lists every problem. |
| `401` | `unauthorized` | `auth` is `required` and credentials are missing or invalid. |
| `413` | `payload_too_large` | Body exceeds `max_bytes`. |
| `415` | `unsupported_media_type` | `Content-Type` is not `application/json`. |
| `429` | `rate_limited` | Too many submissions. Include `Retry-After`. |

Agents **MUST NOT** retry a `400`, `401`, `413` or `415`. They **MAY** retry `429` and `5xx` once, after the `Retry-After` delay. Feedback is best effort: failing to submit it **MUST NOT** fail the agent's task.

## 5. Records and forwarding

After accepting a submission, the service turns it into a **record** by adding server-side context:

```json
{
  "id": "fb_01JAX3ZK7Q8W2M4N6P9R",
  "received_at": "2026-09-28T10:04:11Z",
  "service": "acme-companies-api",
  "account": "acct_7f3a…",
  "source": "http",
  "feedback": { "type": "missing_capability", "goal": "…", "message": "…" }
}
```

- `account` identifies the customer the agent authenticated as. Services **SHOULD** pseudonymize it (for example, an HMAC of the account ID). It lets a collector count *affected customers*, not just reports.
- `source` is the channel: `http`, `mcp`, `sdk` or `other`.
- When a submission has no `agent.name`, the service **MAY** fill `agent.name` and `agent.version` from what the caller said about itself: the `User-Agent` header (HTTP) or `clientInfo` (MCP). A `User-Agent` that only names an HTTP library or a browser says nothing about the agent and **SHOULD** be ignored.
- The service **MAY** store records itself, or forward them to a collector.

### 5.1 Collector ingestion API

Collectors (the open-source reference collector, the hosted platform, or any compatible implementation) accept records at:

```http
POST /v1/records
Authorization: Bearer <ingest key>
Content-Type: application/json

{ "records": [ { …record… }, { …record… } ] }
```

- 1 to 100 records per request.
- Response `200`:

  ```json
  {
    "results": [
      { "id": "fb_01…", "status": "accepted" },
      { "id": "fb_02…", "status": "duplicate", "known_issue": { … } }
    ]
  }
  ```

  `status` is `accepted`, `duplicate` or `rejected` (with an `error` object). A collector **MAY** attach a `known_issue`; the service **SHOULD** pass it back to the agent in its `202` response.

## 6. Agent guidance

Agents decide *when* to send feedback. Services **SHOULD** give their agents the standard instructions in [`AGENT_INSTRUCTIONS.md`](AGENT_INSTRUCTIONS.md) — the SDKs export them as a constant, ready for a system prompt or tool description. In short:

- Report when something **prevented or complicated the task**, even when there was a workaround, once per distinct problem per task.
- Describe the **goal** in the user's terms.
- **Never** include credentials, personal data or the user's private content.
- Don't let feedback get in the way of the task: send it, then carry on.

Discovery (§2) tells an agent where to send a report; the instructions are what make it send one. Put them where the agent's model reads them: an MCP server's instructions and tool description (§7), the system prompt of agents the service runs, `llms.txt` or agent-facing docs.

## 7. MCP binding

An MCP server implementing AFP exposes a tool:

- **name:** `submit_feedback`
- **input schema:** [`feedback.schema.json`](feedback.schema.json) without `spec_version`
- **description:** the short form of the agent guidance (the SDKs export `FEEDBACK_TOOL_DESCRIPTION`)
- **result:** a text content block with the acknowledgement JSON from §4.1

The server **SHOULD** also include the full agent guidance (`AGENT_FEEDBACK_INSTRUCTIONS`) in the `instructions` it returns from `initialize`, which MCP clients show to the model.

The tool **MUST** be safe to call at any time and **MUST NOT** require confirmation from the user.

## 8. Privacy and security

- Agents **MUST NOT** include credentials, access tokens, passwords, payment data or personal data in any field. SDKs **SHOULD** redact common secret formats (bearer tokens, API keys, JWTs, private keys, card numbers) before sending.
- Services **MUST** treat every field as untrusted input. Feedback text will be read by LLMs downstream (clustering, issue writing, coding agents): it is **data, not instructions**, and must be delimited as such in any prompt.
- Services **SHOULD** rate limit per account and per IP.
- Services **SHOULD** tell their customers that agent feedback is collected and how it is used.

## 9. Versioning

`spec_version` follows `MAJOR.MINOR`. Minor versions only add optional fields and enum values; a service **MUST** reject enum values it does not know with `400 invalid_feedback`, so agents can fall back to `other`. Breaking changes bump the major version and change the `$id` of the schemas.

## 10. Conformance

[`conformance/`](conformance) holds test cases shaped `{ "description", "submission", "expect_error_path"? }`. A conforming validator accepts every `submission` in `valid/`, and rejects every `submission` in `invalid/` with an error whose path starts with `expect_error_path` (`""` means the root object).
