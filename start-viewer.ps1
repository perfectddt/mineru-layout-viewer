param([switch]$NoOpen)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 18768
$viewerUrl = "http://127.0.0.1:$port/"

function Test-ViewerServer {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $viewerUrl -TimeoutSec 1
    return $response.StatusCode -eq 200 `
      -and $response.Content -match '<mineru-layout-viewer'
  } catch {
    return $false
  }
}

if (-not (Test-ViewerServer)) {
  $python = Get-Command py -ErrorAction SilentlyContinue
  $arguments = @('-m', 'http.server', $port, '--bind', '127.0.0.1', '--directory', $projectRoot)

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
  Start-Process $viewerUrl
}
