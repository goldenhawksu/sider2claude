param(
  [string]$BunExe,
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Entrypoint,
  [Parameter(Mandatory = $true)][string]$OutLog,
  [Parameter(Mandatory = $true)][string]$ErrLog,
  [Parameter(Mandatory = $true)][string]$PidFile
)

$ErrorActionPreference = 'Stop'

if (-not $BunExe) {
  $BunExe = (Get-Command bun -ErrorAction Stop).Source
}

$process = Start-Process `
  -FilePath $BunExe `
  -ArgumentList @('run', $Entrypoint) `
  -WorkingDirectory $Root `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog `
  -WindowStyle Hidden `
  -PassThru

Set-Content -LiteralPath $PidFile -Value $process.Id -Encoding ASCII
Write-Output "PID: $($process.Id)"
