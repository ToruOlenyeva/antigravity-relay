@echo off
chcp 65001 >nul
title Antigravity Relay Console

set PORT=8089
set SIDECAR_DIR=%~dp0sidecars\panel

:: Check if port 8089 is listening
powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 8089 -State Listen -ErrorAction SilentlyContinue)" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [AntigravityRelay] Starting Sidecar service in background (Port 8089)...
    powershell -NoProfile -Command "Start-Process node -ArgumentList 'main.mjs' -WorkingDirectory '%SIDECAR_DIR%' -WindowStyle Hidden"
    timeout /t 1 /nobreak >nul
)

:: Open web console in standalone Edge app window
start "" msedge --app=http://127.0.0.1:8089 --window-size=440,780

exit
