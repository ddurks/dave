"""Turn logging backends for D.A.V.E.

One JSON record per dispatch() call, written to S3 for retroactive
analytics, prompt-version A/B comparisons, and regression corpus building.

Two backends with the same interface:

  - NoOpTurnLogger: silently discards. Used when no bucket is configured.
  - S3TurnLogger: PUTs one JSON object per call, day-partitioned by key.

Selection happens in build_turn_logger() based on the TURN_LOG_BUCKET env var.

Failures are swallowed: a logging error must never break a user request.
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict

logger = logging.getLogger(__name__)

MAX_FIELD_CHARS = 4000
TRUNCATION_MARKER = "...[truncated]"


def _load_prompt_version() -> str:
    """Read version from data/system-context.json at import time."""
    path = os.path.join(os.path.dirname(__file__), "data", "system-context.json")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f).get("version", "unknown")
    except (OSError, json.JSONDecodeError):
        return "unknown"


PROMPT_VERSION = _load_prompt_version()


def _truncate(value: Any) -> Any:
    """Recursively truncate any string longer than MAX_FIELD_CHARS."""
    if isinstance(value, str):
        if len(value) > MAX_FIELD_CHARS:
            return value[:MAX_FIELD_CHARS] + TRUNCATION_MARKER
        return value
    if isinstance(value, dict):
        return {k: _truncate(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_truncate(v) for v in value]
    return value


def _build_record(req_type: str, body: Dict[str, Any],
                  result: Dict[str, Any], status: int,
                  model: str) -> Dict[str, Any]:
    now = datetime.now(timezone.utc)
    epoch_ms = int(now.timestamp() * 1000)
    record = {
        "timestamp": now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z",
        "epochMs": epoch_ms,
        "sessionId": body.get("sessionId", ""),
        "type": req_type,
        "status": status,
        "model": model,
        "promptVersion": PROMPT_VERSION,
        "request": _truncate(body),
        "response": _truncate(result),
    }
    if "userId" in body:
        record["userId"] = body["userId"]
    return record


class NoOpTurnLogger:
    """Default logger when no bucket is configured. Swallows all calls."""

    def log(self, req_type: str, body: Dict[str, Any],
            result: Dict[str, Any], status: int) -> None:
        return


class S3TurnLogger:
    """S3-backed turn logger. One JSON object per dispatch.

    Object key: {prefix}{YYYY}/{MM}/{DD}/{epoch_ms}-{sessionId}-{req_type}.json
    Day-partitioned for cheap listing and lifecycle rules.
    """

    def __init__(self, bucket: str, key_prefix: str = "turns/",
                 region: str = "us-east-1",
                 model: str = "llama-3.1-8b-instant"):
        import boto3  # imported lazily so tests don't need boto3 installed

        self._bucket = bucket
        self._key_prefix = key_prefix
        self._model = model
        self._s3 = boto3.client("s3", region_name=region)

    def _key(self, epoch_ms: int, session_id: str, req_type: str) -> str:
        dt = datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc)
        safe_session = (session_id or "anon").replace("/", "_")
        return (
            f"{self._key_prefix}{dt.year:04d}/{dt.month:02d}/{dt.day:02d}/"
            f"{epoch_ms}-{safe_session}-{req_type}.json"
        )

    def _put_object(self, key: str, body: bytes) -> None:
        self._s3.put_object(
            Bucket=self._bucket,
            Key=key,
            Body=body,
            ContentType="application/json",
        )

    def log(self, req_type: str, body: Dict[str, Any],
            result: Dict[str, Any], status: int) -> None:
        try:
            record = _build_record(req_type, body, result, status, self._model)
            key = self._key(record["epochMs"], record["sessionId"], req_type)
            self._put_object(key, json.dumps(record).encode("utf-8"))
        except Exception as e:
            logger.warning(f"Turn log write failed: {e}")
            return


def build_turn_logger():
    """Pick a backend based on TURN_LOG_BUCKET. Empty/unset → NoOp."""
    bucket = os.environ.get("TURN_LOG_BUCKET", "").strip()
    if not bucket:
        return NoOpTurnLogger()
    return S3TurnLogger(
        bucket=bucket,
        key_prefix=os.environ.get("TURN_LOG_PREFIX", "turns/"),
        region=os.environ.get("AWS_REGION", "us-east-1"),
        model=os.environ.get("GROQ_MODEL", "llama-3.1-8b-instant"),
    )
