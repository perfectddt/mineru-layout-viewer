[CmdletBinding(PositionalBinding = $false)]
param(
  [switch]$NoOpen,
  # Name-only on purpose: a bare positional argument must reach $Paths so that
  # "start-viewer.cmd notes.md +208" works. Positional binding would otherwise
  # hand the file path to this [int] parameter and fail the conversion.
  [Alias('g', 'goto')]
  [int]$Line = 0,
  [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
  [string[]]$Paths
)

$ErrorActionPreference = 'Stop'

function Resolve-ViewerLaunch {
  param(
    [string[]]$Arguments = @(),
    [int]$Line = 0
  )

  if ($Line -lt 0 -or $Line -gt 99999999) {
    throw 'Line number must be a positive integer.'
  }

  $resolvedLine = $Line
  $path = $null
  for ($index = 0; $index -lt $Arguments.Count; $index++) {
    $argument = $Arguments[$index]
    if ($argument -in @('--line', '-line', '-g', '--goto')) {
      $index++
      if ($index -ge $Arguments.Count -or $Arguments[$index] -notmatch '^[1-9]\d{0,7}$') {
        throw 'A positive line number is required after --line.'
      }
      if ($resolvedLine -le 0) { $resolvedLine = [int]$Arguments[$index] }
      continue
    }
    if ($argument -match '^\+([1-9]\d{0,7})$') {
      if ($resolvedLine -le 0) { $resolvedLine = [int]$Matches[1] }
      continue
    }
    if (-not $path) { $path = $argument }
  }

  $candidate = $null
  $suffixLine = 0
  if ($path -match '^(.*):([1-9]\d{0,7}):(\d+)$') {
    $candidate = $Matches[1]
    $suffixLine = [int]$Matches[2]
  } elseif ($path -match '^(.*):([1-9]\d{0,7})$') {
    $candidate = $Matches[1]
    $suffixLine = [int]$Matches[2]
  }
  if ($candidate) {
    $candidateExists = $false
    $originalExists = $false
    try { $candidateExists = Test-Path -LiteralPath ([System.IO.Path]::GetFullPath($candidate)) } catch { }
    try { $originalExists = Test-Path -LiteralPath ([System.IO.Path]::GetFullPath($path)) } catch { }
    if ($candidateExists -and -not $originalExists) {
      $path = $candidate
      if ($resolvedLine -le 0) { $resolvedLine = $suffixLine }
    }
  }

  [pscustomobject]@{
    Path = $path
    Line = $(if ($resolvedLine -gt 0) { $resolvedLine } else { $null })
  }
}

function Resolve-ExistingPath {
  # Turn whatever the user typed into an existing absolute path, or fail with a
  # message that names the path. The backend can only answer "path-not-found",
  # and Windows PowerShell refuses to normalize a path that still carries a
  # ":line" suffix, so both cases are handled here.
  param([string]$Path)

  if (Test-Path -LiteralPath $Path) {
    try { return [System.IO.Path]::GetFullPath($Path) } catch { return $Path }
  }

  if ($Path -match '^(.+):([1-9]\d{0,7})$') {
    # Resolve-ViewerLaunch leaves the suffix on only when the file without it is
    # missing, so that missing file is the part worth reporting.
    throw "找不到文件：`n$($Matches[1])`n`n末尾的 :$($Matches[2]) 只有在去掉后文件真实存在时才会被当作行号。"
  }

  throw "找不到文件或文件夹：`n$Path"
}

function ConvertTo-DecodedPath {
  # 浏览器（以及 Anki 这类内嵌 webview）在把自定义协议链接交给系统之前，会把
  # href 里的非 ASCII 字符按 UTF-8 百分号编码：空格变 %20、中文变 %E8%BD%AF…。
  # Quicker / Win+R 只是原样转发字符串，不会还原，于是路径必然找不到。
  # 这里在「原样路径不存在、解码后存在」时才采用解码结果，避免误伤名字里
  # 真的带 %XX 的文件。
  param([string]$Path)

  if ([string]::IsNullOrEmpty($Path)) { return $Path }
  if ($Path -notmatch '%[0-9A-Fa-f]{2}') { return $Path }

  $decoded = $null
  try { $decoded = [System.Uri]::UnescapeDataString($Path) } catch { return $Path }
  if ([string]::IsNullOrEmpty($decoded) -or $decoded -eq $Path) { return $Path }

  # 形如 “...三色笔记-第1章 绪论.md:208” 时，探测存在性要先摘掉行号后缀
  $rawProbe = $Path
  $decodedProbe = $decoded
  if ($Path -match '^(.*):([1-9]\d{0,7})$') {
    $rawProbe = $Matches[1]
    $decodedProbe = $decoded -replace ':([1-9]\d{0,7})$', ''
  }

  $rawExists = $false
  $decodedExists = $false
  try { $rawExists = (Test-Path -LiteralPath $rawProbe) -or (Test-Path -LiteralPath $Path) } catch { }
  try { $decodedExists = (Test-Path -LiteralPath $decodedProbe) -or (Test-Path -LiteralPath $decoded) } catch { }

  if ($decodedExists -and -not $rawExists) { return $decoded }
  return $Path
}

if ($MyInvocation.InvocationName -eq '.') { return }

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$preferredPort = 18768
$viewerUrl = $null
$stateFile = Join-Path ([System.IO.Path]::GetTempPath()) 'mineru-layout-viewer-server.json'
$serverState = $null

function Test-ViewerServer {
  try {
    if (-not (Test-Path -LiteralPath $stateFile)) { return $false }
    $script:serverState = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    if (-not $script:serverState.port -or -not $script:serverState.token) { return $false }
    $candidateUrl = "http://127.0.0.1:$($script:serverState.port)/"
    $identityUrl = "$candidateUrl`__viewer/identity?token=$([uri]::EscapeDataString($script:serverState.token))"
    $identity = Invoke-RestMethod -UseBasicParsing -Uri $identityUrl -TimeoutSec 1
    if ($identity.app -ne 'mineru-layout-viewer') { return $false }
    $script:viewerUrl = $candidateUrl
    return $true
  } catch {
    return $false
  }
}

if (-not (Test-ViewerServer)) {
  Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue
  $python = Get-Command py -ErrorAction SilentlyContinue
  $arguments = @(('"{0}"' -f (Join-Path $projectRoot 'viewer-server.py')), '--port', $preferredPort)

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
    'The local server failed to start.',
    'MinerU Layout Viewer'
  ) | Out-Null
  exit 1
}

if (-not $NoOpen) {
  try {
    $arguments = @($Paths | Where-Object { $_ } | ForEach-Object { ConvertTo-DecodedPath -Path $_ })
    $requested = Resolve-ViewerLaunch -Arguments $arguments -Line $Line

    $targetUrl = "$viewerUrl`?token=$([uri]::EscapeDataString($serverState.token))"
    if ($requested.Path) {
      $targetPath = Resolve-ExistingPath -Path $requested.Path
      $openUrl = "$viewerUrl`__viewer/open?token=$([uri]::EscapeDataString($serverState.token))&path=$([uri]::EscapeDataString($targetPath))"
      if ($requested.Line) { $openUrl += "&line=$($requested.Line)" }
      $launch = Invoke-RestMethod -UseBasicParsing -Uri $openUrl -TimeoutSec 10
      $targetUrl = "$($viewerUrl.TrimEnd('/'))$($launch.url)"
    }
  } catch {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($_.Exception.Message, 'MinerU Layout Viewer') | Out-Null
    exit 1
  }

  Start-Process $targetUrl
}
