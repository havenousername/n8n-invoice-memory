"""Read one office's Qdrant point and print it, or check fields on it.

Acceptance script: it reads the live collection in .env. Exit 0 when every expectation holds,
1 when one fails or the cluster can't be read, 2 when the point does not exist.

  python3 scripts/check_point.py m_anna berlin
  python3 scripts/check_point.py m_anna berlin --show stage,latest.amount,lines.2.over_by
  python3 scripts/check_point.py m_anna berlin --expect stage=2 --expect duplicate_count=1 --present summary_text
"""

import argparse
import json
import sys
from collections.abc import Iterable, Mapping
from typing import Any

import bodies
from env import InvalidEnvFile, MissingSetting, load_settings
from qdrant_api import connect
from schema import COLLECTION
from transport import HttpError, TransportError

_MISSING = object()


def get_path(payload: Any, path: str) -> Any:
    """Follow a dot path; integer segments index lists (`documents.0.error`)."""
    current = payload
    for segment in path.split("."):
        if isinstance(current, dict) and segment in current:
            current = current[segment]
        elif isinstance(current, list) and segment.isdigit() and int(segment) < len(current):
            current = current[int(segment)]
        else:
            raise KeyError(path)
    return current


def parse_expectation(text: str) -> tuple[str, Any]:
    path, separator, raw = text.partition("=")
    if not separator:
        raise ValueError(f"expected path=value, got {text!r}")
    try:
        return path, json.loads(raw)
    except json.JSONDecodeError:
        return path, raw


def failures(payload: dict, expects: Mapping[str, Any], present: Iterable[str], absent: Iterable[str]) -> list[str]:
    problems = []
    for path, expected in expects.items():
        actual = _lookup(payload, path)
        if actual is _MISSING:
            problems.append(f"{path}: expected {json.dumps(expected)}, missing")
        elif actual != expected:
            problems.append(f"{path}: expected {json.dumps(expected)}, got {json.dumps(actual)}")
    problems += [f"{path}: expected present, missing" for path in present if _lookup(payload, path) is _MISSING]
    for path in absent:
        actual = _lookup(payload, path)
        if actual is not _MISSING:
            problems.append(f"{path}: expected absent, got {json.dumps(actual)}")
    return problems


def show(payload: dict, paths: Iterable[str]) -> str:
    def render(path: str) -> str:
        value = _lookup(payload, path)
        return "<missing>" if value is _MISSING else json.dumps(value, ensure_ascii=False)

    return " ".join(f"{path}={render(path)}" for path in paths)


def _lookup(payload: dict, path: str) -> Any:
    try:
        return get_path(payload, path)
    except KeyError:
        return _MISSING


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("manager")
    parser.add_argument("office")
    parser.add_argument("--show", default="", help="comma-separated paths to print as path=value")
    parser.add_argument("--expect", action="append", default=[], metavar="PATH=VALUE")
    parser.add_argument("--present", action="append", default=[], metavar="PATH")
    parser.add_argument("--absent", action="append", default=[], metavar="PATH")
    args = parser.parse_args(argv)
    try:
        expects = dict(parse_expectation(text) for text in args.expect)
    except ValueError as error:
        parser.error(str(error))
    try:
        call = connect(load_settings(["QDRANT_URL", "QDRANT_API_KEY"]))
        points = call("POST", f"/collections/{COLLECTION}/points/scroll",
                      bodies.office_scroll(args.manager, args.office))["points"]
    except (InvalidEnvFile, MissingSetting, HttpError, TransportError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    if not points:
        print(f"no point for {args.manager}/{args.office}", file=sys.stderr)
        return 2
    payload = points[0]["payload"]
    shown = [path for path in args.show.split(",") if path]
    if shown:
        print(show(payload, shown))
    if not (shown or expects or args.present or args.absent):
        print(json.dumps(payload, indent=1, ensure_ascii=False))
    problems = failures(payload, expects, args.present, args.absent)
    for problem in problems:
        print(problem, file=sys.stderr)
    if expects or args.present or args.absent:
        print("FAILED" if problems else "ok")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
