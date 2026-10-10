param(
  [string]$DenoExe,
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Port,
  [Parameter(Mandatory = $true)][string]$Entrypoint,
  [Parameter(Mandatory = $true)][string]$OutLog,
  [Parameter(Mandatory = $true)][string]$ErrLog,
  [Parameter(Mandatory = $true)][string]$PidFile
)

$ErrorActionPreference = 'Stop'

if (-not $DenoExe) {
  $DenoExe = (Get-Command deno -ErrorAction Stop).Source
}

$argumentList = @(
  'run',
  '--unstable-kv',
  '--allow-net',
  '--allow-env',
  '--allow-read',
  '--allow-write=.runtime',
  $Entrypoint
)

$env:PORT = $Port
New-Item -ItemType Directory -Path (Join-Path $Root '.runtime') -Force | Out-Null

$process = Start-Process `
  -FilePath $DenoExe `
  -ArgumentList $argumentList `
  -WorkingDirectory $Root `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog `
  -WindowStyle Hidden `
  -PassThru

Set-Content -LiteralPath $PidFile -Value $process.Id -Encoding ASCII
Write-Output "PID: $($process.Id)"
