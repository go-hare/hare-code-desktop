@echo off
chcp 65001 >nul
echo Starting Hare Desktop...
echo.

for %%I in (.) do set "SHORT_PATH=%%~sI"
cd /d "%SHORT_PATH%"

where bun >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Bun is not installed or not in PATH!
    echo Please install Bun from https://bun.sh
    pause
    exit /b 1
)

if not exist "package.json" (
    echo ERROR: package.json not found!
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo Installing desktop dependencies...
    bun install
    if %errorlevel% neq 0 (
        echo ERROR: Failed to install dependencies
        pause
        exit /b 1
    )
)

echo Building desktop frontend...
bun run build
if %errorlevel% neq 0 (
    echo ERROR: Failed to build desktop frontend
    pause
    exit /b 1
)

echo.
echo Launching Electron desktop app...
echo.

node .\scripts\run-electron.cjs

if %errorlevel% neq 0 (
    echo.
    echo ERROR: Failed to start desktop app
    echo Try running manually: node .\scripts\run-electron.cjs
)

pause
