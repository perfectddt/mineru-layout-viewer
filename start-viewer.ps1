param(
  [switch]$NoOpen,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Paths
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 18768
$viewerUrl = "http://127.0.0.1:$port/"
$stateFile = Join-Path ([System.IO.Path]::GetTempPath()) 'mineru-layout-viewer-server.json'
$serverState = $null

function Test-ViewerServer {
  try {
    if (-not (Test-Path -LiteralPath $stateFile)) { return $false }
    $script:serverState = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    if ($script:serverState.port -ne $port -or -not $script:serverState.token) { return $false }
    $identityUrl = "$viewerUrl`__viewer/identity?token=$([uri]::EscapeDataString($script:serverState.token))"
    $identity = Invoke-RestMethod -UseBasicParsing -Uri $identityUrl -TimeoutSec 1
    return $identity.app -eq 'mineru-layout-viewer'
  } catch {
    return $false
  }
}

if (-not (Test-ViewerServer)) {
  $python = Get-Command py -ErrorAction SilentlyContinue
  $arguments = @(('"{0}"' -f (Join-Path $projectRoot 'viewer-server.py')))

  if ($python) {
    $arguments = @('-3') + $arguments
  } else {
    $python = Get-Command python -ErrorAction SilentlyContinue
  }

  if (-not $python) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
      'Python was not found. Install Python or run another static server in the project directory.',
      'MinerU Layout Viewer'
    ) | Out-Null
    exit 1
  }

  Start-Process -FilePath $python.Source `
    -ArgumentList $arguments `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden

  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 150
    if (Test-ViewerServer) { break }
  }
}

if (-not (Test-ViewerServer)) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show(
    "The local server failed to start. Check whether port $port is already in use.",
    'MinerU Layout Viewer'
  ) | Out-Null
  exit 1
}

if (-not $NoOpen) {
  $targetUrl = $viewerUrl
  if ($Paths -and $Paths.Count -gt 0) {
    $targetPath = [System.IO.Path]::GetFullPath($Paths[0])
    $openUrl = "$viewerUrl`__viewer/open?token=$([uri]::EscapeDataString($serverState.token))&path=$([uri]::EscapeDataString($targetPath))"
    $launch = Invoke-RestMethod -UseBasicParsing -Uri $openUrl -TimeoutSec 10
    $targetUrl = "http://127.0.0.1:$port$($launch.url)"
  }
  Start-Process $targetUrl
}
