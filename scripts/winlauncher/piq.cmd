@echo off
rem piq [pi args...] - run pi with llama-server ensured up; shut it down if we started it.
setlocal
set "PIQ_STARTED="

powershell -NoProfile -Command "try{$t=(New-Object Net.Sockets.TcpClient).ConnectAsync('127.0.0.1',8080);if($t.Wait(300) -and $t.Status -eq 'RanToCompletion'){exit 0}}catch{};exit 1"
if not errorlevel 1 goto run

set "PIQ_STARTED=1"
wscript "%~dp0QWEN36MOECLI_TRAY.vbs"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0wait_server.ps1"
if errorlevel 1 exit /b 1

:run
call "%APPDATA%\npm\pi.cmd" %*
set "PIQ_RC=%ERRORLEVEL%"

if defined PIQ_STARTED (
    taskkill /IM llama-server.exe /T /F >nul 2>&1
)
exit /b %PIQ_RC%
