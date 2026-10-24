"""Persistence.

Single-table design for the state that has to outlive a request: mood, the
mood trace, memories, preoccupations, dial values and the spend ledger.

DynamoDB when it is reachable -- the ledger needs an atomic counter, which S3
cannot give -- otherwise a local JSON file, so dev.sh and the tests work with
no AWS account. Sessions and turn logs are not here; sessions.py and
turnlog.py own those.

Item layout (pk / sk):
    STATE    / MOOD            mood vector
    STATE    / DIALS           control-panel dial values
    STATE    / PRESENCE        last visitor heartbeat
    BUDGET   / YYYY-MM         spend ledger, micro-dollars
    MEMORY   / <ts>#<id>       episodic memory
    SEMANTIC / <ts>#<id>       distilled fact
    BUFFER   / <kind>#<ts>#<id> pre-generated utterance
"""

import json
import logging
import os
import threading
import time
from decimal import Decimal

import state_config as config

logger = logging.getLogger(__name__)


def _decode(obj):
    """DynamoDB hands back Decimal; JSON round-trips want int/float."""
    if isinstance(obj, list):
        return [_decode(o) for o in obj]
    if isinstance(obj, dict):
        return {k: _decode(v) for k, v in obj.items()}
    if isinstance(obj, Decimal):
        return int(obj) if obj % 1 == 0 else float(obj)
    return obj


def _encode(obj):
    """DynamoDB rejects float; store them as Decimal."""
    if isinstance(obj, list):
        return [_encode(o) for o in obj]
    if isinstance(obj, dict):
        return {k: _encode(v) for k, v in obj.items()}
    if isinstance(obj, float):
        return Decimal(str(round(obj, 6)))
    return obj


class LocalStore:
    """JSON-file backend for local development. Single process, coarse lock.

    The parsed file is held in memory. Nothing outside this process writes it,
    so the only invalidation needed is our own, and a single generation reads it
    several times over.
    """

    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()
        self._cache = None

    def _read(self):
        if self._cache is None:
            try:
                with open(self.path, encoding="utf-8") as f:
                    self._cache = json.load(f)
            except (OSError, json.JSONDecodeError):
                self._cache = {}
        return self._cache

    def _write(self, data):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, self.path)
        self._cache = data

    def get_item(self, pk, sk):
        with self._lock:
            row = self._read().get(pk + "|" + sk)
            # Copied because rows are now shared with the cache, and a caller
            # that edited one in place would be editing the store.
            return dict(row) if row is not None else None

    def put_item(self, pk, sk, data):
        with self._lock:
            db = self._read()
            db[pk + "|" + sk] = {**data, "pk": pk, "sk": sk}
            self._write(db)

    def query(self, pk, limit=50, reverse=True, prefix=""):
        with self._lock:
            db = self._read()
            head = pk + "|" + prefix
            rows = [dict(v) for k, v in db.items() if k.startswith(head)]
        rows.sort(key=lambda r: r.get("sk", ""), reverse=reverse)
        return rows[:limit]

    def delete_item(self, pk, sk):
        """Returns False when the item was already gone, i.e. we lost the race."""
        with self._lock:
            db = self._read()
            if db.pop(pk + "|" + sk, None) is None:
                return False
            self._write(db)
            return True

    def add_hit(self, pk, sk, expires):
        with self._lock:
            db = self._read()
            key = pk + "|" + sk
            row = db.get(key) or {"pk": pk, "sk": sk, "n": 0}
            row["n"] += 1
            row["expires"] = expires
            db[key] = row
            # Drop expired windows so the dev file doesn't grow forever.
            now = time.time()
            for k in [k for k, r in db.items() if k.startswith("RATE|") and r.get("expires", now) < now]:
                del db[k]
            self._write(db)
            return row["n"]

    def add_counter(self, pk, sk, field, delta):
        with self._lock:
            db = self._read()
            key = pk + "|" + sk
            row = db.get(key) or {"pk": pk, "sk": sk}
            row[field] = row.get(field, 0) + delta
            db[key] = row
            self._write(db)
            return row[field]


class DynamoStore:
    def __init__(self, table_name, region):
        import boto3

        self.ddb = boto3.resource("dynamodb", region_name=region)
        self.table = self.ddb.Table(table_name)
        self.table_name = table_name

    def ensure_table(self):
        """Create the table on first run. 5/5 provisioned sits inside the
        perpetual DynamoDB free tier of 25 RCU / 25 WCU."""
        import botocore.exceptions

        try:
            self.table.load()
            return
        except botocore.exceptions.ClientError as e:
            if e.response["Error"]["Code"] != "ResourceNotFoundException":
                raise
        logger.info("creating DynamoDB table %s", self.table_name)
        self.ddb.create_table(
            TableName=self.table_name,
            KeySchema=[
                {"AttributeName": "pk", "KeyType": "HASH"},
                {"AttributeName": "sk", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "pk", "AttributeType": "S"},
                {"AttributeName": "sk", "AttributeType": "S"},
            ],
            ProvisionedThroughput={"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
        )
        self.table.wait_until_exists()
        try:
            self.ddb.meta.client.update_time_to_live(
                TableName=self.table_name,
                TimeToLiveSpecification={"Enabled": True, "AttributeName": "expires"},
            )
        except Exception as e:  # TTL is a nicety, not a requirement
            logger.warning("could not enable TTL: %s", e)

    def get_item(self, pk, sk):
        r = self.table.get_item(Key={"pk": pk, "sk": sk})
        return _decode(r.get("Item"))

    def put_item(self, pk, sk, data):
        self.table.put_item(Item=_encode({**data, "pk": pk, "sk": sk}))

    def query(self, pk, limit=50, reverse=True, prefix=""):
        from boto3.dynamodb.conditions import Key

        cond = Key("pk").eq(pk)
        if prefix:
            cond = cond & Key("sk").begins_with(prefix)
        r = self.table.query(
            KeyConditionExpression=cond, ScanIndexForward=not reverse, Limit=limit
        )
        return _decode(r.get("Items", []))

    def delete_item(self, pk, sk):
        import botocore.exceptions

        try:
            self.table.delete_item(
                Key={"pk": pk, "sk": sk},
                ConditionExpression="attribute_exists(pk)",
            )
            return True
        except botocore.exceptions.ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            raise

    def add_hit(self, pk, sk, expires):
        r = self.table.update_item(
            Key={"pk": pk, "sk": sk},
            UpdateExpression="ADD #n :one SET #e = :exp",
            ExpressionAttributeNames={"#n": "n", "#e": "expires"},
            ExpressionAttributeValues={":one": 1, ":exp": expires},
            ReturnValues="UPDATED_NEW",
        )
        return int(r["Attributes"]["n"])

    def add_counter(self, pk, sk, field, delta):
        r = self.table.update_item(
            Key={"pk": pk, "sk": sk},
            UpdateExpression="ADD #f :d",
            ExpressionAttributeNames={"#f": field},
            ExpressionAttributeValues={":d": _encode(delta)},
            ReturnValues="UPDATED_NEW",
        )
        return _decode(r["Attributes"])[field]


_store = None
_backend_name = "unset"


def get_store():
    global _store, _backend_name
    if _store is not None:
        return _store
    try:
        s = DynamoStore(config.TABLE_NAME, config.AWS_REGION)
        s.ensure_table()
        _store, _backend_name = s, "dynamodb"
        logger.info("store: DynamoDB table %s", config.TABLE_NAME)
    except Exception as e:
        # On Lambda the local file would be read-only and per-container, so the
        # budget ledger and rate limits would silently read zero. Refuse instead;
        # callers treat a store error as "no".
        if os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
            logger.error("DynamoDB unavailable on Lambda (%s); refusing to fall back", e)
            raise
        logger.warning("DynamoDB unavailable (%s); using local file store", e)
        _store, _backend_name = LocalStore(config.LOCAL_STATE_PATH), "local"
    return _store


def backend_name():
    get_store()
    return _backend_name


# -- Presence ---------------------------------------------------------------

def touch_presence():
    get_store().put_item("STATE", "PRESENCE", {"at": int(time.time())})


def someone_is_watching():
    item = get_store().get_item("STATE", "PRESENCE") or {}
    return (time.time() - item.get("at", 0)) < config.PRESENCE_TIMEOUT_SECONDS


# -- Dials ------------------------------------------------------------------

def state_snapshot():
    """Every STATE item in one query, keyed by sort key.

    Dials, mood and preoccupations share a partition key, so fetching all three
    together costs what fetching one of them used to. Composing a prompt needed
    each of them separately before this, which was three round trips to say
    nothing had changed."""
    return {r.get("sk"): r for r in get_store().query("STATE", limit=10)}


def dials_from(snap):
    """Dials out of an already-fetched snapshot."""
    item = snap.get("DIALS") or {}
    return config.sanitize_dials(item.get("values")), item.get("changed_at", 0)


def get_dials():
    return dials_from(state_snapshot())


def save_dials(values):
    clean = config.sanitize_dials(values)
    get_store().put_item(
        "STATE", "DIALS", {"values": clean, "changed_at": int(time.time())}
    )
    return clean


# -- Budget ledger ----------------------------------------------------------
# Spend is tracked in micro-dollars so the counter stays integral and the
# DynamoDB ADD stays atomic across concurrent requests.

_budget_cache = {"month": None, "item": {}, "read_at": 0.0, "deltas": {}}
_budget_lock = threading.Lock()


def _month_key():
    return time.strftime("%Y-%m", time.gmtime())


def _budget_snapshot(max_age=15.0):
    """Cached ledger read merged with spend this process already knows about,
    so the figure never under-reports between refreshes."""
    month = _month_key()
    with _budget_lock:
        stale = (
            _budget_cache["month"] != month
            or (time.time() - _budget_cache["read_at"]) > max_age
        )
    if stale:
        item = get_store().get_item("BUDGET", month) or {}
        with _budget_lock:
            _budget_cache.update(
                month=month, item=item, read_at=time.time(), deltas={}
            )
    with _budget_lock:
        merged = dict(_budget_cache["item"])
        for field, delta in _budget_cache["deltas"].items():
            merged[field] = int(merged.get(field, 0)) + delta
        return merged


def budget_spent_micros():
    return int(_budget_snapshot().get("micros", 0))


def budget_lane_micros(lane):
    return int(_budget_snapshot().get("lane_" + lane, 0))


def record_spend(lane, micros):
    micros = int(micros)
    month = _month_key()
    with _budget_lock:
        if _budget_cache["month"] == month:
            d = _budget_cache["deltas"]
            d["micros"] = d.get("micros", 0) + micros
            d["lane_" + lane] = d.get("lane_" + lane, 0) + micros
    try:
        get_store().add_counter("BUDGET", month, "micros", micros)
        get_store().add_counter("BUDGET", month, "lane_" + lane, micros)
    except Exception as e:
        logger.error("budget write failed: %s", e)


def budget_report():
    item = _budget_snapshot()
    total = config.MONTHLY_BUDGET_USD
    spent = int(item.get("micros", 0)) / 1_000_000
    return {
        "month": _month_key(),
        "budgetUsd": round(total, 2),
        "spentUsd": round(spent, 4),
        "remainingUsd": round(max(0.0, total - spent), 4),
        "fractionUsed": round(min(1.0, spent / total) if total else 1.0, 4),
        "lanes": {
            k[5:]: round(int(v) / 1_000_000, 4)
            for k, v in item.items()
            if isinstance(k, str) and k.startswith("lane_")
        },
    }


# -- Rate limiting ------------------------------------------------------------

def hit(bucket, window_s):
    """Count one request against `bucket` in the current fixed window and
    return the new total. Rows carry `expires`, so DynamoDB TTL sweeps them."""
    now = int(time.time())
    start = now - now % window_s
    return get_store().add_hit("RATE", f"{bucket}#{window_s}#{start}", start + window_s * 2)

