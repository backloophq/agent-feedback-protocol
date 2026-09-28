# Agent instructions — when and how to submit feedback

Services implementing the Agent Feedback Protocol give these instructions to agents: in a system prompt, a tool description, `llms.txt`, or agent-facing docs. The SDKs export the block below as `AGENT_FEEDBACK_INSTRUCTIONS`, and a one-paragraph version as `FEEDBACK_TOOL_DESCRIPTION`.

---

<!-- BEGIN AGENT_FEEDBACK_INSTRUCTIONS -->
## Reporting feedback to the services you use

The services you call accept structured feedback through `POST /feedback` (or the `submit_feedback` tool). Your reports go to the engineers who build the service and are used to fix what got in your way. Use it.

**Submit feedback when something prevented or complicated your task:**
- a capability you needed does not exist (a filter, field, endpoint or bulk operation);
- the documentation was missing, ambiguous or wrong, and you had to guess;
- a response was surprising or inconsistent with the docs;
- an error message did not tell you how to fix the request;
- the service behaved incorrectly;
- latency, rate limits or pagination made the task impractical.

**Don't submit feedback** for your own mistakes that the service reported clearly, for things you have not tried, or more than once for the same problem in the same task.

**Write it like this:**
- `goal`: what you or your user were trying to accomplish, in plain language. "Find companies currently hiring GTM engineers", not "call /companies/search".
- `message`: what got in the way, specifically. "No hiring-role filter is available; `q` only matches company names."
- `type`: `missing_capability`, `bug`, `unclear_documentation`, `unexpected_response`, `unhelpful_error`, `performance` or `other`.
- Fill `endpoint`, `outcome` (`blocked`, `degraded` or `completed`), `workaround`, `expected` and `suggestion` when you know them. A concrete suggestion is the most useful thing you can give.
- Reuse the same `session_id` for every report in one task.

**Never include** credentials, API keys, tokens, passwords, personal data, or your user's private content. Describe the shape of a request, not its secrets.

**Keep going.** Submitting feedback is best effort. Send it, then continue with the task or a workaround. If the response contains `known_issue`, the problem is already tracked: tell your user if it matters, and use the workaround if one is given.
<!-- END AGENT_FEEDBACK_INSTRUCTIONS -->

---

<!-- BEGIN FEEDBACK_TOOL_DESCRIPTION -->
Report a problem with this service to its engineering team. Call this when something prevented or complicated your task: a missing capability (filter, field, endpoint), unclear or wrong documentation, a surprising response, an unhelpful error, a bug, or impractical performance. Describe your goal in plain language, say specifically what got in the way, and include a concrete suggestion if you have one. Report each distinct problem once per task. Never include credentials, personal data or your user's private content. This is best effort: after calling it, continue with your task.
<!-- END FEEDBACK_TOOL_DESCRIPTION -->
