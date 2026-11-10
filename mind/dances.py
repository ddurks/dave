"""Dances Dave learns from visitors' videos.

A visitor puts a video of someone dancing on his TV; analyze_media decides it
is a dance and reserves a job here. The page uploads the video straight to S3
(a presigned POST), `start` launches a GPU box from the dave-dance launch
template (dance_box.sh), and about fifteen minutes later the box leaves
dances/<job>.glb on the site bucket. From then on it is one of his dances for
everyone: `catalog` lists them and the page picks one when he's asked to dance.

Guards, cheapest first. Each box costs about $0.25:
  - a daily cap on all dances (the real cost ceiling) and one per visitor IP;
  - the upload is capped in size by the presigned POST, and the box only
    learns the first 20 seconds;
  - the box shuts itself down after 40 minutes whatever happens, and `sweep`
    (every 10 minutes) terminates any that outlive 45;
  - this Lambda may only launch g5.xlarge from that one template (serverless.yml).
To retire a dance, delete its .glb from the site bucket.
"""

import logging
import os
import re
import time
import uuid

import boto3
from botocore.exceptions import ClientError

import state

logger = logging.getLogger(__name__)

REGION = os.environ.get("AWS_REGION", "us-east-1")
DANCE_BUCKET = os.environ.get("DAVE_DANCE_BUCKET", "dave-dance-593615615124")
SITE_BUCKET = os.environ.get("DAVE_SITE_BUCKET", "dave-drawvid-frontend")
TD_BUCKET = os.environ.get("DAVE_TD_BUCKET", "tinydancer-593615615124")
SITE_URL = os.environ.get("DAVE_SITE_URL", "https://dave.drawvid.com")
LAUNCH_TEMPLATE = "dave-dance"

PER_DAY = int(os.environ.get("DAVE_DANCES_PER_DAY", "5"))
PER_IP_PER_DAY = int(os.environ.get("DAVE_DANCES_PER_IP_PER_DAY", "1"))
MAX_UPLOAD_BYTES = 60 * 1024 * 1024
DAY = 86400
GIVE_UP_S = 45 * 60  # a job this old without a clip has failed

BOX_SCRIPT = os.path.join(os.path.dirname(__file__), "dance_box.sh")

_s3 = None
_ec2 = None


def s3():
    global _s3
    _s3 = _s3 or boto3.client("s3", region_name=REGION)
    return _s3


def ec2():
    global _ec2
    _ec2 = _ec2 or boto3.client("ec2", region_name=REGION)
    return _ec2


# ── Caps ─────────────────────────────────────────────────────────────────────

def _day_count(bucket):
    """Today's count in a `state.hit` day window, without adding to it."""
    now = int(time.time())
    row = state.get_store().get_item("RATE", f"{bucket}#{DAY}#{now - now % DAY}")
    return int((row or {}).get("n", 0))


def why_not(ip):
    """None if a dance could be learned for this visitor now, else the reason:
    "visitor" (they've had today's) or "today" (he's learned enough today)."""
    try:
        if _day_count(f"dance#{ip}") >= PER_IP_PER_DAY:
            return "visitor"
        if _day_count("dance#all") >= PER_DAY:
            return "today"
    except Exception as e:
        logger.error("dance caps unreadable: %s", e)
        return "today"
    return None


def reserve(ip):
    """Count a dance against both caps and open a job for its upload.
    Returns {"jobId", "upload": {"url", "fields"}}, or None if over a cap."""
    if not ip:
        return None
    try:
        # The visitor's own allowance first, so their retries only ever burn
        # their own count and never the day's for everyone else.
        if state.hit(f"dance#{ip}", DAY) > PER_IP_PER_DAY:
            return None
        everyone = state.hit("dance#all", DAY)
    except Exception as e:
        logger.error("dance caps unavailable: %s", e)
        return None
    if everyone > PER_DAY:
        return None
    job = uuid.uuid4().hex[:12]
    upload = s3().generate_presigned_post(
        DANCE_BUCKET, f"in/{job}",
        Conditions=[["content-length-range", 1, MAX_UPLOAD_BYTES],
                    ["starts-with", "$Content-Type", "video/"]],
        ExpiresIn=600,
    )
    state.get_store().put_item("DANCE", job, {"status": "upload", "createdAt": int(time.time())})
    logger.info("dance %s reserved (%d today)", job, everyone)
    return {"jobId": job, "upload": upload}


# ── Jobs ─────────────────────────────────────────────────────────────────────

def _box_script(job):
    with open(BOX_SCRIPT) as f:
        script = f.read()
    for key, value in {"__JOB__": job, "__DANCE_BUCKET__": DANCE_BUCKET,
                       "__SITE_BUCKET__": SITE_BUCKET, "__TD_BUCKET__": TD_BUCKET,
                       "__REGION__": REGION}.items():
        script = script.replace(key, value)
    return script


def _job_row(job):
    if not isinstance(job, str) or not re.fullmatch(r"[0-9a-f]{12}", job):
        return None
    return state.get_store().get_item("DANCE", job)


def start(job):
    """Launch the box for a job whose video has been uploaded."""
    store = state.get_store()
    row = _job_row(job)
    if not row:
        return {"error": "no such dance"}, 404
    if row.get("status") != "upload":
        return {"status": row.get("status")}, 200
    try:
        s3().head_object(Bucket=DANCE_BUCKET, Key=f"in/{job}")
    except ClientError:
        return {"error": "video not uploaded"}, 400
    try:
        r = ec2().run_instances(
            LaunchTemplate={"LaunchTemplateName": LAUNCH_TEMPLATE},
            MinCount=1, MaxCount=1,
            UserData=_box_script(job),
            TagSpecifications=[{"ResourceType": "instance", "Tags": [
                {"Key": "Name", "Value": "dave-dance"},
                {"Key": "App", "Value": "dave-dance"},
                {"Key": "DanceJob", "Value": job}]}],
        )
    except ClientError as e:
        logger.error("dance %s launch failed: %s", job, e)
        store.put_item("DANCE", job, {**row, "status": "failed"})
        return {"status": "failed"}, 200
    instance = r["Instances"][0]["InstanceId"]
    store.put_item("DANCE", job, {**row, "status": "learning", "instance": instance,
                                  "startedAt": int(time.time())})
    logger.info("dance %s learning on %s", job, instance)
    return {"status": "learning"}, 200


def _clip_url(job):
    return f"{SITE_URL}/dances/{job}.glb"


def _has_clip(job):
    try:
        s3().head_object(Bucket=SITE_BUCKET, Key=f"dances/{job}.glb")
        return True
    except ClientError:
        return False


def status(job):
    """"learning", "done" (with the clip's url) or "failed"."""
    store = state.get_store()
    row = _job_row(job)
    if not row:
        return {"error": "no such dance"}, 404
    st = row.get("status")
    if st == "learning":
        if _has_clip(job):
            st = "done"
        elif time.time() - row.get("startedAt", 0) > GIVE_UP_S or not _box_alive(row.get("instance")):
            # The clip may have landed just as the box went.
            st = "done" if _has_clip(job) else "failed"
        if st != "learning":
            store.put_item("DANCE", job, {**row, "status": st})
    out = {"status": st}
    if st == "done":
        out["url"] = _clip_url(job)
    return out, 200


def _box_alive(instance):
    if not instance:
        return False
    try:
        r = ec2().describe_instances(InstanceIds=[instance])
        state_name = r["Reservations"][0]["Instances"][0]["State"]["Name"]
    except (ClientError, IndexError, KeyError):
        return False
    return state_name in ("pending", "running")


_catalog = {"at": 0.0, "dances": []}


def catalog():
    """Every learned dance as {"id", "url"}, oldest first. Cached a minute."""
    if time.time() - _catalog["at"] > 60:
        found = []
        try:
            pages = s3().get_paginator("list_objects_v2").paginate(Bucket=SITE_BUCKET, Prefix="dances/")
            for page in pages:
                for obj in page.get("Contents", []):
                    key = obj["Key"]
                    if key.endswith(".glb"):
                        found.append((obj["LastModified"], key[len("dances/"):-len(".glb")]))
        except Exception as e:
            # He still has his own dance; keep whatever list we had.
            logger.warning("dance catalog unavailable: %s", e)
            return {"dances": _catalog["dances"]}, 200
        _catalog.update(at=time.time(), dances=[{"id": j, "url": _clip_url(j)} for _, j in sorted(found)])
    return {"dances": _catalog["dances"]}, 200


# ── Sweeper ──────────────────────────────────────────────────────────────────

def sweep(event=None, context=None):
    """Scheduled: terminate any dance box past GIVE_UP_S. The box's own timer
    should already have done it; this catches one that hung before setting it."""
    r = ec2().describe_instances(Filters=[
        {"Name": "tag:App", "Values": ["dave-dance"]},
        {"Name": "instance-state-name", "Values": ["pending", "running"]}])
    now = time.time()
    stale = [i["InstanceId"] for res in r["Reservations"] for i in res["Instances"]
             if now - i["LaunchTime"].timestamp() > GIVE_UP_S]
    if stale:
        logger.warning("terminating stale dance boxes: %s", stale)
        ec2().terminate_instances(InstanceIds=stale)
    return {"terminated": stale}
