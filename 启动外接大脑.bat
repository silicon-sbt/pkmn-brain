@echo off
chcp 65001 >nul 2>&1
title PTC Brain - Jev Service
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js first.
  echo.
  pause
  exit /b 1
)

node start.mjs
echo.
pause
