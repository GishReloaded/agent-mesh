#!/usr/bin/env bash
# Deploy AgentMesh to AWS. See deploy/aws/README.md.
#
#   ./deploy/aws/deploy.sh
#   SSH_CIDR=203.0.113.4/32 KEY_NAME=mykey ./deploy/aws/deploy.sh
#   DESTROY=1 ./deploy/aws/deploy.sh
set -euo pipefail

STACK_NAME="${STACK_NAME:-agentmesh}"
REGION="${REGION:-$(aws configure get region)}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.small}"
KEY_NAME="${KEY_NAME:-}"
SSH_CIDR="${SSH_CIDR:-}"
ALLOW_REGISTRATION="${ALLOW_REGISTRATION:-true}"
DESTROY="${DESTROY:-}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"

step() { printf '\n== %s\n' "$1"; }
note() { printf '   %s\n' "$1"; }

step 'Checking AWS access'
identity=$(aws sts get-caller-identity --output json)
account=$(printf '%s' "$identity" | grep -o '"Account": *"[0-9]*"' | grep -o '[0-9]\{6,\}')
[ -n "$REGION" ] || { echo 'No region configured. Set REGION or run: aws configure' >&2; exit 1; }
note "account $account in $REGION"

if printf '%s' "$identity" | grep -q ':root"'; then
  note 'WARNING: these are root account credentials. They cannot be scoped and'
  note 'give full control of the account. Create an IAM user for deployments'
  note 'and delete the root access keys.'
fi

if [ -n "$DESTROY" ]; then
  step "Deleting stack $STACK_NAME"
  aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION"
  aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$REGION"
  note 'stack deleted. The S3 bucket and its archive are left in place.'
  exit 0
fi

step 'Packaging source'
cd "$repo_root"
if [ -n "$(git status --porcelain)" ]; then
  note 'note: uncommitted changes are NOT included - the archive is built from HEAD'
fi
archive="$(mktemp -d)/agentmesh-src.tar.gz"
git archive --format=tar.gz -o "$archive" HEAD
note "$archive (from $(git rev-parse --short HEAD))"

bucket="agentmesh-deploy-${account}-${REGION}"
step "Uploading to s3://$bucket"
if ! aws s3api head-bucket --bucket "$bucket" --region "$REGION" >/dev/null 2>&1; then
  note 'creating bucket'
  if [ "$REGION" = 'us-east-1' ]; then
    aws s3api create-bucket --bucket "$bucket" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$bucket" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  aws s3api put-public-access-block --bucket "$bucket" \
    --public-access-block-configuration 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true' >/dev/null
  aws s3api put-bucket-encryption --bucket "$bucket" \
    --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' >/dev/null
fi
aws s3 cp "$archive" "s3://$bucket/agentmesh-src.tar.gz" --region "$REGION" >/dev/null
note 'uploaded'

step 'Resolving Amazon Linux 2023 AMI'
case "$INSTANCE_TYPE" in
  t4g.*) arch='arm64' ;;
  *) arch='x86_64' ;;
esac
ami_id=$(aws ec2 describe-images --region "$REGION" --owners amazon \
  --filters "Name=name,Values=al2023-ami-2023*-$arch" 'Name=state,Values=available' \
  --query 'reverse(sort_by(Images,&CreationDate))[:1].ImageId' --output text)
[ -n "$ami_id" ] && [ "$ami_id" != 'None' ] || { echo "No AL2023 $arch AMI found in $REGION." >&2; exit 1; }
note "$ami_id"

step 'Deploying CloudFormation stack'
note 'first run takes 10-20 minutes: CloudFront provisioning and the initial build'
params=(
  "SourceBucket=$bucket"
  'SourceKey=agentmesh-src.tar.gz'
  "AmiId=$ami_id"
  "InstanceType=$INSTANCE_TYPE"
  "AllowRegistration=$ALLOW_REGISTRATION"
)
[ -n "$KEY_NAME" ] && params+=("KeyName=$KEY_NAME")
[ -n "$SSH_CIDR" ] && params+=("SshCidr=$SSH_CIDR")

aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --template-file "$here/cloudformation.yml" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides "${params[@]}" \
  --tags project=agentmesh

step 'Done'
aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table

url=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='Url'].OutputValue" --output text)
echo
echo "The instance still has to build the project on first boot."
echo "Poll until it answers ok:  curl $url/api/v1/healthz"
echo
echo "Then open $url and create your account."
