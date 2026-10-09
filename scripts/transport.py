"""JSON over HTTP with urllib: the one place the scripts touch the network."""

import http.client
import json
import urllib.error
import urllib.request
from collections.abc import Mapping
from typing import Any, Protocol


class HttpError(Exception):
    def __init__(self, status: int, body: Any, method: str, url: str):
        super().__init__(f"{method} {url} returned HTTP {status}: {body}")
        self.status = status
        self.body = body
        self.method = method
        self.url = url


class TransportError(Exception):
    pass


class Send(Protocol):
    def __call__(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        body: Any = None,
        timeout: float = 30.0,
    ) -> Any: ...


def send(
    method: str,
    url: str,
    *,
    headers: Mapping[str, str] | None = None,
    body: Any = None,
    timeout: float = 30.0,
) -> Any:
    data = None if body is None else json.dumps(body).encode()
    request_headers = {"content-type": "application/json"} if data is not None else {}
    request_headers.update(headers or {})
    request = urllib.request.Request(url, data=data, method=method, headers=request_headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        raise HttpError(error.code, _decode_error_body(error.read()), method, url) from None
    except (OSError, http.client.HTTPException) as error:  # URLError, refused, reset, timeout
        raise TransportError(f"{method} {url}: {error}") from error
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as error:
        raise TransportError(f"{method} {url}: response is not JSON: {raw[:120]!r}") from error


def _decode_error_body(raw: bytes) -> Any:
    try:
        return json.loads(raw) if raw else None
    except json.JSONDecodeError:
        return raw.decode(errors="replace")
