# backloop-sdk

Python SDK for the [Agent Feedback Protocol](https://trybackloop.com/spec/): AI agents `POST` structured feedback to `/feedback` on the services they use, so those services learn what agents were trying to do when they got stuck.

- Standard library only (Python 3.9+). Optional FastAPI and Flask helpers.
- Validates against the protocol's [JSON Schemas](https://github.com/guimsh/agent-feedback-protocol/tree/main/spec).
- Mirrors the TypeScript SDK (`@backloop/sdk`): same validation messages, error codes and redaction.

```sh
pip install backloop-sdk              # import backloop
pip install "backloop-sdk[fastapi]"   # or [flask]
```

## Agents: send feedback

```python
from backloop import FeedbackClient

client = FeedbackClient("https://api.example.com", api_key=API_KEY, session_id="task_42")

result = client.try_submit({  # never raises: feedback must not break the task
    "type": "missing_capability",
    "goal": "Find companies currently hiring GTM engineers",
    "endpoint": "/companies/search",
    "method": "GET",
    "message": "No hiring-role filter is available",
    "outcome": "blocked",
    "suggestion": "Add a hiring_role query parameter",
})
if result.ok and "known_issue" in result.ack:
    print("Already tracked:", result.ack["known_issue"]["title"])
```

`submit()` does the same but raises `FeedbackError(message, code, status, details)`. Both redact secrets, card numbers and emails before sending, and retry once on `429`/`5xx`. Use `FeedbackClient.from_discovery(base_url)` to find the endpoint through `/.well-known/agent-feedback`, or `feedback_url_from_link(response.headers["link"], url)` to read it from an error response.

Give your agent the tool and the instructions:

```python
from backloop import AGENT_FEEDBACK_INSTRUCTIONS, feedback_tool

tools = [feedback_tool()]  # {"name": "submit_feedback", "description", "input_schema"}
# When the model calls it: client.try_submit(tool_use.input)
```

## Services: receive feedback

```python
from backloop import FeedbackHandler, forward_to, hash_account

handler = FeedbackHandler(
    on_record=forward_to("https://collector.example.com", ingest_key=INGEST_KEY),  # or your own callable
    service="acme-companies-api",
    identify=lambda request: hash_account(current_account_id(request), SECRET) if authenticated(request) else None,
)
```

FastAPI or Flask:

```python
from backloop import fastapi_router, flask_blueprint

app.include_router(fastapi_router(handler))       # FastAPI
app.register_blueprint(flask_blueprint(handler))  # Flask
```

Both serve `POST /feedback` and `GET /.well-known/agent-feedback`. Any other framework calls the handler directly:

```python
status, body, headers = handler.handle_submit(raw_body, content_type, account, client_ip)
document = handler.discovery("https://api.example.com")
```

`on_record(record)` stores or forwards each accepted record. Return `{"known_issue": {...}}` to pass a tracked issue back to the agent. If it raises, the agent gets `503`. Add `feedback_link_header()` as a `Link` header on your API's error responses so agents find the endpoint.

## Utilities

```python
from backloop import validate_submission, format_issues, redact

result = validate_submission(payload)
if not result.valid:
    print(format_issues(result.issues))  # "goal: is required; type: must be one of: ..."

redact({"note": "auth failed with Bearer 9f8e7d6c5b4a", "password": "hunter2"})
# {"note": "auth failed with [REDACTED]", "password": "[REDACTED]"}
```

## Development

```sh
python3 -m unittest discover -s tests -t .
```

The tests run the shared conformance suite in `spec/conformance`. `src/backloop/_generated.py` is generated from `spec/` by `scripts/sync-schema.mjs`; don't edit it by hand.

License: Apache-2.0
