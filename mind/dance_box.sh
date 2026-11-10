#!/bin/bash
# Boot script for a dance-learning box: turn one visitor's video into a clip
# Dave can dance. dances.py fills in the __PLACEHOLDERS__ and launches a GPU
# instance from the dave-dance launch template with this as its user-data.
#
#   video (DANCE_BUCKET/in/JOB) -> first 20 s, 720p -> GVHMR -> BVH -> moving enough?
#     -> Blender retarget onto davebot.glb -> SITE_BUCKET/dances/JOB.glb
#
# The GVHMR half is tinydancer's infra/aws/launch.sh; the scripts it runs come
# from tinydancer as kit/tinydancer.tgz (see dance_setup.sh). The box always
# terminates: on exit, and by a 40-minute shutdown timer set first thing.

# Every traced command carries the time, so stage timings can be read off the log.
export PS4='+ [$(date +%H:%M:%S)] '
set -xeuo pipefail
JOB="__JOB__"
DANCE_BUCKET="__DANCE_BUCKET__"
SITE_BUCKET="__SITE_BUCKET__"
TD_BUCKET="__TD_BUCKET__"
export AWS_DEFAULT_REGION="__REGION__"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
# A copy in the kit (dance_setup.sh): download.blender.org answers 403 to EC2.
BLENDER_TAR="blender-5.1.1-linux-x64.tar.xz"
LOG=/var/log/dance.log
exec > >(tee "$LOG") 2>&1

shutdown -h +40
finish(){
  aws s3 cp "$LOG" "s3://$DANCE_BUCKET/logs/$JOB.log" || true
  # The visitor's video is only needed for this one run.
  aws s3 rm "s3://$DANCE_BUCKET/in/$JOB" || true
  shutdown -h now
}
trap finish EXIT
( while true; do sleep 60; aws s3 cp "$LOG" "s3://$DANCE_BUCKET/logs/$JOB.log" >/dev/null 2>&1 || true; done ) &

# Blender downloads while GVHMR installs.
( aws s3 cp --quiet "s3://$DANCE_BUCKET/kit/$BLENDER_TAR" - | tar xJ -C /opt && mv /opt/blender-* /opt/blender ) &
BLENDER_PID=$!

# This AMI's system Python is 3.10 (matches GVHMR's cp310 wheels); `python` needs
# a symlink. GVHMR imports tkinter; Blender needs the X/GL libs even headless.
ln -sf "$(command -v python3)" /usr/local/bin/python
apt-get update -y -qq || true
apt-get install -y -qq python3-tk ffmpeg libxi6 libxxf86vm1 libxfixes3 libxrender1 \
  libxkbcommon0 libsm6 libgl1
python -m pip install -q --upgrade pip
python -m pip install -q awscli

cd /home/ubuntu
git clone https://github.com/zju3dv/GVHMR.git --recursive
cd GVHMR
python -m pip install torch==2.3.0 torchvision==0.18.0 --index-url https://download.pytorch.org/whl/cu121
# chumpy's setup.py imports pip, which fails under build isolation.
python -m pip install --no-build-isolation chumpy
python -m pip install -r requirements.txt
python -m pip install -e .
python -c "import pytorch3d" 2>/dev/null || \
  FORCE_CUDA=1 python -m pip install "git+https://github.com/facebookresearch/pytorch3d.git@stable"

mkdir -p inputs/checkpoints/body_models/smplx
aws s3 cp "s3://$TD_BUCKET/checkpoints.tar.gz" /tmp/ck.tgz
tar xzf /tmp/ck.tgz -C inputs/checkpoints
aws s3 cp "s3://$TD_BUCKET/SMPLX_NEUTRAL.npz" inputs/checkpoints/body_models/smplx/SMPLX_NEUTRAL.npz

mkdir -p /opt/kit
aws s3 cp "s3://$DANCE_BUCKET/kit/tinydancer.tgz" - | tar xz -C /opt/kit
cp /opt/kit/motion/run_pipeline.py .
aws s3 cp "s3://$SITE_BUCKET/assets/davebot.glb" /opt/davebot.glb

# Phones send HEVC .mov the OpenCV reader may not take, and long or 4K clips
# only cost time: re-encode the first 20 s at no more than 720 lines.
aws s3 cp "s3://$DANCE_BUCKET/in/$JOB" /tmp/upload
ffmpeg -nostdin -y -i /tmp/upload -t 20 -an -vf "scale=-2:'min(720,ih)'" \
  -c:v libx264 -preset veryfast -crf 20 dance.mp4

python run_pipeline.py dance.mp4 --out dance.bvh
# Someone barely moving is not a dance; fail here and nothing is published.
python /opt/kit/motion/dance_check.py dance.bvh

# Blender exits 0 when its script raises unless told otherwise.
wait "$BLENDER_PID"
/opt/blender/blender -b --python-exit-code 1 --python /opt/kit/blender/blender_import.py -- dance.bvh /tmp/dance.blend
/opt/blender/blender -b --python-exit-code 1 --python /opt/kit/blender/dave_dance.py -- \
  /tmp/dance.blend /opt/davebot.glb "/tmp/$JOB.glb"
aws s3 cp "/tmp/$JOB.glb" "s3://$SITE_BUCKET/dances/$JOB.glb" \
  --content-type model/gltf-binary --cache-control "public, max-age=31536000, immutable"
echo "DONE: dances/$JOB.glb"
