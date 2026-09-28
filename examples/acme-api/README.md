# Acme Companies API (demo)

A small, fictional API used by the Backloop demos. It searches companies and their open jobs, and implements the
[Agent Feedback Protocol](../../spec/SPEC.md): `POST /feedback`, `GET /.well-known/agent-feedback`, and a
`Link: </feedback>; rel="agent-feedback"` header on every error.

It has a few rough edges on purpose, so agents have something to report:

- `/companies/search` cannot filter by the roles a company is hiring for.
- `employee_count` is a size band string, although the docs say it is an integer.
- `country` must be an ISO 3166-1 alpha-2 code, and a full name fails with a bare `invalid request`.
- Pages stop at 40 × 25 results.

```bash
npm start        # http://localhost:4610
npm test         # node --test, no dependencies needed
```

Accepted feedback is forwarded to `BACKLOOP_URL` (default `http://localhost:4700`, the reference collector) or to the
Backloop platform.
