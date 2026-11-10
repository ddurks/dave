#!/usr/bin/env bash
# One-off AWS setup for learning dances (dances.py). Safe to re-run: each step
# skips what already exists, except the kit, which is re-uploaded every time.
#
#   bash mind/dance_setup.sh [path/to/tinydancer]    # default ../tinydancer
#
# Creates:
#   - bucket dave-dance-<account>: in/ (visitors' videos, gone after a day),
#     logs/ (box logs, 30 days), kit/ (tinydancer's scripts for the box)
#   - role + instance profile dave-dance-box: the box may read its video, the
#     kit, GVHMR's checkpoints and davebot.glb, and write only its log and
#     dances/*.glb on the site bucket
#   - launch template dave-dance: g5.xlarge on the newest Deep Learning AMI,
#     terminates on shutdown
# Re-run after changing tinydancer's scripts, to refresh the kit. Re-run with
# NEW_AMI=1 to move the template to the newest Deep Learning AMI.
set -euo pipefail

TD="${1:-$(dirname "$0")/../../tinydancer}"
REGION="us-east-1"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="dave-dance-$ACCOUNT"
SITE_BUCKET="dave-drawvid-frontend"
TD_BUCKET="tinydancer-$ACCOUNT"
ROLE="dave-dance-box"
TEMPLATE="dave-dance"

# --- bucket -------------------------------------------------------------------
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "Creating bucket $BUCKET ..."
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi
# The page uploads the video straight here with a presigned POST.
aws s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration '{"CORSRules":[{
  "AllowedOrigins":["https://dave.drawvid.com","http://localhost:8080","http://127.0.0.1:8080"],
  "AllowedMethods":["POST"],"AllowedHeaders":["*"],"MaxAgeSeconds":3600}]}'
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration '{"Rules":[
  {"ID":"videos","Status":"Enabled","Filter":{"Prefix":"in/"},"Expiration":{"Days":1}},
  {"ID":"logs","Status":"Enabled","Filter":{"Prefix":"logs/"},"Expiration":{"Days":30}}]}'

# --- kit: the tinydancer scripts the box runs ----------------------------------
KIT_FILES="motion/run_pipeline.py motion/dance_check.py blender/blender_import.py
           blender/retarget.py blender/dave_dance.py rigs/davebot_map.py"
for f in $KIT_FILES; do [ -f "$TD/$f" ] || { echo "Missing $TD/$f"; exit 1; }; done
# shellcheck disable=SC2086
tar czf - -C "$TD" $KIT_FILES | aws s3 cp - "s3://$BUCKET/kit/tinydancer.tgz"
echo "Uploaded kit from $TD ($(git -C "$TD" rev-parse --short HEAD 2>/dev/null || echo '?'))."

# --- the box's role --------------------------------------------------------------
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  echo "Creating role $ROLE ..."
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam create-instance-profile --instance-profile-name "$ROLE" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
  CREATED_ROLE=1
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name dance-box --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    {\"Effect\": \"Allow\", \"Action\": [\"s3:GetObject\", \"s3:DeleteObject\"],
     \"Resource\": \"arn:aws:s3:::$BUCKET/in/*\"},
    {\"Effect\": \"Allow\", \"Action\": \"s3:GetObject\",
     \"Resource\": [\"arn:aws:s3:::$BUCKET/kit/*\",
                    \"arn:aws:s3:::$TD_BUCKET/checkpoints.tar.gz\",
                    \"arn:aws:s3:::$TD_BUCKET/SMPLX_NEUTRAL.npz\",
                    \"arn:aws:s3:::$SITE_BUCKET/assets/davebot.glb\"]},
    {\"Effect\": \"Allow\", \"Action\": \"s3:PutObject\",
     \"Resource\": [\"arn:aws:s3:::$BUCKET/logs/*\", \"arn:aws:s3:::$SITE_BUCKET/dances/*\"]}
  ]}"
[ "${CREATED_ROLE:-0}" = 1 ] && { echo "Waiting for IAM propagation ..."; sleep 15; }

# --- launch template -----------------------------------------------------------
AMI=$(aws ec2 describe-images --region "$REGION" --owners amazon \
  --filters "Name=name,Values=Deep Learning OSS Nvidia Driver AMI GPU PyTorch*Ubuntu 22.04*" \
            "Name=state,Values=available" \
  --query 'reverse(sort_by(Images,&CreationDate))[0].ImageId' --output text)
DATA="{
  \"ImageId\": \"$AMI\",
  \"InstanceType\": \"g5.xlarge\",
  \"IamInstanceProfile\": {\"Name\": \"$ROLE\"},
  \"InstanceInitiatedShutdownBehavior\": \"terminate\",
  \"BlockDeviceMappings\": [{\"DeviceName\": \"/dev/sda1\",
    \"Ebs\": {\"VolumeSize\": 120, \"VolumeType\": \"gp3\", \"DeleteOnTermination\": true}}],
  \"TagSpecifications\": [{\"ResourceType\": \"volume\", \"Tags\": [{\"Key\": \"App\", \"Value\": \"dave-dance\"}]}]
}"
if ! aws ec2 describe-launch-templates --region "$REGION" --launch-template-names "$TEMPLATE" >/dev/null 2>&1; then
  echo "Creating launch template $TEMPLATE on $AMI ..."
  aws ec2 create-launch-template --region "$REGION" --launch-template-name "$TEMPLATE" \
    --launch-template-data "$DATA" >/dev/null
elif [ "${NEW_AMI:-0}" = 1 ]; then
  echo "Moving launch template $TEMPLATE to $AMI ..."
  V=$(aws ec2 create-launch-template-version --region "$REGION" --launch-template-name "$TEMPLATE" \
    --launch-template-data "$DATA" --query 'LaunchTemplateVersion.VersionNumber' --output text)
  aws ec2 modify-launch-template --region "$REGION" --launch-template-name "$TEMPLATE" --default-version "$V" >/dev/null
fi
LT_ID=$(aws ec2 describe-launch-templates --region "$REGION" --launch-template-names "$TEMPLATE" \
  --query 'LaunchTemplates[0].LaunchTemplateId' --output text)
echo "Launch template $TEMPLATE: $LT_ID (serverless.yml's DANCE_LAUNCH_TEMPLATE_ID must match)."
