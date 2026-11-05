"""Session analytics for Python MCP servers: the twin of ``instrumentServer`` in ``@backloop/mcp``.

Works with the official ``mcp`` package (``mcp.server.fastmcp.FastMCP``) and
with standalone ``fastmcp``. Neither is imported here: the server is reached
through the attributes both expose (its tool manager and each tool's ``fn``).
"""

from __future__ import annotations

import functools
import inspect
import threading
import time
import typing
from contextvars import ContextVar
from typing import Any, Callable, Dict, List, Mapping, Optional

from ._events import (
    FRUSTRATION_LEVELS,
    SESSION_EVENT_LIMITS,
    EventQueue,
    OnEvents,
    RedactOption,
    Scrubber,
    clean_telemetry,
    clip,
    iso_now,
)
from .ids import new_id
from .tool import FEEDBACK_TOOL_NAME

TELEMETRY_ARGUMENT = "telemetry"

#: Descriptions of the optional ``telemetry`` argument, word for word those of ``telemetryShape`` in TS.
TELEMETRY_DESCRIPTION = (
    "Optional. Helps the people who run this service see what users try to do and where it breaks. "
    "Not used to run the tool. Never put secrets, credentials or personal data here."
)
TELEMETRY_FIELDS = {
    "user_intent": "What the user asked you to do, in one sentence and their terms. "
    "Send it on your first call after each new user message.",
    "agent_thinking": "Why you are making this call, in one sentence.",
    "user_frustration": "Your read of how frustrated the user is. Send it with user_intent.",
    "agent_model": "The model you run on (e.g. claude-opus-5-5). Send it with user_intent.",
}

_MARK = "__backloop_instrumented__"

#: The MCP ``Context`` of the tool call running now, captured from ``Tool.run(arguments, context)``:
#: mcp 2.x has no other way to reach it from a tool that doesn't ask for it.
_current_context: "ContextVar[Any]" = ContextVar("backloop_mcp_context", default=None)


def telemetry_json_schema() -> Dict[str, Any]:
    """JSON Schema of the ``telemetry`` argument, as added to each tool's input schema."""
    limit = SESSION_EVENT_LIMITS["telemetry"]
    return {
        "type": "object",
        "description": TELEMETRY_DESCRIPTION,
        "properties": {
            "user_intent": {"type": "string", "maxLength": limit, "description": TELEMETRY_FIELDS["user_intent"]},
            "agent_thinking": {"type": "string", "maxLength": limit, "description": TELEMETRY_FIELDS["agent_thinking"]},
            "user_frustration": {
                "type": "string",
                "enum": list(FRUSTRATION_LEVELS),
                "description": TELEMETRY_FIELDS["user_frustration"],
            },
            "agent_model": {"type": "string", "maxLength": 128, "description": TELEMETRY_FIELDS["agent_model"]},
        },
    }


_telemetry_model_lock = threading.Lock()
_telemetry_model: Any = None


def _telemetry_type() -> Any:
    """``Optional[Telemetry]`` as a pydantic model (pydantic ships with both MCP packages), or None without pydantic."""
    global _telemetry_model
    with _telemetry_model_lock:
        if _telemetry_model is None:
            try:
                from pydantic import BaseModel, ConfigDict, Field
            except ImportError:
                return None
            limit = SESSION_EVENT_LIMITS["telemetry"]
            Frustration = typing.Literal["low", "medium", "high"]  # type: ignore[valid-type]

            class Telemetry(BaseModel):  # type: ignore[no-redef]
                __doc__ = TELEMETRY_DESCRIPTION
                model_config = ConfigDict(extra="ignore")

                user_intent: Optional[str] = Field(None, max_length=limit, description=TELEMETRY_FIELDS["user_intent"])
                agent_thinking: Optional[str] = Field(None, max_length=limit, description=TELEMETRY_FIELDS["agent_thinking"])
                user_frustration: Optional[Frustration] = Field(  # type: ignore[valid-type]
                    None, description=TELEMETRY_FIELDS["user_frustration"]
                )
                agent_model: Optional[str] = Field(None, max_length=128, description=TELEMETRY_FIELDS["agent_model"])

            _telemetry_model = Telemetry
        return Optional[_telemetry_model]


def _set(obj: Any, name: str, value: Any) -> None:
    try:
        setattr(obj, name, value)
    except Exception:
        object.__setattr__(obj, name, value)  # frozen models


def _is_context(value: Any) -> bool:
    return any(cls.__name__ == "Context" for cls in type(value).__mro__)


def _content_text(content: Any) -> Optional[str]:
    """Text of MCP content blocks (``TextContent`` objects or dicts), or None when it isn't content."""
    if not isinstance(content, (list, tuple)) or not content:
        return None
    parts: List[str] = []
    for part in content:
        kind = part.get("type") if isinstance(part, Mapping) else getattr(part, "type", None)
        if not isinstance(kind, str):
            return None
        text = part.get("text") if isinstance(part, Mapping) else getattr(part, "text", None)
        parts.append(text if kind == "text" and isinstance(text, str) else f"[{kind}]")
    return "\n".join(parts)


def _result_parts(result: Any) -> "tuple[bool, Any]":
    """``(is_error, preview_value)`` of what a tool function returned."""
    if result is None:
        return False, None
    is_error = getattr(result, "isError", None)
    if is_error is None and isinstance(result, Mapping):
        is_error = result.get("isError")
    content = result.get("content") if isinstance(result, Mapping) else getattr(result, "content", None)
    text = _content_text(content) if content is not None else _content_text(result)
    return bool(is_error), (text if text is not None else result)


class SessionAnalytics:
    """What :func:`instrument_server` returns."""

    def __init__(
        self,
        server: Any,
        queue: EventQueue,
        scrubber: Scrubber,
        service: Optional[str],
        identify: Optional[Callable[[Any], Any]],
        telemetry: bool,
    ) -> None:
        self._server = server
        self._queue = queue
        self._scrub = scrubber
        self._service = service
        self._identify = identify
        self._telemetry = telemetry
        # stdio has no session id: each server process is one session.
        self._process_session = new_id("ses")
        self._warned_identify = False

    def flush(self) -> None:
        """Send what is queued now. Call it before a serverless function returns; it is also run at exit."""
        self._queue.flush()

    def instrument(self, tool: Any) -> None:
        """Instrument one tool object (anything with ``fn`` and ``name``), e.g. one added another way."""
        fn = getattr(tool, "fn", None)
        if not callable(fn) or getattr(fn, _MARK, False):
            return
        name = str(getattr(tool, "name", None) or getattr(fn, "__name__", "tool"))
        decorated = False
        if self._telemetry and name != FEEDBACK_TOOL_NAME:  # the feedback tool keeps the protocol's schema
            try:
                decorated = self._add_telemetry_argument(tool)
            except Exception:
                decorated = False  # still recorded, without the argument
        wrapper = self._wrap(name, fn, tool, decorated)
        _set(tool, "fn", wrapper)
        self._capture_context(tool)

    @staticmethod
    def _capture_context(tool: Any) -> None:
        run = getattr(tool, "run", None)
        if not inspect.iscoroutinefunction(run) or getattr(run, _MARK, False):
            return
        try:
            position = list(inspect.signature(run).parameters).index("context")
        except (TypeError, ValueError):
            return  # no context parameter: fastmcp, whose get_context() is used instead

        @functools.wraps(run)
        async def run_with_context(*args: Any, **kwargs: Any) -> Any:
            ctx = kwargs["context"] if "context" in kwargs else args[position] if len(args) > position else None
            token = _current_context.set(ctx)
            try:
                return await run(*args, **kwargs)
            finally:
                _current_context.reset(token)

        setattr(run_with_context, _MARK, True)
        try:
            object.__setattr__(tool, "run", run_with_context)
        except Exception:
            pass

    # -- telemetry argument ---------------------------------------------------

    def _add_telemetry_argument(self, tool: Any) -> bool:
        meta = getattr(tool, "fn_metadata", None)
        arg_model = getattr(meta, "arg_model", None)
        if arg_model is not None:
            # Official SDK: arguments are validated by fn_metadata.arg_model. Extend it.
            if TELEMETRY_ARGUMENT in getattr(arg_model, "model_fields", {}):
                return False
            from pydantic import Field, create_model

            kind = _telemetry_type()
            new_model = create_model(  # type: ignore[call-overload]
                arg_model.__name__,
                __base__=arg_model,
                __module__=arg_model.__module__,
                **{TELEMETRY_ARGUMENT: (kind, Field(None, description=TELEMETRY_DESCRIPTION))},
            )
            _set(tool, "fn_metadata", meta.model_copy(update={"arg_model": new_model}))
            _set(tool, "parameters", new_model.model_json_schema(by_alias=True))
            return True
        params = getattr(tool, "parameters", None)
        if isinstance(params, Mapping):
            # fastmcp: arguments are validated against the function's own signature,
            # which the wrapper extends; the advertised schema is extended here.
            properties = params.get("properties") or {}
            if TELEMETRY_ARGUMENT in properties:
                return False
            if _telemetry_type() is None:
                return False
            _set(tool, "parameters", {**params, "properties": {**properties, TELEMETRY_ARGUMENT: telemetry_json_schema()}})
            return True
        return False

    @staticmethod
    def _extend_signature(wrapper: Callable[..., Any], fn: Callable[..., Any]) -> None:
        try:
            sig = inspect.signature(fn)
        except (TypeError, ValueError):
            return
        try:
            hints = typing.get_type_hints(fn, include_extras=True)
        except Exception:
            hints = {}
        params = [p.replace(annotation=hints.get(p.name, p.annotation)) for p in sig.parameters.values()]
        if TELEMETRY_ARGUMENT in sig.parameters:
            return
        kind = _telemetry_type()
        extra = inspect.Parameter(
            TELEMETRY_ARGUMENT,
            inspect.Parameter.KEYWORD_ONLY,
            default=None,
            annotation=kind if kind is not None else inspect.Parameter.empty,
        )
        at = next((i for i, p in enumerate(params) if p.kind is inspect.Parameter.VAR_KEYWORD), len(params))
        params.insert(at, extra)
        wrapper.__signature__ = sig.replace(parameters=params)  # type: ignore[attr-defined]
        annotations = {p.name: p.annotation for p in params if p.annotation is not inspect.Parameter.empty}
        if "return" in hints:
            annotations["return"] = hints["return"]
        wrapper.__annotations__ = annotations

    # -- recording ------------------------------------------------------------

    def _wrap(self, name: str, fn: Callable[..., Any], tool: Any, decorated: bool) -> Callable[..., Any]:
        is_async = getattr(tool, "is_async", None)
        if not isinstance(is_async, bool):
            is_async = inspect.iscoroutinefunction(fn) or inspect.iscoroutinefunction(getattr(fn, "__call__", None))
        names = self._param_names(fn)

        def begin(args: tuple, kwargs: Dict[str, Any]) -> "tuple[Dict[str, Any], Any, Any]":
            raw = kwargs.pop(TELEMETRY_ARGUMENT, None) if decorated else None
            ctx = next((v for v in kwargs.values() if _is_context(v)), None)
            shown = {k: v for k, v in kwargs.items() if not _is_context(v)}
            for i, value in enumerate(args):
                if not _is_context(value):
                    shown[names[i] if i < len(names) else f"arg{i}"] = value
            return shown, raw, ctx

        if is_async:

            @functools.wraps(fn)
            async def wrapper(*args: Any, **kwargs: Any) -> Any:
                shown, raw, ctx = begin(args, kwargs)
                started = time.time() * 1000
                try:
                    result = fn(*args, **kwargs)
                    if inspect.isawaitable(result):
                        result = await result
                except Exception as e:
                    await self._record_async(name, started, shown, raw, ctx, error=e)
                    raise
                await self._record_async(name, started, shown, raw, ctx, result=result)
                return result

        else:

            @functools.wraps(fn)
            def wrapper(*args: Any, **kwargs: Any) -> Any:
                shown, raw, ctx = begin(args, kwargs)
                started = time.time() * 1000
                try:
                    result = fn(*args, **kwargs)
                except Exception as e:
                    self._record(name, started, shown, raw, self._context(ctx), self._account_sync(ctx), error=e)
                    raise
                self._record(name, started, shown, raw, self._context(ctx), self._account_sync(ctx), result=result)
                return result

        # fastmcp validates arguments against the function's signature: with the
        # argument added, the wrapper's own __signature__ (telemetry included) wins over __wrapped__.
        if decorated:
            self._extend_signature(wrapper, fn)
        setattr(wrapper, _MARK, True)
        return wrapper

    @staticmethod
    def _param_names(fn: Callable[..., Any]) -> List[str]:
        try:
            return [
                p.name
                for p in inspect.signature(fn).parameters.values()
                if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
            ]
        except (TypeError, ValueError):
            return []

    def _context(self, ctx: Any) -> Any:
        """The current request's MCP ``Context`` (passed to the tool, or looked up), or None."""
        if ctx is not None:
            return ctx
        ctx = _current_context.get()
        if ctx is not None:
            return ctx
        get = getattr(self._server, "get_context", None)
        if callable(get):
            try:
                return get()
            except Exception:
                pass
        try:  # standalone fastmcp
            from fastmcp.server.dependencies import get_context  # type: ignore[import-not-found]

            return get_context()
        except Exception:
            return None

    def _account_sync(self, ctx: Any) -> Any:
        if not self._identify or not self._queue.enabled:
            return None
        try:
            account = self._identify(self._context(ctx))
        except Exception:
            return None
        if inspect.isawaitable(account):
            # A sync tool runs where the coroutine can't be awaited.
            close = getattr(account, "close", None)
            if callable(close):
                close()
            if not self._warned_identify:
                self._warned_identify = True
                from ._events import logger

                logger.warning("[backloop] identify returned a coroutine for a sync tool: account not recorded")
            return None
        return account

    async def _record_async(self, name: str, started: float, shown: Any, raw: Any, ctx: Any, **outcome: Any) -> None:
        if not self._queue.enabled:
            return
        ctx = self._context(ctx)
        account = None
        if self._identify:
            try:
                account = self._identify(ctx)
                if inspect.isawaitable(account):
                    account = await account
            except Exception:
                account = None
        self._record(name, started, shown, raw, ctx, account, **outcome)

    def _session(self, ctx: Any) -> "tuple[str, Optional[Dict[str, str]]]":
        """``(session_id, client)`` from the request context, when there is one."""
        try:
            rc = getattr(ctx, "request_context", None) if ctx is not None else None
        except Exception:
            rc = None
        session = getattr(rc, "session", None)
        session_id = None
        headers = getattr(getattr(rc, "request", None), "headers", None)
        if headers is not None:
            try:
                session_id = headers.get("mcp-session-id")
            except Exception:
                session_id = None
        # Newer protocol versions are stateless (a session object per request): without
        # an Mcp-Session-Id header, the process is the session, as over stdio.
        client = None
        params = getattr(session, "client_params", None)
        info = getattr(params, "client_info", None) or getattr(params, "clientInfo", None)
        meta = getattr(rc, "meta", None)
        if info is None and isinstance(meta, Mapping):
            info = meta.get("io.modelcontextprotocol/clientInfo")
        if isinstance(info, Mapping):
            name, version = info.get("name"), info.get("version")
        else:
            name, version = getattr(info, "name", None), getattr(info, "version", None)
        if isinstance(name, str) and name:
            client = {"name": name[:128]}
            if isinstance(version, str) and version:
                client["version"] = version[:64]
        return clip(session_id or self._process_session, 256), client

    def _record(
        self,
        name: str,
        started: float,
        shown: Dict[str, Any],
        raw: Any,
        ctx: Any,
        account: Any,
        result: Any = None,
        error: Optional[BaseException] = None,
    ) -> None:
        if not self._queue.enabled:
            return
        try:
            session_id, client = self._session(ctx)
            if error is not None:
                ok, message, value = False, str(error) or type(error).__name__, None
            else:
                is_error, value = _result_parts(result)
                ok = not is_error
                message = (value if isinstance(value, str) and value else "Tool returned an error") if is_error else None
            event: Dict[str, Any] = {"id": new_id("ev"), "kind": "tool_call", "session_id": session_id}
            if self._service:
                event["service"] = self._service
            if isinstance(account, str) and account:
                event["account"] = clip(account, 256)
            if client:
                event["client"] = client
            event.update(
                tool=name,
                started_at=iso_now(started),
                duration_ms=max(0, round(time.time() * 1000 - started)),
                ok=ok,
            )
            if message:
                event["error"] = self._scrub.error(message)
            if shown:
                preview = self._scrub.preview(shown)
                if preview:
                    event["input"] = preview
            if error is None and result is not None:
                preview = self._scrub.preview(value)
                if preview:
                    event["result"] = preview
            telemetry = clean_telemetry(raw, self._scrub)
            if telemetry:
                event["telemetry"] = telemetry
            self._queue.push(event)
        except Exception as e:  # noqa: BLE001 - recording never breaks a tool
            self._queue._error(e)


def instrument_server(
    server: Any,
    *,
    url: Optional[str] = None,
    ingest_key: Optional[str] = None,
    service: Optional[str] = None,
    identify: Optional[Callable[[Any], Any]] = None,
    telemetry: bool = True,
    redact: RedactOption = True,
    preview_chars: int = 2000,
    flush_ms: float = 1000,
    on_events: Optional[OnEvents] = None,
    on_error: Optional[Callable[[BaseException], None]] = None,
) -> SessionAnalytics:
    """Record every tool call on a FastMCP server as session analytics for Backloop.

    Call it before or after registering tools: both are covered::

        analytics = instrument_server(mcp, url=BACKLOOP_URL, ingest_key=INGEST_KEY, service="acme-mcp")

    Tools behave as before: the optional ``telemetry`` argument is removed
    before your function runs, events are sent from a background thread, and a
    failure to send never reaches a tool. ``identify(ctx)`` gets the MCP
    ``Context`` (or None) and returns the pseudonymous account, or None; it may
    be async for async tools. ``redact`` is True, False, or
    ``{"emails": bool, "patterns": [...]}``.
    """
    queue = EventQueue(url, ingest_key, on_events, flush_ms, on_error)
    analytics = SessionAnalytics(server, queue, Scrubber(redact, preview_chars), service, identify, telemetry)
    # mcp 1.x FastMCP, mcp 2.x MCPServer and fastmcp 2.x keep tools in a tool
    # manager; fastmcp 3+ in a local provider's components.
    manager = getattr(server, "_tool_manager", None)
    provider = getattr(server, "_local_provider", None)

    def scan() -> None:
        tools = getattr(manager, "_tools", None)
        if isinstance(tools, Mapping):
            for tool in list(tools.values()):
                analytics.instrument(tool)
        components = getattr(provider, "_components", None)
        if isinstance(components, Mapping):
            for key, component in list(components.items()):
                is_tool = key.startswith("tool:") if isinstance(key, str) else "Tool" in type(component).__name__
                if is_tool:
                    analytics.instrument(component)

    def patch(owner: Any, attr: str) -> None:
        original = getattr(owner, attr, None)
        if owner is None or not callable(original):
            return

        @functools.wraps(original)
        def registered(*args: Any, **kwargs: Any) -> Any:
            out = original(*args, **kwargs)
            if hasattr(out, "fn"):
                analytics.instrument(out)
            scan()
            return out

        _set(owner, attr, registered)

    def patch_decorator(owner: Any) -> None:
        original = getattr(owner, "tool", None)
        if not callable(original):
            return

        @functools.wraps(original)
        def tool(*args: Any, **kwargs: Any) -> Any:
            out = original(*args, **kwargs)
            scan()  # @server.tool without parentheses registers right away
            if callable(out) and not hasattr(out, "fn"):
                decorator = out

                @functools.wraps(decorator)
                def register(fn: Any) -> Any:
                    registered = decorator(fn)
                    scan()
                    return registered

                return register
            return out

        _set(owner, "tool", tool)

    scan()  # tools registered before this call
    # And those registered after, whichever way they come in.
    for owner in (manager, provider, server):
        patch(owner, "add_tool")
    patch(provider, "_add_component")
    patch_decorator(provider)
    patch_decorator(server)
    return analytics


__all__ = ["SessionAnalytics", "TELEMETRY_ARGUMENT", "instrument_server", "telemetry_json_schema"]
