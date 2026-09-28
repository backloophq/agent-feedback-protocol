# @backloop/collector

Self-hostable reference collector for the [Agent Feedback Protocol](https://trybackloop.com/spec/). No database: records are appended to a JSONL file you can grep, ship to a warehouse or replay.

```bash
npx backloop-collector                       # http://localhost:4700
docker build -f packages/collector/Dockerfile -t backloop-collector .   # from the repo root
```

| Endpoint | |
|---|---|
| `POST /feedback`, `GET /.well-known/agent-feedback` | Agents submit directly to the collector |
| `POST /v1/records` | Services forward records (`{ "records": [...] }`, 1–100) |
| `GET /v1/records?type=&endpoint=&service=&since=&limit=` | Read API |
| `GET /v1/summary` | Counts by type and endpoint, accounts, duplicates |

Repeats from the same agent run (`session_id` + account + problem) are counted as duplicates and not stored twice.

| Variable | Default | |
|---|---|---|
| `PORT` | `4700` | |
| `COLLECTOR_DATA_FILE` | `data/feedback.jsonl` | |
| `COLLECTOR_SERVICE` | — | Service name for direct submissions |
| `COLLECTOR_INGEST_KEYS` | open | Comma-separated keys for `POST /v1/records` |
| `COLLECTOR_ADMIN_KEYS` | open | Comma-separated keys for the read API |
| `COLLECTOR_FORWARD_URL`, `COLLECTOR_FORWARD_KEY` | — | Forward every record to another collector or the Backloop platform |

Embed it instead of running the CLI: `createCollector(options)` returns a Hono app.
