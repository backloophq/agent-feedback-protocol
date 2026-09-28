"""Optional FastAPI and Flask helpers. Each imports its framework lazily.

No ``from __future__ import annotations`` here: FastAPI must be able to
resolve the locally imported ``Request`` annotation.
"""

import inspect
import json
from typing import Any, Callable, Optional

from .server import JSON_HEADERS, FeedbackHandler
from .types import WELL_KNOWN_PATH

Identify = Callable[[Any], Any]

_DISCOVERY_HEADERS = {**JSON_HEADERS, "cache-control": "public, max-age=3600"}


def _client_ip(forwarded_for: Optional[str], remote: Optional[str]) -> Optional[str]:
    if forwarded_for:
        first = forwarded_for.split(",")[0].strip()
        if first:
            return first
    return remote


def _read_capped(stream: Any, limit: int) -> bytes:
    """Read at most ``limit + 1`` bytes: enough for the handler to reject an oversized body."""
    chunks = []
    size = 0
    while size <= limit:
        chunk = stream.read(limit + 1 - size)
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
    return b"".join(chunks)


def fastapi_router(handler: FeedbackHandler, identify: Optional[Identify] = None) -> Any:
    """A FastAPI ``APIRouter`` serving ``POST /feedback`` and ``GET /.well-known/agent-feedback``.

    ``identify(request)`` (sync or async; defaults to ``handler.identify``)
    returns the caller's pseudonymous account, or None. Include it at the app
    root: ``app.include_router(fastapi_router(handler))``.
    """
    from fastapi import APIRouter, Request
    from fastapi.responses import JSONResponse
    from starlette.concurrency import run_in_threadpool

    resolve = identify or handler.identify
    router = APIRouter()

    @router.post("/feedback")
    async def submit_feedback(request: Request):  # type: ignore[no-untyped-def]
        body = bytearray()
        async for chunk in request.stream():
            body += chunk
            if len(body) > handler.max_bytes:
                break
        account = resolve(request) if resolve else None
        if inspect.isawaitable(account):
            account = await account
        client_ip = _client_ip(
            request.headers.get("x-forwarded-for"), request.client.host if request.client else None
        )
        status, payload, headers = await run_in_threadpool(
            handler.handle_submit, bytes(body), request.headers.get("content-type"), account, client_ip
        )
        return JSONResponse(payload, status_code=status, headers=headers)

    @router.get(WELL_KNOWN_PATH)
    async def agent_feedback_discovery(request: Request):  # type: ignore[no-untyped-def]
        return JSONResponse(handler.discovery(str(request.base_url)), headers=_DISCOVERY_HEADERS)

    return router


def flask_blueprint(handler: FeedbackHandler, identify: Optional[Identify] = None) -> Any:
    """A Flask ``Blueprint`` serving ``POST /feedback`` and ``GET /.well-known/agent-feedback``.

    ``identify(request)`` (defaults to ``handler.identify``) returns the
    caller's pseudonymous account, or None. Register it at the app root:
    ``app.register_blueprint(flask_blueprint(handler))``.
    """
    from flask import Blueprint, Response, request

    resolve = identify or handler.identify
    blueprint = Blueprint("backloop", __name__)

    @blueprint.route("/feedback", methods=["POST"])
    def submit_feedback() -> Any:
        body = _read_capped(request.stream, handler.max_bytes)
        account = resolve(request) if resolve else None
        client_ip = _client_ip(request.headers.get("X-Forwarded-For"), request.remote_addr)
        status, payload, headers = handler.handle_submit(
            body, request.headers.get("Content-Type"), account, client_ip
        )
        return Response(json.dumps(payload, ensure_ascii=False), status=status, headers=headers)

    @blueprint.route(WELL_KNOWN_PATH, methods=["GET"])
    def agent_feedback_discovery() -> Any:
        doc = handler.discovery(request.url_root)
        return Response(json.dumps(doc), headers=_DISCOVERY_HEADERS)

    return blueprint
