"""Qdrant REST access: cluster URL, api-key header, and the `result` envelope."""

from typing import Any, Protocol

import transport
from env import Settings


class QdrantCall(Protocol):
    def __call__(self, method: str, path: str, body: Any = None) -> Any: ...


def connect(settings: Settings, send: transport.Send = transport.send) -> QdrantCall:
    headers = {"api-key": settings.qdrant_api_key}

    def call(method: str, path: str, body: Any = None) -> Any:
        return send(method, settings.qdrant_url + path, headers=headers, body=body)["result"]

    return call
