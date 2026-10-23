# Removes the native messaging host registration and the generated manifest.
# The project binaries and engine_options.txt are not touched. ASCII-only on purpose.
$ErrorActionPreference = "Stop"
$HostName = "chess_hint_bridge"
$key = "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"
if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force }

$manifestPath = Join-Path $PSScriptRoot "$HostName.json"
if (Test-Path -LiteralPath $manifestPath) {
  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.path) {
      $enginePathFile = Join-Path (Split-Path -Parent $manifest.path) "engine_path.txt"
      if (Test-Path -LiteralPath $enginePathFile) { Remove-Item -LiteralPath $enginePathFile -Force }
    }
  } catch {
    Write-Warning "Could not read manifest before removing it: $_"
  }
  Remove-Item -LiteralPath $manifestPath -Force
  Write-Host "Removed manifest: $manifestPath"
}

# Cleanup for installations made by older versions that copied binaries to AppData.
$legacyDir = Join-Path $env:LOCALAPPDATA "ChessHintBridge"
if (Test-Path -LiteralPath $legacyDir) {
  try {
    Remove-Item -LiteralPath $legacyDir -Recurse -Force -ErrorAction Stop
    Write-Host "Removed legacy copy: $legacyDir"
  } catch {
    Write-Warning "Could not remove legacy copy at $legacyDir (close Firefox/Zen and delete it manually): $_"
  }
}

Write-Host "Removed. The bridge, Stockfish and engine_options.txt in the project were not deleted."
