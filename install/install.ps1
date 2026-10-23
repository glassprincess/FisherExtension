# Installs the native messaging bridge for Firefox/Zen (current user, no admin rights needed).
# The bridge and engine run in place: nothing is copied to %LOCALAPPDATA%.
# Usage (defaults point to bin\chess_hint_bridge.exe and engine\stockfish.exe):
#   powershell -ExecutionPolicy Bypass -File install\install.ps1
# Or pass explicit files:
#   powershell -ExecutionPolicy Bypass -File install\install.ps1 -BridgeExe <path> -StockfishExe <path>
# NOTE: this file is ASCII-only on purpose (Windows PowerShell 5.1 reads BOM-less files as ANSI).
param(
  [string]$BridgeExe,
  [string]$StockfishExe
)
$ErrorActionPreference = "Stop"
$HostName = "chess_hint_bridge"
$ExtensionId = "chess-hint@local"   # must match browser_specific_settings.gecko.id in manifest.json
$root = Split-Path -Parent $PSScriptRoot

if (-not $BridgeExe) { $BridgeExe = Join-Path $root "bin\chess_hint_bridge.exe" }
if (-not $StockfishExe) { $StockfishExe = Join-Path $root "engine\stockfish.exe" }

foreach ($f in @($BridgeExe, $StockfishExe)) {
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) {
    throw "File not found: $f. Build the bridge with 'cargo build --release' in bridge\ and put stockfish.exe in engine\, or pass -BridgeExe and -StockfishExe."
  }
}
$BridgeExe = (Resolve-Path -LiteralPath $BridgeExe).Path
$StockfishExe = (Resolve-Path -LiteralPath $StockfishExe).Path
$bridgeDir = Split-Path -Parent $BridgeExe
$utf8 = New-Object System.Text.UTF8Encoding($false)

# The bridge reads this file first. Keeping it next to the exe also supports custom paths.
$enginePathFile = Join-Path $bridgeDir "engine_path.txt"
[IO.File]::WriteAllText($enginePathFile, $StockfishExe + "`n", $utf8)

# The host manifest lives in the project and points at the in-place binaries.
$manifest = [ordered]@{
  name = $HostName
  description = "Chess Bot Hint: bridge to stockfish.exe"
  path = $BridgeExe
  type = "stdio"
  allowed_extensions = @($ExtensionId)
}
$manifestPath = Join-Path $PSScriptRoot "$HostName.json"
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), $utf8)

$key = "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $manifestPath

# Older versions copied both binaries to %LOCALAPPDATA%\ChessHintBridge.
# Migrate the optional engine options, then remove the duplicate copy.
$legacyDir = Join-Path $env:LOCALAPPDATA "ChessHintBridge"
if ((Test-Path -LiteralPath $legacyDir) -and ($BridgeExe -like "$legacyDir\*" -or $StockfishExe -like "$legacyDir\*")) {
  Write-Warning "Bridge or engine was passed from the legacy AppData folder; not removing it."
} elseif (Test-Path -LiteralPath $legacyDir) {
  $legacyOptions = Join-Path $legacyDir "engine_options.txt"
  $newOptions = Join-Path $bridgeDir "engine_options.txt"
  if ((Test-Path -LiteralPath $legacyOptions) -and -not (Test-Path -LiteralPath $newOptions)) {
    Copy-Item -LiteralPath $legacyOptions -Destination $newOptions
    Write-Host "Migrated engine_options.txt to: $newOptions"
  }
  try {
    Remove-Item -LiteralPath $legacyDir -Recurse -Force -ErrorAction Stop
    Write-Host "Removed legacy copy: $legacyDir"
  } catch {
    Write-Warning "Could not remove legacy copy at $legacyDir (close Firefox/Zen and delete it manually): $_"
  }
}

Write-Host "Done. Binaries are used in place; nothing was copied to AppData."
Write-Host "Bridge:    $BridgeExe"
Write-Host "Engine:    $StockfishExe"
Write-Host "Manifest:  $manifestPath"
Write-Host "Registry:  $key"
Write-Host "If you move this folder, run install.ps1 again."
Write-Host "SHA256 (save these to detect file tampering later):"
Get-FileHash -Algorithm SHA256 $BridgeExe, $StockfishExe | Format-Table Hash, Path -AutoSize
