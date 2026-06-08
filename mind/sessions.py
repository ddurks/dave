"""Session storage backends for D.A.V.E.

Two backends with the same interface:

  - InMemorySessionStore: dict-based; fine for local dev and tests.
  - S3SessionStore: one JSON object per session; suitable for Lambda where
    containers are ephemeral.

Selection happens in build_session_store() based on the SESSION_BUCKET env var.

Each session is stored as {"turns": [{"role", "content"}, ...],
"lastAccess": <epoch float>}.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Dict, List

logger = logging.getLogger(__name__)

SESSION_MAX_TURNS = 20       # Keep last N messages (user + assistant)
SESSION_TTL_SECONDS = 3600   # Used by InMemorySessionStore; S3 uses lifecycle.


class InMemorySessionStore:
    """Dict-based session store. Expires entries on every write."""

    def __init__(self):
        self._store: Dict[str, Dict] = {}

    def get_turns(self, session_id: str) -> List[Dict[str, str]]:
        now = time.time()
        if session_id not in self._store:
            self._store[session_id] = {"turns": [], "lastAccess": now}
        entry = self._store[session_id]
        entry["lastAccess"] = now
        return entry["turns"]

    def append_turn(self, session_id: str, role: str, content: str) -> None:
        turns = self.get_turns(session_id)
        turns.append({"role": role, "content": content})
        if len(turns) > SESSION_MAX_TURNS:
            del turns[: len(turns) - SESSION_MAX_TURNS]
        self._cleanup_expired()

    def _cleanup_expired(self) -> None:
        now = time.time()
        expired = [
            sid for sid, s in self._store.items()
            if now - s["lastAccess"] > SESSION_TTL_SECONDS
        ]
        for sid in expired:
            del self._store[sid]

    # Exposed for tests that want to reset state between cases.
    def clear(self) -> None:
        self._store.clear()


class S3SessionStore:
    """S3-backed session store. One JSON object per session.

    Object TTL is handled by an S3 lifecycle rule (1-day expiration on the
    sessions/ prefix) — see SESSIONS.md / serverless.yml. We do not try to
    enforce TTL in code.
    """

    def __init__(self, bucket: str, key_prefix: str = "sessions/",
                 region: str = "us-east-1"):
        import boto3  # imported lazily so tests don't need boto3 installed

        self._bucket = bucket
        self._key_prefix = key_prefix
        self._s3 = boto3.client("s3", region_name=region)

    def _key(self, session_id: str) -> str:
        return f"{self._key_prefix}{session_id}.json"

    def _load(self, session_id: str) -> Dict:
        from botocore.exceptions import ClientError

        try:
            resp = self._s3.get_object(Bucket=self._bucket, Key=self._key(session_id))
            return json.loads(resp["Body"].read())
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code", "")
            if code in ("NoSuchKey", "404", "NoSuchBucket"):
                return {"turns": [], "lastAccess": time.time()}
            logger.error(f"S3 get_object failed for session {session_id}: {e}")
            raise

    def _save(self, session_id: str, entry: Dict) -> None:
        try:
            self._s3.put_object(
                Bucket=self._bucket,
                Key=self._key(session_id),
                Body=json.dumps(entry).encode("utf-8"),
                ContentType="application/json",
            )
        except Exception as e:
            logger.error(f"S3 put_object failed for session {session_id}: {e}")
            raise

    def get_turns(self, session_id: str) -> List[Dict[str, str]]:
        return self._load(session_id).get("turns", [])

    def append_turn(self, session_id: str, role: str, content: str) -> None:
        entry = self._load(session_id)
        turns = entry.setdefault("turns", [])
        turns.append({"role": role, "content": content})
        if len(turns) > SESSION_MAX_TURNS:
            del turns[: len(turns) - SESSION_MAX_TURNS]
        entry["lastAccess"] = time.time()
        self._save(session_id, entry)


def build_session_store():
    """Pick a backend based on SESSION_BUCKET. Empty/unset → in-memory."""
    bucket = os.environ.get("SESSION_BUCKET", "").strip()
    if not bucket:
        return InMemorySessionStore()
    return S3SessionStore(
        bucket=bucket,
        key_prefix=os.environ.get("SESSION_KEY_PREFIX", "sessions/"),
        region=os.environ.get("AWS_REGION", "us-east-1"),
    )
