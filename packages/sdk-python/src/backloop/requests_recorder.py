"""Agent analytics for REST APIs: every request an AI agent makes becomes an ``http_request`` event.

The twin of ``recordRequests`` in ``@backloop/sdk``, as ASGI (FastAPI,
Starlette) and WSGI (Flask, Django, any WSGI app) middleware, standard library only::

    app.add_middleware(record_requests, url=BACKLOOP_URL, ingest_key=INGEST_KEY)            # FastAPI / Starlette
    app.wsgi_app = record_requests(app.wsgi_app, url=BACKLOOP_URL, ingest_key=INGEST_KEY)  # Flask

Human traffic (browsers, unknown clients) is not recorded unless ``agents_only=False``.
"""

from __future__ import annotations

import inspect
import json
import re
import time
import urllib.parse
from typing import Any, Callable, Dict, Iterable, Iterator, List, Mapping, Optional, Tuple, Union

from ._events import SESSION_EVENT_LIMITS, EventQueue, OnEvents, RedactOption, Scrubber, clip, iso_now
from .ids import new_id

HeadersLike = Union[Mapping[str, Any], Iterable[Tuple[Any, Any]]]
Client = Dict[str, str]

#: Known AI agents and agent runtimes, by User-Agent product token. Order matters: specific first.
#: The same list, in the same order, as ``AGENT_PATTERNS`` in ``requests.ts``.
_AGENT_PATTERNS: List[Tuple["re.Pattern[str]", str]] = [
    (re.compile(p, re.I), name)
    for p, name in (
        (r"claude-code", "claude-code"),
        (r"Claude-User", "Claude-User"),
        (r"Claude-SearchBot", "Claude-SearchBot"),
        (r"ClaudeBot", "ClaudeBot"),
        (r"ChatGPT-User", "ChatGPT-User"),
        (r"OAI-SearchBot", "OAI-SearchBot"),
        (r"GPTBot", "GPTBot"),
        (r"Perplexity-User", "Perplexity-User"),
        (r"PerplexityBot", "PerplexityBot"),
        (r"Google-Extended|Gemini", "Gemini"),
        (r"MistralAI-User", "MistralAI-User"),
        (r"\bCursor\b", "Cursor"),
        (r"\bCodex\b", "Codex"),
        (r"\bDevin\b", "Devin"),
        (r"Manus", "Manus"),
        (r"\bAnthropic/|anthropic-(?:typescript|python|sdk)", "anthropic-sdk"),
        (r"\bOpenAI/|openai-(?:node|python)", "openai-sdk"),
        (r"langchain|langgraph", "langchain"),
        (r"llamaindex", "llamaindex"),
        (r"mcp-remote|modelcontextprotocol|\bmcp\b", "mcp-client"),
        (r"agent|\bbot\b|crawler|spider", "agent"),
    )
]

_ID_SEGMENT = re.compile(
    r"^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z]{2,6}_[A-Za-z0-9]{6,}"
    r"|[0-9a-f]{16,}|[A-Za-z0-9]{20,})$",
    re.I | re.ASCII,
)
_DEFAULT_SKIP = re.compile(r"/(feedback|healthz|health)(/|$)|/\.well-known/")
_TEXTUAL = re.compile(r"json|text|xml", re.I)
#: Bytes of a body kept: what ``requests.ts`` reads (8000 characters).
_BODY_BYTES = 8000


def _normalize(headers: Optional[HeadersLike]) -> Dict[str, str]:
    """Lower-cased header names; a repeated header keeps its first value, like ``detectAgent``."""
    out: Dict[str, str] = {}
    if not headers:
        return out
    items = headers.items() if isinstance(headers, Mapping) else headers
    for key, value in items:
        if isinstance(key, bytes):
            key = key.decode("latin-1")
        if isinstance(value, (list, tuple)):
            value = value[0] if value else None
        if isinstance(value, bytes):
            value = value.decode("latin-1")
        if value is not None:
            out.setdefault(str(key).lower(), str(value))
    return out


def _detect(headers: Mapping[str, str]) -> Optional[Client]:
    explicit = headers.get("x-agent-name") or headers.get("x-agent")
    if explicit and explicit.strip():
        return {"name": explicit.strip()[:128]}
    signature = re.sub(r'^"|"$', "", headers.get("signature-agent") or "").strip()  # Web Bot Auth
    if signature:
        host = urllib.parse.urlsplit(signature).hostname if "://" in signature else None
        return {"name": (host or signature)[:128]}
    user_agent = headers.get("user-agent") or ""
    for pattern, name in _AGENT_PATTERNS:
        m = pattern.search(user_agent)
        if m:
            client = {"name": name}
            v = re.search(re.escape(m.group(0)) + r"/([\w.-]{1,32})", user_agent, re.I)
            if v:
                client["version"] = v.group(1)
            return client
    # An HTTP library calling with an MCP or agent session header is an agent too.
    if headers.get("mcp-session-id") or headers.get("x-agent-session"):
        return {"name": "agent"}
    return None


def detect_agent(headers: Optional[HeadersLike]) -> Optional[str]:
    """The AI agent behind a request, from its headers, or None for human or unknown traffic.

    Explicit headers win (``X-Agent-Name``, ``X-Agent``, ``Signature-Agent``
    from Web Bot Auth), then the User-Agent (Claude-User, ChatGPT-User,
    claude-code, Cursor, the Anthropic and OpenAI SDKs...). An HTTP library
    such as python-httpx counts when the request carries ``X-Agent-Session``
    or ``Mcp-Session-Id``. Accepts a mapping or ``(name, value)`` pairs.
    """
    client = _detect(_normalize(headers))
    return client["name"] if client else None


def collapse_path(path: str) -> str:
    """``/companies/cmp_001/jobs`` -> ``/companies/:id/jobs``: the route when the framework names none."""
    return "/".join(":id" if seg and _ID_SEGMENT.match(seg) else seg for seg in path.split("/")) or "/"


class _Recorder:
    def __init__(
        self,
        url: Optional[str],
        ingest_key: Optional[str],
        service: Optional[str],
        identify: Optional[Callable[[Any], Any]],
        agents_only: bool,
        route: Optional[Callable[[Any], Optional[str]]],
        skip: Optional[Callable[[str], bool]],
        redact: RedactOption,
        preview_chars: int,
        flush_ms: float,
        on_events: Optional[OnEvents],
        on_error: Optional[Callable[[BaseException], None]],
    ) -> None:
        self.queue = EventQueue(url, ingest_key, on_events, flush_ms, on_error)
        self.scrub = Scrubber(redact, preview_chars)
        self.service = service
        self.identify = identify
        self.agents_only = agents_only
        self.route = route
        self.skip = skip or (lambda path: bool(_DEFAULT_SKIP.search(path)))

    def flush(self) -> None:
        """Send what is queued now. Also run at exit."""
        self.queue.flush()

    def client_for(self, path: str, headers: Mapping[str, str]) -> "Tuple[bool, Optional[Client]]":
        """``(record, client)`` for a request about to run."""
        if not self.queue.enabled:
            return False, None
        try:
            if self.skip(path):
                return False, None
        except Exception:
            pass
        client = _detect(headers)
        return (client is not None or not self.agents_only), client

    def body_cap(self, content_type: Optional[str], always: bool) -> int:
        if not content_type or not _TEXTUAL.search(content_type):
            return 0
        return _BODY_BYTES if always or self.scrub.preview_chars else 0

    def route_for(self, request: Any, framework: Optional[str], path: str) -> str:
        if self.route is not None:
            try:
                chosen = self.route(request)
                if isinstance(chosen, str) and chosen:
                    return chosen
            except Exception:
                pass
        return framework or collapse_path(path)

    def preview(self, text: Optional[str]) -> Optional[str]:
        """Like ``preview`` in ``requests.ts``: JSON is redacted by key as well, then everything as text."""
        if not self.scrub.preview_chars or not text:
            return None
        out = text
        if self.scrub.enabled and text.strip()[:1] in ("[", "{"):
            try:
                out = json.dumps(self.scrub.value(json.loads(text)), ensure_ascii=False, separators=(",", ":"))
            except ValueError:
                pass
        return clip(self.scrub.string(out), self.scrub.preview_chars)

    def record(
        self,
        *,
        request: Any,
        method: str,
        path: str,
        framework_route: Optional[str],
        status: int,
        started: float,
        headers: Mapping[str, str],
        client: Optional[Client],
        account: Any,
        query: str,
        body: Optional[bytes],
        response: Optional[bytes],
        error: Optional[BaseException] = None,
    ) -> None:
        try:
            event: Dict[str, Any] = {"id": new_id("ev"), "kind": "http_request"}
            session_id = headers.get("x-agent-session") or headers.get("mcp-session-id")
            if session_id:
                event["session_id"] = clip(session_id, 256)
            if self.service:
                event["service"] = self.service
            if isinstance(account, str) and account:
                event["account"] = clip(account, 256)
            if client:
                event["client"] = client
            event.update(
                method=method.upper(),
                route=clip(self.route_for(request, framework_route, path), 512),
                status=int(status),
                started_at=iso_now(started),
                duration_ms=max(0, round(time.time() * 1000 - started)),
            )
            text = response.decode("utf-8", "replace") if response else None
            if error is not None:
                event["error"] = self.scrub.error(str(error) or type(error).__name__)
            elif status >= 400 and text:
                event["error"] = self.scrub.error(text)
            # The query, as requests.ts sends it ("a=1 b=2"); without one, the request body.
            if query:
                preview = self.preview(urllib.parse.unquote(query).replace("&", " "))
            else:
                preview = self.preview(body.decode("utf-8", "replace")) if body else None
            if preview:
                event["input"] = preview
            preview = self.preview(text)
            if preview:
                event["result"] = preview
            self.queue.push(event)
        except Exception as e:  # noqa: BLE001 - recording never breaks a request
            self.queue._error(e)

    def account_sync(self, request: Any) -> Any:
        if not self.identify:
            return None
        try:
            account = self.identify(request)
        except Exception:
            return None
        if inspect.isawaitable(account):
            close = getattr(account, "close", None)
            if callable(close):
                close()
            return None
        return account


class _Capture:
    """Keeps the first ``cap`` bytes of what passes through."""

    def __init__(self, cap: int) -> None:
        self.cap = cap
        self.chunks: List[bytes] = []
        self.size = 0

    def add(self, data: Any) -> None:
        if self.size < self.cap and data:
            piece = bytes(data[: self.cap - self.size])
            self.chunks.append(piece)
            self.size += len(piece)

    def value(self) -> Optional[bytes]:
        return b"".join(self.chunks) if self.chunks else None


# -- ASGI ---------------------------------------------------------------------


class RecordRequestsASGI:
    """ASGI middleware recording agent requests. Build it with :func:`record_requests`."""

    def __init__(self, app: Any, recorder: _Recorder) -> None:
        self.app = app
        self._recorder = recorder

    def flush(self) -> None:
        """Send what is queued now."""
        self._recorder.flush()

    async def __call__(self, scope: Dict[str, Any], receive: Callable[..., Any], send: Callable[..., Any]) -> None:
        rec = self._recorder
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        headers = _normalize(scope.get("headers") or [])
        path = scope.get("path") or "/"
        record, client = rec.client_for(path, headers)
        if not record:
            await self.app(scope, receive, send)
            return
        started = time.time() * 1000
        query = (scope.get("query_string") or b"").decode("latin-1")
        body = _Capture(0 if query else rec.body_cap(headers.get("content-type"), False))
        response = _Capture(0)
        state: Dict[str, Any] = {"status": None}

        async def receive_wrapper() -> Any:
            message = await receive()
            if message.get("type") == "http.request":
                body.add(message.get("body") or b"")
            return message

        async def send_wrapper(message: Dict[str, Any]) -> None:
            kind = message.get("type")
            if kind == "http.response.start":
                state["status"] = message.get("status", 200)
                content_type = _normalize(message.get("headers") or []).get("content-type")
                response.cap = rec.body_cap(content_type, state["status"] >= 400)
            elif kind == "http.response.body":
                response.add(message.get("body") or b"")
            await send(message)

        error: Optional[BaseException] = None
        try:
            await self.app(scope, receive_wrapper if body.cap else receive, send_wrapper)
        except Exception as e:
            error = e
            raise
        finally:
            account = None
            if rec.identify:
                try:
                    account = rec.identify(scope)
                    if inspect.isawaitable(account):
                        account = await account
                except Exception:
                    account = None
            rec.record(
                request=scope,
                method=scope.get("method") or "GET",
                path=path,
                framework_route=_asgi_route(scope),
                status=(state["status"] or 500) if error is not None else (state["status"] or 200),
                started=started,
                headers=headers,
                client=client,
                account=account,
                query=query,
                body=body.value(),
                response=response.value(),
                error=error,
            )


def _asgi_route(scope: Mapping[str, Any]) -> Optional[str]:
    """The matched route template: FastAPI puts its ``APIRoute`` in the scope."""
    route = scope.get("route")
    for attr in ("path_format", "path"):
        template = getattr(route, attr, None)
        if isinstance(template, str) and template:
            return template
    return None


# -- WSGI ---------------------------------------------------------------------


class _TeeInput:
    """A ``wsgi.input`` that keeps a copy of the first bytes read."""

    def __init__(self, stream: Any, capture: _Capture) -> None:
        self._stream = stream
        self._capture = capture

    def read(self, *args: Any) -> bytes:
        data = self._stream.read(*args)
        self._capture.add(data)
        return data

    def readline(self, *args: Any) -> bytes:
        data = self._stream.readline(*args)
        self._capture.add(data)
        return data

    def readlines(self, *args: Any) -> List[bytes]:
        lines = self._stream.readlines(*args)
        for line in lines:
            self._capture.add(line)
        return lines

    def __iter__(self) -> Iterator[bytes]:
        for line in self._stream:
            self._capture.add(line)
            yield line

    def __getattr__(self, name: str) -> Any:
        return getattr(self._stream, name)


class _ResponseBody:
    """Wraps a WSGI response iterable: keeps the first bytes, records the request on ``close()``."""

    def __init__(self, iterable: Iterable[bytes], capture: _Capture, done: Callable[[Optional[BaseException]], None]) -> None:
        self._iterable = iterable
        self._capture = capture
        self._done = done
        self._finished = False

    def __iter__(self) -> Iterator[bytes]:
        try:
            for chunk in self._iterable:
                self._capture.add(chunk)
                yield chunk
        except Exception as e:
            self._finish(e)
            raise
        self._finish(None)  # all sent: some servers and test clients close late

    def close(self) -> None:
        try:
            close = getattr(self._iterable, "close", None)
            if callable(close):
                close()
        finally:
            self._finish(None)

    def _finish(self, error: Optional[BaseException]) -> None:
        if not self._finished:
            self._finished = True
            self._done(error)


class RecordRequestsWSGI:
    """WSGI middleware recording agent requests. Build it with :func:`record_requests`."""

    def __init__(self, app: Any, recorder: _Recorder) -> None:
        self.app = app
        self._recorder = recorder
        # Flask: `record_requests(app.wsgi_app)` wraps a bound method of the app, whose url_map names the route.
        self._url_map = getattr(getattr(app, "__self__", app), "url_map", None)

    def flush(self) -> None:
        """Send what is queued now."""
        self._recorder.flush()

    def __call__(self, environ: Dict[str, Any], start_response: Callable[..., Any]) -> Any:
        rec = self._recorder
        headers = {k[5:].replace("_", "-").lower(): v for k, v in environ.items() if k.startswith("HTTP_")}
        if environ.get("CONTENT_TYPE"):
            headers["content-type"] = environ["CONTENT_TYPE"]
        path = environ.get("PATH_INFO") or "/"
        record, client = rec.client_for(path, headers)
        if not record:
            return self.app(environ, start_response)
        started = time.time() * 1000
        query = environ.get("QUERY_STRING") or ""
        body = _Capture(0 if query else rec.body_cap(headers.get("content-type"), False))
        if body.cap and environ.get("wsgi.input") is not None:
            environ["wsgi.input"] = _TeeInput(environ["wsgi.input"], body)
        response = _Capture(0)
        state: Dict[str, Any] = {"status": None}

        def start_response_wrapper(status: str, response_headers: List[Tuple[str, str]], exc_info: Any = None) -> Any:
            try:
                state["status"] = int(str(status).split(" ", 1)[0])
            except ValueError:
                state["status"] = 500
            response.cap = rec.body_cap(_normalize(response_headers).get("content-type"), state["status"] >= 400)
            if exc_info is not None:
                return start_response(status, response_headers, exc_info)
            return start_response(status, response_headers)

        def done(error: Optional[BaseException]) -> None:
            rec.record(
                request=environ,
                method=environ.get("REQUEST_METHOD") or "GET",
                path=path,
                framework_route=self._route(environ),
                status=(state["status"] or 500) if error is not None else (state["status"] or 200),
                started=started,
                headers=headers,
                client=client,
                account=rec.account_sync(environ),
                query=query,
                body=body.value(),
                response=response.value(),
                error=error,
            )

        try:
            iterable = self.app(environ, start_response_wrapper)
        except Exception as e:
            done(e)
            raise
        return _ResponseBody(iterable, response, done)

    def _route(self, environ: Dict[str, Any]) -> Optional[str]:
        if self._url_map is None:
            return None
        try:
            rule, _args = self._url_map.bind_to_environ(environ).match(return_rule=True)
            return rule.rule if isinstance(getattr(rule, "rule", None), str) else None
        except Exception:
            return None


def _is_asgi(app: Any) -> bool:
    return inspect.iscoroutinefunction(app) or inspect.iscoroutinefunction(getattr(app, "__call__", None))


def record_requests(
    app: Any,
    *,
    url: Optional[str] = None,
    ingest_key: Optional[str] = None,
    service: Optional[str] = None,
    identify: Optional[Callable[[Any], Any]] = None,
    agents_only: bool = True,
    route: Optional[Callable[[Any], Optional[str]]] = None,
    skip: Optional[Callable[[str], bool]] = None,
    redact: RedactOption = True,
    preview_chars: int = 1000,
    flush_ms: float = 1000,
    on_events: Optional[OnEvents] = None,
    on_error: Optional[Callable[[BaseException], None]] = None,
    asgi: Optional[bool] = None,
) -> Union[RecordRequestsASGI, RecordRequestsWSGI]:
    """Wrap an ASGI or WSGI app so each agent request becomes an ``http_request`` event.

    The kind of app is detected (``asgi=True/False`` forces it). Only requests
    from detected agents are recorded unless ``agents_only=False`` (see
    :func:`detect_agent`). ``identify(request)`` and ``route(request)`` get the
    ASGI scope or the WSGI environ; ``identify`` returns the pseudonymous
    account (it may be async under ASGI), ``route`` the route template when
    the framework names none (default: FastAPI's route, Flask's url rule, else
    the path with ids collapsed to ``:id``). ``skip(path)`` leaves requests out
    (default: ``/feedback``, ``/health``, ``/healthz`` and ``/.well-known/``).
    The middleware's ``flush()`` sends what is queued now.
    """
    recorder = _Recorder(
        url, ingest_key, service, identify, agents_only, route, skip, redact,
        min(preview_chars, SESSION_EVENT_LIMITS["preview"]), flush_ms, on_events, on_error,
    )  # fmt: skip
    if asgi if asgi is not None else _is_asgi(app):
        return RecordRequestsASGI(app, recorder)
    return RecordRequestsWSGI(app, recorder)


__all__ = ["RecordRequestsASGI", "RecordRequestsWSGI", "collapse_path", "detect_agent", "record_requests"]
