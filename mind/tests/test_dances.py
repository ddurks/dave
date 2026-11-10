"""Tests for learning dances from visitors' videos (dances.py), no real AWS."""

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

import app
import dances

FRAME = "data:image/jpeg;base64,AAAA"


def _missing(*_args, **_kwargs):
    raise ClientError({"Error": {"Code": "404"}}, "HeadObject")


@pytest.fixture
def aws(monkeypatch):
    """Fake S3 and EC2 clients. S3 holds `objects` (keys); EC2 launches i-1."""
    s3, ec2 = MagicMock(), MagicMock()
    s3.objects = set()
    s3.generate_presigned_post.return_value = {"url": "https://up", "fields": {"key": "k"}}
    s3.head_object.side_effect = lambda Bucket, Key: (
        {} if (Bucket, Key) in s3.objects else _missing())
    ec2.run_instances.return_value = {"Instances": [{"InstanceId": "i-1"}]}
    ec2.describe_instances.return_value = {
        "Reservations": [{"Instances": [{"State": {"Name": "running"}}]}]}
    monkeypatch.setattr(dances, "_s3", s3)
    monkeypatch.setattr(dances, "_ec2", ec2)
    monkeypatch.setattr(dances, "PER_DAY", 2)
    monkeypatch.setattr(dances, "PER_IP_PER_DAY", 1)
    return s3, ec2


def _video(stub_llm, dancing=True, ip="1.2.3.4", learnable=True):
    stub_llm.set_json({"text": "A man flails.", "emotion": "dry-amusement", "dancing": dancing})
    return app.dispatch({"type": "analyze_media", "imageData": FRAME,
                         "mediaType": "video", "learnable": learnable}, ip)


def test_dance_video_reserves_a_job(stub_llm, aws):
    result, status = _video(stub_llm)
    assert status == 200
    assert result["learn"]["upload"]["url"] == "https://up"
    assert len(result["learn"]["jobId"]) == 12


def test_no_job_when_not_dancing_or_too_big(stub_llm, aws):
    assert "learn" not in _video(stub_llm, dancing=False)[0]
    assert "learn" not in _video(stub_llm, learnable=False)[0]


def test_one_dance_per_visitor_and_a_daily_cap(stub_llm, aws):
    assert "learn" in _video(stub_llm, ip="a")[0]
    assert "learn" not in _video(stub_llm, ip="a")[0]  # visitor's had today's
    assert "learn" in _video(stub_llm, ip="b")[0]
    assert "learn" not in _video(stub_llm, ip="c")[0]  # PER_DAY = 2 reached


def test_he_is_told_when_he_cannot_learn_it(stub_llm, aws):
    _video(stub_llm, ip="a")
    _video(stub_llm, ip="a")
    prompt = stub_llm.calls[-1]["messages"][-1]["content"][0]["text"]
    assert "already learned one from this visitor" in prompt


def test_client_cannot_choose_its_ip(stub_llm, aws):
    _video(stub_llm, ip="a")
    stub_llm.set_json({"text": "x", "emotion": "boredom", "dancing": True})
    result, _ = app.dispatch({"type": "analyze_media", "imageData": FRAME, "mediaType": "video",
                              "learnable": True, "_ip": "spoofed"}, "a")
    assert "learn" not in result


def test_start_needs_the_upload_then_launches(stub_llm, aws):
    s3, ec2 = aws
    job = _video(stub_llm)[0]["learn"]["jobId"]
    assert app.dispatch({"type": "dance_start", "jobId": job})[1] == 400
    s3.objects.add((dances.DANCE_BUCKET, f"in/{job}"))
    assert app.dispatch({"type": "dance_start", "jobId": job})[0] == {"status": "learning"}
    kwargs = ec2.run_instances.call_args.kwargs
    assert kwargs["LaunchTemplate"] == {"LaunchTemplateName": "dave-dance"}
    assert f'JOB="{job}"' in kwargs["UserData"] and '="__' not in kwargs["UserData"]
    # A second start doesn't launch a second box.
    app.dispatch({"type": "dance_start", "jobId": job})
    assert ec2.run_instances.call_count == 1


def test_status_learning_done_failed(stub_llm, aws):
    s3, ec2 = aws
    job = _video(stub_llm)[0]["learn"]["jobId"]
    s3.objects.add((dances.DANCE_BUCKET, f"in/{job}"))
    app.dispatch({"type": "dance_start", "jobId": job})
    assert app.dispatch({"type": "dance_status", "jobId": job})[0] == {"status": "learning"}
    s3.objects.add((dances.SITE_BUCKET, f"dances/{job}.glb"))
    result = app.dispatch({"type": "dance_status", "jobId": job})[0]
    assert result == {"status": "done", "url": f"{dances.SITE_URL}/dances/{job}.glb"}


def test_box_gone_without_a_clip_is_failed(stub_llm, aws):
    s3, ec2 = aws
    job = _video(stub_llm)[0]["learn"]["jobId"]
    s3.objects.add((dances.DANCE_BUCKET, f"in/{job}"))
    app.dispatch({"type": "dance_start", "jobId": job})
    ec2.describe_instances.return_value = {
        "Reservations": [{"Instances": [{"State": {"Name": "terminated"}}]}]}
    assert app.dispatch({"type": "dance_status", "jobId": job})[0] == {"status": "failed"}


def test_unknown_or_malformed_job(aws):
    assert app.dispatch({"type": "dance_status", "jobId": "0123456789ab"})[1] == 404
    assert app.dispatch({"type": "dance_start", "jobId": "../../etc"})[1] == 404


def test_catalog_lists_clips_oldest_first(aws, monkeypatch):
    s3, _ = aws
    monkeypatch.setattr(dances, "_catalog", {"at": 0.0, "dances": []})
    t = datetime(2026, 11, 10, tzinfo=timezone.utc)
    s3.get_paginator.return_value.paginate.return_value = [{"Contents": [
        {"Key": "dances/bbb.glb", "LastModified": t + timedelta(hours=1)},
        {"Key": "dances/aaa.glb", "LastModified": t},
        {"Key": "dances/notes.txt", "LastModified": t},
    ]}]
    result, _ = app.dispatch({"type": "dances"})
    assert [d["id"] for d in result["dances"]] == ["aaa", "bbb"]


def test_sweep_terminates_only_stale_boxes(aws):
    _, ec2 = aws
    now = datetime.now(timezone.utc)
    ec2.describe_instances.return_value = {"Reservations": [{"Instances": [
        {"InstanceId": "i-old", "LaunchTime": now - timedelta(minutes=50)},
        {"InstanceId": "i-new", "LaunchTime": now - timedelta(minutes=10)},
    ]}]}
    assert dances.sweep() == {"terminated": ["i-old"]}
    ec2.terminate_instances.assert_called_once_with(InstanceIds=["i-old"])


def test_video_frames_all_reach_the_model(stub_llm, aws):
    stub_llm.set_json({"text": "x", "emotion": "boredom", "dancing": False})
    app.dispatch({"type": "analyze_media", "mediaType": "video", "frames": [FRAME] * 6})
    content = stub_llm.calls[-1]["messages"][-1]["content"]
    assert sum(1 for c in content if c.get("type") == "image") == 4  # capped at 4


def test_catalog_survives_s3_being_down(aws, monkeypatch):
    s3, _ = aws
    monkeypatch.setattr(dances, "_catalog", {"at": 0.0, "dances": [{"id": "old", "url": "u"}]})
    s3.get_paginator.side_effect = ClientError({"Error": {"Code": "500"}}, "ListObjectsV2")
    assert app.dispatch({"type": "dances"}) == ({"dances": [{"id": "old", "url": "u"}]}, 200)
