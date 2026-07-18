# Installs the llama-server launcher suite + Windows context-menu entries.
# Usage:  powershell -ExecutionPolicy Bypass -File install.ps1 [-Target <dir>]
#   -Target  where the server runs from (default: <repo>\build\bin\Release)
# Registers (HKCU, no admin needed):
#   "Open in Pi"  / "Open in Vibe"  - folder and folder-background right-click
#   "LLM Config"  - folder and folder-background right-click
param(
    [string]$Target = ""
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
if (-not $Target) {
    $Target = (Resolve-Path (Join-Path $here "..\..\build\bin\Release") -ErrorAction SilentlyContinue).Path
    if (-not $Target) { throw "build\bin\Release not found; pass -Target <dir with llama-server.exe>" }
}
if (-not (Test-Path (Join-Path $Target "llama-server.exe"))) {
    Write-Warning "llama-server.exe not found in $Target - installing anyway"
}

# copy launcher files (skip model_args.json if the user already has one)
Get-ChildItem $here -File | Where-Object { $_.Name -ne "install.ps1" } | ForEach-Object {
    if ($_.Name -eq "model_args.json" -and (Test-Path (Join-Path $Target $_.Name))) {
        Write-Host "keep existing: $($_.Name)"
    } else {
        Copy-Item $_.FullName $Target -Force
        Write-Host "installed: $($_.Name)"
    }
}
New-Item -ItemType Directory -Force (Join-Path $Target "cache") | Out-Null

function Add-Menu($keyName, $label, $command) {
    foreach ($root in @("HKCU:\Software\Classes\Directory\shell", "HKCU:\Software\Classes\Directory\Background\shell")) {
        $arg = if ($root -like "*Background*") { "%V" } else { "%1" }
        $key = "$root\$keyName"
        New-Item -Path "$key\command" -Force | Out-Null
        Set-ItemProperty -Path $key -Name "(default)" -Value $label
        Set-ItemProperty -Path "$key\command" -Name "(default)" -Value ($command -replace "%ARG%", $arg)
    }
    Write-Host "context menu: $label"
}

Add-Menu "pi"        "Open in Pi"    "cmd /k call `"$Target\pi_open.bat`" `"%ARG%`""
Add-Menu "vibe"      "Open in Vibe"  "cmd /k call `"$Target\vibe_open.bat`" `"%ARG%`""
Add-Menu "llmconfig" "LLM Config"    "wscript.exe `"$Target\llm_config.vbs`""

Write-Host "`nDone. Target: $Target"
