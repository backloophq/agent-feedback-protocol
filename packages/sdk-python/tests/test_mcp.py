"""instrument_server: session analytics for FastMCP servers.

Most tests use a fake server shaped like FastMCP (a tool manager holding tools
with ``fn``); the real-server tests run only where ``mcp`` or ``fastmcp`` is installed.
"""

import asyncio
import importlib.util
import inspect
import json
import re
import unittest

from backloop import instrument_server
from backloop.mcp import TELEMETRY_ARGUMENT

from .helpers import LocalServer, refused_url

ISO = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")


def _installed(module):
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def run(value):
    return asyncio.run(value) if inspect.isawaitable(value) else value


class FakeTool:
    def __init__(self, fn, name):
        self.fn = fn
        self.name = name
        params = [p for p in inspect.signature(fn).parameters if p != "ctx"]
        self.parameters = {"type": "object", "properties": {p: {} for p in params}}

    def run(self, arguments, ctx=None):
        kwargs = dict(arguments)
        if "ctx" in inspect.signature(self.fn).parameters:
            kwargs["ctx"] = ctx
        return run(self.fn(**kwargs))


class FakeToolManager:
    def __init__(self):
        self._tools = {}

    def add_tool(self, fn, name=None):
        tool = FakeTool(fn, name or fn.__name__)
        self._tools[tool.name] = tool
        return tool


class Context:
    """Named like the SDKs' Context: an argument of this type is the request context, not input."""

    def __init__(self, session_id=None, client=("claude-code", "1.0.3")):
        info = type("Info", (), {"name": client[0], "version": client[1]})() if client else None
        params = type("Params", (), {"clientInfo": info})()
        session = type("Session", (), {"client_params": params})()
        request = type("Request", (), {"headers": {"mcp-session-id": session_id} if session_id else {}})()
        self.request_context = type("RC", (), {"session": session, "request": request})()


class FakeFastMCP:
    def __init__(self):
        self._tool_manager = FakeToolManager()
        self.context = None

    def add_tool(self, fn, name=None):
        return self._tool_manager.add_tool(fn, name=name)

    def tool(self, name=None):
        def decorator(fn):
            self.add_tool(fn, name=name)
            return fn

        return decorator

    def get_context(self):
        if self.context is None:
            raise ValueError("outside a request")
        return self.context

    def call(self, name, arguments):
        return self._tool_manager._tools[name].run(arguments, self.context)


def collect(server, **options):
    events = []
    analytics = instrument_server(server, on_events=events.extend, **options)
    return analytics, events


class InstrumentServerTest(unittest.TestCase):
    def setUp(self):
        self.server = FakeFastMCP()

        @self.server.tool()
        def search(query: str, limit: int = 10) -> str:
            return f"{limit} results for {query}"

    def test_tool_call_event_shape(self):
        analytics, events = collect(self.server, service="acme-mcp", identify=lambda ctx: "acct_7")
        self.server.context = Context(session_id="mcp-sess-1")
        self.assertEqual(self.server.call("search", {"query": "gtm", "limit": 3}), "3 results for gtm")
        analytics.flush()
        [event] = events
        self.assertRegex(event.pop("id"), r"^ev_[0-9A-Z]{26}$")
        self.assertRegex(event.pop("started_at"), ISO)
        self.assertIsInstance(event.pop("duration_ms"), int)
        self.assertEqual(
            event,
            {
                "kind": "tool_call",
                "session_id": "mcp-sess-1",
                "service": "acme-mcp",
                "account": "acct_7",
                "client": {"name": "claude-code", "version": "1.0.3"},
                "tool": "search",
                "ok": True,
                "input": '{"query":"gtm","limit":3}',
                "result": "3 results for gtm",
            },
        )
        json.dumps(event)  # plain JSON

    def test_tools_registered_before_and_after_are_covered(self):
        analytics, events = collect(self.server)

        def later(x: int) -> int:
            return x * 2

        self.server.add_tool(later)

        @self.server.tool(name="decorated")
        def decorated_fn() -> str:
            return "ok"

        for name in ("search", "later", "decorated"):
            self.assertIn(TELEMETRY_ARGUMENT, self.server._tool_manager._tools[name].parameters["properties"])
        self.server.call("search", {"query": "a"})
        self.assertEqual(self.server.call("later", {"x": 2}), 4)
        self.server.call("decorated", {})
        analytics.flush()
        self.assertEqual([e["tool"] for e in events], ["search", "later", "decorated"])

    def test_instrumenting_twice_wraps_once(self):
        first, events = collect(self.server)
        second, more = collect(self.server)
        self.server.call("search", {"query": "a"})
        first.flush()
        second.flush()
        self.assertEqual(len(events) + len(more), 1)

    def test_telemetry_is_removed_and_recorded(self):
        seen = {}

        @self.server.tool()
        def echo(**kwargs) -> str:
            seen.update(kwargs)
            return "ok"

        analytics, events = collect(self.server)
        self.server.call(
            "echo",
            {
                "text": "hi",
                TELEMETRY_ARGUMENT: {
                    "user_intent": "  Find GTM engineers, my key is sk-ant-abcdefghijklmnopqrstu  ",
                    "agent_thinking": "",
                    "user_frustration": "furious",  # not a level: dropped
                    "agent_model": "claude-opus-4-1",
                    "extra": "ignored",
                },
            },
        )
        analytics.flush()
        self.assertEqual(seen, {"text": "hi"})
        self.assertEqual(
            events[0]["telemetry"],
            {"user_intent": "Find GTM engineers, my key is [REDACTED]", "agent_model": "claude-opus-4-1"},
        )
        self.assertEqual(events[0]["input"], '{"text":"hi"}')

    def test_telemetry_schema(self):
        collect(self.server)
        schema = self.server._tool_manager._tools["search"].parameters["properties"][TELEMETRY_ARGUMENT]
        self.assertEqual(
            sorted(schema["properties"]), ["agent_model", "agent_thinking", "user_frustration", "user_intent"]
        )
        self.assertEqual(schema["properties"]["user_frustration"]["enum"], ["low", "medium", "high"])
        self.assertIn("Never put secrets", schema["description"])

    def test_telemetry_false_leaves_schemas_alone(self):
        before = dict(self.server._tool_manager._tools["search"].parameters)
        analytics, events = collect(self.server, telemetry=False)
        self.assertEqual(self.server._tool_manager._tools["search"].parameters, before)
        self.server.call("search", {"query": "a"})
        analytics.flush()
        self.assertNotIn("telemetry", events[0])

    def test_feedback_tool_keeps_its_schema_but_is_recorded(self):
        @self.server.tool(name="submit_feedback")
        def submit_feedback(type: str, goal: str, message: str) -> str:
            return "accepted"

        analytics, events = collect(self.server)
        self.assertNotIn(TELEMETRY_ARGUMENT, self.server._tool_manager._tools["submit_feedback"].parameters["properties"])
        self.server.call("submit_feedback", {"type": "bug", "goal": "g", "message": "m"})
        analytics.flush()
        self.assertEqual(events[0]["tool"], "submit_feedback")

    def test_errors(self):
        @self.server.tool()
        def boom(x: str) -> str:
            raise ValueError("bad x for a@b.com")

        @self.server.tool()
        def soft() -> dict:
            return {"content": [{"type": "text", "text": "Not found"}], "isError": True}

        analytics, events = collect(self.server)
        with self.assertRaisesRegex(ValueError, "bad x"):
            self.server.call("boom", {"x": "1"})
        self.server.call("soft", {})
        analytics.flush()
        self.assertEqual((events[0]["ok"], events[0]["error"]), (False, "bad x for [REDACTED]"))
        self.assertNotIn("result", events[0])
        self.assertEqual((events[1]["ok"], events[1]["error"], events[1]["result"]), (False, "Not found", "Not found"))

    def test_async_tools_and_async_identify(self):
        @self.server.tool()
        async def fetch(ctx: Context, url: str) -> list:
            await asyncio.sleep(0)
            return [{"type": "text", "text": "page"}, {"type": "image", "data": "..."}]

        async def identify(ctx):
            return "acct_async"

        analytics, events = collect(self.server, identify=identify)
        self.server.context = Context()
        self.assertTrue(inspect.iscoroutinefunction(self.server._tool_manager._tools["fetch"].fn))
        self.server.call("fetch", {"url": "https://example.com"})
        analytics.flush()
        event = events[0]
        self.assertEqual(event["account"], "acct_async")
        self.assertEqual(event["result"], "page\n[image]")
        self.assertEqual(event["input"], '{"url":"https://example.com"}')  # the context is not input

    def test_stdio_session_is_one_per_process(self):
        analytics, events = collect(self.server)
        self.server.call("search", {"query": "a"})  # no request context at all
        self.server.context = Context(client=None)
        self.server.call("search", {"query": "b"})
        analytics.flush()
        self.assertRegex(events[0]["session_id"], r"^ses_")
        self.assertEqual(events[0]["session_id"], events[1]["session_id"])
        self.assertNotIn("client", events[0])

    def test_previews_are_redacted_and_capped(self):
        @self.server.tool()
        def login(password: str, note: str) -> str:
            return "x" * 50

        analytics, events = collect(self.server, preview_chars=20)
        self.server.call("login", {"password": "hunter2", "note": "Bearer abcdefgh12345678"})
        analytics.flush()
        self.assertEqual(events[0]["result"], "x" * 19 + "…")
        self.assertTrue(events[0]["input"].startswith('{"password":"[REDAC'))
        self.assertEqual(len(events[0]["input"]), 20)

        server = FakeFastMCP()
        server.add_tool(login)
        analytics, events = collect(server, redact=False, preview_chars=0)
        server.call("login", {"password": "hunter2", "note": "n"})
        analytics.flush()
        self.assertNotIn("input", events[0])
        self.assertNotIn("result", events[0])

    def test_disabled_without_a_destination(self):
        analytics = instrument_server(self.server)
        self.assertEqual(self.server.call("search", {"query": "a"}), "10 results for a")
        analytics.flush()


class SendTest(unittest.TestCase):
    def test_posts_batches_with_the_ingest_key(self):
        server = FakeFastMCP()
        server.add_tool(lambda: "ok", name="ping")
        with LocalServer((202, {"accepted": 1}, {})) as platform:
            analytics = instrument_server(server, url=platform.url + "/", ingest_key="ik_1", flush_ms=60_000)
            for _ in range(501):
                server.call("ping", {})
            analytics.flush()
        # The 500th event triggers a send from the background thread; flush sends the rest.
        self.assertEqual(sorted(len(b["events"]) for b in platform.json_bodies()), [1, 500])
        request = platform.requests[0]
        self.assertEqual((request["method"], request["path"]), ("POST", "/v1/sessions/events"))
        self.assertEqual(request["headers"]["authorization"], "Bearer ik_1")
        self.assertEqual(request["headers"]["content-type"], "application/json")

    def test_background_thread_sends_after_flush_ms(self):
        import time

        server = FakeFastMCP()
        server.add_tool(lambda: "ok", name="ping")
        with LocalServer((202, {}, {})) as platform:
            instrument_server(server, url=platform.url, flush_ms=10)
            server.call("ping", {})
            deadline = time.monotonic() + 5
            while not platform.requests and time.monotonic() < deadline:
                time.sleep(0.01)
        self.assertEqual(len(platform.json_bodies()[0]["events"]), 1)

    def test_retries_once_on_5xx(self):
        server = FakeFastMCP()
        server.add_tool(lambda: "ok", name="ping")
        with LocalServer((503, {}, {}), (202, {}, {})) as platform:
            analytics = instrument_server(server, url=platform.url, flush_ms=60_000)
            server.call("ping", {})
            analytics.flush()
        self.assertEqual(len(platform.requests), 2)

    def test_failures_never_reach_tools_and_warn_once(self):
        server = FakeFastMCP()
        server.add_tool(lambda: "ok", name="ping")
        analytics = instrument_server(server, url=refused_url(), flush_ms=60_000)
        with self.assertLogs("backloop", "WARNING") as logs:
            for _ in range(2):
                self.assertEqual(server.call("ping", {}), "ok")
                analytics.flush()
        self.assertEqual(len(logs.records), 1)
        self.assertIn("session events not sent", logs.output[0])

    def test_on_error_and_failing_sink(self):
        server = FakeFastMCP()
        server.add_tool(lambda: "ok", name="ping")
        errors = []

        def sink(events):
            raise RuntimeError("sink down")

        analytics = instrument_server(server, on_events=sink, on_error=errors.append)
        self.assertEqual(server.call("ping", {}), "ok")
        analytics.flush()
        self.assertEqual([str(e) for e in errors], ["sink down"])


@unittest.skipUnless(_installed("pydantic"), "pydantic not installed")
class OfficialShapeTest(unittest.TestCase):
    """A tool shaped like the official SDK's: arguments validated by ``fn_metadata.arg_model``."""

    def test_arg_model_is_extended(self):
        from pydantic import BaseModel, create_model

        class ArgModelBase(BaseModel):
            def model_dump_one_level(self):
                return {name: getattr(self, name) for name in type(self).model_fields}

        class FuncMetadata(BaseModel):
            arg_model: type

        class Tool(BaseModel):
            fn: object
            name: str
            parameters: dict
            fn_metadata: FuncMetadata
            is_async: bool = False

            def run(self, arguments):
                parsed = self.fn_metadata.arg_model.model_validate(arguments).model_dump_one_level()
                return self.fn(**parsed)

        def add(a: int, b: int = 1) -> int:
            return a + b

        model = create_model("addArguments", __base__=ArgModelBase, a=(int, ...), b=(int, 1))
        tool = Tool(fn=add, name="add", parameters=model.model_json_schema(), fn_metadata=FuncMetadata(arg_model=model))
        server = FakeFastMCP()
        server._tool_manager._tools["add"] = tool
        analytics, events = collect(server)

        self.assertIn(TELEMETRY_ARGUMENT, tool.parameters["properties"])
        self.assertEqual(tool.run({"a": "2", TELEMETRY_ARGUMENT: {"user_frustration": "high"}}), 3)
        self.assertEqual(tool.run({"a": 2}), 3)
        analytics.flush()
        self.assertEqual(events[0]["telemetry"], {"user_frustration": "high"})
        self.assertEqual(events[0]["input"], '{"a":2,"b":1}')
        self.assertNotIn("telemetry", events[1])


def _real_servers():
    """``(label, make_server, call_tools)`` for each MCP server package installed here."""
    found = []
    if _installed("mcp"):
        try:
            from mcp.server.mcpserver import MCPServer  # mcp 2.x
            from mcp.client import Client

            async def call_v2(server, calls):
                async with Client(server) as client:
                    listed = await client.list_tools()
                    return getattr(listed, "tools", listed), [await client.call_tool(n, a) for n, a in calls]

            found.append(("mcp.server.mcpserver", MCPServer, call_v2))
        except ImportError:
            pass
        try:
            from mcp.server.fastmcp import FastMCP  # mcp 1.x
            from mcp.shared.memory import create_connected_server_and_client_session

            async def call_v1(server, calls):
                async with create_connected_server_and_client_session(server._mcp_server) as client:
                    return (await client.list_tools()).tools, [await client.call_tool(n, a) for n, a in calls]

            found.append(("mcp.server.fastmcp", FastMCP, call_v1))
        except ImportError:
            pass
    if _installed("fastmcp"):
        from fastmcp import Client as FastClient
        from fastmcp import FastMCP as StandaloneFastMCP

        async def call_fastmcp(server, calls):
            async with FastClient(server) as client:
                return await client.list_tools(), [
                    await client.call_tool(n, a, raise_on_error=False) for n, a in calls
                ]

        found.append(("fastmcp", StandaloneFastMCP, call_fastmcp))
    return found


@unittest.skipUnless(_installed("mcp") or _installed("fastmcp"), "mcp / fastmcp not installed")
class RealFastMCPTest(unittest.TestCase):
    def test_real_servers(self):
        for label, make, call in _real_servers():
            with self.subTest(server=label):
                server = make("acme")

                @server.tool()
                def add(a: int, b: int = 1) -> int:
                    """Add two numbers."""
                    return a + b

                analytics, events = collect(server, service="acme-mcp")

                @server.tool()
                async def boom(x: str) -> str:
                    raise ValueError("bad x")

                tools, results = asyncio.run(
                    call(
                        server,
                        [
                            ("add", {"a": 2, TELEMETRY_ARGUMENT: {"user_intent": "add", "agent_model": "m"}}),
                            ("boom", {"x": "1"}),
                        ],
                    )
                )
                analytics.flush()
                schemas = {t.name: getattr(t, "input_schema", None) or t.inputSchema for t in tools}
                self.assertIn(TELEMETRY_ARGUMENT, schemas["add"]["properties"])
                self.assertIn(TELEMETRY_ARGUMENT, schemas["boom"]["properties"])
                self.assertEqual(results[0].content[0].text, "3")
                add_event, boom_event = events
                self.assertEqual(add_event["tool"], "add")
                self.assertTrue(add_event["ok"])
                self.assertEqual(add_event["input"], '{"a":2,"b":1}')
                self.assertEqual(add_event["result"], "3")
                self.assertEqual(add_event["telemetry"], {"user_intent": "add", "agent_model": "m"})
                self.assertIn("name", add_event["client"])
                self.assertEqual((boom_event["ok"], boom_event["error"]), (False, "bad x"))
                self.assertEqual(add_event["session_id"], boom_event["session_id"])


if __name__ == "__main__":
    unittest.main()
