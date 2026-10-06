@echo off
setlocal
cd /d "%~dp0"
set "PORT_PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":4174 .*LISTENING"') do set "PORT_PID=%%P"
if defined PORT_PID (
  start "" "http://localhost:4174/"
  exit /b 0
)
start "?????????" /min cmd /k "node server.mjs"
timeout /t 2 /nobreak >nul
start "" "http://localhost:4174/"
endlocal
