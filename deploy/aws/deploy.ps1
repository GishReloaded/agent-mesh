<#
.SYNOPSIS
  Deploy AgentMesh to AWS: source archive to S3, then a CloudFormation stack
  with one EC2 origin behind CloudFront.

.DESCRIPTION
  Idempotent. Run it again to ship a new version - it re-uploads the archive
  and updates the stack. Creates billable resources; see deploy/aws/README.md
  for what they cost.

.EXAMPLE
  ./deploy/aws/deploy.ps1
  ./deploy/aws/deploy.ps1 -SshCidr "203.0.113.4/32" -KeyName mykey
  ./deploy/aws/deploy.ps1 -Destroy
#>
param(
  [string]$StackName = 'agentmesh',
  [string]$Region = '',
  [ValidateSet('t4g.small', 't4g.medium', 't3.small', 't3.medium')]
  [string]$InstanceType = 't4g.small',
  [string]$KeyName = '',
  [string]$SshCidr = '',
  [ValidateSet('true', 'false')]
  [string]$AllowRegistration = 'true',
  [switch]$Destroy
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')

function Step($message) { Write-Host "`n== $message" -ForegroundColor Cyan }
function Note($message) { Write-Host "   $message" }

# --- preconditions ----------------------------------------------------------

Step 'Checking AWS access'
$identity = aws sts get-caller-identity --output json | ConvertFrom-Json
$account = $identity.Account
if (-not $Region) {
  $Region = (aws configure get region)
  if (-not $Region) { throw 'No region configured. Pass -Region or run: aws configure' }
}
Note "account $account in $Region"

if ($identity.Arn -like '*:root') {
  Write-Host '   WARNING: these are root account credentials.' -ForegroundColor Yellow
  Write-Host '   Root keys cannot be scoped and give full control of the account, including billing.' -ForegroundColor Yellow
  Write-Host '   Create an IAM user with AdministratorAccess for deployments and delete the root keys.' -ForegroundColor Yellow
}

if ($Destroy) {
  Step "Deleting stack $StackName"
  aws cloudformation delete-stack --stack-name $StackName --region $Region
  Note 'waiting for deletion...'
  aws cloudformation wait stack-delete-complete --stack-name $StackName --region $Region
  Note 'stack deleted. The S3 bucket and its archive are left in place.'
  exit 0
}

# --- source archive ---------------------------------------------------------

Step 'Packaging source'
Push-Location $repoRoot
try {
  $dirty = git status --porcelain
  if ($dirty) { Note 'note: uncommitted changes are NOT included - the archive is built from HEAD' }
  $archive = Join-Path $env:TEMP 'agentmesh-src.tar.gz'
  # git archive gives exactly the committed tree: no node_modules, no .env.
  git archive --format=tar.gz -o $archive HEAD
  $sizeMb = [Math]::Round((Get-Item $archive).Length / 1MB, 2)
  Note "$archive ($sizeMb MB, from $(git rev-parse --short HEAD))"
} finally {
  Pop-Location
}

$bucket = "agentmesh-deploy-$account-$Region"
Step "Uploading to s3://$bucket"
$exists = aws s3api head-bucket --bucket $bucket --region $Region 2>&1
if ($LASTEXITCODE -ne 0) {
  Note 'creating bucket'
  if ($Region -eq 'us-east-1') {
    aws s3api create-bucket --bucket $bucket --region $Region | Out-Null
  } else {
    aws s3api create-bucket --bucket $bucket --region $Region `
      --create-bucket-configuration "LocationConstraint=$Region" | Out-Null
  }
  aws s3api put-public-access-block --bucket $bucket `
    --public-access-block-configuration 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true' | Out-Null
  aws s3api put-bucket-encryption --bucket $bucket `
    --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' | Out-Null
}
aws s3 cp $archive "s3://$bucket/agentmesh-src.tar.gz" --region $Region | Out-Null
Note 'uploaded'

# --- AMI --------------------------------------------------------------------

Step 'Resolving Amazon Linux 2023 AMI'
$arch = if ($InstanceType -like 't4g.*') { 'arm64' } else { 'x86_64' }
$amiJson = aws ec2 describe-images --region $Region --owners amazon `
  --filters "Name=name,Values=al2023-ami-2023*-$arch" 'Name=state,Values=available' `
  --query 'reverse(sort_by(Images,&CreationDate))[:1].[ImageId,Name]' --output json | ConvertFrom-Json
$amiId = $amiJson[0][0]
if (-not $amiId) { throw "Could not find an Amazon Linux 2023 $arch AMI in $Region." }
Note "$amiId ($($amiJson[0][1]))"

# --- stack ------------------------------------------------------------------

Step 'Deploying CloudFormation stack'
Note 'first run takes 10-20 minutes: CloudFront provisioning and the initial build'

$parameters = @(
  "SourceBucket=$bucket",
  'SourceKey=agentmesh-src.tar.gz',
  "AmiId=$amiId",
  "InstanceType=$InstanceType",
  "AllowRegistration=$AllowRegistration"
)
if ($KeyName) { $parameters += "KeyName=$KeyName" }
if ($SshCidr) { $parameters += "SshCidr=$SshCidr" }

aws cloudformation deploy `
  --region $Region `
  --stack-name $StackName `
  --template-file (Join-Path $PSScriptRoot 'cloudformation.yml') `
  --capabilities CAPABILITY_IAM `
  --parameter-overrides $parameters `
  --tags "project=agentmesh"

if ($LASTEXITCODE -ne 0) { throw 'Stack deployment failed. See the CloudFormation events in the console.' }

Step 'Done'
$outputs = aws cloudformation describe-stacks --region $Region --stack-name $StackName `
  --query 'Stacks[0].Outputs' --output json | ConvertFrom-Json
foreach ($output in $outputs) { Note "$($output.OutputKey.PadRight(13)) $($output.OutputValue)" }

$url = ($outputs | Where-Object { $_.OutputKey -eq 'Url' }).OutputValue
Write-Host ''
Write-Host 'The instance still has to build the project on first boot.' -ForegroundColor Yellow
Write-Host "Poll until it answers ok:  curl $url/api/v1/healthz" -ForegroundColor Yellow
Write-Host ''
Write-Host "Then open $url and create your account." -ForegroundColor Green
Write-Host 'Afterwards, close public sign-ups:' -ForegroundColor Green
Write-Host "  ./deploy/aws/deploy.ps1 -AllowRegistration false" -ForegroundColor Green
