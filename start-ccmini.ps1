[CmdletBinding()]
param(
    [string]$Provider = "openai",
    [string]$Model = "gpt-5.4",
    [string]$BaseUrl = "https://api.digitflow.cfd/v1",
    [string]$ApiKey = "",
    [switch]$NoLaunch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-PythonHasAiohttp {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PythonExe
    )

    try {
        $result = & $PythonExe -c "import aiohttp,sys;print(sys.executable)" 2>$null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Resolve-CcminiPython {
    $candidates = @()

    if ($env:PYTHON) {
        $candidates += $env:PYTHON
    }

    $pythonCmd = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCmd) {
        $candidates += $pythonCmd.Source
    }

    foreach ($candidate in $candidates | Select-Object -Unique) {
        if ($candidate -and (Test-PythonHasAiohttp -PythonExe $candidate)) {
            return $candidate
        }
    }

    throw "Unable to find a Python interpreter with aiohttp installed."
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

if (-not (Test-Path ".\package.json")) {
    throw "package.json not found. Please run this script from frontend-web."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm is not installed or not in PATH."
}

$pythonExe = Resolve-CcminiPython
$env:PYTHON = $pythonExe
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

$env:CCMINI_PROVIDER = $Provider
$env:CCMINI_MODEL = $Model
$env:CCMINI_BASE_URL = $BaseUrl

if ($ApiKey) {
    $env:CCMINI_API_KEY = $ApiKey
}

Write-Host "Starting ccmini desktop frontend..." -ForegroundColor Cyan
Write-Host "Provider: $($env:CCMINI_PROVIDER)"
Write-Host "Model:    $($env:CCMINI_MODEL)"
Write-Host "Base URL: $($env:CCMINI_BASE_URL)"
Write-Host "Python:   $($env:PYTHON)"
if ($env:CCMINI_API_KEY) {
    Write-Host "API Key:  [set]"
} else {
    Write-Host "API Key:  [not set, configure in Settings -> Models or pass -ApiKey]"
}

if ($NoLaunch) {
    Write-Host "Dry run only. Launch skipped." -ForegroundColor Yellow
    exit 0
}

npm run electron:dev
