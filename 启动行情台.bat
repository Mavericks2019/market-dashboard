@echo off
setlocal
cd /d "%~dp0"
node start-background.mjs
if errorlevel 1 (
  echo Dashboard startup failed. See startup.log.
  pause
  exit /b 1
)
start "" "http://localhost:4174/"
endlocal
