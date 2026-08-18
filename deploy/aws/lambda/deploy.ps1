<#
.SYNOPSIS
  Deploy AgentMesh to AWS Lambda: build, upload to S3, update the stack,
  apply migrations.

.DESCRIPTION
  The database is not part of the stack - pass its connection string once and
  it is remembered in SSM Parameter Store for later deploys. Nothing here is
  billed while idle.

.EXAMPLE
  ./deploy/aws/lambda/deploy.ps1 -DatabaseUrl "postgres://user:pass@host/db?sslmode=require"
  ./deploy/aws/lambda/deploy.ps1                    # reuses the stored settings
  ./deploy/aws/lambda/deploy.ps1 -AllowRegistration false
  ./deploy/aws/lambda/deploy.ps1 -Destroy
#>
param(
  [string]$StackName = 'agentmesh',
  [string]$Region = '',
  [string]$DatabaseUrl = '',
  [ValidateSet('true', 'false')]
  [string]$AllowRegistration = 'true',
  [switch]$SkipBuild,
  [switch]$SkipMigrations,
  [switch]$Destroy
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')

function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Note($m) { Write-Host "   $m" }

Step 'Checking AWS access'
$identity = aws sts get-caller-identity --output json | ConvertFrom-Json
$account = $identity.Account
if (-not $Region) {
  $Region = (aws configure get region)
  if (-not $Region) { throw 'No region configured. Pass -Region or run: aws configure' }
}
Note "account $account in $Region"
if ($identity.Arn -like '*:root') {
  Write-Host '   WARNING: root credentials. They cannot be scoped; a leak is the whole account.' -ForegroundColor Yellow
  Write-Host '   See deploy/aws/README.md for creating an IAM user instead.' -ForegroundColor Yellow
}

if ($Destroy) {
  Step "Deleting stack $StackName"
  aws cloudformation delete-stack --stack-name $StackName --region $Region
  aws cloudformation wait stack-delete-complete --stack-name $StackName --region $Region
  Note 'stack deleted. Your database, the S3 bucket and the stored secrets are untouched.'
  exit 0
}

# --- settings remembered between deploys ------------------------------------

function Get-Secret($name) {
  $value = aws ssm get-parameter --name $name --with-decryption --region $Region `
    --query 'Parameter.Value' --output text 2>$null
  if ($LASTEXITCODE -eq 0 -and $value -and $value -ne 'None') { return $value }
  return $null
}

function Set-Secret($name, $value, $description) {
  aws ssm put-parameter --name $name --value $value --type SecureString --overwrite `
    --description $description --region $Region | Out-Null
}

Step 'Resolving configuration'
$dbParam = "/agentmesh/$StackName/database-url"
$jwtParam = "/agentmesh/$StackName/jwt-secret"

if (-not $DatabaseUrl) { $DatabaseUrl = Get-Secret $dbParam }
if (-not $DatabaseUrl) {
  throw @'
No database configured. Pass it once and it will be remembered:
  ./deploy/aws/lambda/deploy.ps1 -DatabaseUrl "postgres://user:pass@host:5432/agentmesh?sslmode=require"

Any managed PostgreSQL works. Pick one that tolerates short-lived connections
from Lambda - Neon, Supabase and RDS with a small pool all do.
'@
} else {
  Set-Secret $dbParam $DatabaseUrl 'AgentMesh database connection string'
}
Note ("database: " + ($DatabaseUrl -replace '://([^:]+):[^@]*@', '://$1:****@'))

$jwtSecret = Get-Secret $jwtParam
if (-not $jwtSecret) {
  # Generated once. Regenerating it on every deploy would sign everyone out.
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $jwtSecret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  Set-Secret $jwtParam $jwtSecret 'AgentMesh access token signing key'
  Note 'generated a new JWT secret and stored it in SSM'
} else {
  Note 'reusing the stored JWT secret'
}

# --- build ------------------------------------------------------------------

if (-not $SkipBuild) {
  Step 'Building'
  Push-Location $repoRoot
  try {
    npm run build:libs
    if ($LASTEXITCODE -ne 0) { throw 'library build failed' }
    npm run build -w @agentmesh/web
    if ($LASTEXITCODE -ne 0) { throw 'web build failed' }
    node deploy/aws/lambda/build.mjs
    if ($LASTEXITCODE -ne 0) { throw 'lambda bundle failed' }
  } finally {
    Pop-Location
  }
}

$distDir = Join-Path $repoRoot 'dist-lambda'
if (-not (Test-Path (Join-Path $distDir 'http.mjs'))) { throw "No bundle in $distDir. Run without -SkipBuild." }

Step 'Packaging'
$zipPath = Join-Path $env:TEMP 'agentmesh-lambda.zip'
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $distDir '*') -DestinationPath $zipPath -CompressionLevel Optimal
$sizeMb = [Math]::Round((Get-Item $zipPath).Length / 1MB, 2)
Note "$zipPath ($sizeMb MB)"

$bucket = "agentmesh-deploy-$account-$Region"
$sha = (git -C $repoRoot rev-parse --short HEAD)
$key = "lambda/agentmesh-$sha-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()).zip"

Step "Uploading to s3://$bucket/$key"
aws s3api head-bucket --bucket $bucket --region $Region 2>&1 | Out-Null
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
}
aws s3 cp $zipPath "s3://$bucket/$key" --region $Region | Out-Null
Note 'uploaded'

# --- stack ------------------------------------------------------------------

Step 'Deploying stack'
aws cloudformation deploy `
  --region $Region `
  --stack-name $StackName `
  --template-file (Join-Path $PSScriptRoot 'template.yaml') `
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND `
  --parameter-overrides `
    "CodeBucket=$bucket" `
    "CodeKey=$key" `
    "DatabaseUrl=$DatabaseUrl" `
    "JwtSecret=$jwtSecret" `
    "AllowRegistration=$AllowRegistration" `
  --tags project=agentmesh

if ($LASTEXITCODE -ne 0) { throw 'Stack deployment failed. Check the CloudFormation events in the console.' }

# --- migrations -------------------------------------------------------------

if (-not $SkipMigrations) {
  Step 'Applying migrations'
  Note 'run from here, against the database directly - a migration Lambda would race with itself'
  Push-Location $repoRoot
  try {
    $env:DATABASE_URL = $DatabaseUrl
    npm run db:migrate
    if ($LASTEXITCODE -ne 0) { throw 'migrations failed' }
  } finally {
    Pop-Location
  }
}

Step 'Done'
$outputs = aws cloudformation describe-stacks --region $Region --stack-name $StackName `
  --query 'Stacks[0].Outputs' --output json | ConvertFrom-Json
foreach ($o in $outputs) { Note "$($o.OutputKey.PadRight(12)) $($o.OutputValue)" }

$url = ($outputs | Where-Object { $_.OutputKey -eq 'Url' }).OutputValue
Write-Host ''
Write-Host "Open $url and create your account." -ForegroundColor Green
Write-Host 'Then close public sign-ups:' -ForegroundColor Green
Write-Host "  ./deploy/aws/lambda/deploy.ps1 -AllowRegistration false -SkipBuild" -ForegroundColor Green
